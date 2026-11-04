#include "wx_send.h"
#include "CrashLog.h"
#include <vector>
#include <mutex>
#include <atomic>
#include "MinHook.h"
#include <windows.h>
#include <string>
#include <cstddef>
#include <cstring>
#include <objbase.h>
#include "global.h"
#include "tools.h"

using WeixinCall = __int64(*)(...);


namespace Memory
{
    // 分配内存（在当前进程）
    inline void* Allocate(size_t size)
    {
        return VirtualAlloc(nullptr, size, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    }

    // 释放内存
    inline void Free(void* ptr)
    {
        if (ptr) VirtualFree(ptr, 0, MEM_RELEASE);
    }

    // 写入内存
    template<typename T>
    inline void Write(void* address, T value)
    {
        if (address) {
            *reinterpret_cast<T*>(address) = value;
        }
    }

    // 写入字节集
    inline void WriteBytes(void* address, const void* data, size_t size)
    {
        if (address && data) {
            memcpy(address, data, size);
        }
    }

    // 写入字符串
    inline void WriteString(void* address, const std::string& str)
    {
        if (address) {
            memcpy(address, str.c_str(), str.length() + 1);
        }
    }
}


namespace WeixinSend
{
    // ============================================================
    // util
    // ============================================================
    uintptr_t GetWeixinDllBase()
    {
        static uintptr_t base = 0;
        if (!base)
            base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        return base;
    }

    static std::string GenGuidString()
    {
        GUID guid;
        CoCreateGuid(&guid);

        char buf[64] = { 0 };
        // 36 chars, no braces
        snprintf(buf, sizeof(buf),
            "%08x-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x",
            guid.Data1,
            guid.Data2,
            guid.Data3,
            guid.Data4[0], guid.Data4[1],
            guid.Data4[2], guid.Data4[3],
            guid.Data4[4], guid.Data4[5],
            guid.Data4[6], guid.Data4[7]
        );

        return std::string(buf);
    }

    static uint64_t CalcWxCapacity(uint64_t len)
    {
        uint64_t need = len + 1;                
        uint64_t cap = (need + 0xF) & ~0xFULL;  
        return cap - 1;                           // 微信风格
    }


    template<typename T>
    T* HeapAlloc_mb(size_t count)
    {
        return (T*)::HeapAlloc(
            ::GetProcessHeap(),
            HEAP_ZERO_MEMORY,
            sizeof(T) * count
        );
    }


#pragma pack(push, 1)

    struct WeixinStringUnicode
    {
        union
        {
            wchar_t inline_buf[8];  
            wchar_t* heap_buf;
        };
        uint64_t length;  
        uint64_t cap;    
    };

    struct WeixinString
    {
        union
        {
            char  inline_buf[16];
            char* heap_buf;
        };
        uint64_t length;
        uint64_t cap; 
    };
    struct TextMessage
    {
        uint64_t pad0[22] = { 0 };          // 0x000
        WeixinString receiver;              // 0x0B0
        uint64_t pad1[1] = { 0 };           // 0x0D0
        uint64_t type;                      // 0x0D8
        uint64_t pad2[21] = { 0 };          // 0x0E0
        uint64_t msg_len;                   // 0x188
        uint64_t pad3[163] = { 0 };         // 0x190
        WeixinString uuid;                  // 0x6A8
        uint64_t pad4[8] = { 0 };           // 0x6C8
        WeixinString content;               // 0x708
        WeixinString atlist;                // 0x728
    };

    static_assert(sizeof(WeixinString) == 0x20);
    static_assert(offsetof(TextMessage, receiver) == 0x0B0);
    static_assert(offsetof(TextMessage, uuid) == 0x6A8);
    static_assert(offsetof(TextMessage, content) == 0x708);

    struct UnknownBlock
    {
        uint64_t vtable;
        uint64_t temp[6];
        uint64_t self;
    };

    struct InnerStruct1
    {
        void* ptr1;      // +0x00
        void* ptr2;      // +0x08
        void* ptr3;      // +0x10
        uint64_t count;  // +0x18
    };
    struct InnerStruct2
    {
        void* vtable;    // +0x00
        void* ptr1;      // +0x08
        uint64_t data1;  // +0x10
        uint64_t data2;  // +0x18
        uint64_t field1; // +0x20
    };


#pragma pack(pop)

    // ══════════════════════════════════════════════════════════════
    //  结构体布局自动校验
    //  目的：布局一旦被微信改掉，要"响亮地失败"，而不是静默发不出去。
    // ══════════════════════════════════════════════════════════════
    // 前向声明：structcheck::probe() 要用到它（定义在文件后面）
    void BuildTextMessage(uint64_t*, const std::string&, const std::string&, const std::string&);

    // 前向声明：VOICE-DUMP 只读埋点（完整定义在 structcheck 之后，见文件下方）。
    // structcheck 的 send_message detour 在"调原函数之前/之后"各调一次做快照 —— 只读，不改行为。
    namespace voicedump {
        void guardEnter(uint64_t a1, uint64_t a2);
        void guardLeave(uint64_t a1, uint64_t a2);
        bool isOn();     // 开关状态（1 秒缓存），供 detour 决定要不要跑 structcheck 的只读校验
    }

    namespace structcheck {

        struct OneCheck { std::string name, expected, actual; bool pass; };
        std::mutex g_mtx;
        std::vector<OneCheck> g_checks;
        bool g_probed = false, g_probeOk = false, g_hookOk = false;
        // 本次要发的内容（供真对象校验对比）
        std::string g_lastText, g_lastRoom, g_lastAt;
        // 真对象校验结果
        bool g_liveChecked = false, g_liveOk = false;
        std::string g_liveDetail;
        int g_liveOkCount = 0, g_liveBadCount = 0;
        int g_detourCalls = 0;              // detour 被调用的次数（无条件自增）
        std::string g_probeHex;             // 探针对象关键区域的原始字节

        inline bool inModule(const void* p) {
            // 直接读 PE 头拿 SizeOfImage —— 避免依赖 psapi.h（包含顺序有坑）
            uintptr_t base = (uintptr_t)g_hWeixinDll;
            if (base == 0 || IsBadReadPtr((void*)base, 0x40)) return false;
            uint32_t peOff = *(uint32_t*)(base + 0x3C);
            if (peOff == 0 || IsBadReadPtr((void*)(base + peOff), 0x60)) return false;
            if (*(uint32_t*)(base + peOff) != 0x00004550u) return false;   // PE magic
            uint32_t sizeOfImage = *(uint32_t*)(base + peOff + 0x50);
            if (sizeOfImage == 0) return false;
            uintptr_t a = (uintptr_t)p;
            return a >= base && a < base + sizeOfImage;
        }

        // 安全地把 WeixinString 读成 std::string（带长度/指针合法性保护）
        inline std::string readWxStr(const WeixinString* s) {
            if (s == nullptr) return "<null>";
            if (s->length == 0) return "";
            if (s->length > 8192) return "<bad length>";
            const char* p = (s->cap == 0xF) ? s->inline_buf : s->heap_buf;
            if (p == nullptr || IsBadReadPtr(p, (SIZE_T)s->length)) return "<bad ptr>";
            return std::string(p, (size_t)s->length);
        }

        inline void add(const std::string& name, const std::string& exp, const std::string& act) {
            OneCheck c;
            c.name = name; c.expected = exp; c.actual = act; c.pass = (exp == act);
            g_checks.push_back(c);
            if (!c.pass) {
                char buf[256];
                sprintf_s(buf, "[structcheck] FAIL %s: 期望 %s，实际 %s\n", name.c_str(), exp.c_str(), act.c_str());
                OutputDebugStringA(buf);
            }
        }

        // ── ① 探针 ─────────────────────────────────────────────
        void probe() {
            std::lock_guard<std::mutex> lg(g_mtx);
            if (g_probed) return;
            g_probed = true;
            g_checks.clear();

            uintptr_t base = (uintptr_t)g_hWeixinDll;
            std::vector<uint64_t> buf(0x768, 0);          // 8 字节对齐、已清零
            BuildTextMessage(buf.data(), "probe_text", "probe_room", "probe_at");

            // vtable 指针必须等于 offset::txt_message_vtbl，且该处确实像一张 vtable
            uint64_t vt = buf[0];
            add("vtable 指针", std::to_string(base + offset::txt_message_vtbl), std::to_string(vt));
            uint64_t firstEntry = 0;
            if (!IsBadReadPtr((void*)(uintptr_t)vt, 8)) firstEntry = *(uint64_t*)(uintptr_t)vt;
            add("vtable 首项在模块内", "1", inModule((void*)(uintptr_t)firstEntry) ? "1" : "0");

            // WeixinString 的 ABI 假设：cap 在 +0x18、length 在 +0x10、文本在 +0x00
            uint8_t* p = (uint8_t*)buf.data();
            struct Field { const char* name; size_t off; const char* want; };
            Field fields[] = {
                { "receiver@0x0B0", 0x0B0, "probe_room" },
                { "content@0x708",  0x708, "probe_text" },
                { "atlist@0x728",   0x728, "probe_at"   },
            };
            for (auto& f : fields) {
                const WeixinString* ws = (const WeixinString*)(p + f.off);
                add(std::string(f.name) + " 文本", f.want, readWxStr(ws));
                add(std::string(f.name) + " cap=0xF", "15", std::to_string((unsigned long long)ws->cap));
                add(std::string(f.name) + " length", std::to_string(strlen(f.want)), std::to_string((unsigned long long)ws->length));
            }

            // 关键区域原始字节（看清字符串到底落在哪个偏移）
            {
                char hx[1024]; hx[0] = 0;
                for (size_t k = 0x0B0; k < 0x0B0 + 48; k++) sprintf_s(hx + strlen(hx), 8, "%02X ", p[k]);
                g_probeHex = std::string("probeHex 转储 @0x0B0: ") + hx + " | @0x700: ";
                for (size_t k = 0x700; k < 0x700 + 48; k++) sprintf_s(hx + strlen(hx), 8, "%02X ", p[k]);
                g_probeHex += hx;
            }

            g_probeOk = true;
            for (auto& c : g_checks) if (!c.pass) { g_probeOk = false; break; }

            char msg[128];
            sprintf_s(msg, "[structcheck] 探针结果：%s（共 %zu 项）\n", g_probeOk ? "通过" : "未通过", g_checks.size());
            OutputDebugStringA(msg);
        }

        // ── ② 真对象校验（hook send_message）────────────────────
        // ⚠️ 签名由 void(a1,a2) 改成"6 参 + 返回 uint64_t"，三个理由：
        //   ① VOICE-DUMP 要在"原函数返回之后"再看一眼对象（微信可能在这期间往对象里补写本地路径）；
        //   ② 保住 rax 返回值 —— 微信自己的发送路径可能用这个返回值，void 声明会把它丢掉；
        //   ③ 6 个参数是**超集转发**：原函数只用几个就传几个，多传的无害，
        //      但少传（万一原函数其实用了 r8/r9）会把微信自己的发送搞坏。
        //      探针一律只读，异常全部吞在 voicedump 内部，绝不外传。
        typedef uint64_t (*SendMessage_t)(uint64_t, uint64_t, uint64_t, uint64_t, uint64_t, uint64_t);
        SendMessage_t g_origSendMessage = nullptr;

        void inspectLive(uint64_t a1, uint64_t a2) {
            // 参数链（与 SendText 里的构造一致）：arg1[1] -> data；data[1] -> TextMessage*
            std::string wantText, wantRoom, wantAt;
            {
                std::lock_guard<std::mutex> lg(g_mtx);
                wantText = g_lastText; wantRoom = g_lastRoom; wantAt = g_lastAt;
            }
            if (wantText.empty()) return;

            if (IsBadReadPtr((void*)(uintptr_t)a1, 0x28)) { g_liveDetail = "arg1 不可读"; g_liveOk = false; g_liveChecked = true; return; }
            uint64_t* data = (uint64_t*)((uint64_t*)a1)[1];
            if (data == nullptr || IsBadReadPtr(data, 0x20)) { g_liveDetail = "data 不可读"; g_liveOk = false; g_liveChecked = true; return; }
            TextMessage* m = (TextMessage*)data[1];
            if (m == nullptr || IsBadReadPtr(m, sizeof(TextMessage))) { g_liveDetail = "TextMessage 不可读"; g_liveOk = false; g_liveChecked = true; return; }

            std::string gotRoom = readWxStr(&m->receiver);
            std::string gotText = readWxStr(&m->content);
            std::string gotAt = readWxStr(&m->atlist);
            bool ok = (gotRoom == wantRoom) && (gotText == wantText) && (wantAt.empty() || gotAt == wantAt);

            std::lock_guard<std::mutex> lg(g_mtx);
            g_liveChecked = true;
            g_liveOk = ok;
            if (ok) g_liveOkCount++; else g_liveBadCount++;
            char buf[512];
            sprintf_s(buf, "[structcheck] 真对象校验 %s：room=%s text=%s atlist=%s\n",
                      ok ? "通过" : "未通过", gotRoom.c_str(), gotText.c_str(), gotAt.c_str());
            g_liveDetail = buf;
            OutputDebugStringA(buf);
        }

        uint64_t detourSendMessage(uint64_t a1, uint64_t a2, uint64_t a3, uint64_t a4,
                                   uint64_t a5, uint64_t a6) {
            g_detourCalls++;   // 先无条件计数：为 0 就说明钩子压根没被调用
            // ① 入口快照（只读）：此刻对象一定活着、且还是"输入态"，最适合找路径槽。
            //    guardEnter 内部自带开关判断 —— 关着时它立刻返回，等于零开销。
            voicedump::guardEnter(a1, a2);
            // structcheck 的真对象校验也是只读的（只写日志），但只在埋点开着时跑，
            // 免得"关着"时还有额外开销。
            if (voicedump::isOn()) inspectLive(a1, a2);
            // ② 原函数：参数超集转发，返回值原样带回
            uint64_t ret = g_origSendMessage ? g_origSendMessage(a1, a2, a3, a4, a5, a6) : 0;
            // ③ 出口快照（只读）：对比"发送期间微信有没有往对象里补写本地路径"
            voicedump::guardLeave(a1, a2);
            return ret;
        }

        void installSendHook() {
            if (g_hookOk || g_origSendMessage != nullptr) return;
            MH_STATUS st = MH_Initialize();
            if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) return;
            void* target = (void*)((uintptr_t)g_hWeixinDll + offset::send_message);
            if (MH_CreateHook(target, (LPVOID)&detourSendMessage, (LPVOID*)&g_origSendMessage) != MH_OK) return;
            if (MH_EnableHook(target) != MH_OK) { g_origSendMessage = nullptr; return; }
            g_hookOk = true;
            OutputDebugStringA("[structcheck] send_message 钩子已安装（真实对象布局校验 + VOICE-DUMP 只读埋点）\n");
        }

        inline void remember(const std::string& text, const std::string& room, const std::string& at) {
            std::lock_guard<std::mutex> lg(g_mtx);
            g_lastText = text; g_lastRoom = room; g_lastAt = at;
        }

        // 探针未通过 → 拒发（避免用错误的布局把微信弄崩）
        bool allowsSend() {
            std::lock_guard<std::mutex> lg(g_mtx);
            return g_probeOk;
        }

        std::string reportJson() {
            std::lock_guard<std::mutex> lg(g_mtx);
            std::string j = "{\n";
            j += "  \"probeRan\": " + std::string(g_probed ? "true" : "false") + ",\n";
            j += "  \"probeOk\": " + std::string(g_probeOk ? "true" : "false") + ",\n";
            j += "  \"advisoryOnly\": true,\n";
            j += "  \"sendHookInstalled\": " + std::string(g_hookOk ? "true" : "false") + ",\n";
            j += "  \"liveChecked\": " + std::string(g_liveChecked ? "true" : "false") + ",\n";
            j += "  \"liveOk\": " + std::string(g_liveOk ? "true" : "false") + ",\n";
            j += "  \"liveOkCount\": " + std::to_string(g_liveOkCount) + ",\n";
            j += "  \"liveBadCount\": " + std::to_string(g_liveBadCount) + ",\n";
            j += "  \"liveDetail\": \"" + g_liveDetail + "\",\n";
            j += "  \"detourCalls\": " + std::to_string(g_detourCalls) + ",\n";
            j += "  \"sendMessageOffset\": " + std::to_string((unsigned long long)offset::send_message) + ",\n";
            j += "  \"hookTarget\": " + std::to_string((unsigned long long)((uintptr_t)g_hWeixinDll + offset::send_message)) + ",\n";
            j += "  \"probeHex\": \"" + g_probeHex + "\",\n";
            j += "  \"checks\": [\n";
            for (size_t i = 0; i < g_checks.size(); i++) {
                auto& c = g_checks[i];
                j += "    {\"name\":\"" + c.name + "\",\"pass\":" + (c.pass ? "true" : "false")
                   + ",\"expected\":\"" + c.expected + "\",\"actual\":\"" + c.actual + "\"}";
                if (i + 1 < g_checks.size()) j += ",";
                j += "\n";
            }
            j += "  ]\n}\n";
            return j;
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  VOICE-DUMP：只读埋点（纯诊断，不改任何行为）
    //
    //  目的：实测"发语音时，本地 SILK 文件路径放在消息对象的哪个偏移"。
    //
    //  两条取证路径（互为印证）：
    //    ① send_message(Weixin.dll+offset::send_message) 的 detour —— 真实发送路径上的消息对象。
    //       KEY：发图时也会 dump。已知"图片本地路径在 +0xF0"，dump 里必须能在 +0xF0 看到它
    //       —— 能对上就证明"dump 出来的字节 + 偏移标注"是对的，语音那次的偏移就可信。
    //    ② 语音构造器 Weixin.dll+offset::voice_msg_ctr 的 detour —— 微信自己 new 出来的语音对象。
    //
    //  红线：
    //    * 只读：不写对象、不发消息、不改控制流、不改返回值
    //    * 所有"碰目标内存"的读取只走 safeRead()（4KB 分页读 + __try/__except）
    //    * 探针入口外面再包一层 __try/__except：任何异常都不许传播到微信的栈上
    //    * 开关默认关（<Weixin.exe 目录>\hook-voicedump.on 存在才干活）；send 40 次 / ctor 20 次事件上限
    //    * 关着的时候**一个钩子都不挂**（见 watchThread）：与已部署版本行为完全一致
    // ══════════════════════════════════════════════════════════════════
    namespace voicedump {

        constexpr int    kMaxSendEvents = 40;      // send_message 最多 dump 多少次事件（每事件 = 入口 + 出口两块）
                                                   //   文字消息不占名额（见 dumpSend），所以这 40 次基本都留给图片/语音
        constexpr int    kMaxCtorEvents = 20;      // 语音构造器最多 dump 多少次
        constexpr size_t kHexLen        = 0x230;   // hex 覆盖 obj[0,0x230)
                                                   //   = obj 前 0x220 ∪ inner 前 0x220（inner 恒 = obj+0x10）
        constexpr size_t kScanLen       = 0x800;   // 字符串扫描窗口（从 obj 起）
        constexpr size_t kFollowLen     = 0x200;   // 跟随指针后最多读多少字节
        constexpr int    kMaxStrLines   = 48;      // 单节最多打多少条字符串行
        constexpr size_t kMaxReport     = 128 * 1024;

        std::mutex            g_mtx;
        std::atomic<bool>     g_forceOn{ false };   // 运行时开关（HTTP 路由）
        std::atomic<bool>     g_swOn{ false };      // 开关文件是否存在（1 秒缓存，别在微信线程上每次都 stat）
        std::atomic<uint64_t> g_swAt{ 0 };
        std::atomic<bool>     g_sendHook{ false };
        std::atomic<bool>     g_ctorHook{ false };
        std::atomic<uint64_t> g_lastObj{ 0 };
        int                   g_sendEvents = 0;
        int                   g_ctorEvents = 0;
        bool                  g_capNoticed = false;
        std::string           g_lastReport;
        // 两个路径都用"定长缓冲 + 只写一次 + 原子发布"存：
        // 这样 enabled() 在微信线程上读它时不需要加锁，也不会有 std::string 撕裂读。
        char                  g_marker[2 * MAX_PATH] = { 0 };
        char                  g_logPath[2 * MAX_PATH] = { 0 };
        std::atomic<bool>     g_markerReady{ false };
        std::atomic<bool>     g_logPathReady{ false };
        HANDLE                g_hLog = INVALID_HANDLE_VALUE;
        uint64_t              g_wxBase = 0, g_wxEnd = 0;
        thread_local bool     t_sendDumped = false; // 本次 send_message 是否已在入口拿到 dump 名额

        // ── 基础设施 ────────────────────────────────────────────────
        inline std::string stamp() {
            SYSTEMTIME st; GetLocalTime(&st);
            char b[64];
            _snprintf_s(b, sizeof(b), _TRUNCATE, "%02d:%02d:%02d.%03d",
                        st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
            return std::string(b);
        }

        // 日志出口：OutputDebugStringA + 追加到 <Weixin.exe 目录>\hook-probe.log
        // 刻意沿用 probe 的**同一个文件**（不新开日志文件）；两个句柄都是 FILE_APPEND_DATA，互不干扰。
        inline void vlog(const std::string& line) {
            OutputDebugStringA(line.c_str());
            static std::mutex m;
            static bool tried = false;
            std::lock_guard<std::mutex> lg(m);
            if (g_hLog == INVALID_HANDLE_VALUE) {
                if (tried) return;
                tried = true;
                std::string path = "D:\\wxhook\\hook-probe.log";
                char exe[MAX_PATH] = { 0 };
                if (GetModuleFileNameA(nullptr, exe, MAX_PATH) > 0) {
                    std::string s(exe);
                    auto p = s.find_last_of("\\/");
                    if (p != std::string::npos) path = s.substr(0, p + 1) + "hook-probe.log";
                }
                memcpy(g_logPath, path.c_str(),
                       (path.size() + 1 < sizeof(g_logPath)) ? (path.size() + 1) : sizeof(g_logPath) - 1);
                g_logPath[sizeof(g_logPath) - 1] = 0;
                g_logPathReady.store(true, std::memory_order_release);
                g_hLog = CreateFileA(path.c_str(), FILE_APPEND_DATA,
                                     FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                                     OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
            }
            if (g_hLog == INVALID_HANDLE_VALUE) return;
            DWORD w = 0;
            WriteFile(g_hLog, line.data(), (DWORD)line.size(), &w, nullptr);
        }

        inline bool inModule(uint64_t v) { return g_wxBase && v >= g_wxBase && v < g_wxEnd; }

        inline void computeModuleRange() {
            uint64_t base = (uint64_t)g_hWeixinDll;
            if (base == 0 || IsBadReadPtr((void*)base, 0x40)) return;
            uint32_t pe = *(uint32_t*)(base + 0x3C);
            if (pe == 0 || IsBadReadPtr((void*)(base + pe), 0x60)) return;
            if (*(uint32_t*)(base + pe) != 0x00004550u) return;   // 'PE\0\0'
            uint32_t sz = *(uint32_t*)(base + pe + 0x50);         // SizeOfImage
            if (sz == 0) return;
            g_wxBase = base;
            g_wxEnd = base + sz;
        }

        inline void initPaths() {
            if (g_markerReady.load(std::memory_order_acquire)) return;
            std::string dir = "D:\\wxhook\\wx4110\\";
            char exe[MAX_PATH] = { 0 };
            if (GetModuleFileNameA(nullptr, exe, MAX_PATH) > 0) {
                std::string s(exe);
                auto p = s.find_last_of("\\/");
                if (p != std::string::npos) dir = s.substr(0, p + 1);
            }
            std::string marker = dir + "hook-voicedump.on";
            memcpy(g_marker, marker.c_str(),
                   (marker.size() + 1 < sizeof(g_marker)) ? (marker.size() + 1) : sizeof(g_marker) - 1);
            g_marker[sizeof(g_marker) - 1] = 0;
            g_markerReady.store(true, std::memory_order_release);
        }

        inline std::string markerPath() { return std::string(g_marker); }

        // 开关：文件存在（1 秒缓存）或运行时开关
        inline bool enabled() {
            uint64_t now = GetTickCount64();
            if (now - g_swAt.load() >= 1000) {
                g_swAt.store(now);
                bool on = false;
                if (g_markerReady.load(std::memory_order_acquire))
                    on = (GetFileAttributesA(g_marker) != INVALID_FILE_ATTRIBUTES);
                g_swOn.store(on);
            }
            return g_swOn.load() || g_forceOn.load();
        }

        bool isOn() { return enabled(); }   // 对外（structcheck detour 用）

        // 限流取号；超限只提示一次
        inline bool takeSlot(int& ctr, int cap, const char* what) {
            bool full = false;
            bool notice = false;
            {
                std::lock_guard<std::mutex> lg(g_mtx);
                if (ctr >= cap) {
                    full = true;
                    if (!g_capNoticed) { g_capNoticed = true; notice = true; }
                } else {
                    ctr++;
                }
            }
            if (notice) {
                vlog(std::string("[VOICE-DUMP] ") + stamp() + " " + what + " 已达上限 " +
                     std::to_string(cap) + " 次，后续不再 dump（删掉 hook-voicedump.on 即停）\r\n");
            }
            return !full;
        }

        // ── 唯一的"碰目标内存"的地方 ─────────────────────────────────
        // 按 4KB 页切块读：某页没映射就停在那一页，已读到的部分照旧返回。
        // 异常全吞 —— 绝不外传。（本函数刻意不声明任何带析构的局部对象）
        inline size_t safeRead(uint64_t addr, void* dst, size_t n) {
            uint8_t* d = (uint8_t*)dst;
            size_t got = 0;
            __try {
                while (got < n) {
                    size_t pageLeft = 0x1000 - (size_t)((addr + got) & 0xFFF);
                    size_t chunk = (n - got < pageLeft) ? (n - got) : pageLeft;
                    memcpy(d + got, (const void*)(uintptr_t)(addr + got), chunk);
                    got += chunk;
                }
            }
            __except (EXCEPTION_EXECUTE_HANDLER) {
                // 读到哪算哪
            }
            return got;
        }

        // ── 字符判定 / 转码 ────────────────────────────────────────
        inline bool wideOk(uint16_t c) {
            if (c >= 0x20 && c < 0x7F) return true;        // ASCII 可见
            if (c == 0x09) return true;                    // tab
            if (c >= 0x4E00 && c <= 0x9FFF) return true;   // CJK 汉字
            if (c >= 0x3000 && c <= 0x303F) return true;   // CJK 标点
            if (c >= 0xFF00 && c <= 0xFFEF) return true;   // 全角
            return false;
        }
        inline bool narrowOk(uint8_t c) { return (c >= 0x20 && c < 0x7F) || c >= 0x80; }
        inline bool narrowAscii(uint8_t c) { return c >= 0x20 && c < 0x7F; }

        // 日志里只转义引号和控制字符；反斜杠保留原样（Windows 路径要能直接看）
        inline std::string escapeForLog(const std::string& s) {
            std::string o;
            o.reserve(s.size());
            for (size_t i = 0; i < s.size(); i++) {
                unsigned char c = (unsigned char)s[i];
                if (c == '"') { o += "\\\""; }
                else if (c < 0x20) { o.push_back('.'); }
                else { o.push_back((char)c); }
            }
            return o;
        }

        inline std::string wideToUtf8(const wchar_t* w, size_t n) {
            if (n == 0) return std::string();
            int need = WideCharToMultiByte(CP_UTF8, 0, w, (int)n, nullptr, 0, nullptr, nullptr);
            if (need <= 0) return std::string();
            std::string s((size_t)need, '\0');
            WideCharToMultiByte(CP_UTF8, 0, w, (int)n, &s[0], need, nullptr, nullptr);
            return s;
        }

        // "从 p 处开始就是一条字符串"（WeixinString 的 heap_buf 正是这样）
        inline std::string strAtWide(const uint8_t* p, size_t got) {
            std::wstring w;
            size_t n = 0;
            while (n + 1 < got && w.size() < 512) {
                uint16_t c = (uint16_t)(p[n] | (p[n + 1] << 8));
                if (!wideOk(c)) break;
                w.push_back((wchar_t)c);
                n += 2;
            }
            if (w.size() < 4) return std::string();
            return escapeForLog(wideToUtf8(w.c_str(), w.size()));
        }

        inline std::string strAtNarrow(const uint8_t* p, size_t got) {
            std::string s;
            size_t n = 0, ascii = 0;
            while (n < got && s.size() < 512) {
                if (!narrowOk(p[n])) break;
                if (narrowAscii(p[n])) ascii++;
                s.push_back((char)p[n]);
                n++;
            }
            if (s.size() < 4 || ascii * 5 < s.size() * 3) return std::string();
            return escapeForLog(s);
        }

        // 偏移标注：同时给 obj 相对 与 inner 相对（inner = obj+0x10），免得事后自己减
        inline void labelOff(char* b, size_t cb, size_t off) {
            if (off >= 0x10) {
                _snprintf_s(b, cb, _TRUNCATE, "obj+0x%03llX (inner+0x%03llX)",
                            (unsigned long long)off, (unsigned long long)(off - 0x10));
            } else {
                _snprintf_s(b, cb, _TRUNCATE, "obj+0x%03llX (inner 之前)",
                            (unsigned long long)off);
            }
        }

        // ── 扫描：对象内部的 UTF-16LE / 窄字符可读串 ─────────────────
        inline void scanWide(const uint8_t* buf, size_t len, std::vector<std::string>& out, int& budget) {
            size_t i = 0;
            while (i + 1 < len && budget > 0) {
                uint16_t c = (uint16_t)(buf[i] | (buf[i + 1] << 8));
                if (!wideOk(c)) { i++; continue; }
                size_t start = i;
                std::wstring w;
                while (i + 1 < len && w.size() < 512) {
                    uint16_t d = (uint16_t)(buf[i] | (buf[i + 1] << 8));
                    if (!wideOk(d)) break;
                    w.push_back((wchar_t)d);
                    i += 2;
                }
                if (w.size() >= 4) {
                    char lb[80];
                    labelOff(lb, sizeof(lb), start);
                    out.push_back(std::string(lb) + "  WIDE-STR   \"" +
                                  escapeForLog(wideToUtf8(w.c_str(), w.size())) + "\"");
                    budget--;
                } else {
                    i = start + 1;   // 不是串：从下一个字节重新找
                }
            }
        }

        inline void scanNarrow(const uint8_t* buf, size_t len, std::vector<std::string>& out, int& budget) {
            size_t i = 0;
            while (i < len && budget > 0) {
                if (!narrowOk(buf[i])) { i++; continue; }
                size_t start = i, n = 0, ascii = 0;
                while (i < len && narrowOk(buf[i]) && n < 512) {
                    if (narrowAscii(buf[i])) ascii++;
                    n++;
                    i++;
                }
                if (n >= 4 && ascii * 5 >= n * 3) {
                    char lb[80];
                    labelOff(lb, sizeof(lb), start);
                    out.push_back(std::string(lb) + "  NARROW-STR \"" +
                                  escapeForLog(std::string((const char*)buf + start, n)) + "\"");
                    budget--;
                } else {
                    i = start + 1;
                }
            }
        }

        // ── 指针跟随：对象里的 qword 指向别处时，跟过去看是不是字符串 ──
        // 关键：路径比 7 个宽字符长时 WeixinString 走**堆**，对象里只存指针
        //（SetWeixinStringU：wstr.size() < 8 才 inline）。所以这一步是必需的，
        // 否则图片路径（+0xF0）根本看不见，也就没法校准。
        inline void followPtrs(const uint8_t* buf, size_t len, uint64_t objBase,
                               std::vector<std::string>& out, int& budget) {
            std::vector<uint8_t> t(kFollowLen, 0);
            for (size_t off = 0; off + 8 <= len && budget > 0; off += 8) {
                uint64_t v = 0;
                memcpy(&v, buf + off, 8);
                if (v < 0x10000 || v >= 0x00007FFFFFFFFFFFULL) continue;
                if (v & 1) continue;                                  // 不是对齐指针
                if (inModule(v)) continue;                            // 模块内 = vtable/代码
                if (v >= objBase && v < objBase + len) continue;       // 指向对象自身
                size_t got = safeRead(v, t.data(), t.size());
                if (got < 8) continue;
                std::string w = strAtWide(t.data(), got);
                std::string a = w.empty() ? strAtNarrow(t.data(), got) : std::string();
                if (w.empty() && a.empty()) continue;
                char lb[80], hb[64];
                labelOff(lb, sizeof(lb), off);
                _snprintf_s(hb, sizeof(hb), _TRUNCATE, "  PTR-STR   = 0x%llX -> ",
                            (unsigned long long)v);
                std::string line = std::string(lb) + hb;
                line += w.empty() ? ("narrow \"" + a + "\"") : ("wide   \"" + w + "\"");
                // 顺带报 WeixinString 的长度/容量槽（union 之后 +0x10 = length、+0x18 = cap）
                if (off + 0x20 <= len) {
                    uint64_t sl = 0, sc = 0;
                    memcpy(&sl, buf + off + 0x10, 8);
                    memcpy(&sc, buf + off + 0x18, 8);
                    if (sl > 0 && sl <= 0x10000 && sc <= 0x10000) {
                        char sb[80];
                        _snprintf_s(sb, sizeof(sb), _TRUNCATE,
                                    "   (slot+0x10 len=%llu, slot+0x18 cap=%llu)",
                                    (unsigned long long)sl, (unsigned long long)sc);
                        line += sb;
                    }
                }
                out.push_back(line);
                budget--;
            }
        }

        // ── 一次对象 dump（返回要写日志的整块文本）──────────────────
        std::string dumpObject(const std::string& tag, uint64_t obj, bool wantHex) {
            std::string o;
            if (obj == 0) return o;

            std::vector<uint8_t> buf(kScanLen, 0);
            size_t got = safeRead(obj, buf.data(), buf.size());
            if (got < 0x18) {
                char b[224];
                _snprintf_s(b, sizeof(b), _TRUNCATE,
                            "[VOICE-DUMP] %s %s obj=0x%llX 不可读（只拿到 %llu 字节）—— 跳过\r\n",
                            stamp().c_str(), tag.c_str(), (unsigned long long)obj,
                            (unsigned long long)got);
                return std::string(b);
            }

            uint64_t vtOuter = 0, tag8 = 0, vtInner = 0;
            memcpy(&vtOuter, buf.data() + 0x00, 8);
            memcpy(&tag8,    buf.data() + 0x08, 8);
            memcpy(&vtInner, buf.data() + 0x10, 8);

            char b[512];
            _snprintf_s(b, sizeof(b), _TRUNCATE,
                        "[VOICE-DUMP] ===== %s %s obj=0x%llX (读到 %llu 字节) =====\r\n",
                        stamp().c_str(), tag.c_str(), (unsigned long long)obj,
                        (unsigned long long)got);
            o += b;
            _snprintf_s(b, sizeof(b), _TRUNCATE,
                        "[VOICE-DUMP]   head: +0x00=0x%llX(inModule=%d)  +0x08=0x%llX(tag)  "
                        "+0x10=0x%llX(inModule=%d, 内层 vtable)   inner = obj+0x10\r\n",
                        (unsigned long long)vtOuter, inModule(vtOuter) ? 1 : 0,
                        (unsigned long long)tag8,
                        (unsigned long long)vtInner, inModule(vtInner) ? 1 : 0);
            o += b;
            {
                uint32_t d[8] = { 0, 0, 0, 0, 0, 0, 0, 0 };
                if (got >= 0x20) memcpy(d, buf.data(), 0x20);
                _snprintf_s(b, sizeof(b), _TRUNCATE,
                            "[VOICE-DUMP]   obj 前 8 个 dword : %08X %08X %08X %08X %08X %08X %08X %08X\r\n",
                            d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]);
                o += b;
                if (got >= 0x30) {
                    uint32_t e2[8] = { 0, 0, 0, 0, 0, 0, 0, 0 };
                    memcpy(e2, buf.data() + 0x10, 0x20);
                    _snprintf_s(b, sizeof(b), _TRUNCATE,
                                "[VOICE-DUMP]   inner(obj+0x10) 前 8 个 dword : %08X %08X %08X %08X %08X %08X %08X %08X"
                                "   （语音判别：inner+0x0C == 0x22/34）\r\n",
                                e2[0], e2[1], e2[2], e2[3], e2[4], e2[5], e2[6], e2[7]);
                    o += b;
                }
            }

            // ── ★ 字符串扫描（本地 SILK/图片路径会在这一节以明文现形）──
            o += "[VOICE-DUMP]   扫描窗口 = obj[0,0x800)；语音对象总大小只有 0x208，"
                 "所以 obj+0x230 之后的串可能属于相邻堆块 —— 认偏移时以 KEY 节里标出的槽位为准\r\n";
            int budgetW = kMaxStrLines, budgetN = kMaxStrLines, budgetP = kMaxStrLines;
            std::vector<std::string> sw, sn, sp;
            scanWide(buf.data(), got, sw, budgetW);
            scanNarrow(buf.data(), got, sn, budgetN);
            followPtrs(buf.data(), got, obj, sp, budgetP);

            o += "[VOICE-DUMP]   --- KEY 1/3: UTF-16LE 明文串（对象内部，偏移就是槽位）---\r\n";
            if (sw.empty()) o += "[VOICE-DUMP]     (无)\r\n";
            for (auto& s : sw) { o += "[VOICE-DUMP]     "; o += s; o += "\r\n"; }

            o += "[VOICE-DUMP]   --- KEY 2/3: 指针跟随（对象里只存指针时，路径在堆上）---\r\n";
            if (sp.empty()) o += "[VOICE-DUMP]     (无)\r\n";
            for (auto& s : sp) { o += "[VOICE-DUMP]     "; o += s; o += "\r\n"; }

            o += "[VOICE-DUMP]   --- KEY 3/3: 窄字符（ASCII/UTF-8）串 ---\r\n";
            if (sn.empty()) o += "[VOICE-DUMP]     (无)\r\n";
            for (auto& s : sn) { o += "[VOICE-DUMP]     "; o += s; o += "\r\n"; }

            // ── hex（覆盖 obj 前 0x220 与 inner 前 0x220 的并集）────────
            if (wantHex) {
                _snprintf_s(b, sizeof(b), _TRUNCATE,
                            "[VOICE-DUMP]   hex @obj[0x000..0x%03llX)  （偏移列 = 相对 obj；"
                            "inner 相对 = 该值 - 0x10；inner 从 +0x010 开始）\r\n",
                            (unsigned long long)kHexLen);
                o += b;
                size_t n = (got < kHexLen) ? got : kHexLen;
                for (size_t off = 0; off < n; off += 16) {
                    char line[160];
                    _snprintf_s(line, sizeof(line), _TRUNCATE, "     +%03llX  ",
                                (unsigned long long)off);
                    std::string hexs, ascs;
                    for (size_t k = 0; k < 16; k++) {
                        if (off + k < n) {
                            unsigned char c = buf[off + k];
                            char t[8];
                            _snprintf_s(t, sizeof(t), _TRUNCATE, "%02X ", c);
                            hexs += t;
                            ascs.push_back((c >= 0x20 && c < 0x7F) ? (char)c : '.');
                        } else {
                            hexs += "   ";
                            ascs.push_back(' ');
                        }
                    }
                    std::string row = std::string(line) + hexs + " |" + ascs + "|\r\n";
                    o += row;
                }
            }

            {
                std::lock_guard<std::mutex> lg(g_mtx);
                if (o.size() <= kMaxReport) g_lastReport = o;
                g_lastObj.store(obj);
            }
            return o;
        }

        // ── 消息对象判定 / 参数链挑选 ───────────────────────────────
        // 判据：外层 vtable（+0x00）与内层 vtable（+0x10）都落在 Weixin.dll 里。
        // 图片对象、文字对象、语音对象都满足；参数包装结构（param1_vtable 那个）不满足。
        inline bool validMsgObj(uint64_t p) {
            if (p == 0) return false;
            uint64_t hdr[3] = { 0, 0, 0 };
            if (safeRead(p, hdr, sizeof(hdr)) != sizeof(hdr)) return false;
            return inModule(hdr[0]) && inModule(hdr[2]);
        }

        // 只读埋点：send_message 的一次事件（入口 phase="ENTER" / 出口 phase="LEAVE"）。
        // takeSlotNow=true 时才消耗 dump 名额（出口那次复用入口已拿到的名额）。
        // 返回 true = 这一次已经 dump 过（供出口那次判断）。
        bool dumpSend(uint64_t a1, uint64_t a2, const char* phase, bool takeSlotNow) {
            (void)a2;
            uint64_t h1[3] = { 0, 0, 0 }, h2[3] = { 0, 0, 0 };
            uint64_t p1 = 0, p2 = 0;
            if (a1) {
                safeRead(a1, h1, sizeof(h1));
                safeRead(a1 + 8, &p1, 8);
            }
            if (p1) {
                safeRead(p1, h2, sizeof(h2));
                safeRead(p1 + 8, &p2, 8);
            }

            uint64_t obj = 0;
            const char* how = "";
            bool validated = true;
            if (validMsgObj(p2))      { obj = p2; how = "a1[1][1]"; }
            else if (validMsgObj(p1)) { obj = p1; how = "a1[1]"; }
            else if (validMsgObj(a1)) { obj = a1; how = "a1"; }
            else {
                // 兜底：在 a1 / a1[1] 的头 8 个 qword 里找一个像消息对象的
                uint64_t probes[2] = { a1, p1 };
                const char* names[2] = { "a1[*]", "a1[1][*]" };
                for (int k = 0; k < 2 && obj == 0; k++) {
                    if (probes[k] == 0) continue;
                    for (int i = 0; i < 8 && obj == 0; i++) {
                        uint64_t v = 0;
                        if (safeRead(probes[k] + (uint64_t)i * 8, &v, 8) != 8) break;
                        if (validMsgObj(v)) { obj = v; how = names[k]; }
                    }
                }
                if (obj == 0) {
                    obj = p2 ? p2 : (p1 ? p1 : a1);
                    how = "兜底(未通过校验)";
                    validated = false;
                }
            }
            if (obj == 0) return false;

            // 消息类型：外层 +0xE8（1=文字 / 3=图片 / 47=动图）；语音类内层 vtable 单独认
            uint64_t mtype = 0, innerVt = 0;
            safeRead(obj + 0xE8, &mtype, 8);
            safeRead(obj + 0x10, &innerVt, 8);
            bool isVoiceObj = (g_wxBase != 0) && (innerVt == g_wxBase + offset::voice_msg_vtbl2);

            if (takeSlotNow) {
                // 文字消息：只提示、不 dump、也不占名额 —— 否则机器人的文字流量
                // 会把 20 次名额吃光，真正要看的语音/图片反而 dump 不到。
                // 注意：**语音对象永不跳过**（哪怕它的 +0xE8 也恰好是 1）。
                if (mtype == 1 && !isVoiceObj) {
                    static std::atomic<int> textSeen{ 0 };
                    int n = ++textSeen;
                    if (n <= 3) {
                        char t[256];
                        _snprintf_s(t, sizeof(t), _TRUNCATE,
                                    "[VOICE-DUMP] %s 跳过一条文字消息（外层 +0xE8=1），不 dump、不占名额；累计文字=%d\r\n",
                                    stamp().c_str(), n);
                        vlog(t);
                    }
                    return false;
                }
                if (!takeSlot(g_sendEvents, kMaxSendEvents, "send_message")) return false;
            }

            std::string out;
            char b[768];
            _snprintf_s(b, sizeof(b), _TRUNCATE,
                        "[VOICE-DUMP]  参数链: a1=0x%llX[+0]=0x%llX[+8]=0x%llX -> p1=0x%llX[+0]=0x%llX[+8]=0x%llX -> p2=0x%llX\r\n",
                        (unsigned long long)a1, (unsigned long long)h1[0], (unsigned long long)h1[1],
                        (unsigned long long)p1, (unsigned long long)h2[0], (unsigned long long)h2[1],
                        (unsigned long long)p2);
            out += b;
            _snprintf_s(b, sizeof(b), _TRUNCATE,
                        "[VOICE-DUMP]  选中消息对象 = %s（0x%llX）；布局校验 = %s；"
                        "外层 +0xE8(消息类型) = %llu；内层 vtable = 0x%llX%s\r\n",
                        how, (unsigned long long)obj,
                        validated ? "通过（外层/内层 vtable 都在 Weixin.dll 里）"
                                  : "未通过（字段与预期不符，仍按此地址 dump，仅供参考）",
                        (unsigned long long)mtype, (unsigned long long)innerVt,
                        isVoiceObj ? "  <== 语音类内层 vtable，确认是语音对象" : "");
            out += b;
            out += dumpObject(std::string("SEND-") + phase, obj, true);
            vlog(out);
            return true;
        }

        // ── 语音构造器 dump ────────────────────────────────────────
        void dumpCtor(uint64_t self, uint64_t ret) {
            uint64_t wantOuter = g_wxBase + offset::voice_msg_vtbl;
            uint64_t wantInner = g_wxBase + offset::voice_msg_vtbl2;
            uint64_t obj = 0;
            const char* how = "";
            uint64_t cand[2] = { ret, self };
            const char* names[2] = { "返回值(rax)", "入参(rcx)" };
            for (int i = 0; i < 2 && obj == 0; i++) {
                uint64_t p = cand[i];
                if (p == 0) continue;
                uint64_t hdr[3] = { 0, 0, 0 };
                if (safeRead(p, hdr, sizeof(hdr)) != sizeof(hdr)) continue;
                if (hdr[0] == wantOuter || hdr[2] == wantInner || validMsgObj(p)) {
                    obj = p;
                    how = names[i];
                }
            }
            std::string out;
            char b[384];
            _snprintf_s(b, sizeof(b), _TRUNCATE,
                        "[VOICE-DUMP]  构造器 rax=0x%llX  rcx=0x%llX  期望外层 vtable=0x%llX 内层=0x%llX  选中=%s\r\n",
                        (unsigned long long)ret, (unsigned long long)self,
                        (unsigned long long)wantOuter, (unsigned long long)wantInner,
                        obj ? how : "（都不像语音对象，仍按 rax dump）");
            out += b;
            if (obj == 0) obj = ret ? ret : self;
            out += dumpObject("CTOR", obj, true);
            vlog(out);
        }

        // ── 探针入口（最外层这圈 __try 是最后一道保险）──────────────
        void guardEnter(uint64_t a1, uint64_t a2) {
            t_sendDumped = false;
            if (!enabled()) return;                                        // 关着：只花一次缓存读
            __try {
                t_sendDumped = dumpSend(a1, a2, "ENTER", true);
            } __except (EXCEPTION_EXECUTE_HANDLER) {
                OutputDebugStringA("[VOICE-DUMP] SEND-ENTER 探针异常，已吞掉（对象可能已失效）\n");
            }
        }

        void guardLeave(uint64_t a1, uint64_t a2) {
            if (!t_sendDumped) return;                                     // 入口没 dump，出口也不 dump
            t_sendDumped = false;
            __try {
                dumpSend(a1, a2, "LEAVE", false);                          // 复用入口已拿到的名额
            } __except (EXCEPTION_EXECUTE_HANDLER) {
                OutputDebugStringA("[VOICE-DUMP] SEND-LEAVE 探针异常，已吞掉（对象可能已释放）\n");
            }
        }

        // ── 钩子安装 ───────────────────────────────────────────────
        typedef uint64_t (*VoiceCtor_t)(uint64_t, uint64_t, uint64_t, uint64_t, uint64_t, uint64_t);
        VoiceCtor_t g_origVoiceCtor = nullptr;

        uint64_t detourVoiceCtor(uint64_t a1, uint64_t a2, uint64_t a3, uint64_t a4,
                                 uint64_t a5, uint64_t a6) {
            // 只读：先原样调原构造器（超集转发），拿到返回值和对象，再 dump。
            uint64_t ret = g_origVoiceCtor ? g_origVoiceCtor(a1, a2, a3, a4, a5, a6) : 0;
            if (enabled() && takeSlot(g_ctorEvents, kMaxCtorEvents, "语音构造器")) {
                __try {
                    dumpCtor(a1, ret);
                } __except (EXCEPTION_EXECUTE_HANDLER) {
                    OutputDebugStringA("[VOICE-DUMP] CTOR 探针异常，已吞掉\n");
                }
            }
            return ret;
        }

        void installSendHook() {
            structcheck::installSendHook();
            g_sendHook.store(structcheck::g_hookOk);
        }

        void installCtorHook() {
            if (g_ctorHook.load() || g_origVoiceCtor != nullptr) return;
            if (g_hWeixinDll == nullptr) return;
            MH_STATUS st = MH_Initialize();
            if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) return;
            void* target = (void*)((uintptr_t)g_hWeixinDll + offset::voice_msg_ctr);
            if (MH_CreateHook(target, (LPVOID)&detourVoiceCtor, (LPVOID*)&g_origVoiceCtor) != MH_OK) return;
            if (MH_EnableHook(target) != MH_OK) { g_origVoiceCtor = nullptr; return; }
            g_ctorHook.store(true);
            char b[256];
            _snprintf_s(b, sizeof(b), _TRUNCATE,
                        "[VOICE-DUMP] 语音构造器钩子已安装：Weixin.dll+0x%llX（只读 dump）\n",
                        (unsigned long long)offset::voice_msg_ctr);
            vlog(b);
        }

        // 启动后延迟起的**监视线程**：默认什么都不装（= 与已部署版本行为完全一致），
        // 只有开关真的打开（开关文件出现 / HTTP 开了运行时开关）才去挂 MinHook。
        // 这样"默认关"是真的零侵入；同时不必重启微信就能开。
        // 刻意不在 DllMain(loader lock) 里挂：挂不上最多是没数据，绝不能影响微信启动。
        DWORD WINAPI watchThread(LPVOID) {
            Sleep(1500);
            computeModuleRange();
            initPaths();

            bool announced = false;
            for (;;) {
                if (enabled()) {
                    installSendHook();
                    installCtorHook();
                    if (!announced) {
                        announced = true;
                        char b[768];
                        _snprintf_s(b, sizeof(b), _TRUNCATE,
                            "[VOICE-DUMP] %s 开关已开 → 钩子就位：send_message=%s  语音构造器=%s\r\n"
                            "[VOICE-DUMP] 开关文件 = %s；用法：现在去发一条语音（或发张图做校准）→ "
                            "本文件里看 \"SEND-ENTER / CTOR\" 段落的 KEY 1/3（UTF-16 明文串）、KEY 2/3（指针跟随）\r\n",
                            stamp().c_str(),
                            g_sendHook.load() ? "已装" : "未装（失败）",
                            g_ctorHook.load() ? "已装" : "未装（失败）",
                            g_marker);
                        vlog(b);
                    }
                } else if (!announced) {
                    static bool saidOnce = false;
                    if (!saidOnce) {
                        saidOnce = true;
                        char b[512];
                        _snprintf_s(b, sizeof(b), _TRUNCATE,
                            "[VOICE-DUMP] %s 只读埋点待命（默认关，未挂任何钩子，零侵入）："
                            "开关文件 = %s；创建它即开，或 POST /Debug/VoiceDump {\"on\":true}\r\n",
                            stamp().c_str(), g_marker);
                        vlog(b);
                    }
                }
                Sleep(2000);
            }
            return 0;
        }

        // 供 HTTP 路由用：立刻再 dump 一次最近捕获的对象（可能已释放 → 只读 + 异常全吞）
        void dumpLast() {
            uint64_t obj = g_lastObj.load();
            std::string out;
            char b[256];
            _snprintf_s(b, sizeof(b), _TRUNCATE,
                        "[VOICE-DUMP] %s MANUAL 重新 dump 最近一次捕获的对象\r\n", stamp().c_str());
            out += b;
            if (obj == 0) {
                out += "[VOICE-DUMP]  还没有捕获过任何对象（先发一条消息）\r\n";
                vlog(out);
                return;
            }
            out += dumpObject("MANUAL", obj, true);
            vlog(out);
        }
    }   // namespace voicedump

    // 新增: 设置 Unicode 字符串
    inline void SetWeixinStringU(WeixinStringUnicode* ws, const std::string& s)
    {
        memset(ws, 0, sizeof(WeixinStringUnicode));

        // 将 std::string (UTF-8) 转换为 std::wstring (Unicode)
        int size = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
        std::wstring wstr(size - 1, L'\0');
        MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, &wstr[0], size);

        ws->length = wstr.size();  // 设置长度
        if (wstr.size() < 8)
        {
            // 短字符串: 使用内联缓冲区
            memcpy(ws->inline_buf, wstr.data(), wstr.size() * sizeof(wchar_t));
            ws->inline_buf[wstr.size()] = L'\0';
            ws->cap = 0xF;
        }
        else
        {
            // 长字符串: 堆分配
            wchar_t* buf = (wchar_t*)::HeapAlloc(
                ::GetProcessHeap(),
                HEAP_ZERO_MEMORY,
                (wstr.size() + 1) * sizeof(wchar_t)
            );
            memcpy(buf, wstr.data(), (wstr.size() + 1) * sizeof(wchar_t));
            ws->heap_buf = buf;
            ws->cap = CalcWxCapacity(wstr.size());
        }
    }

    inline void SetWeixinString(WeixinString* dst, const std::string& src)
    {
        // 必须先清零
        memset(dst, 0, sizeof(WeixinString));

        dst->length = src.size();

        if (src.size() < 16)
        {
            // inline 模式
            memcpy(dst->inline_buf, src.data(), src.size());
            dst->cap = 0xF;
        }
        else
        {
            // heap 模式
            char* buf = (char*)::HeapAlloc(::GetProcessHeap(), HEAP_ZERO_MEMORY, src.size() + 1);
            //char* buf = (char*)Memory::Allocate(s.size() + 1);
            if (!buf) {
                Memory::Free(buf);
                return;
            }

            memcpy(buf, src.data(), src.size());
            buf[src.size()] = '\0';
            dst->heap_buf = buf;
            dst->cap = CalcWxCapacity(src.size());

        }
    }



    void BuildSendParam1_sub(uint64_t* msgBuf, const std::string& wxid, const std::string& imgPath)
    {
        uint64_t filesize = 文件_取大小(imgPath);
        std::string guid = GenGuidString();

        msgBuf[0] = (uintptr_t)g_hWeixinDll + offset::img_msg_vtbl;
        msgBuf[1] = 0x200000006;
        msgBuf[2] = (uintptr_t)g_hWeixinDll + offset::img_msg_vtb2;


        *(uint64_t*)(msgBuf + 0x40 / 8) = 0xF;
        *(uint64_t*)(msgBuf + 0x60 / 8) = 0xF;
        *(uint64_t*)(msgBuf + 0x80 / 8) = 0xF;
        *(uint64_t*)(msgBuf + 0xA0 / 8) = 0xF;
        *(uint64_t*)(msgBuf + 0xA8 / 8) = 0x0000000100000000;
        *(uint64_t*)(msgBuf + 0xB0 / 8) = 0x0000000700000000;

        // === wxid ===
        SetWeixinString((WeixinString*)(msgBuf + 0xC0 / 8), wxid);
        *(uint64_t*)(msgBuf + 0xD0 / 8) = wxid.size();
        *(uint64_t*)(msgBuf + 0xD8 / 8) = CalcWxCapacity(wxid.size());

        //文件类型 3= png图片   47 = gif
        *(uint64_t*)(msgBuf + 0xE8 / 8) = 3;        


        // === 图片路径 ===
        SetWeixinStringU((WeixinStringUnicode*)(msgBuf + 0xF0 / 8), imgPath);
        *(uint64_t*)(msgBuf + 0x100 / 8) = imgPath.size(); // 图片路径长度
        *(uint64_t*)(msgBuf + 0x108 / 8) = CalcWxCapacity(imgPath.size());


        *(uint64_t*)(msgBuf + 0x130 / 8) = 0xF;
        *(uint64_t*)(msgBuf + 0x150 / 8) = 7;
        *(uint64_t*)(msgBuf + 0x170 / 8) = 0xF;

        //0x178 = filename
		//0x188 & 0x190= filename length & capacity

        *(uint64_t*)(msgBuf + 0x198 / 8) = filesize;         //图片大小
        *(uint64_t*)(msgBuf + 0x1B8 / 8) = 0xF;

        *(uint64_t*)(msgBuf + 0x668 / 8) = 0xF;
        *(uint64_t*)(msgBuf + 0x688 / 8) = 0xF;
        *(uint64_t*)(msgBuf + 0x6B0 / 8) = 0xF;
        SetWeixinString((WeixinString*)(msgBuf + 0x6B8 / 8), guid);
        *(uint64_t*)(msgBuf + 0x6C8 / 8) = guid.size();      // length = 36
        *(uint64_t*)(msgBuf + 0x6D0 / 8) = CalcWxCapacity(guid.size());


        *(uint64_t*)(msgBuf + 0x6F0 / 8) = 0xF;
        *(uint64_t*)(msgBuf + 0x710 / 8) = 0xF;
        *(uint64_t*)(msgBuf + 0x738 / 8) = 0xF;
        *(uint64_t*)(msgBuf + 0x760 / 8) = 0xF;
        *(uint64_t*)(msgBuf + 0x780 / 8) = 0xF;
        *(uint64_t*)(msgBuf + 0x7A0 / 8) = 0xF;
    }

    void BuildSendParam2_Image(uint64_t* out)
    {
        // 获取 Weixin.dll 模块句柄
        uintptr_t hModule = (uintptr_t)GetModuleHandleA("Weixin.dll");

        uint64_t globalValue = *(uint64_t*)(hModule + offset::param2);


        WeixinCall create = (WeixinCall)(hModule + offset::create_param2);

        // 第一个分配: 16字节 (不是 0x10 * 8 = 128字节!)
        uint64_t* buf = (uint64_t*)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 0x10);

        // 分配三个 64 字节的结构
        auto p2 = (UnknownBlock*)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 64);
        auto p3 = (UnknownBlock*)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 64);
        auto p4 = (UnknownBlock*)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 64);

        p2->vtable = hModule + offset::param2_1;
        p2->temp[0] = 0;
        p2->temp[1] = 0;
        p2->temp[2] = 0;
        p2->temp[3] = 0;
        p2->temp[4] = 0;
        p2->temp[5] = 0;
        p2->self = (uint64_t)p2;

        p3->vtable = hModule + offset::param2_2;
        p3->temp[0] = 0;
        p3->temp[1] = 0;
        p3->temp[2] = 0;
        p3->temp[3] = 0;
        p3->temp[4] = 0;
        p3->temp[5] = 0;
        p3->self = (uint64_t)p3;

        p4->vtable = hModule + offset::param2_3;
        p4->temp[0] = 0;
        p4->temp[1] = 0;
        p4->temp[2] = 0;
        p4->temp[3] = 0;
        p4->temp[4] = 0;
        p4->temp[5] = 0;
        p4->self = (uint64_t)p4;

        // 调用子函数，参数顺序根据汇编确定
        // rcx = out, rdx = p4, r8 = p3, r9 = p2, [rsp+0x30] = buf, [rsp+0x38] = globalValue
        create(
            (uint64_t)out,      // arg1
            (uint64_t)p2,       // arg2
            (uint64_t)p3,       // arg3
            (uint64_t)p4,       // arg4
            (uint64_t)buf,      // arg5
            globalValue         // arg6 - 从 Weixin.dll+0x8E4C758 读取的值
        );
    }

    InnerStruct2* BuildSendParam1(uint64_t msgStruct)
    {
        // 获取 Weixin.dll 模块句柄
        uintptr_t hModule = (uintptr_t)GetModuleHandleA("Weixin.dll");

        // 分配第一个结构: 0x20 (32字节)
        InnerStruct1* struct1 = (InnerStruct1*)HeapAlloc(GetProcessHeap(), 8, 0x20);

        // 初始化第一个结构
        struct1->ptr1 = (void*)(msgStruct + 0x10);  // 指向消息结构的 +0x10 偏移
        struct1->ptr2 = (void*)(msgStruct); 
        struct1->ptr3 = nullptr;
        struct1->count = 0;

        // 分配第二个结构: 0x28 (40字节)
        InnerStruct2* struct2 = (InnerStruct2*)HeapAlloc(GetProcessHeap(), 8, 0x28);

        // 初始化第二个结构
        struct2->vtable = (void*)(hModule + offset::param1_vtable);  // vtable 指针
        struct2->ptr1 = struct1;                           // 指向第一个结构
        struct2->data1 = (uint64_t)struct1 + 0x10;               // 重复指针
        struct2->data2 = (uint64_t)struct1 + 0x10;               // 重复指针
        struct2->field1 = 1;                                 // 标志位 = 1

        // 返回第二个结构
        return struct2;
    }

    void SendImage(const std::string& wxid, const std::string& imgPath)
    {
        std::lock_guard<std::recursive_mutex> _lck(g_clientCallMutex);   // 串行化：发送与查库不能同时进客户端
        uintptr_t WeixinDLL_baseAddr = GetWeixinDllBase();

        uint64_t* msgStruct = (uint64_t*)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 0x7C0);
        if (!msgStruct) {
            return;
        }

        BuildSendParam1_sub(msgStruct, wxid, imgPath);

        uint64_t* struct2 = (uint64_t*)BuildSendParam1((uint64_t)msgStruct);


        uint64_t* paramStruct = (uint64_t*)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 0xE8);

        BuildSendParam2_Image(paramStruct);

        WeixinCall send_message = (WeixinCall)(WeixinDLL_baseAddr + offset::send_message);
        crashlog::Note("IMAGE send_message ENTER msgStruct=%p struct2=%p param=%p", msgStruct, struct2, paramStruct);
        send_message((uint64_t)struct2, (uint64_t)paramStruct);
        crashlog::Note("IMAGE send_message RETURN struct2=%p param=%p", struct2, paramStruct);

    }



    void BuildTextMessage(uint64_t* ptr, const std::string& text, const std::string& wxid,
                          const std::string& atlist = std::string())
    {
        uintptr_t base = GetWeixinDllBase();

        // 对齐原始布局
        ptr[0] = base + offset::txt_message_vtbl;
        ptr[1] = 0x200000005LL;


        WeixinCall init_text_st = (WeixinCall)(base + offset::txt_message_ctr);

        TextMessage* msg = reinterpret_cast<TextMessage*>(ptr + 2);
        init_text_st(reinterpret_cast<uint64_t>(msg));

        SetWeixinString(&msg->receiver, wxid);
        SetWeixinString(&msg->content, text);
        // ── 真 @ 的关键 ──
        // atlist 里放被 @ 的人的 wxid（多个用英文逗号分隔）。
        // 只有填了这个字段，被 @ 的人才会真的收到提醒（红点）；
        // 只把 "@名字" 写进正文的话，对方是收不到提醒的（只是看着像 @）。
        if (!atlist.empty()) {
            SetWeixinString(&msg->atlist, atlist);
        }
        msg->msg_len = text.length();
        msg->type = 1;
    }

    void BuildSendParam2_Text(uint64_t* a1)
    {
        uintptr_t base = GetWeixinDllBase();
        WeixinCall Build_Send_TextImg_Pars2 = (WeixinCall)(base + offset::create_param2);

        uint64_t a2 = base + offset::param2_1;
        uint64_t a3 = base + offset::param2_2;
        uint64_t a4 = base + offset::param2_3;

        uint64_t param2_addr = base + offset::param2;  
         

        uint64_t* buf = HeapAlloc_mb<uint64_t>(16);


        auto p2 = (UnknownBlock*)HeapAlloc_mb<uint64_t>(64);
        auto p3 = (UnknownBlock*)HeapAlloc_mb<uint64_t>(64);
        auto p4 = (UnknownBlock*)HeapAlloc_mb<uint64_t>(64);

        // === 必须清零 ===
        memset(p2, 0, sizeof(UnknownBlock));
        memset(p3, 0, sizeof(UnknownBlock));
        memset(p4, 0, sizeof(UnknownBlock));

        p2->vtable = a2;
        p2->self = (uint64_t)p2;

        p3->vtable = a3;
        p3->self = (uint64_t)p3;

        p4->vtable = a4;
        p4->self = (uint64_t)p4;

        // === 核心：最后一个参数必须解引用 ===
        Build_Send_TextImg_Pars2(
            (uint64_t)a1,
            (uint64_t)p2,
            (uint64_t)p3,
            (uint64_t)p4,
            (uint64_t)buf,
            *(uint64_t*)param2_addr
        );
    }

    void SendText(const std::string& wxidorgid, const std::string& msg,
                  const std::string& atlist)
    {
        std::lock_guard<std::recursive_mutex> _lck(g_clientCallMutex);   // 串行化：发送与查库不能同时进客户端
        uintptr_t base = GetWeixinDllBase();

		//不同版本需要调整 msgBuf 大小，过小会导致发送失败，过大会浪费内存 
        uint64_t* msgBuf = HeapAlloc_mb<uint64_t>(0x768);
        BuildTextMessage(msgBuf, msg, wxidorgid, atlist);

        uint64_t* data = HeapAlloc_mb<uint64_t>(0x20);
        data[0] = (uint64_t)(msgBuf + 2);
        data[1] = (uint64_t)(msgBuf);
        data[2] = 0;

        uint64_t* arg1 = HeapAlloc_mb<uint64_t>(0x28);
        arg1[0] = base + offset::param1_vtable;
        arg1[1] = reinterpret_cast<uint64_t>(data);
        arg1[2] = (uint64_t)data + 0x10;
        arg1[3] = (uint64_t)data + 0x10;
        arg1[4] = 1;

        uint64_t* arg2 = HeapAlloc_mb<uint64_t>(0xE8);
        BuildSendParam2_Text(arg2);

        WeixinCall send_message = (WeixinCall)(base + offset::send_message);
        crashlog::Note("TEXT send_message ENTER arg1=%p arg2=%p", arg1, arg2);
        send_message((uint64_t)arg1, (uint64_t)arg2);
        crashlog::Note("TEXT send_message RETURN arg1=%p arg2=%p", arg1, arg2);
    }



    std::string StructCheckReportJson() {
        return structcheck::reportJson();
    }

    // ══════════════════════════════════════════════════════════════════
    //  VOICE-DUMP 对外接口（只读诊断；默认关，开关文件 / HTTP 路由都能开）
    // ══════════════════════════════════════════════════════════════════
    namespace {
        std::string jsonEsc(const std::string& s) {
            std::string o;
            o.reserve(s.size() + 16);
            for (size_t i = 0; i < s.size(); i++) {
                unsigned char c = (unsigned char)s[i];
                switch (c) {
                    case '"':  o += "\\\""; break;
                    case '\\': o += "\\\\"; break;
                    case '\n': o += "\\n";  break;
                    case '\r': o += "\\r";  break;
                    case '\t': o += "\\t";  break;
                    default:
                        if (c < 0x20) {
                            char b[8];
                            _snprintf_s(b, sizeof(b), _TRUNCATE, "\\u%04X", (unsigned)c);
                            o += b;
                        } else {
                            o.push_back((char)c);
                        }
                }
            }
            return o;
        }
    }

    void StartVoiceDumpHookThread() {
        // 只起一次；真正的安装由监视线程按需做（避开 DllMain 的 loader lock，且默认不挂钩子）
        static bool started = false;
        if (started) return;
        started = true;
        HANDLE h = CreateThread(nullptr, 0, voicedump::watchThread, nullptr, 0, nullptr);
        if (h) CloseHandle(h);
    }

    void VoiceDumpSetEnabled(bool on) {
        voicedump::initPaths();
        voicedump::computeModuleRange();
        voicedump::g_forceOn.store(on);
        // 运行时开开关也立刻把钩子装上（幂等；装不上只是没数据，不影响微信）
        voicedump::installSendHook();
        voicedump::installCtorHook();
        voicedump::vlog(std::string("[VOICE-DUMP] ") + voicedump::stamp() +
                        " 运行时开关 -> " + (on ? "ON" : "OFF") +
                        "（标记文件 " + voicedump::markerPath() + "）\r\n");
    }

    void VoiceDumpNow() {
        __try {
            voicedump::dumpLast();
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            OutputDebugStringA("[VOICE-DUMP] MANUAL 探针异常，已吞掉\n");
        }
    }

    std::string VoiceDumpReportJson() {
        uint64_t lastObj = 0;
        std::string last, marker, logPath;
        int se = 0, ce = 0;
        {
            std::lock_guard<std::mutex> lg(voicedump::g_mtx);
            last = voicedump::g_lastReport;
            lastObj = voicedump::g_lastObj.load();
            marker = voicedump::markerPath();
            if (voicedump::g_logPathReady.load(std::memory_order_acquire))
                logPath = std::string(voicedump::g_logPath);
            se = voicedump::g_sendEvents;
            ce = voicedump::g_ctorEvents;
        }
        std::string j = "{\n";
        j += "  \"enabled\": " + std::string(voicedump::enabled() ? "true" : "false") + ",\n";
        j += "  \"forceOn\": " + std::string(voicedump::g_forceOn.load() ? "true" : "false") + ",\n";
        j += "  \"markerFile\": \"" + jsonEsc(marker) + "\",\n";
        j += "  \"markerExists\": " + std::string(voicedump::g_swOn.load() ? "true" : "false") + ",\n";
        j += "  \"logFile\": \"" + jsonEsc(logPath) + "\",\n";
        j += "  \"sendHookInstalled\": " + std::string(voicedump::g_sendHook.load() ? "true" : "false") + ",\n";
        j += "  \"ctorHookInstalled\": " + std::string(voicedump::g_ctorHook.load() ? "true" : "false") + ",\n";
        j += "  \"sendEvents\": " + std::to_string(se) + ",\n";
        j += "  \"ctorEvents\": " + std::to_string(ce) + ",\n";
        j += "  \"maxSendEvents\": " + std::to_string(voicedump::kMaxSendEvents) + ",\n";
        j += "  \"maxCtorEvents\": " + std::to_string(voicedump::kMaxCtorEvents) + ",\n";
        j += "  \"sendMessageOffset\": " + std::to_string((unsigned long long)offset::send_message) + ",\n";
        j += "  \"voiceCtorOffset\": " + std::to_string((unsigned long long)offset::voice_msg_ctr) + ",\n";
        j += "  \"voiceOuterVtable\": " + std::to_string((unsigned long long)offset::voice_msg_vtbl) + ",\n";
        j += "  \"voiceInnerVtable\": " + std::to_string((unsigned long long)offset::voice_msg_vtbl2) + ",\n";
        j += "  \"lastObj\": " + std::to_string((unsigned long long)lastObj) + ",\n";
        j += "  \"structCheckDetourCalls\": " + std::to_string(structcheck::g_detourCalls) + ",\n";
        j += "  \"note\": \"只读埋点：不发送、不改对象、不改行为。lastDump = 最近一次 dump 原文。\",\n";
        j += "  \"lastDump\": \"" + jsonEsc(last) + "\"\n}\n";
        return j;
    }

    void DecodePic(const std::string& enc_pic_path, const std::string& dec_pic_path)
    {
        uintptr_t base = GetWeixinDllBase();

        uint64_t* arg1 = HeapAlloc_mb<uint64_t>(0x28);
        SetWeixinString((WeixinString*)(arg1), enc_pic_path);

        uint64_t* arg2 = HeapAlloc_mb<uint64_t>(0x28);
        SetWeixinString((WeixinString*)(arg2), dec_pic_path);


        WeixinCall Decode_Pic = (WeixinCall)(base + offset::dec_pic_call);
        Decode_Pic((uint64_t)arg1, (uint64_t)arg2, 1);
    }

    // ══════════════════════════════════════════════════════════════════
    //  VOICE-SEND：/SendVoiceMsg —— 把一段本地 SILK 发成真正的语音气泡(type 34)
    //
    //  与 /SendImgMsg 的唯一结构差异：语音消息对象【不手搓】，而是调用微信
    //  自己的工厂 0x619A190（照抄真实发送链 0x54B02A0 → 0x6199D10 → 工厂）：
    //      factory(out[2], 收件人*, str0*, 时长*, arg5*)
    //  它做 new(0x778) + 外层包装 vtable + 内层 ctor（基类 ctor / GUID /
    //  自引用 shared_ptr / 收件人 / str0 / 时长 / arg5）。手搓那 0x778 字节
    //  还得复刻基类 ctor 与 shared_ptr 控制块，风险高得多。
    //  造好后写 inner+0xD8 = 34（与 0x6199D10 同一句），再走已验证的发送链：
    //      BuildSendParam1(outer) + BuildSendParam2_Text(arg2) + send_message
    //
    //  安全契约（不许削弱）：
    //    * 开关默认关（<Weixin.exe 目录>\hook-voice-send.on，或 POST /Debug/VoiceSend）；
    //      关着时一个字节都不碰客户端内存，直接返回错误码。
    //    * 对目标内存的所有读写走 safeRead*/safeWrite*（VirtualQuery 分页 + __try/__except）。
    //    * 造对象【前】预检：工厂/ctor/两个 vtable 都落在 Weixin.dll 内、函数首字节像
    //      函数开头、vtable[0] 是模块内代码指针且等于预期槽值；任一不符 → 拒发。
    //    * 造对象【后】逐字段回读校验：两层 vtable / 收件人 / str0 / 时长 / arg5 /
    //      GUID / 类型；任一不符 → 不发 + 返回错误码。
    //    * send_message 外面包 __try/__except；失败只返回错误码 + 记日志，不抛不崩。
    //    * 每次调用写完整日志：开关、文件与大小、对象地址、vtable、各字段值、
    //      send_message 返回、错误码。日志：<Weixin.exe 目录>\voice-send.log
    //    * 不影响任何既有路由（/SendTextMsg /SendImgMsg /QueryDB/* /Debug/* 一字不改）。
    // ══════════════════════════════════════════════════════════════════
    namespace voicesend {

        // ── 错误码 ────────────────────────────────────────────────────
        enum {
            kOk             = 0,
            kErrDisabled    = -1001,   // 特性开关关着
            kErrBadRequest  = -1002,   // 参数不合法（wxid/path/mode）
            kErrNoWeixinDll = -1003,   // 拿不到 Weixin.dll base
            kErrBadSilkFile = -1004,   // SILK 文件读不了 / 空 / 太大 / 魔数不对
            kErrPreflight   = -1005,   // 造对象前的布局预检没过
            kErrConstruct   = -1006,   // 工厂调用异常 / 返回空指针
            kErrLayout      = -1007,   // 造完对象后逐字段回读校验没过（不发）
            kErrSend        = -1008,   // send_message 抛异常
            kErrBusy        = -1009,   // 上一次还在发（串行化）
        };

        static const char* errName(int code)
        {
            switch (code) {
                case kOk:             return "ok";
                case kErrDisabled:    return "disabled (feature switch is OFF)";
                case kErrBadRequest:  return "bad request";
                case kErrNoWeixinDll: return "Weixin.dll base unavailable";
                case kErrBadSilkFile: return "bad silk file";
                case kErrPreflight:   return "preflight check failed";
                case kErrConstruct:   return "voice object construction failed";
                case kErrLayout:      return "post-construction layout check failed";
                case kErrSend:        return "send_message raised an exception";
                case kErrBusy:        return "busy (another voice send in progress)";
                default:              return "unknown";
            }
        }

        // ── 调参 ──────────────────────────────────────────────────────
        static const size_t   kMaxSilkBytes   = 4u * 1024u * 1024u;  // SILK 文件上限（60s 语音约 100KB）
        static const size_t   kMaxStr0Bytes   = 1u * 1024u * 1024u;  // str0 回读上限
        static const uint32_t kMsPerFrame     = 20;                  // 微信自己按 20ms/帧 折算（this+0x180 默认 20）
        static const uint32_t kArg5v0         = 4;                   // 真实调用点 0x54B03E1 = {u32 4, u32 3, u64 30000}
        static const uint32_t kArg5v1         = 3;
        static const uint64_t kArg5v2         = 30000;

        // 工厂的 5 号参数（栈参数）：16B → inner+0x730、[0x10] → inner+0x740、+0x18 的 std::string → inner+0x748
        struct VoiceArg5 {
            uint32_t    v0;
            uint32_t    v1;
            uint64_t    v2;
            uint8_t     flag;
            uint8_t     pad[7];
            WeixinString str1;
        };
        static_assert(sizeof(VoiceArg5) == 0x38, "VoiceArg5 must be 0x38 bytes");

        typedef uint64_t (*VoiceFactory_t)(uint64_t* out, const void* receiver,
                                           const void* str0, const uint32_t* durationMs,
                                           const void* arg5);

        // ── 状态 ──────────────────────────────────────────────────────
        static std::mutex        g_logMtx;
        static std::mutex        g_sendMtx;
        static std::atomic<bool> g_forceOn{ false };
        static std::atomic<bool> g_markerSeen{ false };
        static std::atomic<bool> g_pathsReady{ false };
        static std::atomic<uint64_t> g_calls{ 0 };
        static std::atomic<uint64_t> g_okCount{ 0 };
        static std::atomic<uint64_t> g_failCount{ 0 };
        static char              g_logPath[MAX_PATH * 2] = { 0 };
        static char              g_markerPath[MAX_PATH * 2] = { 0 };
        static std::string       g_lastLine;

        static void stamp(char* out, size_t n)
        {
            SYSTEMTIME st; GetLocalTime(&st);
            _snprintf_s(out, n, _TRUNCATE, "%02d:%02d:%02d.%03d",
                        st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
        }

        static void rawWrite(const char* s, size_t n)
        {
            if (g_logPath[0] == 0 || s == nullptr || n == 0) return;
            HANDLE h = CreateFileA(g_logPath, FILE_APPEND_DATA, FILE_SHARE_READ,
                                   nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
            if (h == INVALID_HANDLE_VALUE) return;
            DWORD wr = 0;
            WriteFile(h, s, (DWORD)n, &wr, nullptr);
            CloseHandle(h);
        }

        static void vlog(const std::string& s)
        {
            std::lock_guard<std::mutex> lg(g_logMtx);
            rawWrite(s.data(), s.size());
            OutputDebugStringA(s.c_str());
            g_lastLine = s;
        }

        static void initPaths()
        {
            if (g_pathsReady.load(std::memory_order_acquire)) return;
            char exe[MAX_PATH] = { 0 };
            if (GetModuleFileNameA(nullptr, exe, MAX_PATH) > 0) {
                char* slash = strrchr(exe, '\\');
                if (slash) *(slash + 1) = 0; else exe[0] = 0;
                _snprintf_s(g_logPath, sizeof(g_logPath), _TRUNCATE, "%svoice-send.log", exe);
                _snprintf_s(g_markerPath, sizeof(g_markerPath), _TRUNCATE, "%shook-voice-send.on", exe);
            }
            g_pathsReady.store(true, std::memory_order_release);
        }

        static std::string markerPath() { initPaths(); return std::string(g_markerPath); }
        static std::string logPath()    { initPaths(); return std::string(g_logPath); }

        static bool enabled()
        {
            if (g_forceOn.load()) return true;
            initPaths();
            if (g_markerPath[0] == 0) return false;
            bool on = (GetFileAttributesA(g_markerPath) != INVALID_FILE_ATTRIBUTES);
            g_markerSeen.store(on);
            return on;
        }

        // ── 安全内存访问 ──────────────────────────────────────────────
        // 注意：__try 作用域里不许放带析构的对象（沿用本文件既有纪律）。
        static bool readable(const void* p, size_t n)
        {
            if (p == nullptr || n == 0) return false;
            uintptr_t a = (uintptr_t)p;
            uintptr_t end = a + n;
            if (end < a) return false;                       // 溢出
            MEMORY_BASIC_INFORMATION mbi;
            uintptr_t cur = a;
            int guard = 0;
            while (cur < end && guard++ < 64) {
                if (VirtualQuery((LPCVOID)cur, &mbi, sizeof(mbi)) == 0) return false;
                if (mbi.State != MEM_COMMIT) return false;
                if (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)) return false;
                if ((mbi.Protect & 0xFF) == PAGE_EXECUTE) return false;
                uintptr_t regionEnd = (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
                if (regionEnd <= cur) return false;
                cur = regionEnd;
            }
            return cur >= end;
        }

        static bool sehCopy(const void* src, void* dst, size_t n)
        {
            if (src == nullptr || dst == nullptr || n == 0) return false;
            __try {
                memcpy(dst, src, n);
                return true;
            } __except (EXCEPTION_EXECUTE_HANDLER) {
                return false;
            }
        }

        static bool safeReadBytes(uint64_t addr, void* dst, size_t n)
        {
            if (addr == 0 || dst == nullptr || n == 0) return false;
            if (!readable((const void*)addr, n)) return false;
            return sehCopy((const void*)addr, dst, n);
        }

        static bool safeReadU64(uint64_t addr, uint64_t* out)
        {
            return safeReadBytes(addr, out, sizeof(uint64_t));
        }

        static bool safeReadU32(uint64_t addr, uint32_t* out)
        {
            return safeReadBytes(addr, out, sizeof(uint32_t));
        }

        static bool safeWriteBytes(uint64_t addr, const void* src, size_t n)
        {
            if (addr == 0 || src == nullptr || n == 0) return false;
            if (!readable((const void*)addr, n)) return false;
            DWORD oldProt = 0;
            if (!VirtualProtect((LPVOID)addr, n, PAGE_READWRITE, &oldProt)) return false;
            bool ok = false;
            __try {
                memcpy((void*)addr, src, n);
                ok = true;
            } __except (EXCEPTION_EXECUTE_HANDLER) {
                ok = false;
            }
            DWORD tmp = 0;
            VirtualProtect((LPVOID)addr, n, oldProt, &tmp);
            return ok;
        }

        static bool safeWriteU32(uint64_t addr, uint32_t v)
        {
            return safeWriteBytes(addr, &v, sizeof(uint32_t));
        }

        // 按 MSVC std::string 布局（buf@0 / size@+0x10 / cap@+0x18）安全回读
        static bool safeReadWxString(uint64_t addr, std::string* out, size_t maxBytes)
        {
            out->clear();
            uint64_t size = 0, cap = 0;
            if (!safeReadU64(addr + 0x10, &size)) return false;
            if (!safeReadU64(addr + 0x18, &cap)) return false;
            if (size > maxBytes) return false;
            if (size == 0) return true;
            if (cap >= 0x10) {
                uint64_t ptr = 0;
                if (!safeReadU64(addr, &ptr) || ptr == 0) return false;
                out->resize((size_t)size);
                return safeReadBytes(ptr, &(*out)[0], (size_t)size);
            }
            // SSO：数据就在对象内，最多 16 字节
            if (size > 16) return false;
            out->resize((size_t)size);
            return safeReadBytes(addr, &(*out)[0], (size_t)size);
        }

        static bool inModule(uint64_t p)
        {
            uintptr_t base = GetWeixinDllBase();
            if (base == 0 || p < base) return false;
            uint32_t peOff = 0;
            if (!safeReadU32((uint64_t)base + 0x3C, &peOff)) return false;
            uint32_t sizeOfImage = 0;
            if (!safeReadU32((uint64_t)base + peOff + 0x50, &sizeOfImage)) return false;
            return p < (uint64_t)base + sizeOfImage;
        }

        static std::string hexU64(uint64_t v)
        {
            char b[32];
            _snprintf_s(b, sizeof(b), _TRUNCATE, "0x%llX", (unsigned long long)v);
            return std::string(b);
        }

        static std::string hexDump(const std::string& d, size_t n)
        {
            std::string o;
            size_t m = d.size() < n ? d.size() : n;
            char b[8];
            for (size_t i = 0; i < m; i++) {
                _snprintf_s(b, sizeof(b), _TRUNCATE, "%02X ", (unsigned char)d[i]);
                o += b;
            }
            return o;
        }

        static void freeWxString(WeixinString* s)
        {
            if (s == nullptr) return;
            if (s->cap >= 0x10 && s->heap_buf != nullptr) {
                ::HeapFree(::GetProcessHeap(), 0, s->heap_buf);
            }
            s->heap_buf = nullptr;
            s->length = 0;
            s->cap = 0;
        }

        // ── 文件读取 / SILK 判定 ──────────────────────────────────────
        static bool readWholeFile(const std::string& path, std::string* out, std::string* err)
        {
            out->clear();
            HANDLE h = CreateFileA(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                   nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
            if (h == INVALID_HANDLE_VALUE) {
                char b[128];
                _snprintf_s(b, sizeof(b), _TRUNCATE, "CreateFileA failed, GetLastError=%lu",
                            (unsigned long)GetLastError());
                *err = b;
                return false;
            }
            LARGE_INTEGER sz; sz.QuadPart = 0;
            if (!GetFileSizeEx(h, &sz) || sz.QuadPart <= 0) {
                CloseHandle(h);
                *err = "empty file or GetFileSizeEx failed";
                return false;
            }
            if (sz.QuadPart > (LONGLONG)kMaxSilkBytes) {
                CloseHandle(h);
                *err = "file larger than 4 MB";
                return false;
            }
            out->resize((size_t)sz.QuadPart);
            size_t got = 0;
            while (got < out->size()) {
                DWORD rd = 0;
                size_t left = out->size() - got;
                DWORD want = (DWORD)(left > 0x100000 ? 0x100000 : left);
                if (!ReadFile(h, &(*out)[got], want, &rd, nullptr) || rd == 0) break;
                got += rd;
            }
            CloseHandle(h);
            if (got != out->size()) {
                *err = "short read";
                out->clear();
                return false;
            }
            return true;
        }

        static bool silkMagicOk(const std::string& d, size_t* bodyOff, std::string* note)
        {
            *bodyOff = 0;
            if (d.size() >= 1 && (unsigned char)d[0] == 0x02) *bodyOff = 1;
            if (d.size() >= *bodyOff + 9 && memcmp(d.data() + *bodyOff, "#!SILK_V3", 9) == 0) {
                *note = (*bodyOff == 1) ? "SILK_V3 (0x02 prefixed)" : "SILK_V3 (no 0x02 prefix)";
                return true;
            }
            if (d.size() >= *bodyOff + 6 && memcmp(d.data() + *bodyOff, "#!SILK", 6) == 0) {
                *note = "SILK (older magic)";
                return true;
            }
            *note = "not a SILK file (magic mismatch)";
            return false;
        }

        // 从 SILK V3 帧头估时长（微信自己按 20ms/帧 折算）。
        // 帧长有两种历史写法（含/不含尾字节），两种都试，优先"正好走完文件"的那种。
        static uint32_t silkFrameWalk(const std::string& d, size_t off, int minusOne, bool* exact)
        {
            uint32_t frames = 0;
            *exact = false;
            while (off + 2 <= d.size() && frames < 60000) {
                uint32_t n = (uint32_t)(unsigned char)d[off] | ((uint32_t)(unsigned char)d[off + 1] << 8);
                off += 2;
                if (n == 0) break;
                if (minusOne) { if (n == 0) break; n -= 1; }
                if (off + n > d.size()) return frames;
                off += n;
                ++frames;
            }
            *exact = (off == d.size());
            return frames;
        }

        static uint32_t estimateSilkDurationMs(const std::string& d, size_t bodyOff)
        {
            if (d.size() < bodyOff + 11) return 0;
            size_t off = bodyOff + 9;                 // 跳过 "#!SILK_V3"
            bool e0 = false, e1 = false;
            uint32_t f0 = silkFrameWalk(d, off, 0, &e0);
            uint32_t f1 = silkFrameWalk(d, off, 1, &e1);
            uint32_t f = 0;
            if (e0)      f = f0;
            else if (e1) f = f1;
            else         f = (f0 > f1) ? f0 : f1;
            if (f == 0) return 0;
            return f * kMsPerFrame;
        }

        // ── 预检 / 调用（__try 里不放带析构的对象）────────────────────
        struct PreflightInfo {
            uint64_t base = 0, factory = 0, ctor = 0, outerVt = 0, innerVt = 0;
            uint64_t outerSlot0 = 0, innerSlot0 = 0;
        };

        static bool preflight(PreflightInfo* pi, std::string* why)
        {
            uintptr_t base = GetWeixinDllBase();
            if (base == 0) { *why = "Weixin.dll base == 0"; return false; }
            pi->base      = (uint64_t)base;
            pi->factory   = (uint64_t)base + offset::voice_send_factory;
            pi->ctor      = (uint64_t)base + offset::voice_send_ctr;
            pi->outerVt   = (uint64_t)base + offset::voice_send_outer_vtbl;
            pi->innerVt   = (uint64_t)base + offset::voice_send_inner_vtbl;

            if (!inModule(pi->factory))  { *why = "factory RVA not inside Weixin.dll"; return false; }
            if (!inModule(pi->ctor))     { *why = "ctor RVA not inside Weixin.dll"; return false; }
            if (!inModule(pi->outerVt))  { *why = "outer vtable RVA not inside Weixin.dll"; return false; }
            if (!inModule(pi->innerVt))  { *why = "inner vtable RVA not inside Weixin.dll"; return false; }

            unsigned char b1 = 0, b2 = 0;
            if (!safeReadBytes(pi->factory, &b1, 1)) { *why = "factory not readable"; return false; }
            if (!safeReadBytes(pi->ctor, &b2, 1))    { *why = "ctor not readable"; return false; }
            // 4.1.10.27 两个函数都以 push rbp (0x55) 开头；放宽到常见 prologue 首字节
            if (!(b1 == 0x55 || b1 == 0x48 || b1 == 0x40 || b1 == 0x4C || b1 == 0xE9)) {   // 0xE9 = 眼睛探针的 jmp，转发安全
                *why = "factory first byte looks wrong: 0x" + hexDump(std::string(1, (char)b1), 1);
                return false;
            }
            if (!(b2 == 0x55 || b2 == 0x48 || b2 == 0x40 || b2 == 0x4C || b2 == 0xE9)) {
                *why = "ctor first byte looks wrong: 0x" + hexDump(std::string(1, (char)b2), 1);
                return false;
            }

            if (!safeReadU64(pi->outerVt, &pi->outerSlot0) || !inModule(pi->outerSlot0)) {
                *why = "outer vtable[0] is not a code pointer inside Weixin.dll";
                return false;
            }
            if (!safeReadU64(pi->innerVt, &pi->innerSlot0) || !inModule(pi->innerSlot0)) {
                *why = "inner vtable[0] is not a code pointer inside Weixin.dll";
                return false;
            }
            // 精确槽值校验（版本一旦变，这里会响亮地失败，而不是发出去崩）
            uint64_t wantOuter = (uint64_t)base + offset::voice_send_outer_slot0;
            uint64_t wantInner = (uint64_t)base + offset::voice_send_inner_dtor;
            if (pi->outerSlot0 != wantOuter) {
                *why = "outer vtable[0] mismatch: got " + hexU64(pi->outerSlot0) + " want " + hexU64(wantOuter);
                return false;
            }
            if (pi->innerSlot0 != wantInner) {
                *why = "inner vtable[0] mismatch: got " + hexU64(pi->innerSlot0) + " want " + hexU64(wantInner);
                return false;
            }
            return true;
        }

        static bool callFactory(uint64_t fn, uint64_t* out, const void* recv,
                                const void* str0, const uint32_t* dur, const void* arg5)
        {
            bool ok = false;
            __try {
                VoiceFactory_t f = (VoiceFactory_t)fn;
                f(out, recv, str0, dur, arg5);
                ok = true;
            } __except (EXCEPTION_EXECUTE_HANDLER) {
                ok = false;
            }
            return ok;
        }

        static bool callSendMessage(uint64_t fn, uint64_t arg1, uint64_t arg2, int64_t* ret)
        {
            bool ok = false;
            __try {
                WeixinCall f = (WeixinCall)fn;
                *ret = f(arg1, arg2);
                ok = true;
            } __except (EXCEPTION_EXECUTE_HANDLER) {
                ok = false;
            }
            return ok;
        }

        // ── 一条日志（先算好字符串，再一次性写）──────────────────────
        static void logLine(const std::string& s)
        {
            char ts[32]; stamp(ts, sizeof(ts));
            std::string line = "[VSEND] ";
            line += ts; line += " "; line += s; line += "\r\n";
            vlog(line);
        }
    }   // namespace voicesend

    // ══════════════════════════════════════════════════════════════════
    //  /SendVoiceMsg 的实现（对外入口；失败一律返回错误码，不抛不崩）
    // ══════════════════════════════════════════════════════════════════
    int SendVoice(const std::string& wxidorgid, const std::string& silkPath,
                  uint32_t durationMs, const std::string& str0Mode,
                  const std::string& str0Raw, std::string* detailJson)
    {
        std::lock_guard<std::recursive_mutex> _lck(g_clientCallMutex);   // 串行化：发送与查库不能同时进客户端
        using namespace voicesend;

        std::string detail = "{}";
        std::string mode = str0Mode.empty() ? std::string("path") : str0Mode;
        if (detailJson) *detailJson = detail;

        // ── 0) 开关（关着时绝不碰客户端内存）──────────────────────────
        bool on = enabled();
        uint64_t callNo = g_calls.fetch_add(1) + 1;
        if (!on) {
            logLine("call#" + std::to_string(callNo) + " REJECTED: " + errName(kErrDisabled) +
                    " (marker=" + markerPath() + ")");
            if (detailJson) {
                *detailJson = "{\"enabled\":false,\"reason\":\"" + jsonEsc(errName(kErrDisabled)) +
                              "\",\"markerFile\":\"" + jsonEsc(markerPath()) + "\"}";
            }
            return kErrDisabled;
        }

        // ── 1) 参数 ──────────────────────────────────────────────────
        if (wxidorgid.empty() || silkPath.empty()) {
            logLine("call#" + std::to_string(callNo) + " REJECTED: empty wxidorgid or path");
            return kErrBadRequest;
        }
        if (mode != "path" && mode != "bytes" && mode != "raw") {
            logLine("call#" + std::to_string(callNo) + " REJECTED: bad str0Mode=" + mode);
            return kErrBadRequest;
        }
        if (mode == "raw" && str0Raw.empty()) {
            logLine("call#" + std::to_string(callNo) + " REJECTED: str0Mode=raw but str0Raw empty");
            return kErrBadRequest;
        }

        // 串行化：同一时刻只发一条（避免并发造对象 / 并发进发送器）
        std::unique_lock<std::mutex> sendLock(g_sendMtx, std::try_to_lock);
        if (!sendLock.owns_lock()) {
            logLine("call#" + std::to_string(callNo) + " REJECTED: busy");
            return kErrBusy;
        }

        // ── 2) 读文件 + SILK 判定 ────────────────────────────────────
        std::string fileData, ferr, magicNote;
        if (!readWholeFile(silkPath, &fileData, &ferr)) {
            logLine("call#" + std::to_string(callNo) + " FAIL read path=" + silkPath + " err=" + ferr);
            if (detailJson) *detailJson = "{\"error\":\"" + jsonEsc(ferr) + "\"}";
            return kErrBadSilkFile;
        }
        size_t bodyOff = 0;
        bool silkOk = silkMagicOk(fileData, &bodyOff, &magicNote);
        uint32_t estDur = silkOk ? estimateSilkDurationMs(fileData, bodyOff) : 0;
        bool durEstimated = false;
        if (durationMs == 0) { durationMs = estDur; durEstimated = (estDur != 0); }

        logLine("call#" + std::to_string(callNo) + " BEGIN path=" + silkPath +
                " size=" + std::to_string((unsigned long long)fileData.size()) +
                " magic=" + magicNote +
                " first16=" + hexDump(fileData, 16) +
                " mode=" + mode +
                " durMs=" + std::to_string(durationMs) + (durEstimated ? "(estimated)" : "") +
                " wxid=" + wxidorgid);

        if (!silkOk) {
            logLine("call#" + std::to_string(callNo) + " FAIL: " + magicNote +
                    " first16=" + hexDump(fileData, 16));
            if (detailJson) *detailJson = "{\"error\":\"not a SILK file\",\"first16\":\"" +
                                          jsonEsc(hexDump(fileData, 16)) + "\"}";
            return kErrBadSilkFile;
        }

        // ── 3) str0 的取值（三种模式）────────────────────────────────
        //   path  : str0 = SILK 绝对路径（头号假设：微信自己按路径上传）
        //   bytes : str0 = SILK 原始字节（缺 0x02 前缀就补上，与微信 DB 里的存法一致）
        //   raw   : str0 = 调用方给的字符串（调试/对照用）
        std::string str0Value;
        if (mode == "path") {
            str0Value = silkPath;
            bool ascii = true;
            for (size_t i = 0; i < str0Value.size(); i++) {
                if ((unsigned char)str0Value[i] >= 0x80) { ascii = false; break; }
            }
            if (!ascii) {
                logLine("call#" + std::to_string(callNo) +
                        " WARN: path has non-ASCII bytes; str0 is a narrow std::string, "
                        "an ASCII-only path is much safer");
            }
        } else if (mode == "bytes") {
            str0Value = fileData;
            if (!(str0Value.size() >= 1 && (unsigned char)str0Value[0] == 0x02)) {
                str0Value.insert(str0Value.begin(), (char)0x02);   // 与微信存的 0x02 + #!SILK_V3 对齐
            }
        } else {
            str0Value = str0Raw;
        }

        // ── 4) 预检（造对象前）──────────────────────────────────────
        PreflightInfo pi;
        std::string why;
        if (!preflight(&pi, &why)) {
            logLine("call#" + std::to_string(callNo) + " FAIL preflight: " + why);
            if (detailJson) *detailJson = "{\"error\":\"preflight: " + jsonEsc(why) + "\"}";
            return kErrPreflight;
        }
        logLine("call#" + std::to_string(callNo) + " preflight OK base=" + hexU64(pi.base) +
                " factory=" + hexU64(pi.factory) + " ctor=" + hexU64(pi.ctor) +
                " outerVt=" + hexU64(pi.outerVt) + "(slot0=" + hexU64(pi.outerSlot0) + ")" +
                " innerVt=" + hexU64(pi.innerVt) + "(slot0=" + hexU64(pi.innerSlot0) + ")");

        // ── 5) 造对象（调微信自己的工厂）─────────────────────────────
        WeixinString receiver;  memset(&receiver, 0, sizeof(receiver));
        WeixinString str0;      memset(&str0, 0, sizeof(str0));
        VoiceArg5    arg5;      memset(&arg5, 0, sizeof(arg5));

        SetWeixinString(&receiver, wxidorgid);
        SetWeixinString(&str0, str0Value);

        arg5.v0   = kArg5v0;
        arg5.v1   = kArg5v1;
        arg5.v2   = kArg5v2;
        arg5.flag = 0;
        memset(&arg5.str1, 0, sizeof(arg5.str1));
        arg5.str1.cap = 0xF;                       // 空 std::string（与真实调用点一致）

        uint32_t dur = durationMs;
        uint64_t out[2] = { 0, 0 };
        crashlog::Note("VOICE factory ENTER call#%llu factory=%p", (unsigned long long)callNo, (void*)pi.factory);
        bool factoryOk = callFactory(pi.factory, out, &receiver, &str0, &dur, &arg5);
        crashlog::Note("VOICE factory RETURN call#%llu ok=%d inner=%p outer=%p",
                       (unsigned long long)callNo, (int)factoryOk, (void*)out[0], (void*)out[1]);

        uint64_t inner = out[0], outer = out[1];
        std::string str0Show = (mode == "bytes")
            ? ("<" + std::to_string((unsigned long long)str0Value.size()) + " bytes>")
            : str0Value;
        logLine("call#" + std::to_string(callNo) + " factory " + (factoryOk ? "returned" : "RAISED") +
                " inner=" + hexU64(inner) + " outer=" + hexU64(outer) +
                " str0(mode=" + mode + ",len=" + std::to_string((unsigned long long)str0Value.size()) +
                ")=" + (str0Show.size() > 160 ? str0Show.substr(0, 160) + "..." : str0Show));

        // 两个串的本地副本已经拷进对象了，这里可以安全释放
        freeWxString(&receiver);
        freeWxString(&str0);

        if (!factoryOk || inner == 0 || outer == 0) {
            logLine("call#" + std::to_string(callNo) + " FAIL construct: factoryOk=" +
                    (factoryOk ? "1" : "0") + " inner=" + hexU64(inner) + " outer=" + hexU64(outer));
            if (detailJson) *detailJson = "{\"error\":\"factory failed\",\"inner\":\"" + hexU64(inner) +
                                          "\",\"outer\":\"" + hexU64(outer) + "\"}";
            return kErrConstruct;
        }

        // ── 6) 造完对象后的逐字段回读校验（不对就不发）───────────────
        {
            uint64_t vtOuter = 0, vtInner = 0, guidSize = 0;
            uint32_t durField = 0, f0 = 0, f1 = 0;
            uint64_t f2 = 0;
            uint8_t  flagByte = 0xFF;
            std::string recvBack, str0Back, guid;
            std::string a5(16, '\0');

            bool okAll = true;
            std::string bad;

            if (!safeReadU64(outer, &vtOuter) || vtOuter != pi.outerVt) {
                okAll = false; bad = "outer vtable=" + hexU64(vtOuter) + " want " + hexU64(pi.outerVt);
            }
            if (okAll && (!safeReadU64(inner, &vtInner) || vtInner != pi.innerVt)) {
                okAll = false; bad = "inner vtable=" + hexU64(vtInner) + " want " + hexU64(pi.innerVt);
            }
            if (okAll) {
                if (!safeReadWxString(inner + 0xB0, &recvBack, 4096) || recvBack != wxidorgid) {
                    okAll = false; bad = "receiver readback mismatch (len=" +
                                         std::to_string((unsigned long long)recvBack.size()) + ")";
                }
            }
            if (okAll) {
                if (!safeReadWxString(inner + 0x708, &str0Back, kMaxStr0Bytes) || str0Back != str0Value) {
                    okAll = false; bad = "str0 readback mismatch (len=" +
                                         std::to_string((unsigned long long)str0Back.size()) +
                                         " want " + std::to_string((unsigned long long)str0Value.size()) + ")";
                }
            }
            if (okAll && (!safeReadU32(inner + 0x728, &durField) || durField != durationMs)) {
                okAll = false; bad = "duration field=" + std::to_string(durField) +
                                     " want " + std::to_string(durationMs);
            }
            if (okAll) {
                if (!safeReadBytes(inner + 0x730, &a5[0], 16)) {
                    okAll = false; bad = "arg5 block unreadable";
                } else {
                    memcpy(&f0, a5.data() + 0, 4);
                    memcpy(&f1, a5.data() + 4, 4);
                    memcpy(&f2, a5.data() + 8, 8);
                    if (f0 != kArg5v0 || f1 != kArg5v1 || f2 != kArg5v2) {
                        okAll = false; bad = "arg5 block mismatch";
                    }
                }
            }
            if (okAll && (!safeReadBytes(inner + 0x740, &flagByte, 1) || flagByte != 0)) {
                okAll = false; bad = "arg5 flag byte=" + std::to_string((int)flagByte);
            }
            if (okAll && (!safeReadU64(inner + 0x6B8, &guidSize) || guidSize == 0)) {
                okAll = false; bad = "GUID field empty (base ctor did not run?)";
            }
            if (okAll) (void)safeReadWxString(inner + 0x6A8, &guid, 256);

            logLine("call#" + std::to_string(callNo) + " postcheck " + (okAll ? "OK" : ("FAIL: " + bad)) +
                    " innerVt=" + hexU64(vtInner) + " outerVt=" + hexU64(vtOuter) +
                    " recv=\"" + recvBack + "\"" +
                    " str0.len=" + std::to_string((unsigned long long)str0Back.size()) +
                    " dur=" + std::to_string(durField) +
                    " arg5={" + std::to_string(f0) + "," + std::to_string(f1) + "," +
                    std::to_string((unsigned long long)f2) + "} flag=" + std::to_string((int)flagByte) +
                    " guid=\"" + guid + "\"");

            if (!okAll) {
                if (detailJson) *detailJson = "{\"error\":\"" + jsonEsc(bad) + "\",\"inner\":\"" + hexU64(inner) +
                                              "\",\"outer\":\"" + hexU64(outer) + "\"}";
                return kErrLayout;
            }

            // 类型字段 = 34（与 0x6199D10 的 mov dword [rax+0xd8],0x22 一致）
            if (!safeWriteU32(inner + 0xD8, 34)) {
                logLine("call#" + std::to_string(callNo) + " FAIL: cannot write type field at inner+0xD8");
                if (detailJson) *detailJson = "{\"error\":\"cannot write type field\"}";
                return kErrLayout;
            }
            uint32_t typeBack = 0;
            if (!safeReadU32(inner + 0xD8, &typeBack) || typeBack != 34) {
                logLine("call#" + std::to_string(callNo) + " FAIL: type readback=" + std::to_string(typeBack));
                if (detailJson) *detailJson = "{\"error\":\"type readback mismatch\"}";
                return kErrLayout;
            }

            // ── 7) 交给已验证的发送链（与发图同一套 arg1/arg2）────────
            uint64_t* arg1 = (uint64_t*)BuildSendParam1(outer);
            uint64_t* arg2 = HeapAlloc_mb<uint64_t>(0xE8);
            if (arg1 == nullptr || arg2 == nullptr) {
                logLine("call#" + std::to_string(callNo) + " FAIL: send param allocation failed");
                if (detailJson) *detailJson = "{\"error\":\"send param allocation failed\"}";
                return kErrConstruct;
            }
            BuildSendParam2_Text(arg2);

            int64_t sendRet = 0;
            crashlog::Note("VOICE send_message ENTER call#%llu inner=%p outer=%p arg1=%p arg2=%p dur=%u",
                           (unsigned long long)callNo, (void*)inner, (void*)outer,
                           (void*)arg1, (void*)arg2, (unsigned)durationMs);
            bool sent = callSendMessage(pi.base + offset::send_message,
                                        (uint64_t)arg1, (uint64_t)arg2, &sendRet);
            crashlog::Note("VOICE send_message RETURN call#%llu sent=%d", (unsigned long long)callNo, (int)sent);
            logLine("call#" + std::to_string(callNo) + " send_message=" + hexU64(pi.base + offset::send_message) +
                    " arg1=" + hexU64((uint64_t)arg1) + " arg2=" + hexU64((uint64_t)arg2) +
                    " " + (sent ? "returned" : "RAISED") + " ret=" + hexU64((uint64_t)sendRet));

            if (!sent) {
                if (detailJson) *detailJson = "{\"error\":\"send_message raised\",\"inner\":\"" + hexU64(inner) +
                                              "\",\"outer\":\"" + hexU64(outer) + "\"}";
                g_failCount.fetch_add(1);
                return kErrSend;
            }

            g_okCount.fetch_add(1);
            logLine("call#" + std::to_string(callNo) + " DONE ret=0 (queued) inner=" + hexU64(inner) +
                    " outer=" + hexU64(outer) + " durMs=" + std::to_string(durationMs) +
                    " str0Mode=" + mode + " sendRet=" + hexU64((uint64_t)sendRet));

            if (detailJson) {
                std::string d;
                d += "{\"enabled\":true";
                d += ",\"inner\":\"" + hexU64(inner) + "\"";
                d += ",\"outer\":\"" + hexU64(outer) + "\"";
                d += ",\"factory\":\"" + hexU64(pi.factory) + "\"";
                d += ",\"ctor\":\"" + hexU64(pi.ctor) + "\"";
                d += ",\"outerVtable\":\"" + hexU64(pi.outerVt) + "\"";
                d += ",\"innerVtable\":\"" + hexU64(pi.innerVt) + "\"";
                d += ",\"typeField\":34";
                d += ",\"durationMs\":" + std::to_string(durationMs);
                d += ",\"durationEstimated\":" + std::string(durEstimated ? "true" : "false");
                d += ",\"fileSize\":" + std::to_string((unsigned long long)fileData.size());
                d += ",\"str0Mode\":\"" + jsonEsc(mode) + "\"";
                d += ",\"str0Len\":" + std::to_string((unsigned long long)str0Value.size());
                d += ",\"guid\":\"" + jsonEsc(guid) + "\"";
                d += ",\"sendMessageRet\":\"" + hexU64((uint64_t)sendRet) + "\"";
                d += ",\"logFile\":\"" + jsonEsc(logPath()) + "\"";
                d += "}";
                *detailJson = d;
            }
            return kOk;
        }
    }

    // ── 开关 / 状态（给 /Debug/VoiceSend 用）─────────────────────────
    void VoiceSendSetEnabled(bool on)
    {
        voicesend::initPaths();
        voicesend::g_forceOn.store(on);
        voicesend::logLine(std::string("runtime switch -> ") + (on ? "ON" : "OFF") +
                           " (marker=" + voicesend::markerPath() + ")");
    }

    bool VoiceSendIsEnabled()
    {
        return voicesend::enabled();
    }

    std::string VoiceSendReportJson()
    {
        using namespace voicesend;
        initPaths();
        std::string last;
        {
            std::lock_guard<std::mutex> lg(g_logMtx);
            last = g_lastLine;
        }
        std::string j = "{\n";
        j += "  \"enabled\": " + std::string(enabled() ? "true" : "false") + ",\n";
        j += "  \"forceOn\": " + std::string(g_forceOn.load() ? "true" : "false") + ",\n";
        j += "  \"markerFile\": \"" + jsonEsc(markerPath()) + "\",\n";
        j += "  \"markerExists\": " + std::string(g_markerSeen.load() ? "true" : "false") + ",\n";
        j += "  \"logFile\": \"" + jsonEsc(logPath()) + "\",\n";
        j += "  \"calls\": " + std::to_string((unsigned long long)g_calls.load()) + ",\n";
        j += "  \"ok\": " + std::to_string((unsigned long long)g_okCount.load()) + ",\n";
        j += "  \"fail\": " + std::to_string((unsigned long long)g_failCount.load()) + ",\n";
        j += "  \"factoryOffset\": " + std::to_string((unsigned long long)offset::voice_send_factory) + ",\n";
        j += "  \"ctorOffset\": " + std::to_string((unsigned long long)offset::voice_send_ctr) + ",\n";
        j += "  \"outerVtableOffset\": " + std::to_string((unsigned long long)offset::voice_send_outer_vtbl) + ",\n";
        j += "  \"innerVtableOffset\": " + std::to_string((unsigned long long)offset::voice_send_inner_vtbl) + ",\n";
        j += "  \"sendMessageOffset\": " + std::to_string((unsigned long long)offset::send_message) + ",\n";
        j += "  \"note\": \"默认关；开=建 <Weixin.exe 目录>\\\\hook-voice-send.on 或 POST /Debug/VoiceSend {\\\"on\\\":true}\",\n";
        j += "  \"lastLine\": \"" + jsonEsc(last) + "\"\n}\n";
        return j;
    }

}
