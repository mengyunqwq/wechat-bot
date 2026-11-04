#include "db_mgr.h"
#include <atomic>
#include <thread>
#include <chrono>
#include <set>
#include <string>
#include <vector>
#include <cstring>
#include <cstdio>
#include <intrin.h>   // _ReturnAddress()：识别 SQL 入口的调用来源
#include "xwechat_offsets.h"
#include "SundaySearch.h"
#include "global.h"
#include "tools.h"
#include "MinHook.h"
#include "msg_push.h"   // 第三轮：消息写入抓取 + 推送（见 msg_push.h 顶部说明）

// ══════════════════════════════════════════════════════════════════
//  数据库句柄登记表（修复"靠扫内存找句柄"的脆弱做法）
//
//  原来：扫内存找"指向 VFS 的指针值"当候选句柄，再用 errcode 验证。
//        实测命中数会在 219 / 225 / 3 之间跳 —— 一跳就一个库都找不到，
//        表现就是"机器人突然不回复了"（收消息依赖数据库轮询）。
//
//  现在：把 sqlite3_api_routines 的 open_v2 换成我们的 detour，
//        微信每打开一个数据库就记下 {句柄 → 文件名}，直接用真实记录。
//        记录为空时仍回退到原来的扫描（保证老库也能发现）。
// ══════════════════════════════════════════════════════════════════
static void codec_get_key(sqlite3CodecGetKey func, sqlite3* db, int index, void** pKey, int* pLen);   // 前置声明（定义在文件后半段）
static sqlite3CodecGetKey g_codecGetKeyFn = nullptr;   // 在客户端线程里取密钥用（方案 A-2）

namespace db_registry {
    // ══════════════════════════════════════════════════════════════════
    //  数据库句柄登记表（2026-10-19 第二次重做 · 干净版）
    //
    //  三条红线（改代码前先读 —— 上一版就是踩着它们把客户端搞崩的）：
    //   ① **绝不主动探测句柄**：不发 SELECT 1、不 prepare 试探、不用 SEH 吞访问违例。
    //      句柄"好坏"只由【真实查询的返回码】判定（noteQueryResult）。
    //   ② prepare detour 里除"记一条映射"外什么都不做：不调 API、不读内存、
    //      不做 I/O、不打日志。开销 = 一次哈希 + 一次线性探测 + 一次 relaxed store，
    //      O(1) 且**完全无锁**（连互斥量都不碰，见 noteHot）。
    //   ③ 缓存逐条维护：坏的那一条**只剔它自己**，绝不 m_dbs.clear()。
    //
    //  为什么原来会崩：在两个 detour 之外、从我们自己的线程往微信的**活连接**上
    //  压 prepare("SELECT 1") 做"可用性探测"，靠 SEH 吞访问违例 —— 三次崩溃的主角。
    //  为什么原来启动要 3 分钟：缓存为空时**每次调用**都做一遍全地址空间扫描，
    //  桥每 2.5 秒轮询 6 张表 → 客户端被自己的扫描拖死（实测 scans=153）。
    // ══════════════════════════════════════════════════════════════════

    inline long long nowMs() { return (long long)GetTickCount64(); }

    // sqlite3 API 表（installPrepare 里填入）。这里提前声明：取名/复核会用到它的只读槽位
    // db_filename（**只读、不发 SQL**）。
    sqlite3_api_routines* g_api = nullptr;
    // 安装钩子的互斥：早装线程 / DatabaseMgr 构造 / HTTP 线程可能同时进来
    std::recursive_mutex g_installMtx;

std::atomic<uintptr_t> g_lastVfs{ 0 };   // 最近一次 vfs_find 的结果（诊断用）
std::atomic<long long> g_connLockOk{ 0 };     // 成功拿到连接锁的次数
std::atomic<long long> g_connLockNull{ 0 };   // db_mutex 为空/未生效的次数（锁没起作用）
std::atomic<long long> g_connLockSerial{ 0 }; // 走"进程内串行锁"退路的次数（2026-11-04 新增）
// ★ 2026-11-04 事故：微信 4.1.10.27 的连接不是 FULLMUTEX，db_mutex(db) 恒返回 NULL，
//   于是每条 SQL 都**无锁直冲**客户端线程 → 语音解码风暴时把客户端自己的读请求挤掉，
//   用户看到的是"微信聊天界面不显示消息"。
//   退路：拿不到连接锁时，用一把进程内的递归互斥把**我们自己的**查询串起来
//   （不能和客户端互斥，但足以保证"我们不并发轰库"）。
std::recursive_mutex g_serialQueryMtx;

// ── 连接级互斥（对齐 sqlite 自己的连接锁）────────────────────────
// 背景：我们通过 sqlite3_api_routines 直接调 prepare/step/finalize，
//       这些是内部实现，**不拿连接锁**（公开 sqlite3_prepare_v2 才会 enter）。
//       与客户端线程并发时会踩坏 lookaside 空闲链表 → 客户端崩溃。
//       这里借 api 表的 db_mutex / mutex_enter / mutex_leave 补上同一把锁。
class SqliteConnLock {
public:
    explicit SqliteConnLock(sqlite3* db) {
        if (db == nullptr) return;
        if (g_api && g_api->db_mutex && g_api->mutex_enter) {
            m_mutex = g_api->db_mutex(db);
            if (m_mutex) {
                g_api->mutex_enter(m_mutex);
                m_locked = true;
                g_connLockOk.fetch_add(1, std::memory_order_relaxed);
                return;
            }
            g_connLockNull.fetch_add(1, std::memory_order_relaxed);
        } else {
            g_connLockNull.fetch_add(1, std::memory_order_relaxed);   // 槽位缺失
        }
        // 退路：进不了客户端的连接锁 → 至少让我们自己的查询不并发（2026-11-04）
        g_serialQueryMtx.lock();
        m_serial = true;
        g_connLockSerial.fetch_add(1, std::memory_order_relaxed);
    }
    ~SqliteConnLock() {
        if (m_locked && g_api && g_api->mutex_leave) g_api->mutex_leave(m_mutex);
        else if (m_serial) g_serialQueryMtx.unlock();
    }
    bool locked() const { return m_locked; }
    bool serial() const { return m_serial; }
private:
    sqlite3_mutex* m_mutex = nullptr;
    bool m_locked = false;
    bool m_serial = false;   // 走的是进程内串行锁退路
};

    // ── 计数器（热路径上只有一次 relaxed 自增/store）──────────────────
    std::atomic<long long> g_registrations{ 0 };    // 累计登记（含覆盖登记）
    std::atomic<long long> g_pruned{ 0 };           // 逐条剔除的句柄数
    std::atomic<long long> g_queryOk{ 0 };          // 真实查询：句柄健康
    std::atomic<long long> g_queryFail{ 0 };        // 真实查询：连接级失败
    std::atomic<long long> g_suspect{ 0 };          // 连续失败到达阈值（进入观察）
    std::atomic<long long> g_evicted{ 0 };          // 到达阈值**且**内存读不通 → 剔除
    std::atomic<long long> g_healCount{ 0 };        // 连续拿不到句柄触发的自愈次数
    std::atomic<long long> g_hitRegistry{ 0 };      // 按名直查注册表命中
    std::atomic<long long> g_hitCache{ 0 };         // m_dbs 缓存命中
    std::atomic<long long> g_miss{ 0 };             // 没找到
    std::atomic<long long> g_namePassRuns{ 0 };     // 取名扫描执行次数
    std::atomic<long long> g_namePassSkipped{ 0 };  // 扫描进行中 → 直接返回缓存
    std::atomic<long long> g_namePassThrottled{ 0 };// 节流窗口内 → 不扫
    std::atomic<long long> g_lastScanMs{ 0 };       // 上次取名扫描时刻(ms)
    std::atomic<int>       g_scanBusy{ 0 };         // 单飞标记（1 = 有线程正在扫）
    std::atomic<int>       g_emptyScans{ 0 };       // 连续"扫了没收获"次数（指数退避用）
    std::atomic<int>       g_passAttempted{ 0 };    // 上一轮取名扫描尝试了几个句柄
    std::atomic<int>       g_passNamed{ 0 };        // 上一轮取名扫描成功了几个
    std::atomic<long long> g_openNamed{ 0 };        // open_v2 直接给出的库名条数（诊断用）
    std::atomic<long long> g_lastRegMs{ 0 };        // 最近一次**新句柄**出现的时刻（突发稳定判定用）
    std::atomic<long long> g_lastFastRefreshMs{ 0 };// 上次轻量名字刷新时刻
    std::atomic<long long> g_nameRefreshChanged{ 0 };// 轻量刷新纠正过多少次映射

    // ── 句柄表：固定槽位 + 全原子字段（读路径零锁）──────────────────────
    //  key: 0 = 空位，1 = 墓碑（已剔除，探测时跨过），其它 = 句柄地址。
    //  为什么不用 std::map + mutex：prepare 是**每次查询**都走的热路径，
    //  而桥每 2.5 秒要碰同一批数据，一把全局锁就把微信自己的 SQL 也拖慢了。
    enum { kSlotCount = 1024 };
    struct Slot {
        std::atomic<uintptr_t> key{ 0 };
        std::atomic<int>       name{ 0 };      // 名字池下标 + 1（0 = 还没名字）
        std::atomic<long long> tick{ 0 };      // 最近一次在 SQL 入口见到(ms)
        std::atomic<long long> lastOk{ 0 };    // 最近一次真实查询成功(ms)
        std::atomic<long long> lastFail{ 0 };  // 最近一次连接级失败(ms)
        std::atomic<int>       fail{ 0 };      // 连续失败计数（成功一次清零）
        std::atomic<int>       src{ 0 };       // 0=prepare 1=open_v2 2=取名扫描
    };
    Slot g_slot[kSlotCount];

    // 名字池：只追加、索引稳定（槽位里的 name 是下标 + 1）
    std::mutex g_nameMtx;
    std::vector<std::string> g_names;

    inline int internName(const std::string& n) {
        if (n.empty()) return 0;
        std::lock_guard<std::mutex> lg(g_nameMtx);
        for (size_t i = 0; i < g_names.size(); ++i) if (g_names[i] == n) return (int)i + 1;
        if (g_names.size() >= 512) return 0;
        g_names.push_back(n);
        return (int)g_names.size();
    }

    // 一次性拷出名字池（给遍历用，避免每个槽位都去拿锁）
    inline std::vector<std::string> copyNames() {
        std::lock_guard<std::mutex> lg(g_nameMtx);
        return g_names;
    }

    // 从完整路径取文件名（如 ...\message_0.db → message_0.db）
    inline std::string baseName(const std::string& p) {
        auto pos = p.find_last_of("\\/");
        return pos == std::string::npos ? p : p.substr(pos + 1);
    }

    // 名字像不像库文件名（挡掉"句柄地址被复用时传进来的垃圾串"）
    inline bool looksLikeDbName(const std::string& s) {
        if (s.size() < 4 || s.size() > 128) return false;
        if (s.find('\\') != std::string::npos || s.find('/') != std::string::npos) return false;
        char a = s[s.size() - 3], b = s[s.size() - 2], c = s[s.size() - 1];
        return (a == '.') && (b == 'd' || b == 'D') && (c == 'b' || c == 'B');
    }

    inline unsigned homeOf(uintptr_t p) {
        uint64_t h = (uint64_t)p * 0x9E3779B97F4A7C15ull;
        return (unsigned)((h >> 54) & (unsigned)(kSlotCount - 1));
    }

    // 查槽位（无锁读路径）：命中 → 槽位；没有 → nullptr
    inline Slot* findSlot(uintptr_t p) {
        unsigned i = homeOf(p);
        for (unsigned n = 0; n < (unsigned)kSlotCount; ++n) {
            Slot& s = g_slot[(i + n) & (unsigned)(kSlotCount - 1)];
            const uintptr_t k = s.key.load(std::memory_order_relaxed);
            if (k == p) return &s;
            if (k == 0) return nullptr;           // 空位 = 这条探测链到头了
        }
        return nullptr;
    }

    // 占位：唯一用 CAS 的地方，只在**首次**见到某个句柄时发生（此后永不）
    inline Slot* claimSlot(uintptr_t p) {
        unsigned i = homeOf(p);
        for (unsigned n = 0; n < (unsigned)kSlotCount; ++n) {
            Slot& s = g_slot[(i + n) & (unsigned)(kSlotCount - 1)];
            uintptr_t k = s.key.load(std::memory_order_relaxed);
            if (k == p) return &s;
            if (k == 0 || k == 1) {
                if (s.key.compare_exchange_strong(k, p, std::memory_order_acq_rel)) {
                    return &s;                    // 抢到（墓碑在 retire 时已清零全部字段）
                }
                if (k == p) return &s;            // 别人刚抢了同一个句柄
            }
        }
        return nullptr;                           // 表满（1024 对实测 ~20 个库绰绰有余）
    }

    // 前向声明：safeDbName 定义在本命名空间后面（用 api->db_filename 只读取名）
    inline bool safeDbName(void* handle, std::string& out);

    // ── 方案 A-2：在**客户端线程**里把每个库的 SQLCipher 密钥抓下来 ──
    //   为什么不在我们自己的线程调 codec_get_key：那等于又一次跨线程读客户端连接，
    //   实测会把客户端搞崩。这里只在客户端调用 prepare 的上下文里读一次（安全）。
    std::mutex g_keyMtx;
    std::map<std::string, std::string> g_keys;      // 库路径 → 原始密钥

    inline void tryCaptureKey(void* db) {
        if (g_WxVersion != 0) return;   // 新版 codec 偏移未适配：不抓密钥（会崩）`n        if (g_codecGetKeyFn == nullptr || db == nullptr) return;
        std::string path;
        if (!safeDbName(db, path) || path.empty()) return;
        {
            std::lock_guard<std::mutex> lg(g_keyMtx);
            if (g_keys.find(path) != g_keys.end()) return;   // 已抓过
        }
        void* pKey = nullptr;
        int nKey = 0;
        ::codec_get_key(g_codecGetKeyFn, (sqlite3*)db, 0, &pKey, &nKey);
        if (pKey == nullptr || nKey <= 0) return;
        std::lock_guard<std::mutex> lg(g_keyMtx);
        g_keys[path] = std::string((const char*)pKey, (size_t)nKey);
    }

    inline bool keyForPath(const std::string& path, std::string& out) {
        std::lock_guard<std::mutex> lg(g_keyMtx);
        auto it = g_keys.find(path);
        if (it == g_keys.end()) return false;
        out = it->second;
        return true;
    }
    // ★★ prepare detour 的**唯一**动作：记一条映射 ★★
    //   O(1)、无锁、不调 API、不读内存、不做 I/O、不打日志。
    //   首次见到的句柄也只是 CAS 占一个槽（无分配、无锁、无系统调用）。
    inline void noteHot(void* db) {
        const uintptr_t p = (uintptr_t)db;
        if (p == 0) return;
        Slot* s = findSlot(p);
        if (s != nullptr) {
            s->tick.store(nowMs(), std::memory_order_relaxed);
            return;
        }
        Slot* c = claimSlot(p);
        if (c != nullptr) {
            c->tick.store(nowMs(), std::memory_order_relaxed);
            g_registrations.fetch_add(1, std::memory_order_relaxed);
        tryCaptureKey(db);   // 客户端线程里顺手抓密钥（方案 A-2，安全）
            g_lastRegMs.store(nowMs(), std::memory_order_relaxed);   // 新句柄出现（只在首次登记时写）
        }
    }

    // open_v2 登记（低频：每次开库一次；名字直接来自 filename 参数，安全且权威）
    inline void noteOpened(void* db, const std::string& rawName) {
        const uintptr_t p = (uintptr_t)db;
        if (p == 0) return;
        std::string nm = baseName(rawName);
        if (!looksLikeDbName(nm)) nm.clear();
        const int idx = internName(nm);            // 低频路径，允许拿名字锁
        Slot* s = findSlot(p);
        if (s == nullptr) s = claimSlot(p);
        if (s == nullptr) return;
        if (idx > 0) s->name.store(idx, std::memory_order_relaxed);   // 地址被复用 → 以最新一次 open 为准
        if (idx > 0) g_openNamed.fetch_add(1, std::memory_order_relaxed);
        s->src.store(1, std::memory_order_relaxed);
        s->fail.store(0, std::memory_order_relaxed);                  // 新连接：失败计数清零
        s->tick.store(nowMs(), std::memory_order_relaxed);
        g_registrations.fetch_add(1, std::memory_order_relaxed);
        g_lastRegMs.store(nowMs(), std::memory_order_relaxed);
    }

    // ── 新版（4.1.15+）专用：只读扫描（不改代码/不改表）────────────────
    //   用 vfs_find(NULL) 拿默认 VFS，再扫本进程内存找"第一个字段 == VFS"的对象
    //   （sqlite3 结构体偏移 0 就是 pVfs），用 db_filename（自身带 SEH）只读验证名字。
    // 独立 SEH 包装（函数内无析构对象，MSVC 才允许 __try）
    inline sqlite3_vfs* vfsFindSafe(sqlite3_api_routines* api) {
        __try { return api->vfs_find(nullptr); } __except (EXCEPTION_EXECUTE_HANDLER) { return nullptr; }
    }

    inline int scanByVfs(sqlite3_api_routines* api) {
        if (api == nullptr || api->db_filename == nullptr) return 0;
        int added = 0;
        MEMORY_BASIC_INFORMATION mbi;
        unsigned char* addr = nullptr;
        while (VirtualQuery(addr, &mbi, sizeof(mbi)) == sizeof(mbi)) {
            const DWORD pr = mbi.Protect;
            const bool rd = (pr & (PAGE_READONLY | PAGE_READWRITE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE)) != 0;
            if (mbi.State == MEM_COMMIT && mbi.Type == MEM_PRIVATE && rd && mbi.RegionSize <= (64ull << 20)) {
                unsigned char* q = (unsigned char*)mbi.BaseAddress;
                unsigned char* qe = q + mbi.RegionSize;
                for (; q + 8 <= qe; q += 8) {
                    void* pvfs = *(void**)q;
                    if (pvfs == nullptr || !IsReadableRegion(pvfs, 32)) continue;
                    const int iVer = *(int*)pvfs;
                    if (iVer < 1 || iVer > 3) continue;
                    const char* nm = *(const char**)((unsigned char*)pvfs + 24);
                    if (nm == nullptr || !IsReadableRegion(nm, 5)) continue;
                    if (strncmp(nm, "win32", 5) != 0 && strncmp(nm, "unix", 4) != 0 && strncmp(nm, "wcdb", 4) != 0) continue;
                    std::string name;
                    if (safeDbName((void*)q, name) && !name.empty() && looksLikeDbName(baseName(name))) {
                        noteOpened((void*)q, name);
                        added++;
                    }
                }
            }
            addr = (unsigned char*)mbi.BaseAddress + mbi.RegionSize;
            if (addr == nullptr) break;
        }
        return added;
    }

    // SEH 包装（自身无析构对象）：扫描中任何访问违例变成 -1，不让异常冒出
    inline int scanByVfsSafe(sqlite3_api_routines* api) {
        __try { return scanByVfs(api); } __except (EXCEPTION_EXECUTE_HANDLER) { return -1; }
    }


    // 取名扫描的成果回填（src=2）。只给**已登记**的句柄补名字，绝不新造句柄。
    inline void noteNamed(void* db, const std::string& name) {
        const uintptr_t p = (uintptr_t)db;
        if (p == 0 || name.empty()) return;
        const int idx = internName(name);
        if (idx <= 0) return;
        Slot* s = findSlot(p);
        if (s == nullptr) return;
        s->name.store(idx, std::memory_order_relaxed);
        s->src.store(2, std::memory_order_relaxed);
    }

    inline bool isRegistered(uintptr_t p) { return findSlot(p) != nullptr; }

    // 逐条剔除（**只删它自己**）
    inline void retireHandle(uintptr_t p) {
        Slot* s = findSlot(p);
        if (s == nullptr) return;
        s->key.store(1, std::memory_order_release);   // 先立墓碑：读路径立刻看不到它
        s->name.store(0, std::memory_order_relaxed);
        s->tick.store(0, std::memory_order_relaxed);
        s->lastOk.store(0, std::memory_order_relaxed);
        s->lastFail.store(0, std::memory_order_relaxed);
        s->fail.store(0, std::memory_order_relaxed);
        g_pruned.fetch_add(1, std::memory_order_relaxed);
    }

    // 连接级失败 = "这个句柄本身坏了"的返回码。
    // SQLITE_ERROR(1)（SQL 写错 / 没有这个表）、BUSY/LOCKED（微信正在写）**不算** ——
    // 它们恰好证明连接是活的、而且能正确回答。
    inline bool isConnFailure(int rc) {
        const int base = rc & 0xFF;
        return base == SQLITE_MISUSE || base == SQLITE_NOTADB || base == SQLITE_CORRUPT ||
               base == SQLITE_IOERR || base == SQLITE_CANTOPEN;
    }

    static const int kEvictStreak = 3;      // 连续 3 次连接级失败（且内存读不通）→ 剔除

    // ★ 句柄好坏的**唯一**判据：真实查询的返回码（我们不主动去试）
    //   返回 true = 这个句柄已被剔除，调用方应立刻丢掉它
    bool noteQueryResult(void* db, int rc) {
        const uintptr_t p = (uintptr_t)db;
        if (p == 0) return false;
        Slot* s = findSlot(p);
        if (s == nullptr) return true;                        // 已被剔除 / 从未登记
        if (!isConnFailure(rc)) {
            s->fail.store(0, std::memory_order_relaxed);      // 成功一次就清零
            s->lastOk.store(nowMs(), std::memory_order_relaxed);
            g_queryOk.fetch_add(1, std::memory_order_relaxed);
            return false;
        }
        const int n = s->fail.fetch_add(1, std::memory_order_relaxed) + 1;
        s->lastFail.store(nowMs(), std::memory_order_relaxed);
        g_queryFail.fetch_add(1, std::memory_order_relaxed);

        // ── SQLITE_MISUSE(21)：sqlite 自己说"这个连接对象不可用"（已关闭/不是连接）──
        // 这不是瞬时状态（BUSY/LOCKED/IOERR 才是），所以**立刻**剔除，不等 3 次。
        // 实测场景：WCDB 关掉 message_0.db 的连接后地址被复用，表里留着 3 个已关闭句柄，
        // 桥每次查都拿到它 → `execute sqlite3_prepare failed` → 机器人静默失聪。
        if ((rc & 0xFF) == SQLITE_MISUSE) {
            retireHandle(p);
            g_evicted.fetch_add(1, std::memory_order_relaxed);
            return true;
        }
        if (n < kEvictStreak) return false;
        g_suspect.fetch_add(1, std::memory_order_relaxed);
        // 最后一道闸门：IsReadableRegion 单独用会误杀**正常**句柄
        // （sqlite3 对象只有几百字节，堆块后面未必还有 4KB 可读页），
        // 所以只有"真实查询连续失败 + 内存也读不通"才剔除。
        if (IsReadableRegion((const void*)p, 0x1000)) return false;
        retireHandle(p);
        g_evicted.fetch_add(1, std::memory_order_relaxed);
        return true;
    }

    struct Entry {
        void*       handle;
        std::string name;
        int         fail;
        long long   tick;
        long long   lastOk;
        long long   lastFail;
        int         src;
    };

    // 遍历全表拷一份（1024 次 relaxed 读；桥每 2.5 秒调几次也没压力）
    std::vector<Entry> snapshot() {
        std::vector<std::string> names = copyNames();
        std::vector<Entry> out;
        out.reserve(64);
        for (int i = 0; i < (int)kSlotCount; ++i) {
            Slot& s = g_slot[i];
            const uintptr_t p = s.key.load(std::memory_order_relaxed);
            if (p == 0 || p == 1) continue;
            Entry e;
            e.handle = (void*)p;
            const int idx = s.name.load(std::memory_order_relaxed);
            if (idx > 0 && (size_t)idx <= names.size()) e.name = names[(size_t)idx - 1];
            e.fail = s.fail.load(std::memory_order_relaxed);
            e.tick = s.tick.load(std::memory_order_relaxed);
            e.lastOk = s.lastOk.load(std::memory_order_relaxed);
            e.lastFail = s.lastFail.load(std::memory_order_relaxed);
            e.src = s.src.load(std::memory_order_relaxed);
            out.push_back(e);
        }
        return out;
    }

    inline bool entryByHandle(void* h, Entry& out) {
        Slot* s = findSlot((uintptr_t)h);
        if (s == nullptr) return false;
        out.handle = h;
        const int idx = s->name.load(std::memory_order_relaxed);
        out.name.clear();
        if (idx > 0) {
            std::lock_guard<std::mutex> lg(g_nameMtx);
            if ((size_t)idx <= g_names.size()) out.name = g_names[(size_t)idx - 1];
        }
        out.fail = s->fail.load(std::memory_order_relaxed);
        out.tick = s->tick.load(std::memory_order_relaxed);
        out.lastOk = s->lastOk.load(std::memory_order_relaxed);
        out.lastFail = s->lastFail.load(std::memory_order_relaxed);
        out.src = s->src.load(std::memory_order_relaxed);
        return true;
    }

    // 句柄 → 库名（只用登记表，不碰客户端连接对象；比 db_filename 安全）
    inline bool nameForHandle(void* h, std::string& out) {
        Entry e;
        if (entryByHandle(h, e) && !e.name.empty()) { out = e.name; return true; }
        return false;
    }

    inline size_t liveCount() {
        size_t n = 0;
        for (int i = 0; i < (int)kSlotCount; ++i) {
            const uintptr_t p = g_slot[i].key.load(std::memory_order_relaxed);
            if (p != 0 && p != 1) ++n;
        }
        return n;
    }

    inline size_t unnamedCount() {
        size_t n = 0;
        for (int i = 0; i < (int)kSlotCount; ++i) {
            Slot& s = g_slot[i];
            const uintptr_t p = s.key.load(std::memory_order_relaxed);
            if (p == 0 || p == 1) continue;
            if (s.name.load(std::memory_order_relaxed) == 0) ++n;
        }
        return n;
    }

    // 需要取名扫描吗？（有句柄但没名字 → 需要）
    // ★ 还要等"突发稳定" 2 秒：微信启动时会在十几秒内连续开 30+ 个库，
    //   如果第一个句柄一出现就扫，只能拿到 1 个名字，剩下的得等 30 秒（实测启动因此多花 30s）。
    //   等 2 秒不夸张：这 2 秒里没有任何额外代价，只是等它把这批库开完。
    inline bool needNamePass() {
        if (unnamedCount() == 0) return false;
        const long long lastReg = g_lastRegMs.load(std::memory_order_relaxed);
        if (lastReg != 0 && (nowMs() - lastReg) < 2000) return false;   // 还在开库，等它开完
        return true;
    }

    // 按库名取句柄（零 SQL、零探测）。
    // 同名可能有 2~3 个连接（WCDB 连接池）→ 取"连续失败最少"，再看"最近用过"的。
    //
    // ★ 为什么必须复核（实测翻车点）★
    //   sqlite3* 地址会被复用：句柄 H 在 T 时刻是 message_0.db，关掉后被重新 open 成
    //   emoticon.db —— 缓存里 H 还叫 message_0.db。结果是"查 message_0.db 却查到表情库"，
    //   桥侧表现就是 `SELECT ... FROM Name2Id` → sqlite3_prepare failed。
    //   复核方式：**只读**的 api->db_filename（不 prepare、不发 SQL、不碰表），
    //   拿到权威名字不一致就当场改映射。db_filename 只读 db->aDb[0].zDbSName，成本纳秒级。
    // 安全地把 db_filename 的结果拷成 std::string。
    // 为什么要先 IsReadableRegion(fn,1)：db_filename 只返回一个 const char*，
    // 万一对象已被释放（堆块被别的分配复用），这个指针可能是垃圾 → 直接 std::string(fn)
    // 会解引用野指针。先确认那一字节可读、再限长，风险就收敛成"拿不到名字"。
    // 独立的 SEH 包装：只调 db_filename，函数里没有任何带析构的 C++ 对象，
    // 所以 MSVC 允许在这里用 __try（放进 safeDbName 会报 C2712「要求对象展开」）。
    // 计数器：SEH 兜住了多少次野指针（没这个数就分不清"没遇到"和"兜住了但没留痕"）
    inline std::atomic<unsigned>& sehDbFilenameHits() {
        static std::atomic<unsigned> v{0};
        return v;
    }

    inline const char* sehDbFilename(void* handle) {
        __try {
            return (const char*)g_api->db_filename((sqlite3*)handle, "main");
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            sehDbFilenameHits().fetch_add(1, std::memory_order_relaxed);
            return nullptr;      // 野指针 → 当成"拿不到名字"，绝不崩
        }
    }

    // ★★ 2026-10-22 修（第三次崩溃，23:16:07）★★
    //  旧实现的致命缺陷：只有 db_filename **调用本身**在 SEH 里，返回的 const char*
    //  后面的每一次解引用全在 SEH 外：
    //      if (fn == nullptr || *fn == '\0') ...      ← ① 野指针解引用
    //      if (!IsReadableRegion(fn, 1)) ...          ← 检查写在 ① 之后，等于没用
    //      while (n < 512 && fn[n] != '\0') ...       ← ② 盲读 512 字节，越界必崩
    //  db_filename 对已释放的句柄可能返回非空但指向已回收堆块的指针；
    //  那种指针 IsReadableRegion 可能是 true（页还在映射），读下去就是垃圾或崩。
    //
    //  为什么以前不崩：contact.db 被 retire 后 verifyName 根本不会被调用。
    //  而 trusted 改成"tick 老化先 verifyName"之后，高频查 contact.db 就等于
    //  给这个 bug 加了触发器 → 23:16:07 崩。
    //
    //  正确做法：把**整个字符串读取**包进 SEH，并且读到调用方提供的栈缓冲区里
    //  （栈一定可写，不会因为写入再崩一次）。函数内无任何带析构的 C++ 对象，
    //  避免 MSVC C2712「要求对象展开」。
    inline bool sehReadDbName(void* handle, char* buf, size_t bufsz, size_t* outLen) {
        __try {
            const char* fn = (const char*)g_api->db_filename((sqlite3*)handle, "main");
            if (fn == nullptr) return false;
            size_t i = 0;
            while (i + 1 < bufsz) {
                const char c = fn[i];      // 越界/野指针在这里触发 SEH
                if (c == '\0') break;
                buf[i] = c;
                ++i;
            }
            buf[i] = '\0';
            *outLen = i;
            return true;
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            sehDbFilenameHits().fetch_add(1, std::memory_order_relaxed);
            return false;
        }
    }

    inline bool safeDbName(void* handle, std::string& out) {
        out.clear();
        if (g_api == nullptr || g_api->db_filename == nullptr || handle == nullptr) return false;

        char buf[512];
        size_t n = 0;
        if (!sehReadDbName(handle, buf, sizeof(buf), &n)) return false;   // 所有解引用都在 SEH 内
        if (n == 0) return false;

        // ★ 允许中文路径：db_filename 返回完整路径，中文字节 > 0x7E。
        //   只挡控制字符（<0x20），然后 baseName() 取到 *.db 文件名（本身是 ASCII）。
        for (size_t i = 0; i < n; ++i) {
            if ((unsigned char)buf[i] < 0x20) return false;   // 控制字符 → 肯定是垃圾
        }
        out = baseName(std::string(buf, n));
        return looksLikeDbName(out);
    }

    bool verifyName(void* handle, const std::string& expect) {
        if (handle == nullptr) return false;
        if (g_api == nullptr || g_api->db_filename == nullptr) return true;   // 拿不到槽位 → 不改判
        std::string nm;
        if (!safeDbName(handle, nm)) {
        // 拿不到名字 → 不信任这个候选：WCDB 把连接关掉后地址还留在表里，
        // db_filename 对已关闭的连接返回空串。以前这里"当它匹配"，结果一直把
        // 已关闭的句柄发给桥 → prepare 返回 SQLITE_MISUSE(21)。
        return false;
        }
        if (nm == expect) return true;
        noteNamed(handle, nm);          // 地址复用 → 立刻纠正映射
        return false;
    }

    // ── 轻量名字刷新（每 2 秒最多一次）────────────────────────────────
    // 只用 api->db_filename：**只读、零 SQL、零锁、纳秒级**，不碰任何表。
    // 专门对付"句柄被回收后地址被别的库复用"——这是缓存名过期的主因。
    // 与 namePass（30 秒节流、可能发 PRAGMA 兜底）分工：这个负责"纠正"，那个负责"首轮取名"。
    int refreshNamesFast() {
        if (g_api == nullptr || g_api->db_filename == nullptr) return 0;
        const long long now = nowMs();
        long long prev = g_lastFastRefreshMs.load(std::memory_order_relaxed);
        if (prev != 0 && (now - prev) < 2000) return 0;
        if (!g_lastFastRefreshMs.compare_exchange_strong(prev, now)) return 0;
        std::vector<std::string> names = copyNames();
        int changed = 0;
        for (int i = 0; i < (int)kSlotCount; ++i) {
            Slot& s = g_slot[i];
            const uintptr_t p = s.key.load(std::memory_order_relaxed);
            if (p == 0 || p == 1) continue;
            const long long tick = s.tick.load(std::memory_order_relaxed);
            if (tick == 0 || (now - tick) > 120000) continue;      // 只刷新"最近用过"的
            if (!IsReadableRegion((const void*)p, 64)) continue;
            std::string nm;
            if (!safeDbName((void*)p, nm)) continue;
            const int idx = s.name.load(std::memory_order_relaxed);
            const std::string cur = (idx > 0 && (size_t)idx <= names.size())
                                  ? names[(size_t)idx - 1] : std::string();
            if (cur == nm) continue;
            const int ni = internName(nm);
            if (ni > 0) { s.name.store(ni, std::memory_order_relaxed); ++changed; }
        }
        if (changed > 0) g_nameRefreshChanged.fetch_add(changed, std::memory_order_relaxed);
        return changed;
    }

    void* findByName(const std::string& name) {
        if (name.empty()) return nullptr;
        // 最多两趟：第一趟找不到 → 做一次轻量名字刷新（纠正过期映射）再找一趟
        for (int attempt = 0; attempt < 2; ++attempt) {
            if (attempt == 1) { if (refreshNamesFast() == 0) return nullptr; }
            for (int round = 0; round < 2; ++round) {
                std::vector<Entry> all = snapshot();
                void* best = nullptr;
                int bestFail = 1 << 30;
                long long bestTick = -1;
                for (size_t i = 0; i < all.size(); ++i) {
                    if (all[i].name != name) continue;
                    if (all[i].fail > bestFail) continue;
                    if (all[i].fail == bestFail && all[i].tick <= bestTick) continue;
                    best = all[i].handle;
                    bestFail = all[i].fail;
                    bestTick = all[i].tick;
                }
                if (best == nullptr) break;              // 这趟没有同名候选 → 交给下一趟刷新
                if (verifyName(best, name)) return best;
                // 名字过期 → verifyName 已改好映射，重来一轮
            }
        }
        return nullptr;
    }

    // ── 诊断报告（GET /Debug/DBRescan）───────────────────────────────
    // 纯只读：不跑任何 SQL、不改任何状态。
    nlohmann::ordered_json reportRegistry() {
        std::vector<Entry> all = snapshot();
        const long long now = nowMs();
        nlohmann::ordered_json arr = nlohmann::ordered_json::array();
        size_t named = 0;
        for (size_t i = 0; i < all.size(); ++i) {
            if (!all[i].name.empty()) ++named;
            nlohmann::ordered_json e;
            e["handle"] = format_string("0x%llX", (unsigned long long)(uintptr_t)all[i].handle);
            e["db"] = all[i].name;
            e["fail_streak"] = all[i].fail;
            e["age_ms"] = (all[i].tick > 0) ? (now - all[i].tick) : -1;
            e["last_ok_ms_ago"] = (all[i].lastOk > 0) ? (now - all[i].lastOk) : -1;
            e["last_fail_ms_ago"] = (all[i].lastFail > 0) ? (now - all[i].lastFail) : -1;
            e["source"] = (all[i].src == 1) ? "open_v2" : (all[i].src == 2 ? "name_pass" : "prepare");
            arr.push_back(e);
        }
        nlohmann::ordered_json j;
        j["count"] = (int)all.size();
        j["named"] = (int)named;
        j["unnamed"] = (int)(all.size() - named);
        j["entries"] = arr;
        return j;
    }

    nlohmann::ordered_json reportCounters() {
        nlohmann::ordered_json c;
        c["registrations"] = (long long)g_registrations.load(std::memory_order_relaxed);
        c["open_v2_names"] = (long long)g_openNamed.load(std::memory_order_relaxed);   // open_v2 detour 给出的库名条数
        c["name_refresh_fixed"] = (long long)g_nameRefreshChanged.load(std::memory_order_relaxed); // 轻量刷新纠正的过期映射
        c["pruned"] = (long long)g_pruned.load(std::memory_order_relaxed);
        c["query_ok"] = (long long)g_queryOk.load(std::memory_order_relaxed);
        c["query_fail"] = (long long)g_queryFail.load(std::memory_order_relaxed);
        c["seh_dbfn"] = (long long)sehDbFilenameHits().load(std::memory_order_relaxed);   // db_filename 被 SEH 兜住的次数
        c["suspect"] = (long long)g_suspect.load(std::memory_order_relaxed);
        c["evicted"] = (long long)g_evicted.load(std::memory_order_relaxed);
        c["self_heal_runs"] = (long long)g_healCount.load(std::memory_order_relaxed);
        c["lookup_registry"] = (long long)g_hitRegistry.load(std::memory_order_relaxed);
        c["lookup_cache"] = (long long)g_hitCache.load(std::memory_order_relaxed);
        c["lookup_miss"] = (long long)g_miss.load(std::memory_order_relaxed);
        long long ok = c["lookup_registry"].get<long long>() + c["lookup_cache"].get<long long>();
        long long all = ok + c["lookup_miss"].get<long long>();
        c["lookup_total"] = all;
        c["lookup_ok"] = ok;
        c["success_rate"] = (all > 0) ? (double)ok / (double)all : 0.0;
        return c;
    }

    nlohmann::ordered_json reportNamePass() {
        const long long now = nowMs();
        const long long last = g_lastScanMs.load(std::memory_order_relaxed);
        nlohmann::ordered_json j;
        j["runs"] = (long long)g_namePassRuns.load(std::memory_order_relaxed);
        j["skipped_busy"] = (long long)g_namePassSkipped.load(std::memory_order_relaxed);
        j["throttled"] = (long long)g_namePassThrottled.load(std::memory_order_relaxed);
        j["busy"] = (g_scanBusy.load(std::memory_order_relaxed) != 0);
        j["last_ms_ago"] = (last > 0) ? (now - last) : -1;
        j["last_attempted"] = g_passAttempted.load(std::memory_order_relaxed);
        j["last_named"] = g_passNamed.load(std::memory_order_relaxed);
        j["min_interval_ms"] = 30000;      // 全局最多每 30 秒扫一次（失败指数退避到 5 分钟）
        j["consecutive_empty"] = g_emptyScans.load(std::memory_order_relaxed);
        return j;
    }

    // ── detour: open_v2 ────────────────────────────────────────────────
    //  微信每打开一个数据库就记下 {句柄 → 文件名}：名字最权威、且零成本。
    typedef int (*open_v2_t)(const char*, sqlite3**, int, const char*);
    open_v2_t g_origOpenV2 = nullptr;
    bool g_installed = false;
    bool g_installedCode = false;

    int detourOpenV2(const char* filename, sqlite3** ppDb, int flags, const char* zVfs) {
        int rc = g_origOpenV2 ? g_origOpenV2(filename, ppDb, flags, zVfs) : 1 /*SQLITE_ERROR*/;
        if (rc == 0 && ppDb != nullptr && *ppDb != nullptr && filename != nullptr && *filename != '\0') {
            noteOpened((void*)*ppDb, std::string(filename));
        }
        return rc;
    }

    // ── detour: open（v1）────────────────────────────────────────────────
    //  ★ 2026-10-22 实测：微信核心开库走的是 **v1 入口** sqlite3_open，不是 open_v2。
    //    证据（/Debug/ApiTable 的 slots 地址，module_base = 0x7FFB71DB0000）：
    //      open       0x7FFB75078E20  ← 在 Weixin.dll 内（真实 sqlite）
    //      open_v2    0x7FFC3D618DE0  ← 在**另一个模块**（WCDB 封装层），从不被调用
    //      db_filename 0x7FFB7507A9E0 ← 在 Weixin.dll 内
    //    所以之前只 hook open_v2 → open_v2_names 恒为 0；
    //    contact.db 这类「只在启动或低频访问时打开」的库永远进不了注册表，
    //    桥就读不到（表现为 get database handle which named contact.db failed）。
    //    补上 v1 入口后，**每次开库都会被记录**，不再依赖事后猜名字。
    typedef int (*open_t)(const char*, sqlite3**);
    open_t g_origOpen = nullptr;
    bool g_installedOpenV1 = false;

    int detourOpen(const char* filename, sqlite3** ppDb) {
        int rc = g_origOpen ? g_origOpen(filename, ppDb) : 1 /*SQLITE_ERROR*/;
        if (rc == 0 && ppDb != nullptr && *ppDb != nullptr && filename != nullptr && *filename != '\0') {
            noteOpened((void*)*ppDb, std::string(filename));
        }
        return rc;
    }

    // ── detour: open16（宽字符版）────────────────────────────────────────
    //  ★ 2026-10-22 第二次实测：`open_v1_code=true` 但 open_v2_names 恒为 0，
    //    registrations 只有 prepare 抓到的 2 个。磁盘上 contact.db 明明 23:19:04 被写了
    //    （微信确实打开了它），但没有任何 open hook 触发。
    //    说明微信开库既不调 open、也不调 open_v2，而很可能调 **open16**（wchar 文件名）。
    //    open16 的槽位地址 0x7FFB75079490 紧挨着 open 的 0x7FFB75078E20（同一模块），
    //    是这个 sqlite 版本真正被使用的入口。
    typedef int (*open16_t)(const void*, sqlite3**);
    open16_t g_origOpen16 = nullptr;
    bool g_installedOpen16 = false;

    int detourOpen16(const void* filename, sqlite3** ppDb) {
        int rc = g_origOpen16 ? g_origOpen16(filename, ppDb) : 1 /*SQLITE_ERROR*/;
        // filename 是 UTF-16LE；用 WideCharToMultiByte 转成 UTF-8 再交给 noteOpened
        if (rc == 0 && ppDb != nullptr && *ppDb != nullptr && filename != nullptr) {
            char buf[512];
            int n = ::WideCharToMultiByte(CP_UTF8, 0, (const wchar_t*)filename, -1,
                                          buf, (int)sizeof(buf) - 1, nullptr, nullptr);
            if (n > 1) {
                buf[n - 1] = '\0';              // 去掉结尾的 \0
                noteOpened((void*)*ppDb, std::string(buf));
            }
        }
        return rc;
    }

    // ── detour: prepare ────────────────────────────────────────────────
    //  prepare 是每次查询都必走的路径 —— 只要微信还在用这个库，句柄就一定新鲜且活着。
    typedef int (*prepare_t)(sqlite3*, const char*, int, sqlite3_stmt**, const char**);
    prepare_t g_origPrepare = nullptr;
    bool g_installedPrepare = false;

    inline bool prepareHookInstalled() { return g_installedPrepare && g_origPrepare != nullptr; }
    inline bool openHookInstalled() { return ((g_installed || g_installedCode) && g_origOpenV2 != nullptr) || (g_installedOpenV1 && g_origOpen != nullptr); }



    // ══════════════════════════════════════════════════════════════════
    //  探针（第一轮：只观察不接管；第二轮：广谱 + 多入口 + 来源识别）
    //
    //  第一轮实测结论：消息写库**不经过** api->prepare（sqlite3_prepare_v2）——
    //  PROBE-MSG / PROBE-WRITE 都是 0 条，但 prepare 钩子确实活着。
    //  第二轮要回答：写库到底走哪个 SQL 入口，还是根本是另一个 sqlite 实例。
    //
    //  因此第二轮加三件事：
    //    ① 调用来源识别（self=我们自己的 QueryDB / wx=Weixin.dll / other）。
    //       没有这个，广谱日志根本读不了：bridge 轮询**本身就在查 message_0.db 的 Msg_ 表**
    //       （`SELECT name FROM sqlite_master ... LIKE 'Msg_%'`、
    //        `SELECT MAX(local_id) FROM Msg_xxx`、`SELECT ... FROM Msg_xxx ORDER BY local_id`），
    //       所以"看到 SELECT ... Msg_"极可能是我方流量，不能当成"微信在读消息表"。
    //    ② 广谱特征：前 40 条互不相同的语句（不管类型），带来源 + 入口名 + 目标表。
    //    ③ 补齐其它 SQL 入口：prepare16_v2 / prepare_v3 / prepare16_v3 / exec
    //       —— 全部来自同一张 g_api 表（sqlite3.h:164/336/338/146），同一套 MinHook 手法。
    //       exec 内部会调 prepare_v2（SQLite legacy.c），所以 exec 与 prepare 会各记一行，属正常。
    //
    //  约束不变：不拦截、不改 rc/出参/控制流、不阻塞。
    //  未命中路径的成本：一次 _ReturnAddress + 一次计数器自增 + O(1) 首词读取。
    // ══════════════════════════════════════════════════════════════════
    namespace probe {

        enum class Kw { Other, Insert, Update, Delete, Replace };

        // 日志出口：OutputDebugStringA + 追加到 <Weixin.exe 所在目录>\hook-probe.log
        inline void sink(const std::string& line) {
            OutputDebugStringA(line.c_str());
            static std::mutex logMtx;
            static HANDLE hLog = INVALID_HANDLE_VALUE;
            static bool logTried = false;      // 开不了就只试一次，别每次重试
            std::lock_guard<std::mutex> lg(logMtx);
            if (hLog == INVALID_HANDLE_VALUE) {
                if (logTried) return;
                logTried = true;
                std::string path = "D:\\wxhook\\hook-probe.log";
                char exe[MAX_PATH] = { 0 };
                if (GetModuleFileNameA(nullptr, exe, MAX_PATH) > 0) {
                    std::string s(exe);
                    auto p = s.find_last_of("\\/");
                    if (p != std::string::npos) path = s.substr(0, p + 1) + "hook-probe.log";
                }
                hLog = CreateFileA(path.c_str(), FILE_APPEND_DATA,
                                   FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                                   OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
                if (hLog == INVALID_HANDLE_VALUE) return;
                DWORD w = 0;
                std::string hdr = "[probe] ---- session ---- log file = " + path + "\r\n";
                WriteFile(hLog, hdr.data(), (DWORD)hdr.size(), &w, nullptr);
            }
            DWORD w = 0;
            WriteFile(hLog, line.data(), (DWORD)line.size(), &w, nullptr);
        }

        inline std::string stamp() {
            SYSTEMTIME st;
            GetLocalTime(&st);
            char b[64];
            _snprintf_s(b, sizeof(b), _TRUNCATE, "%02d:%02d:%02d.%03d",
                        st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
            return std::string(b);
        }

        inline std::string clip(const char* s, int len, size_t cap) {
            if (s == nullptr) return "<null>";
            std::string t(s, len < 0 ? strlen(s) : (size_t)len);
            if (t.size() > cap) {
                t.resize(cap);
                t += "...<truncated>";
            }
            return t;
        }

        // ── 调用来源识别 ────────────────────────────────────────────────
        // 我们自己的模块范围 / Weixin.dll 范围，在 arm() 里一次性算好，
        // 热路径上只读这几个全局（无锁、无 API 调用）。
        uint64_t g_selfBase = 0, g_selfEnd = 0, g_wxBase = 0, g_wxEnd = 0;

        inline uint64_t peImageSize(uint64_t base) {
            if (base == 0 || IsBadReadPtr((LPVOID)base, sizeof(IMAGE_DOS_HEADER))) return 0;
            auto dos = (IMAGE_DOS_HEADER*)base;
            if (dos->e_magic != IMAGE_DOS_SIGNATURE) return 0;
            uint64_t ntAddr = base + (uint64_t)dos->e_lfanew;
            if (IsBadReadPtr((LPVOID)ntAddr, sizeof(IMAGE_NT_HEADERS))) return 0;
            auto nt = (IMAGE_NT_HEADERS*)ntAddr;
            if (nt->Signature != IMAGE_NT_SIGNATURE) return 0;
            return (uint64_t)nt->OptionalHeader.SizeOfImage;
        }

        // caller = detour 入口处的 _ReturnAddress()（MinHook 用 jmp 进入 detour，
        // 所以栈上的返回地址就是"原来那个调用者"）。off：self/wx 时是模块内偏移。
        inline const char* callerClass(void* caller, uint64_t& off) {
            uint64_t a = (uint64_t)caller;
            if (g_selfEnd > g_selfBase && a >= g_selfBase && a < g_selfEnd) { off = a - g_selfBase; return "self"; }
            if (g_wxEnd > g_wxBase && a >= g_wxBase && a < g_wxEnd) { off = a - g_wxBase; return "wx"; }
            off = a;
            return "other";
        }

        std::atomic<long long> g_cSelf{ 0 }, g_cWx{ 0 }, g_cOther{ 0 }, g_cTotal{ 0 };

        // step 探针用的"最近见过的 stmt 指针"环形缓存（无锁、无分配）。
        // step 是最热的函数，命中时只有一次 load + 比较，绝不做哈希/加锁/分配。
        const size_t kStmtRing = 4096;
        std::atomic<void*> g_stmtRing[kStmtRing];
        inline bool stmtSeen(void* stmt) {
            size_t idx = (((size_t)stmt) >> 4) % kStmtRing;
            void* cur = g_stmtRing[idx].load(std::memory_order_relaxed);
            if (cur == stmt) return true;
            g_stmtRing[idx].store(stmt, std::memory_order_relaxed);
            return false;
        }

        // 里程碑计数：每类第 1 次必记，另外 10/100/1000/... 各记一次；
        // 再每 1000 次总调用打一行心跳。日志量有界，但"wx 到底有没有涨"绝不会漏。
        inline void countCaller(const char* cls) {
            long long n;
            if (cls[0] == 's')      n = ++g_cSelf;
            else if (cls[0] == 'w') n = ++g_cWx;
            else                    n = ++g_cOther;
            long long total = ++g_cTotal;
            bool milestone = (n == 1 || n == 10 || n == 100 || n == 1000 || n == 10000 || n == 100000);
            bool heartbeat = (total % 1000 == 0);
            if (milestone || heartbeat) {
                char b[288];
                _snprintf_s(b, sizeof(b), _TRUNCATE,
                            "[PROBE-SUM] %s 累计 SQL 入口调用 self=%lld wx=%lld other=%lld（%s 第 %lld 次%s）\r\n",
                            stamp().c_str(), g_cSelf.load(), g_cWx.load(), g_cOther.load(), cls, n,
                            milestone ? "" : "，心跳");
                sink(b);
            }
        }

        // ── 极简 SQL 词法（只用来做"语句特征"，不做完整解析）──────────
        inline bool identCh(char c) {
            return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                   (c >= '0' && c <= '9') || c == '_' || c == '$';
        }
        inline std::string upperOf(std::string s) {
            for (auto& c : s) if (c >= 'a' && c <= 'z') c = (char)(c - 32);
            return s;
        }
        // 读 i 处的标识符（支持 "t" [t] `t`；allowSQuote=true 时也认 't'）；i 前进；读不到返回空且 i 不动
        // allowSQuote 只给 INSERT 解析用：SQLite 允许把 'main' 当标识符写，
        // 但 'xxx' 在普通表达式里是字符串字面量，全局放开会让 SELECT 的表名解析跑偏。
        inline std::string readIdent(const char* sql, int limit, int& i, bool allowSQuote = false) {
            while (i < limit && (sql[i] == ' ' || sql[i] == '\t' || sql[i] == '\r' || sql[i] == '\n')) ++i;
            if (i >= limit) return "";
            char c = sql[i];
            if (c == '"' || c == '[' || c == '`' || (allowSQuote && c == '\'')) {
                char close = (c == '[') ? ']' : c;
                ++i;
                size_t st = (size_t)i;
                while (i < limit && sql[i] != close) ++i;
                std::string r(sql + st, (size_t)i - st);
                if (i < limit) ++i;
                return r;
            }
            size_t st = (size_t)i;
            while (i < limit && identCh(sql[i])) ++i;
            return std::string(sql + st, (size_t)i - st);
        }
        // 找关键字（词边界、大小写不敏感）后面那个标识符
        inline std::string findAfterKeyword(const char* sql, int limit, const char* kw) {
            size_t klen = strlen(kw);
            for (int i = 0; i + (int)klen <= limit; ++i) {
                bool ok = true;
                for (size_t k = 0; k < klen; ++k) {
                    char a = sql[i + k];
                    if (a >= 'a' && a <= 'z') a = (char)(a - 32);
                    if (a != kw[k]) { ok = false; break; }
                }
                if (!ok) continue;
                if (i > 0 && identCh(sql[i - 1])) continue;
                int j = i + (int)klen;
                if (j < limit && identCh(sql[j])) continue;
                return readIdent(sql, limit, j);
            }
            return "";
        }

        // 解析 INSERT/REPLACE 的形状：目标表 + 列清单。
        // 这是修好 `INSERT INTO 'main'.'Msg_x' (a,b) VALUES(?,?)` 的关键
        // （旧解析只认双引号，且不剥 '库名.' 前缀 → 日志里 table=-，Msg_ 写入被漏判）。
        inline void parseInsert(const char* sql, int limit, std::string& table,
                                std::vector<std::string>& cols) {
            int i = 0;
            (void)readIdent(sql, limit, i, true);                       // INSERT / REPLACE
            std::string w = upperOf(readIdent(sql, limit, i, true));
            if (w == "OR") {                                            // INSERT OR REPLACE / OR IGNORE
                (void)readIdent(sql, limit, i, true);
                w = upperOf(readIdent(sql, limit, i, true));
            }
            if (w != "INTO") return;                                    // 形状不认识，交给调用方兜底
            table = readIdent(sql, limit, i, true);
            // '库名'.'表名' → 取表名
            while (i < limit && (sql[i] == ' ' || sql[i] == '\t' || sql[i] == '\r' || sql[i] == '\n')) ++i;
            if (i < limit && sql[i] == '.') {
                ++i;
                table = readIdent(sql, limit, i, true);
            }
            // 列清单 (a, b, c)：有就解析，没有（INSERT INTO t VALUES(...)）留空给调用方查 PRAGMA
            while (i < limit && (sql[i] == ' ' || sql[i] == '\t' || sql[i] == '\r' || sql[i] == '\n')) ++i;
            if (i < limit && sql[i] == '(') {
                ++i;
                for (int guard = 0; guard < 256; ++guard) {
                    std::string name = readIdent(sql, limit, i, true);
                    if (!name.empty()) cols.push_back(name);
                    while (i < limit && (sql[i] == ' ' || sql[i] == '\t')) ++i;
                    if (i < limit && sql[i] == ',') { ++i; continue; }
                    break;
                }
            }
        }


        // 从写语句里取出目标表名（不做完整 SQL 解析，够用即可；取不到返回空串）。
        // 认 INSERT [OR ...] INTO t / REPLACE INTO t / UPDATE t / DELETE FROM t，
        // 支持 "库名.表名"（取表名）、"t"/[t]/`t` 三种引号。
        // 注：INSERT/REPLACE 现在走上面的 parseInsert（它还会给列清单），这里主要给 UPDATE/DELETE 用。
        inline std::string targetTable(const char* sql, int n, Kw kw) {
            if (sql == nullptr) return "";
            int limit = (n < 0) ? 512 : (n < 512 ? n : 512);
            int i = 0;
            auto isWs = [&](int k) {
                return k < limit && (sql[k] == ' ' || sql[k] == '\t' || sql[k] == '\r' || sql[k] == '\n');
            };
            auto skipWs = [&]() { while (isWs(i)) ++i; };
            auto isIdent = [&](char c) {
                return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                       (c >= '0' && c <= '9') || c == '_' || c == '$';
            };
            auto word = [&]() -> std::string {
                size_t s = (size_t)i;
                while (i < limit && isIdent(sql[i])) ++i;
                return std::string(sql + s, (size_t)i - s);
            };
            auto ident = [&]() -> std::string {
                skipWs();
                if (i >= limit) return "";
                char c = sql[i];
                // 单引号也要认：SQLite 允许把 'main' 当标识符写，
                // 实测微信全是 `INSERT/DELETE FROM 'main'.'xxx'` 这种形状（不认就 table=-）。
                // 这里是在"已知位置"读标识符（不是搜索），所以不会被字符串字面量带偏。
                if (c == '"' || c == '[' || c == '`' || c == '\'') {
                    char close = (c == '[') ? ']' : c;
                    ++i;
                    size_t s = (size_t)i;
                    while (i < limit && sql[i] != close) ++i;
                    std::string r(sql + s, (size_t)i - s);
                    if (i < limit) ++i;
                    return r;
                }
                return word();
            };
            auto upper = [](std::string s) {
                for (auto& c : s) if (c >= 'a' && c <= 'z') c = (char)(c - 32);
                return s;
            };
            (void)word();
            if (kw == Kw::Update) {
                // UPDATE [OR <conflict-algo>] <表名> SET ...
                // 旧实现这里用 word() 读掉了表名却丢掉，结果表名变成后面的 SET（实测 UPDATE Msg_x → table=SET）。
                // 改成：只在确实是 "OR" 时消费，否则回退，让下面的 ident() 去读表名（它认引号与库名前缀）。
                // 注意 word() 不跳空白，连续读两个词之间必须显式 skipWs()。
                int save = i;
                skipWs();
                if (upper(word()) == "OR") {
                    skipWs();
                    (void)word();                       // 消费冲突算法
                } else {
                    i = save;                           // 不是 OR → 回退
                }
            } else {
                skipWs();
                std::string w = upper(word());
                if (w == "OR") { skipWs(); (void)word(); skipWs(); w = upper(word()); }
                if (w != "INTO" && w != "FROM") return "";     // 形状不认识，放弃
            }
            std::string t = ident();
            skipWs();
            if (i < limit && sql[i] == '.') { ++i; t = ident(); }   // 库名.表名 → 取表名
            return t;
        }

        inline bool isMsgTable(const std::string& t) {
            if (t.size() < 4) return false;
            return (t[0] == 'M' || t[0] == 'm') && (t[1] == 'S' || t[1] == 's') &&
                   (t[2] == 'G' || t[2] == 'g') && t[3] == '_';
        }

        // 目标库名：直接从注册表读（零 API 调用、绝不主动去查库）
        inline std::string dbName(sqlite3* db) {
            if (db == nullptr) return "null-db";
            Entry e;
            if (entryByHandle((void*)db, e) && !e.name.empty()) return e.name;
            return "unknown";
        }

        inline size_t countParams(const char* sql, int n) {
            if (sql == nullptr) return 0;
            size_t limit = (n < 0) ? strlen(sql) : (size_t)n;
            size_t c = 0;
            for (size_t k = 0; k < limit; ++k) if (sql[k] == '?') ++c;
            return c;
        }

        // 语句特征：首个关键字 + 第二个关键字 + 尽力解析出的目标表（+ INSERT 的列清单）
        struct Sig { std::string kw1, kw2, table; std::vector<std::string> cols; };

        inline Sig makeSig(const char* sql, int n) {
            Sig g;
            if (sql == nullptr) return g;
            int limit = (n < 0) ? (int)strlen(sql) : n;
            if (limit > 512) limit = 512;      // 只看前 512 字节，代价有界
            if (limit <= 0) return g;
            int i = 0;
            g.kw1 = upperOf(readIdent(sql, limit, i));
            g.kw2 = upperOf(readIdent(sql, limit, i));
            const std::string& k1 = g.kw1;
            if (k1 == "INSERT" || k1 == "REPLACE") {
                // 走 parseInsert：它同时给出目标表 + 列清单，并正确处理
                // `INSERT INTO 'main'.'Msg_x' (a,b) VALUES(?,?)` 这种带引号/带库名前缀的形状
                parseInsert(sql, limit, g.table, g.cols);
                if (g.table.empty()) {                     // 形状不认识 → 退回老解析
                    g.table = targetTable(sql, limit, (k1 == "INSERT") ? Kw::Insert : Kw::Replace);
                }
            } else if (k1 == "UPDATE" || k1 == "DELETE") {
                Kw kw = (k1 == "UPDATE") ? Kw::Update : Kw::Delete;
                g.table = targetTable(sql, limit, kw);
            } else if (k1 == "SELECT" || k1 == "WITH" || k1 == "EXPLAIN") {
                g.table = findAfterKeyword(sql, limit, "FROM");
            } else if (k1 == "PRAGMA") {
                g.table = g.kw2;                          // PRAGMA database_list / table_info
            } else if (k1 == "CREATE" || k1 == "DROP" || k1 == "ALTER") {
                g.table = findAfterKeyword(sql, limit, "TABLE");
                if (g.table.empty()) g.table = findAfterKeyword(sql, limit, "INDEX");
                if (g.table.empty()) g.table = findAfterKeyword(sql, limit, "VIEW");
                if (upperOf(g.table) == "IF") g.table = findAfterKeyword(sql, limit, "EXISTS");
            }
            auto dot = g.table.find('.');
            if (dot != std::string::npos) g.table = g.table.substr(dot + 1);   // 库名.表名 → 表名
            return g;
        }

        // ── 第三轮：把"消息写库"的语句标进 msgpush ──────────────────────
        //  判定：INSERT/REPLACE + 表名像消息表 + 目标库属于 message 家族（拿不到库名就放宽）。
        //  标记本身不做任何拦截：只是让 bind/step 知道"这条要抓"。
        inline void logCappedProbe(std::atomic<long long>& c, int cap, const std::string& line) {
            long long v = ++c;
            if (v <= cap) sink(line);
            else if (v == cap + 1) sink("[probe] 该类日志已达上限 " + std::to_string(cap) + " 条\r\n");
        }

        inline std::string lowerOf(std::string s) {
            for (auto& c : s) if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
            return s;
        }

        // 库名属于 message 家族？拿不到（unknown/空）时放宽为 true —— 任务书要求"拿不到就按 SQL 判断"
        inline bool isMessageDbName(const std::string& db) {
            if (db.empty() || db == "unknown" || db == "null-db") return true;
            return lowerOf(db).find("message") != std::string::npos;
        }

        // 表名像消息表？Msg_* 一定要；另外 message/msg 家族的表也算（例如 message_fts_v4_0_content）
        inline bool isMsgWriteTable(const std::string& t) {
            if (t.empty()) return false;
            if (isMsgTable(t)) return true;
            std::string l = lowerOf(t);
            return l.find("msg") != std::string::npos || l.find("message") != std::string::npos;
        }

        inline std::string quoteIdentSql(const std::string& name) {
            std::string o = "\"";
            for (size_t i = 0; i < name.size(); ++i) {
                if (name[i] == '"') o += "\"\"";
                else o += name[i];
            }
            o += "\"";
            return o;
        }

        // INSERT 没写列清单时（INSERT INTO t VALUES(?,?)）用 PRAGMA table_info 拿列序，按表缓存
        inline std::vector<std::string> tableColumns(sqlite3* db, const std::string& table) {
            static std::mutex m;
            static std::map<std::string, std::vector<std::string>> cache;
            {
                std::lock_guard<std::mutex> lg(m);
                auto it = cache.find(table);
                if (it != cache.end()) return it->second;
            }
            std::vector<std::string> cols;
            if (g_api != nullptr && g_api->prepare != nullptr && g_api->step != nullptr &&
                g_api->finalize != nullptr && db != nullptr && !table.empty()) {
                std::string sql = "PRAGMA table_info(" + quoteIdentSql(table) + ")";
                sqlite3_stmt* st = nullptr;
                if (g_api->prepare(db, sql.c_str(), -1, &st, nullptr) == SQLITE_OK && st != nullptr) {
                    int guard = 0;
                    while (g_api->step(st) == SQLITE_ROW && guard++ < 256) {
                        // PRAGMA table_info 的列序：cid, name, type, notnull, dflt_value, pk
                        const unsigned char* nm = (g_api->column_text != nullptr)
                                                ? g_api->column_text(st, 1) : nullptr;
                        cols.push_back(nm != nullptr ? std::string((const char*)nm) : std::string());
                    }
                    g_api->finalize(st);
                }
            }
            {
                std::lock_guard<std::mutex> lg(m);
                cache[table] = cols;
            }
            return cols;
        }

        // 防重入：maybeMark → tableColumns → api->prepare → detourPrepare → maybeMark。
        // （PRAGMA 本来就不命中标记条件，不会递归；这道锁只是保险。）
        inline bool& inMark() { static thread_local bool v = false; return v; }
        struct MarkGuard {
            bool held;
            MarkGuard() : held(false) { if (!inMark()) { inMark() = true; held = true; } }
            ~MarkGuard() { if (held) inMark() = false; }
        };

        inline bool maybeMark(sqlite3* db, const char* sql, int n, int rc, sqlite3_stmt** stmt) {
            if (rc != SQLITE_OK || stmt == nullptr || *stmt == nullptr || sql == nullptr) return false;
            MarkGuard guard;
            if (!guard.held) return false;

            Sig g = makeSig(sql, n);
            if (g.kw1 != "INSERT" && g.kw1 != "REPLACE") return false;
            if (!isMsgWriteTable(g.table)) return false;

            std::string dbn = dbName(db);
            if (!isMessageDbName(dbn)) {
                static std::atomic<long long> cSkip{ 0 };
                logCappedProbe(cSkip, 20, "[PUSH-CHK-SKIP] " + stamp() + " db=" + dbn + " table=" + g.table
                               + " 不是 message 家族库，跳过标记\r\n");
                return false;
            }

            std::vector<std::string> cols = g.cols;             // 优先用 SQL 里的列清单
            if (cols.empty()) cols = tableColumns(db, g.table); // 没有就查 PRAGMA（按表缓存）

            bool pushable = isMsgTable(g.table);                // 只有 Msg_* 才是要推给桥的"消息行"

            static std::atomic<long long> cChk{ 0 };
            std::string colNames;
            for (size_t k = 0; k < cols.size(); ++k) {
                if (k) colNames += ",";
                colNames += cols[k];
            }
            logCappedProbe(cChk, 40, "[PUSH-CHK] " + stamp() + " db=" + dbn + " table=" + g.table
                           + " kw=" + g.kw1 + " cols=" + std::to_string(cols.size())
                           + " cols=[" + colNames + "] push=" + (pushable ? "yes" : "no") + "\r\n");

            msgpush::mark(*stmt, dbn, g.table, cols, pushable);
            return true;
        }

        // 兜底：WCDB 会把 prepare 好的语句**缓存复用**。如果那条 INSERT 是在我们挂钩之前
        // 就 prepare 好的，标记那一步永远轮不到它 —— 但它的 step 一定会撞上我们。
        // 这里用 api->sql(stmt) 反查 SQL 补上标记：本条已经没有值了，**下一条起就能抓到**。
        // 没有这道兜底，"挂钩前已缓存的写语句"会让第三轮一条都抓不到（第一轮就栽在这个坑）。
        inline void lateMarkFromStmt(sqlite3_stmt* stmt) {
            if (g_api == nullptr || g_api->sql == nullptr || stmt == nullptr) return;
            const char* sql = g_api->sql(stmt);
            if (sql == nullptr || *sql == '\0') return;
            int k = 0;                                  // 廉价预筛：只有 INSERT/REPLACE 才值得解析
            while (sql[k] == ' ' || sql[k] == '\t' || sql[k] == '\r' || sql[k] == '\n') ++k;
            char c = sql[k];
            if (c != 'I' && c != 'i' && c != 'R' && c != 'r') return;
            sqlite3* db = (g_api->db_handle != nullptr) ? (sqlite3*)g_api->db_handle(stmt) : nullptr;
            if (maybeMark(db, sql, -1, SQLITE_OK, &stmt)) {
                static std::atomic<long long> cLate{ 0 };
                logCappedProbe(cLate, 20, "[PUSH-LATE] " + stamp()
                               + " 该语句在挂钩前就已 prepare，本次补上标记（本条无值，下一条起有值）\r\n");
            }
        }

        // ── 第三轮改造：**通知式**判定（不依赖标记 / 不依赖 bind 值）──────────
        // 为什么单独写一个：Msg_ 的 INSERT 是挂钩前就 prepare 好的**缓存语句**，
        // maybeMark() 那套标记只能在 step 时事后补、而且保持不住 → bind 值永远抓不到（实测 PUSH-CAP=0）。
        // 这里在 step 成行时**直接按 SQL 判定**，命中就入队一条轻量通知（桥收到后立刻查一次库）。
        // 纯内存 + 短临界区：微信线程上零网络、零阻塞；失败只是"这次不通知"（桥还有轮询兜底）。
        inline void notifyIfMsgWrite(sqlite3_stmt* stmt) {
            if (g_api == nullptr || g_api->sql == nullptr || stmt == nullptr) return;
            const char* sql = g_api->sql(stmt);
            if (sql == nullptr || *sql == '\0') return;
            int k = 0;                                  // 廉价预筛：只有 INSERT/REPLACE 才值得解析
            while (sql[k] == ' ' || sql[k] == '\t' || sql[k] == '\r' || sql[k] == '\n') ++k;
            const char c = sql[k];
            if (c != 'I' && c != 'i' && c != 'R' && c != 'r') return;

            Sig g = makeSig(sql, -1);
            if (g.kw1 != "INSERT" && g.kw1 != "REPLACE") return;
            if (!isMsgTable(g.table)) return;           // 通知式只服务 Msg_*（消息行）
            sqlite3* db = (g_api->db_handle != nullptr) ? (sqlite3*)g_api->db_handle(stmt) : nullptr;
            const std::string dbn = dbName(db);
            if (!isMessageDbName(dbn)) return;
            msgpush::notifyWrite(dbn, g.table);
        }

        // UTF-16 的标记路径（prepare16_v2 / prepare16_v3）：先有界转 UTF-8，再走同一套判定
        inline void markFromSql16(sqlite3* db, const void* sql16, int n, int rc, sqlite3_stmt** stmt) {
            if (rc != SQLITE_OK || sql16 == nullptr || stmt == nullptr || *stmt == nullptr) return;
            int wchars;
            if (n < 0) {                                   // NUL 结尾：自己数但封顶（不做无界扫描）
                wchars = 0;
                while (wchars < 4096 && ((const wchar_t*)sql16)[wchars] != 0) ++wchars;
            } else {
                wchars = n / 2;                            // n 是 UTF-16 的字节数
            }
            if (wchars > 512) wchars = 512;
            if (wchars <= 0) return;
            char buf[2048] = { 0 };
            int got = WideCharToMultiByte(CP_UTF8, 0, (const wchar_t*)sql16, wchars, buf,
                                          (int)sizeof(buf) - 1, nullptr, nullptr);
            if (got <= 0) return;
            buf[got] = '\0';
            maybeMark(db, buf, got, rc, stmt);
        }

        // 所有 SQL 入口（prepare / prepare16_v2 / prepare_v3 / prepare16_v3 / exec）汇到这里。
        // 只读、只记日志；不改 rc / 出参 / 控制流。
        inline void onSql(sqlite3* db, const char* sql, int n, int rc, sqlite3_stmt** stmt,
                          const char* via, void* caller) {
            uint64_t off = 0;
            const char* cls = callerClass(caller, off);
            countCaller(cls);

            // ① 一次性存活证明：区分"没命中"和"钩子没挂上"
            static std::atomic<bool> firstCall{ true };
            if (firstCall.exchange(false)) {
                char b[256];
                _snprintf_s(b, sizeof(b), _TRUNCATE,
                            "[probe] %s 首个 SQL 入口被调用 via=%s from=%s+0x%llX sql=",
                            stamp().c_str(), via, cls, (unsigned long long)off);
                sink(std::string(b) + clip(sql, n, 160) + "\r\n");
            }

            Sig g = makeSig(sql, n);

            // ② 广谱：前 40 条互不相同的语句特征（来源不同算不同条）
            {
                static std::mutex seenMtx;
                static std::set<std::string> seen;
                bool fresh = false;
                {
                    std::lock_guard<std::mutex> lg(seenMtx);
                    std::string key = std::string(cls) + "|" + g.kw1 + "|" + g.kw2 + "|" + g.table;
                    if (seen.size() < 40 && seen.insert(key).second) fresh = true;
                }
                if (fresh) {
                    char b[320];
                    _snprintf_s(b, sizeof(b), _TRUNCATE,
                                "[PROBE-SIG] %s from=%s+0x%llX via=%s kw1=%s kw2=%s table=%s rc=%d db=%s sql=",
                                stamp().c_str(), cls, (unsigned long long)off, via,
                                g.kw1.c_str(), g.kw2.c_str(),
                                (g.table.empty() ? "-" : g.table.c_str()), rc, dbName(db).c_str());
                    sink(std::string(b) + clip(sql, n, 120) + "\r\n");
                }
            }

            // ③ 任何写语句都记（封顶 300 行）—— "写发生在这个实例上吗"的直接证据
            if (g.kw1 == "INSERT" || g.kw1 == "UPDATE" || g.kw1 == "DELETE" || g.kw1 == "REPLACE") {
                static std::atomic<long long> wcount{ 0 };
                long long wn = ++wcount;
                if (wn <= 300) {
                    char b[320];
                    _snprintf_s(b, sizeof(b), _TRUNCATE,
                                "[PROBE-WRITE#%lld] %s from=%s+0x%llX via=%s db=%s table=%s rc=%d sql=",
                                wn, stamp().c_str(), cls, (unsigned long long)off, via,
                                dbName(db).c_str(), (g.table.empty() ? "-" : g.table.c_str()), rc);
                    sink(std::string(b) + clip(sql, n, 400) + "\r\n");
                }
            }

            // ④ 第一轮那一类：INSERT + Msg_*（保留语义，封顶 500）
            if (g.kw1 == "INSERT" && isMsgTable(g.table)) {
                static std::atomic<long long> mcount{ 0 };
                long long mn = ++mcount;
                if (mn <= 500) {
                    char b[256];
                    _snprintf_s(b, sizeof(b), _TRUNCATE,
                                "[PROBE-MSG#%lld] %s from=%s+0x%llX via=%s db=%s table=%s rc=%d stmt=0x%p ph=%zu sql=",
                                mn, stamp().c_str(), cls, (unsigned long long)off, via,
                                dbName(db).c_str(), g.table.c_str(), rc,
                                (void*)((stmt && *stmt) ? *stmt : nullptr), countParams(sql, n));
                    sink(std::string(b) + clip(sql, n, 900) + "\r\n");
                }
            }
        }

        // UTF-16 入口（prepare16_v2 / prepare16_v3）：先转 UTF-8，再走同一套判定
        inline void onSql16(sqlite3* db, const void* sql16, int n, int rc, sqlite3_stmt** stmt,
                            const char* via, void* caller) {
            if (sql16 == nullptr) { onSql(db, nullptr, -1, rc, stmt, via, caller); return; }
            int wchars;
            if (n < 0) {                                   // NUL 结尾：自己数，但封顶（不做无界扫描）
                wchars = 0;
                while (wchars < 4096 && ((const wchar_t*)sql16)[wchars] != 0) ++wchars;
            } else {
                wchars = n / 2;                            // n 是 UTF-16 的字节数
            }
            if (wchars > 512) wchars = 512;                // 只转前 512 个宽字符
            if (wchars <= 0) { onSql(db, "", 0, rc, stmt, via, caller); return; }
            char buf[2048] = { 0 };
            int got = WideCharToMultiByte(CP_UTF8, 0, (const wchar_t*)sql16, wchars,
                                          buf, (int)sizeof(buf) - 1, nullptr, nullptr);
            if (got < 0) got = 0;
            buf[got] = '\0';
            onSql(db, buf, got, rc, stmt, via, caller);
        }

        // prepare（sqlite3_prepare_v2）入口
        inline void onPrepare(sqlite3* db, const char* sql, int n, int rc, sqlite3_stmt** stmt, void* caller) {
            onSql(db, sql, n, rc, stmt, "prepare", caller);
        }

        // open_v2 探针：这个 sqlite 实例打开过哪些库（封顶 100 行）
        inline void onOpen(const char* filename, int rc, void* db) {
            if (filename == nullptr || *filename == '\0') return;
            static std::atomic<long long> n{ 0 };
            long long k = ++n;
            if (k > 100) return;
            std::string p(filename);
            auto pos = p.find_last_of("\\/");
            std::string base = (pos == std::string::npos) ? p : p.substr(pos + 1);
            char b[256];
            _snprintf_s(b, sizeof(b), _TRUNCATE, "[PROBE-OPEN#%lld] %s rc=%d handle=0x%p file=%s\r\n",
                        k, stamp().c_str(), rc, db, base.c_str());
            sink(b);
        }

        // 安装时喊一声：把来源识别范围算好（热路径上只读全局，无锁无 API 调用）
        // ── step 探针（对付"语句被缓存"这个坑）──────────────────────────
        // 为什么要它：WCDB 会把 prepare 好的语句**缓存起来反复用**
        // （SQLITE_PREPARE_PERSISTENT）。如果那条 INSERT 是在我们挂钩之前就 prepare 好的，
        // 那么无论我们挂多少个 prepare 入口都永远看不到它 —— 但它的 step 一定会被我们撞上。
        // 所以这里用 api->sql(stmt) 反查"正在执行的语句"的 SQL 原文：
        // 与 prepare 时机无关，是"写库到底在不在这台 sqlite 上"最直接的证据。
        // 调用方来源（self/wx）同时给出 Weixin.dll 里的调用点 RVA —— 万一路线 B 要逆向，这就是入口。
        inline void onStep(sqlite3_stmt* stmt, int rc, void* caller) {
            if (g_api == nullptr || g_api->sql == nullptr || stmt == nullptr) return;
            const char* sql = g_api->sql(stmt);
            if (sql == nullptr || *sql == '\0') return;
            uint64_t off = 0;
            const char* cls = callerClass(caller, off);
            Sig g = makeSig(sql, -1);
            // 去重：同一 (来源,语句特征) 只记一次（封顶 60）
            static std::mutex m;
            static std::set<std::string> seen;
            bool fresh = false;
            {
                std::lock_guard<std::mutex> lg(m);
                std::string key = std::string(cls) + "|" + g.kw1 + "|" + g.kw2 + "|" + g.table;
                if (seen.size() < 60 && seen.insert(key).second) fresh = true;
            }
            if (!fresh) return;
            bool isWrite = (g.kw1 == "INSERT" || g.kw1 == "UPDATE" ||
                            g.kw1 == "DELETE" || g.kw1 == "REPLACE");
            const char* tag = (g.kw1 == "INSERT" && isMsgTable(g.table))
                            ? "-MSG" : (isWrite ? "-W" : "");
            sqlite3* db = (g_api->db_handle != nullptr) ? (sqlite3*)g_api->db_handle(stmt) : nullptr;
            char b[352];
            _snprintf_s(b, sizeof(b), _TRUNCATE,
                        "[PROBE-STEP%s] %s from=%s+0x%llX kw1=%s kw2=%s table=%s rc=%d stmt=0x%p db=%s sql=",
                        tag, stamp().c_str(), cls, (unsigned long long)off,
                        g.kw1.c_str(), g.kw2.c_str(), (g.table.empty() ? "-" : g.table.c_str()),
                        rc, (void*)stmt, dbName(db).c_str());
            sink(std::string(b) + clip(sql, -1, 300) + "\r\n");
        }

        inline void arm() {
            if (g_hModule) {
                g_selfBase = (uint64_t)g_hModule;
                g_selfEnd = g_selfBase + peImageSize(g_selfBase);
            }
            if (g_hWeixinDll) {
                g_wxBase = (uint64_t)g_hWeixinDll;
                g_wxEnd = g_wxBase + peImageSize(g_wxBase);
            }
            char b[320];
            _snprintf_s(b, sizeof(b), _TRUNCATE,
                        "[probe] %s 来源识别就绪 self=[0x%llX,0x%llX) wx=[0x%llX,0x%llX)\r\n",
                        stamp().c_str(),
                        (unsigned long long)g_selfBase, (unsigned long long)g_selfEnd,
                        (unsigned long long)g_wxBase, (unsigned long long)g_wxEnd);
            sink(b);
            sink("[probe] " + stamp() + " SQL 入口探针已就绪（只记日志）\r\n");
            // 第三轮：把消息抓取+推送模块装上（它自己起一条工作线程；微信线程不碰网络）
            msgpush::arm(&sink);
        }
    }

    // ── 第二轮补挂的 SQL 入口（都在同一张 sqlite3_api_routines 表里）──────
    //   prepare16    == sqlite3_prepare16_v2  (sqlite3.h:164)
    //   prepare_v3   == sqlite3_prepare_v3    (sqlite3.h:336)
    //   prepare16_v3 == sqlite3_prepare16_v3  (sqlite3.h:338)
    //   exec         == sqlite3_exec          (sqlite3.h:146)
    // 全部用 MinHook 挂"函数代码地址"（与 prepare / open_v2 同一套已验证生效的手法）。
    typedef int (*prepare16_t)(sqlite3*, const void*, int, sqlite3_stmt**, const void**);
    prepare16_t g_origPrepare16 = nullptr;

    typedef int (*prepare_v3_t)(sqlite3*, const char*, int, unsigned int, sqlite3_stmt**, const char**);
    prepare_v3_t g_origPrepareV3 = nullptr;

    typedef int (*prepare16_v3_t)(sqlite3*, const void*, int, unsigned int, sqlite3_stmt**, const void**);
    prepare16_v3_t g_origPrepare16V3 = nullptr;

    typedef int (*exec_t)(sqlite3*, const char*, sqlite3_callback, void*, char**);
    exec_t g_origExec = nullptr;

    // step == sqlite3_step (sqlite3.h:186)。最热，但也是唯一能戳穿"语句被缓存"的入口。
    typedef int (*step_t)(sqlite3_stmt*);
    step_t g_origStep = nullptr;

    int detourStep(sqlite3_stmt* stmt) {
        int rc = g_origStep ? g_origStep(stmt) : 1;
        // 推送通道（第三轮）：**只在开关打开时**才做任何事。
        // 默认是关的（hook-push.on 不存在）→ 这里只剩一次 relaxed 原子读，
        // 不做 SQL 解析、不查表、不加锁、不打日志。
        if (rc == SQLITE_DONE && stmt != nullptr && msgpush::enabled()) {
            // ① 通知式（主路）：不依赖标记/绑定值，直接按 SQL 判定"这条是往 Msg_ 表写"，
            //    命中就入队一条轻量通知，桥收到后立刻针对该群查一次库。
            probe::notifyIfMsgWrite(stmt);
            // ② 旧的值抓取路径保留（清标记，避免标记表泄漏）
            if (!msgpush::rowDone(stmt)) probe::lateMarkFromStmt(stmt);
        }
        return rc;
    }

    // ── 第三轮：bind 家族 + finalize（都在同一张 g_api 表里）────────────
    //   bind_blob/text 的二进制在 bind 那一刻就转 hex 拷走（调用方可能用 SQLITE_STATIC，
    //   之后再改/释放那块内存），所以出参、rc、控制流一律原样。
    typedef int (*bind_blob_t)(sqlite3_stmt*, int, const void*, int, void(*)(void*));
    bind_blob_t g_origBindBlob = nullptr;
    typedef int (*bind_blob64_t)(sqlite3_stmt*, int, const void*, sqlite3_uint64, void(*)(void*));
    bind_blob64_t g_origBindBlob64 = nullptr;
    typedef int (*bind_text_t)(sqlite3_stmt*, int, const char*, int, void(*)(void*));
    bind_text_t g_origBindText = nullptr;
    typedef int (*bind_text64_t)(sqlite3_stmt*, int, const char*, sqlite3_uint64, void(*)(void*), unsigned char);
    bind_text64_t g_origBindText64 = nullptr;
    typedef int (*bind_int_t)(sqlite3_stmt*, int, int);
    bind_int_t g_origBindInt = nullptr;
    typedef int (*bind_int64_t)(sqlite3_stmt*, int, sqlite_int64);
    bind_int64_t g_origBindInt64 = nullptr;
    typedef int (*bind_double_t)(sqlite3_stmt*, int, double);
    bind_double_t g_origBindDouble = nullptr;
    typedef int (*bind_null_t)(sqlite3_stmt*, int);
    bind_null_t g_origBindNull = nullptr;
    typedef int (*bind_value_t)(sqlite3_stmt*, int, const sqlite3_value*);
    bind_value_t g_origBindValue = nullptr;
    typedef int (*finalize_t)(sqlite3_stmt*);
    finalize_t g_origFinalize = nullptr;

    int detourBindBlob(sqlite3_stmt* s, int i, const void* p, int n, void(*d)(void*)) {
        int rc = g_origBindBlob ? g_origBindBlob(s, i, p, n, d) : 1;
        if (rc == SQLITE_OK) msgpush::bindValue(s, i, SQLITE_BLOB, p, n, 0, 0.0);
        return rc;
    }
    int detourBindBlob64(sqlite3_stmt* s, int i, const void* p, sqlite3_uint64 n, void(*d)(void*)) {
        int rc = g_origBindBlob64 ? g_origBindBlob64(s, i, p, n, d) : 1;
        if (rc == SQLITE_OK) msgpush::bindValue(s, i, SQLITE_BLOB, p,
                                                (n > 0x7FFFFFFFull) ? 0x7FFFFFFF : (int)n, 0, 0.0);
        return rc;
    }
    int detourBindText(sqlite3_stmt* s, int i, const char* p, int n, void(*d)(void*)) {
        int rc = g_origBindText ? g_origBindText(s, i, p, n, d) : 1;
        if (rc == SQLITE_OK) msgpush::bindValue(s, i, SQLITE_TEXT, p, n, 0, 0.0);
        return rc;
    }
    int detourBindText64(sqlite3_stmt* s, int i, const char* p, sqlite3_uint64 n,
                         void(*d)(void*), unsigned char enc) {
        int rc = g_origBindText64 ? g_origBindText64(s, i, p, n, d, enc) : 1;
        if (rc == SQLITE_OK) msgpush::bindValue(s, i, SQLITE_TEXT, p,
                                                (n > 0x7FFFFFFFull) ? 0x7FFFFFFF : (int)n, 0, 0.0);
        return rc;
    }
    int detourBindInt(sqlite3_stmt* s, int i, int v) {
        int rc = g_origBindInt ? g_origBindInt(s, i, v) : 1;
        if (rc == SQLITE_OK) msgpush::bindValue(s, i, SQLITE_INTEGER, nullptr, 0, (long long)v, 0.0);
        return rc;
    }
    int detourBindInt64(sqlite3_stmt* s, int i, sqlite_int64 v) {
        int rc = g_origBindInt64 ? g_origBindInt64(s, i, v) : 1;
        if (rc == SQLITE_OK) msgpush::bindValue(s, i, SQLITE_INTEGER, nullptr, 0, (long long)v, 0.0);
        return rc;
    }
    int detourBindDouble(sqlite3_stmt* s, int i, double v) {
        int rc = g_origBindDouble ? g_origBindDouble(s, i, v) : 1;
        if (rc == SQLITE_OK) msgpush::bindValue(s, i, SQLITE_FLOAT, nullptr, 0, 0, v);
        return rc;
    }
    int detourBindNull(sqlite3_stmt* s, int i) {
        int rc = g_origBindNull ? g_origBindNull(s, i) : 1;
        if (rc == SQLITE_OK) msgpush::bindValue(s, i, SQLITE_NULL, nullptr, 0, 0, 0.0);
        return rc;
    }
    // bind_value：WCDB 一般不用，但挂上更保险（用同一张表的 value_* 取值）
    int detourBindValue(sqlite3_stmt* s, int i, const sqlite3_value* v) {
        int rc = g_origBindValue ? g_origBindValue(s, i, v) : 1;
        if (rc == SQLITE_OK && v != nullptr && g_api != nullptr && g_api->value_type != nullptr) {
            sqlite3_value* vv = (sqlite3_value*)v;
            int t = g_api->value_type(vv);
            if (t == SQLITE_INTEGER) {
                long long iv = (g_api->value_int64 != nullptr) ? (long long)g_api->value_int64(vv) : 0;
                msgpush::bindValue(s, i, SQLITE_INTEGER, nullptr, 0, iv, 0.0);
            } else if (t == SQLITE_FLOAT) {
                double dv = (g_api->value_double != nullptr) ? g_api->value_double(vv) : 0.0;
                msgpush::bindValue(s, i, SQLITE_FLOAT, nullptr, 0, 0, dv);
            } else if (t == SQLITE_TEXT) {
                const void* p = (g_api->value_text != nullptr) ? (const void*)g_api->value_text(vv) : nullptr;
                int nb = (g_api->value_bytes != nullptr) ? g_api->value_bytes(vv) : -1;
                msgpush::bindValue(s, i, SQLITE_TEXT, p, nb, 0, 0.0);
            } else if (t == SQLITE_BLOB) {
                const void* p = (g_api->value_blob != nullptr) ? g_api->value_blob(vv) : nullptr;
                int nb = (g_api->value_bytes != nullptr) ? g_api->value_bytes(vv) : 0;
                msgpush::bindValue(s, i, SQLITE_BLOB, p, nb, 0, 0.0);
            } else if (t == SQLITE_NULL) {
                msgpush::bindValue(s, i, SQLITE_NULL, nullptr, 0, 0, 0.0);
            }
        }
        return rc;
    }
    int detourFinalize(sqlite3_stmt* s) {
        int rc = g_origFinalize ? g_origFinalize(s) : 1;
        msgpush::finalizeStmt(s);
        return rc;
    }

    // ══════════════════════════════════════════════════════════════════
    //  ★★ 下面这一组 detour 就是"红线②"的落地处 ★★
    //  在 sqlite3_prepare 的 detour 里，除了 noteHot（记一条映射）之外**什么都不做**：
    //    · 不调任何 sqlite API（不再有 db_filename / SELECT 1 / errcode）
    //    · 不读微信的内存（除 detour 自己的入参 sql 指针；默认关的推送通道除外）
    //    · 不做 I/O、不打日志（连 OutputDebugString 都没有）
    //    · 不加锁：noteHot 是一次哈希 + 一次线性探测 + 一次 relaxed store
    //  推送通道（msgpush，默认关）是唯一例外：开关打开时才会解析 SQL 做标记，
    //  这里用一次 relaxed 原子读把它挡在门外。
    // ══════════════════════════════════════════════════════════════════
    int detourPrepare(sqlite3* db, const char* sql, int n, sqlite3_stmt** stmt, const char** tail) {
        if (g_WxVersion != 0) {   // 新版二分：只透传，不登记、不探针
            return g_origPrepare ? g_origPrepare(db, sql, n, stmt, tail) : 1;
        }
        // SEH 兜底：万一还有漏网的野指针，在这里变成 SQLITE_MISUSE 而不是崩掉客户端。
        // 注意 __try 里不能有带析构的 C++ 对象，所以只放一次函数调用。
        int rc = SQLITE_MISUSE;
        __try {
            rc = g_origPrepare ? g_origPrepare(db, sql, n, stmt, tail) : 1;
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            rc = SQLITE_MISUSE;           // 访问违例 → 当成句柄已失效，不往上抛
        }
        noteHot(db);                      // 唯一动作（O(1)、无锁、无 API）
        if (rc == SQLITE_OK && msgpush::enabled()) {
            probe::maybeMark(db, sql, n, rc, stmt);   // 仅在推送通道打开时执行
        }
        return rc;
    }

    int detourPrepare16(sqlite3* db, const void* sql, int n, sqlite3_stmt** stmt, const void** tail) {
        int rc = g_origPrepare16 ? g_origPrepare16(db, sql, n, stmt, tail) : 1;
        noteHot(db);
        if (rc == SQLITE_OK && msgpush::enabled()) probe::markFromSql16(db, sql, n, rc, stmt);
        return rc;
    }

    int detourPrepareV3(sqlite3* db, const char* sql, int n, unsigned int flags,
                        sqlite3_stmt** stmt, const char** tail) {
        int rc = g_origPrepareV3 ? g_origPrepareV3(db, sql, n, flags, stmt, tail) : 1;
        noteHot(db);
        if (rc == SQLITE_OK && msgpush::enabled()) {
            probe::maybeMark(db, sql, n, rc, stmt);          // 实测消息写库走这个入口
        }
        return rc;
    }

    int detourPrepare16V3(sqlite3* db, const void* sql, int n, unsigned int flags,
                          sqlite3_stmt** stmt, const void** tail) {
        int rc = g_origPrepare16V3 ? g_origPrepare16V3(db, sql, n, flags, stmt, tail) : 1;
        noteHot(db);
        if (rc == SQLITE_OK && msgpush::enabled()) probe::markFromSql16(db, sql, n, rc, stmt);
        return rc;
    }

    int detourExec(sqlite3* db, const char* sql, sqlite3_callback cb, void* arg, char** errmsg) {
        int rc = g_origExec ? g_origExec(db, sql, cb, arg, errmsg) : 1;
        noteHot(db);
        return rc;
    }

    // 挂一个"函数代码级"钩子。失败只记日志、返回 false —— 绝不抛、绝不影响既有行为。
    bool installOneHook(void* target, LPVOID detour, LPVOID* orig, const char* name) {
        if (target == nullptr) {
            OutputDebugStringA((std::string("[db_registry] ") + name + " 槽位为空（该 sqlite 版本没这个入口），跳过\n").c_str());
            return false;
        }
        if (MH_CreateHook(target, detour, orig) != MH_OK) {
            OutputDebugStringA((std::string("[db_registry] MH_CreateHook(") + name + ") 失败\n").c_str());
            return false;
        }
        if (MH_EnableHook(target) != MH_OK) {
            OutputDebugStringA((std::string("[db_registry] MH_EnableHook(") + name + ") 失败\n").c_str());
            return false;
        }
        OutputDebugStringA((std::string("[db_registry] ") + name + " 钩子已安装\n").c_str());
        return true;
    }

    void installPrepare(sqlite3_api_routines* api) {
        std::lock_guard<std::recursive_mutex> _ilk(g_installMtx);
        if (g_WxVersion != 0) return;   // 新版：不装 MinHook，改用 install() 改表
        if (g_installedPrepare || api == nullptr || api->prepare == nullptr) return;
        g_installedPrepare = true;
        g_api = api;
        MH_STATUS st = MH_Initialize();
        if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) { g_installedPrepare = false; return; }
        void* target = (void*)api->prepare;
        if (MH_CreateHook(target, (LPVOID)&detourPrepare, (LPVOID*)&g_origPrepare) != MH_OK) {
            OutputDebugStringA("[db_registry] MH_CreateHook(prepare) 失败\n");
            g_installedPrepare = false;
            return;
        }
        if (MH_EnableHook(target) != MH_OK) {
            OutputDebugStringA("[db_registry] MH_EnableHook(prepare) 失败\n");
            g_installedPrepare = false;
            return;
        }
        OutputDebugStringA("[db_registry] prepare 钩子已安装（句柄按真实查询记录）\n");

        // 新版（4.1.15+）只保留 prepare：其余探针（prepare16/bind*/exec/step/probe::arm）
        // 内部依赖旧版结构偏移，装到新版上会崩。DB 读所需的最小集 = prepare + open16。
        if (g_WxVersion != 0) return;

        // ── 第二轮：把其它 SQL 入口一次挂全 ──────────────────────────────
        // 第一轮实测"消息写库不经过 prepare"，所以把这张表上所有可能承载 SQL 的入口都挂上，
        // 一次部署就能看出写库到底走哪个（全部失败也不影响主路径，纯探针）。
        installOneHook((void*)api->prepare16,    (LPVOID)&detourPrepare16,   (LPVOID*)&g_origPrepare16,   "prepare16_v2");
        installOneHook((void*)api->prepare_v3,   (LPVOID)&detourPrepareV3,   (LPVOID*)&g_origPrepareV3,   "prepare_v3");
        installOneHook((void*)api->prepare16_v3, (LPVOID)&detourPrepare16V3, (LPVOID*)&g_origPrepare16V3, "prepare16_v3");
        installOneHook((void*)api->exec,         (LPVOID)&detourExec,        (LPVOID*)&g_origExec,        "exec");
        // step：唯一能抓到"挂钩之前就 prepare 好、之后反复复用"的写语句
        installOneHook((void*)api->step,         (LPVOID)&detourStep,        (LPVOID*)&g_origStep,        "step");

        // ── 第三轮：bind 家族 + finalize（抓值 / 成行 / 清标记）────────────
        // 只对"已标记的消息写语句"干活；未标记时 bind 路径只花一次原子读。
        installOneHook((void*)api->bind_blob,     (LPVOID)&detourBindBlob,     (LPVOID*)&g_origBindBlob,     "bind_blob");
        installOneHook((void*)api->bind_blob64,   (LPVOID)&detourBindBlob64,   (LPVOID*)&g_origBindBlob64,   "bind_blob64");
        installOneHook((void*)api->bind_text,     (LPVOID)&detourBindText,     (LPVOID*)&g_origBindText,     "bind_text");
        installOneHook((void*)api->bind_text64,   (LPVOID)&detourBindText64,   (LPVOID*)&g_origBindText64,   "bind_text64");
        installOneHook((void*)api->bind_int,      (LPVOID)&detourBindInt,      (LPVOID*)&g_origBindInt,      "bind_int");
        installOneHook((void*)api->bind_int64,    (LPVOID)&detourBindInt64,    (LPVOID*)&g_origBindInt64,    "bind_int64");
        installOneHook((void*)api->bind_double,   (LPVOID)&detourBindDouble,   (LPVOID*)&g_origBindDouble,   "bind_double");
        installOneHook((void*)api->bind_null,     (LPVOID)&detourBindNull,     (LPVOID*)&g_origBindNull,     "bind_null");
        installOneHook((void*)api->bind_value,    (LPVOID)&detourBindValue,    (LPVOID*)&g_origBindValue,    "bind_value");
        installOneHook((void*)api->finalize,      (LPVOID)&detourFinalize,     (LPVOID*)&g_origFinalize,     "finalize");

        probe::arm();   // 推送通道（默认关）+ 日志出口就绪
    }

    // ── 方式二（真正生效的那个）：直接 hook open_v2 的函数代码 ──────────
    // 实测：微信核心开库时**不走** API 表（那张表是给扩展用的），
    //       所以改表没用。但 api->open_v2 本身就是"真实函数的地址"，
    //       直接 hook 这段代码即可。用 MinHook（自带指令边界处理，不会把指令截断）。
    void installCode(sqlite3_api_routines* api) {
        if (g_WxVersion != 0) return;   // 新版：MinHook 挂钩会触发客户端校验 → 崩，只用改表
        std::lock_guard<std::recursive_mutex> _ilk(g_installMtx);
        if (g_installedCode || api == nullptr || api->open_v2 == nullptr) return;
        g_installedCode = true;
        MH_STATUS st = MH_Initialize();
        if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) {
            OutputDebugStringA("[db_registry] MH_Initialize 失败，退回扫描方式\n");
            g_installedCode = false;
            return;
        }
        void* target = (void*)api->open_v2;
        if (MH_CreateHook(target, (LPVOID)&detourOpenV2, (LPVOID*)&g_origOpenV2) != MH_OK) {
            OutputDebugStringA("[db_registry] MH_CreateHook(open_v2) 失败，退回扫描方式\n");
            g_installedCode = false;
            return;
        }
        if (MH_EnableHook(target) != MH_OK) {
            OutputDebugStringA("[db_registry] MH_EnableHook(open_v2) 失败，退回扫描方式\n");
            g_installedCode = false;
        }
        OutputDebugStringA("[db_registry] open_v2 代码钩子已安装（数据库句柄按真实打开记录）\n");

        // ★ 2026-10-22：再挂 v1 入口 —— 微信核心开库走这个。
        //   open_v2 的槽位指向外部模块（WCDB 封装层），微信从不去调它，
        //   所以只挂 open_v2 时 open_v2_names 恒为 0，contact.db 永远进不了注册表。
        //   两个都挂是安全的：同一个库只会走其中一条路径，noteOpened 内部有去重。
        if (api->open != nullptr &&
            installOneHook((void*)api->open, (LPVOID)&detourOpen, (LPVOID*)&g_origOpen, "open")) {
            g_installedOpenV1 = true;
            OutputDebugStringA("[db_registry] open(v1) 代码钩子已安装（微信核心开库走这个入口）\n");
        }

        // ★ 2026-10-22 第三次：open(v1) 装了却从不触发（open_v2_names 恒 0，
        //   registrations 只有 prepare 抓到的 2 个），而磁盘上 contact.db 明明被写过。
        //   微信实际用的是 **open16**（wchar 文件名版）——补上这个入口。
        if (api->open16 != nullptr &&
            installOneHook((void*)api->open16, (LPVOID)&detourOpen16, (LPVOID*)&g_origOpen16, "open16")) {
            g_installedOpen16 = true;
            OutputDebugStringA("[db_registry] open16 代码钩子已安装（微信实际使用的开库入口）\n");
        }
    }

    // ★ 2026-10-23 late-arm：构造时微信的 sqlite3_api_routines 表还没填，
    //   api->open16 / api->open 都是 nullptr → 当时跳过的钩子之后再也不重试，
    //   导致 contact.db（只在点通讯录时才打开）永远登记不上。
    //   现在每次真实查询前补装一次（幂等，挂上就不再重复）。
    void rearm(sqlite3_api_routines* api) {
        std::lock_guard<std::recursive_mutex> _ilk(g_installMtx);
        if (api == nullptr) return;
        if (!g_installedOpen16 && api->open16 != nullptr) {
            if (installOneHook((void*)api->open16, (LPVOID)&detourOpen16, (LPVOID*)&g_origOpen16, "open16(late)")) {
                g_installedOpen16 = true;
                OutputDebugStringA("[db_registry] open16 钩子补装成功（late-arm）\n");
            }
        }
        if (!g_installedOpenV1 && api->open != nullptr) {
            if (installOneHook((void*)api->open, (LPVOID)&detourOpen, (LPVOID*)&g_origOpen, "open(late)")) {
                g_installedOpenV1 = true;
                OutputDebugStringA("[db_registry] open(v1) 钩子补装成功（late-arm）\n");
            }
        }
        if (!g_installedCode && api->open_v2 != nullptr) installCode(api);
        if (!g_installedPrepare && api->prepare != nullptr) installPrepare(api);
    }

// 连接锁自检：db_mutex 槽位是否有效、锁是否真的拿到（给 /Debug/DBRescan 用）
    inline nlohmann::ordered_json reportConnLock(uintptr_t modBase, uintptr_t modSize) {
        nlohmann::ordered_json j;
        const uintptr_t slot = (g_api != nullptr) ? (uintptr_t)g_api->db_mutex : 0;
        j["db_mutex_slot"] = format_string("0x%llX", (unsigned long long)slot);
        j["db_mutex_in_module"] = (modBase != 0 && modSize != 0 && slot >= modBase && slot < modBase + modSize);
        j["vfs_find_slot"] = format_string("0x%llX", (unsigned long long)(g_api ? (uintptr_t)g_api->vfs_find : 0));
        j["vfs_ptr"] = format_string("0x%llX", (unsigned long long)g_lastVfs.load());
        j["vfs_null"] = (g_lastVfs.load() == 0);
        j["lock_ok"] = g_connLockOk.load(std::memory_order_relaxed);
        j["lock_null"] = g_connLockNull.load(std::memory_order_relaxed);
        j["lock_serial"] = g_connLockSerial.load(std::memory_order_relaxed);   // 走退路串行锁的次数
        j["effective"] = (g_connLockOk.load(std::memory_order_relaxed) > 0);
        j["note"] = "effective=false 且 lock_null>0 → 这把锁没起作用（db_mutex 槽位不对/连接非 FULLMUTEX）";
        return j;
    }

    // 安装：把 API 表里的 open_v2 指向 detour（表在 .rdata，需要临时改页保护）
    // 安装：把 API 表里的 open_v2 / open16 / prepare 指向我们的 detour（改数据、不动代码）
    void install(sqlite3_api_routines* api) {
        std::lock_guard<std::recursive_mutex> _ilk(g_installMtx);
        if (g_installed || api == nullptr) return;
        g_installed = true;

        auto patchSlot = [](void** s, void* fn) -> bool {
            DWORD op = 0;
            if (!VirtualProtect(s, sizeof(void*), PAGE_READWRITE, &op)) return false;
            *s = fn;
            DWORD t = 0;
            VirtualProtect(s, sizeof(void*), op, &t);
            return true;
        };

        if (g_WxVersion == 0 && api->open_v2 != nullptr) {   // 新版：表项也不改（微信校验 → 崩），只用只读扫描
            open_v2_t orig = (open_v2_t)api->open_v2;
            if (patchSlot((void**)&api->open_v2, (void*)&detourOpenV2)) {
                g_origOpenV2 = orig;
                OutputDebugStringA("[db_registry] open_v2 表项已替换\n");
            }
        }
        char _dbMode[32] = { 0 };
        GetEnvironmentVariableA("WXHOOK_DB", _dbMode, sizeof(_dbMode));   // 调试开关：o16 / prep / both
        const bool _doO16 = (strstr(_dbMode, "o16") != nullptr);
        const bool _doPrep = (strstr(_dbMode, "prep") != nullptr);
        // 新版（4.1.15+）：MinHook 挂钩会被客户端校验 → 崩；open16/prepare 也只用改表
        if (g_WxVersion != 0) {
        if (_doO16 && api->open16 != nullptr) {
                open16_t o16 = (open16_t)api->open16;
                if (patchSlot((void**)&api->open16, (void*)&detourOpen16)) {
                    g_origOpen16 = o16;
                    g_installedOpen16 = true;
                    OutputDebugStringA("[db_registry][new] open16 表项已替换\n");
                }
            }
        if (_doPrep && api->prepare != nullptr) {
                prepare_t op = (prepare_t)api->prepare;
                if (patchSlot((void**)&api->prepare, (void*)&detourPrepare)) {
                    g_origPrepare = op;
                    g_installedPrepare = true;
                    OutputDebugStringA("[db_registry][new] prepare 表项已替换\n");
                }
            }
        }
    }

    // 说明：原来这里还有一个"open_v2 登记表快照"（snapshot），它会逐条对句柄做只读探测 —— 已删除。
    // 只读探测 + "真能查"探测来剔除失效项 —— 那套主动探测已经全部删掉。
    // 现在注册表只剩一个来源（g_slot 原子表），失效判定统一由 noteQueryResult 负责。
}


namespace xmgr {
    // 早装（登录前就挂好 open16/prepare）——解决"客户端秒登录，DB 在我们装钩子之前就打开了"。
    // 由 inline_weixin_dll_load 在 ResolveOffsets() 之后调用一次；幂等，装好后线程退出。
    void StartEarlyArmThread() {
        std::thread([] {
            OutputDebugStringA("[db_registry] 早装线程启动（等待 API 表填充）\n");
            for (int i = 0; i < 1200; ++i) {          // 最多等 10 分钟
                if (g_hWeixinDll != nullptr) {
                    auto* api = (sqlite3_api_routines*)((size_t)g_hWeixinDll + XWECHAT_SQLITE3_API_ROUTINES_OFFSET);
                    if (api != nullptr && api->open16 != nullptr && api->prepare != nullptr && api->step != nullptr) {
                        db_registry::install(api);
                        db_registry::installCode(api);
                        db_registry::installPrepare(api);
                        db_registry::rearm(api);
                        OutputDebugStringA("[db_registry] 早装完成（登录前已挂 open16/prepare）\n");
                        return;
                    }
                }
                Sleep(500);
            }
            OutputDebugStringA("[db_registry] 早装超时（API 表始终没填充）\n");
        }).detach();
    }
}

static void codec_get_key(sqlite3CodecGetKey func, sqlite3* db, int index, void** pKey, int* pLen) {
	__try {
		func(db, index, pKey, pLen);
	}
	__except (EXCEPTION_EXECUTE_HANDLER) {
		//这里输出异常调试信息 
	}
}

namespace xmgr {

	static std::string toHexString(const std::string& str)
	{
		static const char hex[] = "0123456789ABCDEF";
		std::string out;
		out.reserve(str.size() * 2);

		for (size_t i = 0; i < str.size(); ++i)
		{
			out.push_back(hex[(unsigned char)str[i] >> 4]);
			out.push_back(hex[(unsigned char)str[i] & 0x0F]);
		}
		return out;
	}

	// 判断一个指针是否落在 Weixin.dll 模块内（从 PE 头取 SizeOfImage，最可靠）
	// 为什么要它：backup_init 可能因为「表还没填好」而是 null/垃圾；
	// 原来直接 backup_init + 0xAD 然后 WriteProcessMemory → 往随机地址写 14 字节 0x90 → 客户端崩。
	// （实测：DLL 加载 2 秒就构造 DatabaseMgr 时，启动 9 秒后崩溃）
	static bool inWeixinModule(const void* p) {
		if (p == nullptr || g_hWeixinDll == nullptr) return false;
		const uintptr_t base = (uintptr_t)g_hWeixinDll;
		const IMAGE_DOS_HEADER* dos = (const IMAGE_DOS_HEADER*)base;
		if (dos->e_magic != IMAGE_DOS_SIGNATURE) return false;
		const IMAGE_NT_HEADERS* nt = (const IMAGE_NT_HEADERS*)(base + (uintptr_t)dos->e_lfanew);
		if (nt->Signature != IMAGE_NT_SIGNATURE) return false;
		const uintptr_t size = (uintptr_t)nt->OptionalHeader.SizeOfImage;
		if (size == 0) return false;
		const uintptr_t a = (uintptr_t)p;
		return a >= base && a < base + size;
	}

	DatabaseMgr::DatabaseMgr() {
		size_t module_base = (size_t)g_hWeixinDll;
		m_sqlite3Rountines = (sqlite3_api_routines*)(module_base + XWECHAT_SQLITE3_API_ROUTINES_OFFSET);
		m_sqlcipherRountines = (sqlcipher_api_routines*)(module_base + XWECHAT_SQLCIPHER_API_ROUTINES_OFFSET);
		m_codecGetKey = (sqlite3CodecGetKey)(module_base + XWECHAT_SQLITE3_CODEC_GET_KEY_FUNC);
		// 安装 open_v2 钩子：以后微信打开的每个数据库都会被登记（见文件开头 db_registry）。
		// 这样就不必再靠"扫内存找指针值"——那种方式实测命中数会从 219 跳到 3，一跳就全废。
		db_registry::install(m_sqlite3Rountines);        // 改 API 表（对走扩展的库有效）
		db_registry::installCode(m_sqlite3Rountines);    // 直接 hook 函数代码（主路径）
		db_registry::installPrepare(m_sqlite3Rountines); // hook prepare：每次查询必走，最可靠
		LPVOID patchAddress = (LPVOID)((size_t)m_sqlite3Rountines->backup_init + 0xAD);
		std::vector<BYTE> nopData(14, 0x90);
		m_backupAsmCode.resize(nopData.size(), 0);
		ReadProcessMemory(GetCurrentProcess(), patchAddress, m_backupAsmCode.data(), m_backupAsmCode.size(), nullptr);
		WriteProcessMemory(GetCurrentProcess(), patchAddress, (LPCVOID)nopData.data(), nopData.size(), nullptr);
	}

	DatabaseMgr::~DatabaseMgr() {
		if (m_sqlite3Rountines != nullptr && m_backupAsmCode.size() != 0) {
			LPVOID patchAddress = (LPVOID)((size_t)m_sqlite3Rountines->backup_init + 0xAD);
			WriteProcessMemory(GetCurrentProcess(), patchAddress, (LPCVOID)m_backupAsmCode.data(), m_backupAsmCode.size(), 0);
			m_backupAsmCode.resize(0);
		}
	}

// ══════════════════════════════════════════════════════════════════
	//  方案 A：自开只读连接（不碰客户端连接 → 从根上避免并发踩内存）
	//
	//  背景：这个微信的 sqlite 是 THREADSAFE=2（multi-thread），连接**没有互斥锁**
	//  （db_mutex 返回 NULL），所以"拿连接锁"这条路走不通。客户端自己用上层锁保护，
	//  我们从别的线程并发用它的连接就是不安全的。
	//
	//  做法：用 codec_get_key 拿到该库的 SQLCipher 密钥 → 用**同一套 sqlite/sqlcipher
	//  函数**自己 open_v2(READONLY) 一个连接 + sqlcipher key() 解密 → SELECT 全走它。
	//  写语句仍然走客户端连接（写很少，且写权限只属于客户端）。
	// ══════════════════════════════════════════════════════════════════
	sqlite3* DatabaseMgr::ownConnectionFor(sqlite3* clientDb) {
		if (clientDb == nullptr || m_sqlite3Rountines == nullptr) return nullptr;
		if (m_sqlite3Rountines->db_filename == nullptr || m_sqlite3Rountines->open_v2 == nullptr) return nullptr;

		std::string pathStr;
		if (!db_registry::nameForHandle(clientDb, pathStr) || pathStr.empty()) {
		    const char* p0 = (const char*)m_sqlite3Rountines->db_filename(clientDb, "main");   // 最后兜底
		    if (p0 == nullptr || *p0 == 0) return nullptr;
		    pathStr = p0;
		}
		const char* path = pathStr.c_str();
		if (path == nullptr || *path == '\0') return nullptr;

		std::lock_guard<std::mutex> lg(m_ownMtx);
		auto it = m_ownDbs.find(path);
		if (it != m_ownDbs.end()) return it->second;

		std::string key2;
		if (!db_registry::keyForPath(path, key2) || key2.empty()) {
			OutputDebugStringA("[own_db] 该库密钥还没抓到（等客户端 prepare），暂用客户端连接\n");
			return nullptr;
		}
		const void* pKey = key2.data();
		const int kLen = (int)key2.size();
		sqlite3* own = nullptr;
		int rc = m_sqlite3Rountines->open_v2(path, &own, 0x00000001 /*SQLITE_OPEN_READONLY*/, nullptr);
		if (rc != 0 || own == nullptr) {
			OutputDebugStringA("[own_db] open_v2(READONLY) 失败，回退客户端连接\n");
			return nullptr;
		}
		if (m_sqlcipherRountines != nullptr && m_sqlcipherRountines->key != nullptr) {
			if (m_sqlcipherRountines->key(own, pKey, kLen) != 0) {
				OutputDebugStringA("[own_db] sqlcipher key() 失败，回退客户端连接\n");
				m_sqlite3Rountines->close(own);
				return nullptr;
			}
		} else {
			m_sqlite3Rountines->close(own);
			return nullptr;
		}

		m_ownDbs[path] = own;
		OutputDebugStringA((std::string("[own_db] 已开独立只读连接: ") + path + "\n").c_str());
		return own;
	}

void DatabaseMgr::forgetOwn(sqlite3* clientDb) {
		if (clientDb == nullptr || m_sqlite3Rountines == nullptr || m_sqlite3Rountines->db_filename == nullptr) return;
		const char* path = (const char*)m_sqlite3Rountines->db_filename(clientDb, "main");
		if (path == nullptr) return;
		std::lock_guard<std::mutex> lg(m_ownMtx);
		auto it = m_ownDbs.find(path);
		if (it != m_ownDbs.end()) {
			try { m_sqlite3Rountines->close(it->second); } catch (...) {}
			m_ownDbs.erase(it);
			OutputDebugStringA("[own_db] 丢弃独立连接，回退客户端连接\n");
		}
	}

	nlohmann::ordered_json DatabaseMgr::execute(sqlite3* db, const std::string& sql)
	{
        std::lock_guard<std::recursive_mutex> _lck(g_clientCallMutex);   // 串行化：避免 httplib 两个工作线程同时进客户端 sqlite
        db_registry::SqliteConnLock _conn(db);   // ★ 连接锁：与客户端线程互斥（根治 lookaside 损坏）

        // 方案 A：只读 SQL 走我们自己的只读连接（不碰客户端连接）
        sqlite3* runDb = db;
        bool useOwn = false;
        {
            std::string s2;
            for (char c : sql) { if (!isspace((unsigned char)c)) { s2.push_back((char)toupper((unsigned char)c)); } if (s2.size() >= 6) break; }
            if (s2 == "SELECT" || s2 == "PRAGMA" || s2 == "WITH" || s2 == "EXPLAIN") {
                if (sqlite3* own = ownConnectionFor(db)) { runDb = own; useOwn = true; }
            }
        }
        db_registry::rearm(m_sqlite3Rountines);   // 每次查询补装钩子（幂等）
		nlohmann::ordered_json rdata = { {"status",0},{"desc",""} };
		if (db == nullptr) {
			rdata["status"] = -1;
			rdata["desc"] = "input db handle is nullptr";
			return rdata;
		}
		sqlite3_stmt* stmt = nullptr;
		int rc = m_sqlite3Rountines->prepare((LPVOID)runDb, sql.c_str(), -1, &stmt, 0);
		// ★★ 句柄好坏的**唯一**判据就在这里：真实查询的返回码。
		//    我们不主动去试句柄；只有真实查询（桥发来的 SQL / 取名扫描 / backup）
		//    返回连接级错误时，才给这个句柄记一次失败；成功一次就清零。
		db_registry::noteQueryResult((void*)db, rc);
		if (rc != SQLITE_OK && useOwn && runDb != db) {
		    // 独立连接失败（WAL 锁 / 密钥 / 只读限制）→ 丢弃缓存，回退客户端连接重试一次
		    forgetOwn(db);
		    runDb = db;
		    stmt = nullptr;
		    rc = m_sqlite3Rountines->prepare((LPVOID)db, sql.c_str(), -1, &stmt, 0);
		}
		if (rc != SQLITE_OK) {
			rdata["status"] = rc;
			rdata["desc"] = format_string("execute %s failed", "sqlite3_prepare");
			return rdata;
		}
		nlohmann::ordered_json items = nlohmann::ordered_json::array();
		int stepRc = SQLITE_OK;
		while ((stepRc = m_sqlite3Rountines->step(stmt)) == SQLITE_ROW)
		{
			int col_count = m_sqlite3Rountines->column_count(stmt);
			nlohmann::ordered_json item;
			for (int i = 0; i < col_count; i++)
			{
				const char* ColName = m_sqlite3Rountines->column_name(stmt, i);
				int nType = m_sqlite3Rountines->column_type(stmt, i);
				const void* pReadBlobData = m_sqlite3Rountines->column_blob(stmt, i);
				int nLength = m_sqlite3Rountines->column_bytes(stmt, i);
				std::string key(ColName);
				std::string value;
				switch (nType)
				{
				case SQLITE_BLOB:
				{
					value = toHexString(std::string((char*)pReadBlobData, nLength));
					break;
				}
				default:
				{
					value = std::string((char*)pReadBlobData, nLength);
					break;
				}
				}
				item[key] = value;
			}
			items.push_back(item);
		}
		m_sqlite3Rountines->finalize(stmt);
		if (stepRc != SQLITE_DONE && stepRc != SQLITE_OK) {
			db_registry::noteQueryResult((void*)db, stepRc);   // 执行期才暴露的连接级错误
		}
		rdata["data"] = items;
		return rdata;
	}

	// ── 连续失败自愈（兜底）────────────────────────────────────────────
	// 桥每 2.5 秒轮询 6 张表；偶尔拿不到句柄是正常的（message_1..9.db 本来就不存在，
	// 微信的库是懒加载的）。但**连续** N 次拿不到，说明注册表可能真坏了
	// （就是本次修的"句柄丢失"），此时做一次合并 + 一次带节流的取名扫描。
	// 注意：**不 clear、不扫地址空间、不探测句柄**，只走公开的两条安全路径。
	static std::atomic<int> s_handleFailStreak{ 0 };
	static std::atomic<long long> s_lastHealMs{ 0 };
	static const int kHealThreshold = 5;
	static const long long kHealIntervalMs = 30000;

	static void noteHandleMiss(DatabaseMgr& mgr, const std::string& dbname) {
		int n = s_handleFailStreak.fetch_add(1, std::memory_order_relaxed) + 1;
		if (n < kHealThreshold) return;
		long long now = db_registry::nowMs();
		long long prev = s_lastHealMs.load();
		if (now - prev <= kHealIntervalMs) return;
		if (!s_lastHealMs.compare_exchange_strong(prev, now)) return;
		db_registry::g_healCount.fetch_add(1, std::memory_order_relaxed);
		OutputDebugStringA(format_string(
			"[db_mgr][self-heal] 连续 %d 次拿不到句柄（最近：%s），触发一次重扫（节流 30s，不清空缓存）\n",
			n, dbname.c_str()).c_str());
		mgr.searchDatabases();                 // 合并注册表 + 内部节流的取名扫描
		bool found = mgr.hasDb(dbname);
		OutputDebugStringA(format_string(
			"[db_mgr][self-heal] 重扫完成：目标 %s %s\n",
			dbname.c_str(), found ? "已恢复" : "仍不在").c_str());
		if (found) s_handleFailStreak.store(0, std::memory_order_relaxed);
	}

	nlohmann::ordered_json DatabaseMgr::execute(const std::string& dbname, const std::string& sql)
	{
        std::lock_guard<std::recursive_mutex> _lck(g_clientCallMutex);   // 串行化：避免 httplib 两个工作线程同时进客户端 sqlite
        db_registry::rearm(m_sqlite3Rountines);   // 每次查询补装钩子（幂等）
		nlohmann::ordered_json rdata = { {"status",0},{"desc",""} };
		LPVOID dbHandle = getDatabaseHandle(dbname);
		if (dbHandle == nullptr) {
			rdata["status"] = -1;
			rdata["desc"] = format_string("get database handle which named %s failed", dbname);
			noteHandleMiss(*this, dbname);          // 连续失败 → 自愈兜底
			return rdata;
		}
		s_handleFailStreak.store(0, std::memory_order_relaxed);   // 成功 → 清零
		g_IsLogin = 1;   // 能拿到库句柄 = 已登录（桥靠这个判断）
		rdata = execute((sqlite3*)dbHandle, sql);
		return rdata;
	}

	std::string DatabaseMgr::codec_get_key(const std::string& dbname) {
		LPVOID dbHandle = getDatabaseHandle(dbname);
		if (dbHandle == nullptr)
			return "";
		return codec_get_key((sqlite3*)dbHandle);
	}

	std::string DatabaseMgr::codec_get_key(sqlite3* db) {
		char* pKey = nullptr;
		int iLen = 0;
		std::string szKey;
		return szKey;
		if (m_codecGetKey == nullptr)
			return szKey;
		nlohmann::ordered_json queryResult = execute(db, std::string("PRAGMA cipher_store_pass"));
		if (queryResult["data"][0]["cipher_store_pass"] == 0) {
			return szKey;
		}
		::codec_get_key(m_codecGetKey, db, 0, (void**)&pKey, &iLen);
		if (pKey == nullptr)
			return szKey;
		szKey = std::string(pKey, iLen);
		return szKey;
	}

	void DatabaseMgr::backup_xprogress(int remaining, int pagecount) {
		//LL_DEBUG("backup process: %d/%d\n", pagecount - remaining, pagecount);
		//OutputDebugStringA("[backup process]\n");
	}

	int DatabaseMgr::backup(sqlite3* db, const std::string& out_path)
	{
        std::lock_guard<std::recursive_mutex> _lck2(g_clientCallMutex);
        db_registry::SqliteConnLock _conn(db);   // backup 与查询共用同一把连接锁
		int rc = SQLITE_OK;
		if (db == nullptr) {
			return -1;
		}
		sqlite3* pNewDbHandle = nullptr;
		sqlite3_backup* pBackupHandle = nullptr;
		rc = m_sqlite3Rountines->open(out_path.c_str(), &pNewDbHandle);
		if (rc == SQLITE_OK) {
			pBackupHandle = m_sqlite3Rountines->backup_init(pNewDbHandle, (const char*)"main", db, (const char*)"main");
			if (pBackupHandle) {
				do {
					rc = m_sqlite3Rountines->backup_step(pBackupHandle, 5);
					backup_xprogress(
						m_sqlite3Rountines->backup_remaining(pBackupHandle),
						m_sqlite3Rountines->backup_pagecount(pBackupHandle)
					);
					if (rc == SQLITE_OK || rc == SQLITE_BUSY || rc == SQLITE_LOCKED) {
						m_sqlite3Rountines->sleep(50);
					}
				} while (rc == SQLITE_OK || rc == SQLITE_BUSY || rc == SQLITE_LOCKED);
				(void)m_sqlite3Rountines->backup_finish(pBackupHandle);
			}
			rc = m_sqlite3Rountines->errcode(pNewDbHandle);
		}
		(void)m_sqlite3Rountines->close(pNewDbHandle);
		return rc;
	}

	int DatabaseMgr::backup(const std::string& dbname, const std::string& out_path)
	{
		int rc = SQLITE_OK;
		sqlite3* pExistDbHandle = (sqlite3*)getDatabaseHandle(dbname);
		if (pExistDbHandle == nullptr) {
			return -1;
		}
		return backup(pExistDbHandle, out_path);
	}

	// ══════════════════════════════════════════════════════════════════
	//  searchDatabases：把注册表合并进缓存
	//
	//  ★ 根因修复点（与上一版最大的不同）★
	//    原代码在"发现任意一条看起来无效"时执行 m_dbs.clear() —— 一次清空整张表；
	//    而那条判据 IsReadableRegion(h,0x1000) 对**完全正常**的 sqlite3 句柄也会 false
	//    （sqlite3 对象只有几百字节，堆块后面未必还有 4KB 可读页）。
	//    于是桥的连续轮询反复把整张表清空 → 找不到 message_0.db →
	//    "get database handle which named message_0.db failed" → 机器人静默失聪。
	//    现在：逐条判定、逐条剔除，**绝不清空**；剔不剔由**真实查询的返回码**说了算。
	//
	//  ★ 也不在持锁状态下做任何慢操作：上一版在锁里扫整个地址空间，
	//    桥每 2.5 秒一催就排队 → 客户端启动被拖到 3 分钟（scans=153）。
	// ══════════════════════════════════════════════════════════════════
	const std::map<std::string, LPVOID>& DatabaseMgr::searchDatabases() {
		// ── ① 逐条校验 + 合并注册表（持锁时间只够拷几个 map，微秒级）──────
		{
			std::lock_guard<std::mutex> lg(m_searchDbMtx);
			// 剔掉"已经不在注册表里"的那一条（被 noteQueryResult 剔除 / 从未登记）
			for (auto it = m_dbs.begin(); it != m_dbs.end(); ) {
				if (!db_registry::isRegistered((uintptr_t)it->second)) {
					it = m_dbs.erase(it);
				} else {
					++it;
				}
			}
			// 注册表 → 缓存（**合并**，不覆盖别的来源；同名的挑"失败最少 + 最新鲜"）
			std::vector<db_registry::Entry> live = db_registry::snapshot();
			for (size_t i = 0; i < live.size(); ++i) {
				if (live[i].name.empty()) continue;
				auto it = m_dbs.find(live[i].name);
				if (it == m_dbs.end()) { m_dbs[live[i].name] = live[i].handle; continue; }
				db_registry::Entry cur;
				const bool curOk = db_registry::entryByHandle(it->second, cur);
				if (!curOk || live[i].fail < cur.fail ||
					(live[i].fail == cur.fail && live[i].tick > cur.tick)) {
					it->second = live[i].handle;
				}
			}
		}

		// ── ② 有句柄但没名字 → 一次（节流 + 单飞的）取名扫描 ─────────────
		//    正在扫的时候，别的线程**直接返回现有缓存**（不排队、不并发扫）。
		if (db_registry::needNamePass()) {
			const int added = namePass();
			if (added > 0) {
				std::lock_guard<std::mutex> lg(m_searchDbMtx);
				std::vector<db_registry::Entry> live = db_registry::snapshot();
				for (size_t i = 0; i < live.size(); ++i) {
					if (live[i].name.empty()) continue;
					if (!m_dbs.count(live[i].name)) m_dbs[live[i].name] = live[i].handle;
				}
			}
		}

		if (!m_dbs.empty() && g_IsLogin == 0) g_IsLogin = 1;   // 有句柄 = 已登录
		return m_dbs;
	}

	// ── 给"已登记但还没名字"的句柄补名字 ─────────────────────────────
	//  为什么只补名字、不做别的事：句柄是不是**真句柄**，由 prepare/open_v2 钩子证明
	//  （它们刚刚真的被微信拿来执行过 SQL）；这里只是问一句"你是哪个库"。
	//  绝不扫地址空间、绝不拿未验证的指针开刀、绝不发 SELECT 1 试探。
	//
	//  闸门（任务书要求）：
	//    · 全局最多每 30 秒一次；
	//    · 连续"扫了没收获"→ 指数退避，最多 5 分钟；
	//    · 扫描进行中其他线程**直接返回**现有缓存（不排队等、不并发扫）。
	//  返回 >0 = 本次补上的条数；0 = 扫了没收获；<0 = 没扫（节流中 / 别人正在扫）
	int DatabaseMgr::namePass() {
		if (db_registry::g_scanBusy.exchange(1) != 0) {
			db_registry::g_namePassSkipped.fetch_add(1, std::memory_order_relaxed);
			return -1;                                  // 扫描进行中 → 立刻回去用缓存
		}
		struct BusyGuard {
			~BusyGuard() { db_registry::g_scanBusy.store(0, std::memory_order_relaxed); }
		} busyGuard;

		const long long now = db_registry::nowMs();
		long long wait = 30000LL;                       // 全局下限：30 秒
		const int empties = db_registry::g_emptyScans.load(std::memory_order_relaxed);
		for (int i = 0; i < empties && wait < 300000LL; ++i) wait *= 2;   // 30→60→120→240→300(封顶)
		if (wait > 300000LL) wait = 300000LL;
		long long prev = db_registry::g_lastScanMs.load(std::memory_order_relaxed);
		if (prev != 0 && (now - prev) < wait) {
			db_registry::g_namePassThrottled.fetch_add(1, std::memory_order_relaxed);
			return -1;                                  // 太快了，节流
		}
		if (!db_registry::g_lastScanMs.compare_exchange_strong(prev, now)) {
			db_registry::g_namePassThrottled.fetch_add(1, std::memory_order_relaxed);
			return -1;
		}
		db_registry::g_namePassRuns.fetch_add(1, std::memory_order_relaxed);

		int added = 0;
		int attempted = 0;
		bool hadUnnamed = false;
		std::vector<db_registry::Entry> all = db_registry::snapshot();
		for (size_t i = 0; i < all.size(); ++i) {
			if (all[i].name.empty()) hadUnnamed = true;
			// 只处理"最近还在 SQL 入口出现过"的句柄 —— 冷了很久的有可能是已关闭的
			if (all[i].tick == 0 || (now - all[i].tick) > 120000) continue;
			// 内存闸门：只看**对象头部**能不能读，绝不用 0x1000 去看 4KB ——
			// ★ 实测教训：IsReadableRegion(h, 0x1000) 对**完全正常**的 sqlite3 句柄也会 false
			//   （对象只有几百字节，堆块后面未必还有 4KB 可读页）。用它当闸门会让第一轮取名
			//   只成功 1 个、剩下的要等 30 秒后的下一轮 → 启动被拖到 58.7 秒（实测）。
			if (!IsReadableRegion(all[i].handle, 64)) continue;
			++attempted;

			// ① 首选：api->db_filename —— **只读**（不 prepare、不发 SQL、不碰任何表），纳秒级。
			//    它同时负责纠正"地址复用"造成的过期名字（实测：message_0.db 的句柄被回收后
			//    重开成 emoticon.db，缓存名不改就会查错库）。
			bool named = false;
			if (db_registry::g_api != nullptr && db_registry::g_api->db_filename != nullptr) {
				std::string fnm;
				if (db_registry::safeDbName(all[i].handle, fnm)) {
					if (fnm != all[i].name) { db_registry::noteNamed(all[i].handle, fnm); ++added; }
					named = true;
				}
			}
			if (named) continue;
			if (!all[i].name.empty()) continue;

			// ② 退路：真查询 PRAGMA database_list（db_filename 槽位不可用时才会走到）
            // ★ 2026-10-22：这条退路会对句柄真的发 SQL，同样有野指针风险。
            //   ordered_json 有析构函数，不能放进 __try，所以用"先探测可读"降风险 + 交给 prepare 的 SEH。
            if (!IsReadableRegion(all[i].handle, 64)) continue;
            nlohmann::ordered_json q = execute((sqlite3*)all[i].handle, "PRAGMA database_list");
			if (!q.contains("data") || !q["data"].is_array() || q["data"].empty()) continue;
			auto& row = q["data"][0];
			if (!row.contains("file") || !row["file"].is_string()) continue;
			const std::string dbpath = row["file"].get<std::string>();
			if (dbpath.empty()) continue;
			const std::string nm = db_registry::baseName(dbpath);
			if (!db_registry::looksLikeDbName(nm)) continue;
			db_registry::noteNamed(all[i].handle, nm);
			++added;
		}
		db_registry::g_passAttempted.store(attempted, std::memory_order_relaxed);
		db_registry::g_passNamed.store(added, std::memory_order_relaxed);
		// 只有"确实有没名字的句柄、而且一个都没拿到"才算空扫（进指数退避）
		db_registry::g_emptyScans.store((hadUnnamed && added == 0) ? (empties + 1) : 0,
		                                std::memory_order_relaxed);
		return added;
	}

	LPVOID DatabaseMgr::getDatabaseHandle(const std::string& dbname)
	{
		if (dbname.empty()) return nullptr;

		// ── ① 注册表按名直查（命中也要判断可信：零 API、零 SQL、零锁）──────
		//  为什么加这一步：原来的 ① 是「命中就直接 return」，而注册表里的句柄
		//  在 WCDB 回收连接后会变成野指针 → sqlite3_prepare(野指针) → 客户端崩。
		//  （实测 16:43:30 崩溃前，桥正在反复探测 message_1.db）
		//  为什么不用 db_filename 验证：对已释放的句柄调它，校验本身就会崩。
		LPVOID h = db_registry::findByName(dbname);
		if (h != nullptr) {
			db_registry::Entry e;
			bool trusted = false;
			if (db_registry::entryByHandle((void*)h, e)) {
				// ★ 2026-10-22 修（第二次）：tick 是「open/prepare 入口时间」，**不是**
				//   「上次成功读的时间」。低频访问的库（contact.db / contact_fts.db 只在
				//   微信启动时 open 一次、或插件每 5 分钟读一次）tick 必然老化到 5 分钟，
				//   于是被判成"死句柄" → retireHandle 立墓碑 → 该库**永久**读不到，
				//   直到微信重新 open。实测：open(v1) hook 只是让它"第一次能登记"，
				//   救不了后续被判死（22:41 又报 get database handle contact.db failed）。
				//
				//   新判据（分两级）：
				//     · fail 计数是硬条件（连续真失败 ≥2 就真的不可信）
				//     · tick 老化时**不直接判死**，先 SEH 验名字：
				//       verifyName → safeDbName → sehDbFilename，全程有 SEH，
				//       对已释放的野指针只会返回 false，绝不会崩。
				//   这样既能挡住真野指针，又不会误杀活着的冷门库。
				trusted = (e.fail < 2);
				if (trusted && (db_registry::nowMs() - e.tick >= 300000)) {
					trusted = db_registry::verifyName((void*)h, dbname);
				}
			}
			if (trusted) {
				db_registry::g_hitRegistry.fetch_add(1, std::memory_order_relaxed);
				return h;
			}
			// 不可信 → 剔除这条，继续走 ②③ 重新找（绝不返回野指针）
			db_registry::retireHandle((uintptr_t)h);
		}

		// ── ② m_dbs 缓存（只剔失效的那一条，绝不清空整表）───────────────
		// 命中也要复核名字：句柄地址会被复用，缓存里那条可能已经改开成别的库了
		// （实测：message_0.db 的句柄被回收后重开成 emoticon.db）。
		{
			std::lock_guard<std::mutex> lg(m_searchDbMtx);
			auto it = m_dbs.find(dbname);
			if (it != m_dbs.end()) {
				const bool okName = db_registry::verifyName(it->second, dbname);
				if (okName && db_registry::isRegistered((uintptr_t)it->second)) {
					db_registry::g_hitCache.fetch_add(1, std::memory_order_relaxed);
					return it->second;
				}
				m_dbs.erase(it);      // ★ 只剔这一条
			}
		}

		// ── ③ 合并注册表（必要时触发一次带节流的取名扫描）───────────────
		searchDatabases();
		{
			std::lock_guard<std::mutex> lg(m_searchDbMtx);
			auto it = m_dbs.find(dbname);
			if (it != m_dbs.end()) {
				if (db_registry::verifyName(it->second, dbname) &&
					db_registry::isRegistered((uintptr_t)it->second)) {
					db_registry::g_hitCache.fetch_add(1, std::memory_order_relaxed);
					return it->second;
				}
				m_dbs.erase(it);
			}
		}

		// ── ④ 仍然没有：连续未命中 → 节流自愈（只重扫合并，**绝不清空**）──
		// 微信的库是**懒加载**的：message_1..9.db 本来就可能不存在，所以"找不到"
		// 是正常情况，绝不能因此清表（原代码就是在这里 m_dbs.clear() 的）。
		noteHandleMiss(*this, dbname);
		db_registry::g_miss.fetch_add(1, std::memory_order_relaxed);
		return nullptr;
	}

	nlohmann::ordered_json DatabaseMgr::getDatabaseInfo() {
		nlohmann::ordered_json jdbs = nlohmann::ordered_json::array();
		// 原版这里有 if (!g_IsLogin) return jdbs; —— 但 g_IsLogin 永远为 0，
		// 首次调用必然返回空。去掉这个门（合并逻辑本身会判断有没有数据库）。

		//OutputDebugStringA("[getDatabaseInfo] 用户已登录\n");

		// ★ 这里原来有一句 m_dbs.clear()：一次"列库"就把整张句柄表清空，
		//   正是"句柄丢失"的帮凶之一（清空后要靠重扫才能恢复）。已删除。
		searchDatabases();
		// 拷一份再遍历：桥的轮询线程会并发增删 m_dbs（迭代器失效 → 未定义行为）。
		std::map<std::string, LPVOID> copy;
		{
			std::lock_guard<std::mutex> lg(m_searchDbMtx);
			copy = m_dbs;
		}
		for (auto& db : copy) {
			nlohmann::json jdb = { {"dbName",db.first},{"dbHandle",(size_t)db.second} };
			jdbs.push_back(jdb);
		}
		return jdbs;
	}

	bool DatabaseMgr::hasDb(const std::string& dbname) {
		std::lock_guard<std::mutex> lg(m_searchDbMtx);
		return m_dbs.find(dbname) != m_dbs.end();
	}

	// ── GET /Debug/DBRescan：纯只读快照 ──────────────────────────────
	// 不跑任何 SQL、不改任何状态、不动 m_dbs —— 监控可以放心高频轮询。
	// 想真扫一次用 POST {"force":true}（带 30 秒节流）。
	nlohmann::ordered_json DatabaseMgr::dbRescanReport() {
		nlohmann::ordered_json j;
		{
			std::lock_guard<std::mutex> lg(m_searchDbMtx);
			const long long now = db_registry::nowMs();
			nlohmann::ordered_json cache = nlohmann::ordered_json::array();
			for (auto& kv : m_dbs) {
				db_registry::Entry e;
				const bool ok = db_registry::entryByHandle(kv.second, e);
				nlohmann::ordered_json x;
				x["db"] = kv.first;
				x["handle"] = format_string("0x%llX", (unsigned long long)(uintptr_t)kv.second);
				x["registered"] = ok;
				x["fail_streak"] = ok ? e.fail : -1;
				x["last_ok_ms_ago"] = (ok && e.lastOk > 0) ? (now - e.lastOk) : -1;
				x["source"] = ok ? ((e.src == 1) ? "open_v2" : (e.src == 2 ? "name_pass" : (e.src == 3 ? "api_named" : "prepare"))) : "unknown";
				cache.push_back(x);
			}
			j["cache"] = cache;
			j["db_count"] = (int)m_dbs.size();
			j["message_0_present"] = (m_dbs.find("message_0.db") != m_dbs.end());
		}
		nlohmann::ordered_json hooks = nlohmann::ordered_json::object();
		hooks["prepare"] = db_registry::prepareHookInstalled();
		hooks["open_v2"] = db_registry::openHookInstalled();
		j["hooks"] = hooks;
		j["registry"] = db_registry::reportRegistry();
		j["name_pass"] = db_registry::reportNamePass();
		j["counters"] = db_registry::reportCounters();
		{
		    const uintptr_t b = (uintptr_t)g_hWeixinDll;
		    uintptr_t s = (uintptr_t)g_MyModuleSize;
		    if (s == 0 && b != 0) {
		        const IMAGE_DOS_HEADER* dos = (const IMAGE_DOS_HEADER*)b;
		        if (dos->e_magic == IMAGE_DOS_SIGNATURE) {
		            const IMAGE_NT_HEADERS* nt = (const IMAGE_NT_HEADERS*)(b + (uintptr_t)dos->e_lfanew);
		            if (nt->Signature == IMAGE_NT_SIGNATURE) s = (uintptr_t)nt->OptionalHeader.SizeOfImage;
		        }
		    }
		    j["conn_lock"] = db_registry::reportConnLock(b, s);
		    {
		        std::lock_guard<std::mutex> lgOwn(m_ownMtx);
		        nlohmann::ordered_json arr = nlohmann::ordered_json::array();
		        for (auto& kv : m_ownDbs) arr.push_back(kv.first);
		        j["own_dbs"] = arr;
		        j["own_db_count"] = (int)m_ownDbs.size();
		        {
		            std::lock_guard<std::mutex> lgK(db_registry::g_keyMtx);
		            nlohmann::ordered_json arr2 = nlohmann::ordered_json::array();
		            for (auto& kv : db_registry::g_keys) arr2.push_back(kv.first);
		            j["keys_captured"] = arr2;
		            j["key_count"] = (int)db_registry::g_keys.size();
		        }
		    }
		}
		j["IsLogin"] = g_IsLogin;
		j["note"] = "只读快照：不跑任何 SQL、不改任何状态；POST {\"force\":true} 才触发一次（30 秒节流）";
		return j;
	}

	// ── POST /Debug/DBRescan {"force":true}：触发一次取名扫描 ───────────
	// 带 30 秒节流：节流窗口内返回"太快了"而不是硬扫。
	nlohmann::ordered_json DatabaseMgr::dbRescanForce() {
		if (g_WxVersion != 0) {
		    const int scanned = db_registry::scanByVfsSafe(m_sqlite3Rountines);
		    OutputDebugStringA((std::string("[db_registry][new] VFS 扫描登记 ") + std::to_string(scanned) + " 个\n").c_str());
		}
		const int added = namePass();
		nlohmann::ordered_json j;
		if (added < 0) {
			j["forced"] = false;
			j["throttled"] = true;
			j["message"] = "太快了：取名扫描最多每 30 秒一次（连续没收获会指数退避到 5 分钟）";
		} else {
			j["forced"] = true;
			j["added"] = added;
			j["message"] = format_string("扫完了，本次补上 %d 个库名", added);
		}
		searchDatabases();                    // 合并进缓存（逐条维护，绝不清空）
		j["report"] = dbRescanReport();
		return j;
	}
	// ══════════════════════════════════════════════════════════════════
	//  API 表诊断（2026-10-21）
	//  背景：外部部署反馈「GetAllDBName 能列库，但 QueryDB/execute 一律
	//        get database handle which named xxx failed」，且 registry 里
	//        prepare 抓到的句柄 db 名为空。
	//  取名靠 api->db_filename；如果那个槽位是 null，名字永远为空 →
	//        按名查找必然全 miss。
	//  这里把每个关键槽位的**地址**和**是否落在 Weixin.dll 模块内**列出来，
	//  一眼就能分清：钩子没装上 vs 装了但入口不对 vs 槽位为空。
	//  红线：纯只读，不调任何 sqlite API、不发 SQL、不改状态。
	// ══════════════════════════════════════════════════════════════════
	nlohmann::ordered_json DatabaseMgr::apiTableReport() {
		nlohmann::ordered_json j;
		const uintptr_t base = (uintptr_t)g_hWeixinDll;
		uintptr_t size = (uintptr_t)g_MyModuleSize;
		if (size == 0 && base != 0) {                    // 兜底：读 PE 的 SizeOfImage
		    const IMAGE_DOS_HEADER* dos = (const IMAGE_DOS_HEADER*)base;
		    if (dos->e_magic == IMAGE_DOS_SIGNATURE) {
		        const IMAGE_NT_HEADERS* nt = (const IMAGE_NT_HEADERS*)(base + (uintptr_t)dos->e_lfanew);
		        if (nt->Signature == IMAGE_NT_SIGNATURE) size = (uintptr_t)nt->OptionalHeader.SizeOfImage;
		    }
		}
		const uintptr_t end = base + size;

		j["module_base"] = format_string("0x%llX", (unsigned long long)base);
		j["module_size"] = (unsigned long long)size;
		j["module_end"] = format_string("0x%llX", (unsigned long long)end);
		j["api_table"] = format_string("0x%llX", (unsigned long long)(uintptr_t)m_sqlite3Rountines);
		j["api_table_in_module"] = (base != 0 && (uintptr_t)m_sqlite3Rountines >= base
		                            && (uintptr_t)m_sqlite3Rountines < end);
		j["IsLogin"] = g_IsLogin;

		nlohmann::ordered_json slots = nlohmann::ordered_json::object();
		auto probe = [&](const char* name, const void* fn) {
			nlohmann::ordered_json x;
			const uintptr_t p = (uintptr_t)fn;
			x["addr"] = format_string("0x%llX", (unsigned long long)p);
			x["is_null"] = (p == 0);
			x["in_module"] = (base != 0 && size != 0 && p >= base && p < end);
			x["readable"] = (p != 0 && IsReadableRegion((const void*)p, 1));
			slots[name] = x;
		};

		if (m_sqlite3Rountines != nullptr) {
			probe("open",         (const void*)m_sqlite3Rountines->open);
			probe("open16",       (const void*)m_sqlite3Rountines->open16);
			probe("open_v2",      (const void*)m_sqlite3Rountines->open_v2);
			probe("prepare",      (const void*)m_sqlite3Rountines->prepare);
			probe("prepare16",    (const void*)m_sqlite3Rountines->prepare16);
			probe("prepare_v3",   (const void*)m_sqlite3Rountines->prepare_v3);
			probe("prepare16_v3", (const void*)m_sqlite3Rountines->prepare16_v3);
			probe("db_filename",  (const void*)m_sqlite3Rountines->db_filename);
			probe("db_handle",    (const void*)m_sqlite3Rountines->db_handle);
			probe("exec",         (const void*)m_sqlite3Rountines->exec);
			probe("step",         (const void*)m_sqlite3Rountines->step);
			probe("finalize",     (const void*)m_sqlite3Rountines->finalize);
			probe("db_mutex",   (const void*)m_sqlite3Rountines->db_mutex);
			probe("mutex_enter",(const void*)m_sqlite3Rountines->mutex_enter);
			probe("mutex_leave",(const void*)m_sqlite3Rountines->mutex_leave);
		} else {
			j["api_table_null"] = true;
		}
		j["slots"] = slots;
		// sqlite 版本与线程模式（验证 api 表布局 / 连接是否 FULLMUTEX）
		try {
		    if (m_sqlite3Rountines->libversion) j["libversion"] = m_sqlite3Rountines->libversion();
		    if (m_sqlite3Rountines->xthreadsafe) j["xthreadsafe"] = m_sqlite3Rountines->xthreadsafe();
		    if (m_sqlite3Rountines->compileoption_used) j["threadsafe_opt"] = m_sqlite3Rountines->compileoption_used("THREADSAFE");
		} catch (...) { j["sqlite_info_error"] = true; }

		j["hooks_installed"] = {
			{ "open_v2_code", db_registry::openHookInstalled() },
			{ "open_v1_code", db_registry::g_installedOpenV1 && db_registry::g_origOpen != nullptr },
			{ "prepare",      db_registry::prepareHookInstalled() },
		};
		j["counters"] = {
			{ "registrations",  (long long)db_registry::g_registrations.load(std::memory_order_relaxed) },
			{ "open_v2_names",  (long long)db_registry::g_openNamed.load(std::memory_order_relaxed) },
			{ "name_pass_runs", (long long)db_registry::g_namePassRuns.load(std::memory_order_relaxed) },
		};
		j["note"] = "纯只读快照：不调任何 sqlite API、不发 SQL、不改任何状态";

		return j;
	}


}
