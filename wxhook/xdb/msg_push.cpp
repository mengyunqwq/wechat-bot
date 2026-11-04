// ══════════════════════════════════════════════════════════════════════
//  消息写入抓取 + 推送（第三轮）—— 见 msg_push.h 顶部的设计说明
//
//  数据流：
//    detourPrepareV3/16V3  → msgpush::mark()      打标记（含列清单）
//    detourBind*           → msgpush::bindValue() 抓值（blob/text 转 hex）
//    detourStep(DONE)      → msgpush::rowDone()   成行 → 打包 JSON → 入队
//    detourFinalize        → msgpush::finalizeStmt() 清标记
//    工作线程(本文件)      → 复查开关 + 出队 + WinHTTP POST(g_CallBack_Url)
//
//  微信线程上只做：map 查找 + 内存拷贝 + 入队（都在小临界区里）。没有任何网络调用。
// ══════════════════════════════════════════════════════════════════════
#include "msg_push.h"

#include <windows.h>
#include <winhttp.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <deque>
#include <map>
#include <mutex>

#include "global.h"     // g_CallBack_Url

#pragma comment(lib, "winhttp.lib")

namespace msgpush {

    // ── 可调参数（全部有上限，防日志/内存失控）──────────────────────
    static const size_t kMaxQueue      = 512;          // 队列上限（满了丢最旧并计数）
    static const size_t kMaxCap        = 512;          // 同时标记的 stmt 上限（防泄漏）
    static const int    kMaxBytes      = 512 * 1024;   // 单个值最多抓多少字节（超出截断）
    static const int    kLogCapCap     = 300;          // [PUSH-CAP] 上限
    static const int    kLogCapSent    = 300;          // [PUSH-SENT] 上限
    static const int    kLogCapFail    = 120;          // [PUSH-FAIL] 上限
    static const int    kLogCapMark    = 40;           // [PUSH-MARK] 上限
    static const int    kLogCapNotify  = 60;           // [PUSH-NOTIFY] 上限
    static const int    kNotifyGapMs   = 500;          // 同表通知最小间隔（去重，防一次写入多条语句刷屏）
    static const int    kWorkerSleepMs = 250;          // 工作线程轮询间隔（复查开关 + 排空）
    static const int    kDrainPerTick  = 8;            // 每轮最多发几条

    // ── 状态 ────────────────────────────────────────────────────────
    struct Cap {
        std::string db, table;
        bool pushable = false;
        std::vector<std::string> cols;      // 列清单（可能为空 → 用 c<idx> 兜底）
        std::map<int, std::string> val;     // 参数序号(1-based) → JSON 值片段
        std::map<int, int> typ;             // 参数序号 → SQLITE_* 类型
        bool truncated = false;
    };

    static LogFn       g_log = nullptr;
    static std::string g_marker;
    static std::string g_url;

    static std::atomic<bool> g_enabled{ false };
    static std::atomic<bool> g_workerStarted{ false };
    static std::atomic<long long> g_markedCount{ 0 };
    static std::atomic<long long> g_dropped{ 0 };
    static std::atomic<long long> g_sent{ 0 };
    static std::atomic<long long> g_failed{ 0 };
    static std::atomic<long long> g_queued{ 0 };

    static std::mutex g_mtx;                            // 保护 g_caps
    static std::map<sqlite3_stmt*, Cap> g_caps;

    static std::mutex g_qMtx;                           // 保护 g_q
    static std::deque<std::string> g_q;

    // 通知式推送的去重表：表名 → 上次通知时间（独立锁，不跟 bind 路径抢 g_mtx）
    static std::mutex g_nMtx;
    static std::map<std::string, long long> g_lastNotify;

    // 各类日志的已打印条数（用于封顶）
    static std::atomic<long long> g_cCapLog{ 0 }, g_cMark{ 0 }, g_cSent{ 0 },
                                  g_cFail{ 0 }, g_cDrop{ 0 }, g_cQueued{ 0 }, g_cSkip{ 0 },
                                  g_cNotify{ 0 };

    // ── 小工具 ──────────────────────────────────────────────────────
    static std::string stamp() {
        SYSTEMTIME st;
        GetLocalTime(&st);
        char b[64];
        _snprintf_s(b, sizeof(b), _TRUNCATE, "%02d:%02d:%02d.%03d",
                    st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
        return std::string(b);
    }

    static long long epochMillis() {
        return (long long)std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
    }

    static std::string ptrHex(const void* p) {
        char b[32];
        _snprintf_s(b, sizeof(b), _TRUNCATE, "%llX", (unsigned long long)(uintptr_t)p);
        return std::string(b);
    }

    static std::string hexOf(const void* p, int n) {
        static const char* H = "0123456789ABCDEF";
        std::string out;
        if (n <= 0) return out;
        out.reserve((size_t)n * 2);
        const unsigned char* b = (const unsigned char*)p;
        for (int i = 0; i < n; ++i) {
            out.push_back(H[b[i] >> 4]);
            out.push_back(H[b[i] & 0x0F]);
        }
        return out;
    }

    static std::string jsonEscape(const std::string& s) {
        std::string o;
        o.reserve(s.size() + 8);
        for (size_t i = 0; i < s.size(); ++i) {
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

    static const char* typeName(int t) {
        switch (t) {
            case SQLITE_INTEGER: return "int";
            case SQLITE_FLOAT:   return "float";
            case SQLITE_TEXT:    return "text";
            case SQLITE_BLOB:    return "blob";
            case SQLITE_NULL:    return "null";
            default:             return "?";
        }
    }

    // 日志封顶：前 cap 条原样打印，之后只在跨过 cap 时提示一次
    static void logCapped(std::atomic<long long>& counter, int cap, const std::string& line) {
        long long n = ++counter;
        if (g_log == nullptr) return;
        if (n <= cap) {
            g_log(line);
        } else if (n == cap + 1) {
            g_log("[PUSH] 该类日志已达上限 " + std::to_string(cap) + " 条，后续同类不再打印（计数继续）\r\n");
        }
    }

    static std::string colNameAt(const Cap& c, int idx) {
        if (idx >= 1 && (size_t)idx <= c.cols.size() && !c.cols[(size_t)idx - 1].empty())
            return c.cols[(size_t)idx - 1];
        return "c" + std::to_string(idx);
    }

    static bool markerExists() {
        if (g_marker.empty()) return false;
        return GetFileAttributesA(g_marker.c_str()) != INVALID_FILE_ATTRIBUTES;
    }

    // ── POST（只在工作线程上调用）───────────────────────────────────
    static bool httpPostJson(const std::string& url, const std::string& json,
                             DWORD& status, DWORD& err) {
        status = 0;
        err = 0;

        int wlen = MultiByteToWideChar(CP_UTF8, 0, url.c_str(), -1, nullptr, 0);
        if (wlen <= 1) { err = (DWORD)-1; return false; }
        std::wstring wurl((size_t)wlen - 1, L'\0');
        MultiByteToWideChar(CP_UTF8, 0, url.c_str(), -1, &wurl[0], wlen);

        URL_COMPONENTSW uc{};
        uc.dwStructSize = sizeof(uc);
        wchar_t host[256] = { 0 };
        wchar_t path[1024] = { 0 };
        uc.lpszHostName = host;      uc.dwHostNameLength = _countof(host);
        uc.lpszUrlPath = path;       uc.dwUrlPathLength = _countof(path);
        if (!WinHttpCrackUrl(wurl.c_str(), 0, 0, &uc)) { err = GetLastError(); return false; }

        HINTERNET hs = WinHttpOpen(L"WeChatHookPush/1.0", WINHTTP_ACCESS_TYPE_NO_PROXY,
                                   WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
        if (!hs) { err = GetLastError(); return false; }
        // 显式短超时（毫秒）：解析 500 / 连接 1000 / 发送 1000 / 接收 1500
        WinHttpSetTimeouts(hs, 500, 1000, 1000, 1500);

        bool ok = false;
        HINTERNET hc = WinHttpConnect(hs, uc.lpszHostName, uc.nPort, 0);
        if (hc) {
            DWORD flags = (uc.nScheme == INTERNET_SCHEME_HTTPS) ? WINHTTP_FLAG_SECURE : 0;
            HINTERNET hr = WinHttpOpenRequest(hc, L"POST",
                                              (path[0] != 0) ? path : L"/",
                                              nullptr, WINHTTP_NO_REFERER,
                                              WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
            if (hr) {
                const wchar_t* hdr = L"Content-Type: application/json\r\n";
                BOOL sent = WinHttpSendRequest(hr, hdr, -1,
                                               (LPVOID)json.data(), (DWORD)json.size(),
                                               (DWORD)json.size(), 0);
                if (sent && WinHttpReceiveResponse(hr, nullptr)) {
                    DWORD st = 0, slen = sizeof(st);
                    if (WinHttpQueryHeaders(hr,
                                            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                            WINHTTP_HEADER_NAME_BY_INDEX, &st, &slen,
                                            WINHTTP_NO_HEADER_INDEX)) {
                        status = st;
                        ok = (st >= 200 && st < 300);
                    } else {
                        err = GetLastError();
                    }
                } else {
                    err = GetLastError();
                }
                WinHttpCloseHandle(hr);
            } else {
                err = GetLastError();
            }
            WinHttpCloseHandle(hc);
        } else {
            err = GetLastError();
        }
        WinHttpCloseHandle(hs);
        return ok;
    }

    static void postOne(const std::string& json) {
        DWORD status = 0, err = 0;
        bool ok = httpPostJson(g_url, json, status, err);
        if (ok) {
            ++g_sent;
            logCapped(g_cSent, kLogCapSent,
                      "[PUSH-SENT] " + stamp() + " ok rc=" + std::to_string(status)
                      + " bytes=" + std::to_string(json.size()) + " url=" + g_url
                      + " 累计发送=" + std::to_string(g_sent.load()) + "\r\n");
        } else {
            ++g_failed;
            logCapped(g_cFail, kLogCapFail,
                      "[PUSH-FAIL] " + stamp() + " rc=" + std::to_string(status)
                      + " err=" + std::to_string(err) + " bytes=" + std::to_string(json.size())
                      + " url=" + g_url + " 累计失败=" + std::to_string(g_failed.load()) + "\r\n");
        }
    }

    // ── 唯一的工作线程：复查开关 + 出队 POST ────────────────────────
    static DWORD WINAPI workerProc(LPVOID) {
        bool lastOn = g_enabled.load();
        if (g_log) {
            g_log("[PUSH-SW] " + stamp() + " 推送开关 = " + (lastOn ? "ON" : "OFF")
                  + "（标记文件 " + g_marker + "）\r\n");
        }
        for (;;) {
            bool on = markerExists();
            if (on != lastOn) {
                g_enabled.store(on);
                lastOn = on;
                if (g_log) {
                    g_log("[PUSH-SW] " + stamp() + " 推送开关 -> " + (on ? "ON" : "OFF")
                          + "（运行时切换生效，无需重启）\r\n");
                }
            }
            if (on) {
                for (int i = 0; i < kDrainPerTick; ++i) {
                    std::string json;
                    {
                        std::lock_guard<std::mutex> lg(g_qMtx);
                        if (g_q.empty()) break;
                        json = std::move(g_q.front());
                        g_q.pop_front();
                    }
                    postOne(json);
                }
            }
            Sleep(kWorkerSleepMs);
        }
        return 0;
    }

    static void ensureWorker() {
        bool expect = false;
        if (!g_workerStarted.compare_exchange_strong(expect, true)) return;
        HANDLE h = CreateThread(nullptr, 0, workerProc, nullptr, 0, nullptr);
        if (h != nullptr) {
            CloseHandle(h);
            if (g_log) g_log("[PUSH] 工作线程已启动（唯一一条：复查开关 + POST，微信线程不碰网络）\r\n");
        } else {
            g_workerStarted.store(false);
            if (g_log) g_log("[PUSH] 工作线程创建失败：推送不可用（抓取仍会记日志）\r\n");
        }
    }

    // ── 对外接口 ────────────────────────────────────────────────────
    void arm(LogFn logger) {
        g_log = logger;

        std::string dir = "D:\\wxhook\\wx4110\\";
        char exe[MAX_PATH] = { 0 };
        if (GetModuleFileNameA(nullptr, exe, MAX_PATH) > 0) {
            std::string s(exe);
            auto p = s.find_last_of("\\/");
            if (p != std::string::npos) dir = s.substr(0, p + 1);
        }
        g_marker = dir + "hook-push.on";

        // 快照推送目标：g_CallBack_Url 在 DllMain 解析启动参数时已赋值
        g_url = g_CallBack_Url.empty() ? std::string("http://127.0.0.1:18998") : g_CallBack_Url;

        g_enabled.store(markerExists());

        if (g_log) {
            g_log("[PUSH] 推送目标 = " + g_url + "\r\n");
            g_log("[PUSH] 开关标记文件 = " + g_marker + "，当前 "
                  + (g_enabled.load() ? "ON" : "OFF（默认关；创建该文件即开，无需重启）") + "\r\n");
        }
        ensureWorker();     // 一装就起，这样开关状态从第一刻起就被盯着
    }

    bool enabled() { return g_enabled.load(); }
    std::string markerPath() { return g_marker; }
    std::string postUrl() { return g_url; }

    void mark(sqlite3_stmt* stmt, const std::string& db, const std::string& table,
              const std::vector<std::string>& cols, bool pushable) {
        if (stmt == nullptr) return;
        bool isNew = false;
        {
            std::lock_guard<std::mutex> lg(g_mtx);
            auto it = g_caps.find(stmt);
            if (it == g_caps.end()) {
                if (g_caps.size() >= kMaxCap) {
                    logCapped(g_cSkip, 5,
                              "[PUSH] 标记表已达上限 " + std::to_string(kMaxCap)
                              + "，跳过 " + table + "（防泄漏）\r\n");
                    return;
                }
                it = g_caps.insert(std::make_pair(stmt, Cap())).first;
                isNew = true;
            }
            Cap& c = it->second;
            c.db = db;
            c.table = table;
            c.pushable = pushable;
            c.cols = cols;
            c.val.clear();
            c.typ.clear();
            c.truncated = false;
            g_markedCount.store((long long)g_caps.size());
        }
        logCapped(g_cMark, kLogCapMark,
                  "[PUSH-MARK] " + stamp() + " db=" + db + " table=" + table
                  + " cols=" + std::to_string(cols.size())
                  + " push=" + (pushable ? "yes" : "no")
                  + (isNew ? " (新标记)" : " (已标记)") + "\r\n");
    }

    void bindValue(sqlite3_stmt* stmt, int idx, int type, const void* data, int nbytes,
                   long long ival, double dval) {
        // 没有任何标记时零成本返回（第一次消息写入之前，bind 路径完全不受影响）
        if (g_markedCount.load(std::memory_order_relaxed) == 0) return;
        if (stmt == nullptr || idx <= 0) return;

        std::lock_guard<std::mutex> lg(g_mtx);
        auto it = g_caps.find(stmt);
        if (it == g_caps.end()) return;
        Cap& c = it->second;

        char nb[64];
        switch (type) {
            case SQLITE_INTEGER:
                c.val[idx] = std::to_string(ival);
                c.typ[idx] = type;
                break;
            case SQLITE_FLOAT:
                _snprintf_s(nb, sizeof(nb), _TRUNCATE, "%.17g", dval);
                c.val[idx] = nb;
                c.typ[idx] = type;
                break;
            case SQLITE_NULL:
                c.val[idx] = "null";
                c.typ[idx] = type;
                break;
            case SQLITE_BLOB:
            case SQLITE_TEXT: {
                const char* p = (const char*)data;
                if (p == nullptr) {
                    c.val[idx] = "\"\"";
                    c.typ[idx] = type;
                    break;
                }
                int n = nbytes;
                if (n < 0) n = (int)strlen(p);          // text 的 n<0 = 到 NUL
                if (n > kMaxBytes) { n = kMaxBytes; c.truncated = true; }
                c.val[idx] = "\"" + hexOf(p, n) + "\""; // 二进制按 hex 存，不解压（交给桥）
                c.typ[idx] = type;
                break;
            }
            default:
                return;
        }
    }

    // 入队（有界，满了丢最旧并计数）—— emitRow 与 notifyWrite 共用。
    // 纯内存 + 短临界区：微信线程上零网络、零阻塞。
    static void pushQueue(std::string json, const std::string& table) {
        bool droppedOld = false;
        size_t qsz = 0;
        {
            std::lock_guard<std::mutex> lg(g_qMtx);
            while (g_q.size() >= kMaxQueue) {
                g_q.pop_front();
                ++g_dropped;
                droppedOld = true;
            }
            g_q.push_back(std::move(json));
            qsz = g_q.size();
        }
        ++g_queued;
        if (droppedOld) {
            logCapped(g_cDrop, 20,
                      "[PUSH-DROP] " + stamp() + " 队列满(" + std::to_string(kMaxQueue)
                      + ")，丢弃最旧，累计丢弃=" + std::to_string(g_dropped.load()) + "\r\n");
        }
        logCapped(g_cQueued, 60,
                  "[PUSH-QUEUE] " + stamp() + " table=" + table
                  + " 入队，队列=" + std::to_string(qsz) + "\r\n");
    }

    static void emitRow(sqlite3_stmt* stmt, const Cap& c) {
        // ① 摘要日志：一定有（便于验收：表名 + 每列的 名字:类型:长度）
        std::string colsum;
        for (std::map<int, int>::const_iterator it = c.typ.begin(); it != c.typ.end(); ++it) {
            int idx = it->first;
            int len = 0;
            std::map<int, std::string>::const_iterator vit = c.val.find(idx);
            if (vit != c.val.end()) len = (int)vit->second.size();
            if (!colsum.empty()) colsum += ",";
            colsum += colNameAt(c, idx) + ":" + typeName(it->second) + ":" + std::to_string(len);
        }
        logCapped(g_cCapLog, kLogCapCap,
                  "[PUSH-CAP] " + stamp() + " db=" + c.db + " table=" + c.table
                  + " stmt=0x" + ptrHex(stmt)
                  + " nbind=" + std::to_string(c.typ.size())
                  + " push=" + (c.pushable ? (g_enabled.load() ? "yes" : "no(开关关)") : "no(非Msg_表)")
                  + (c.truncated ? " TRUNCATED" : "")
                  + " cols=[" + colsum + "]\r\n");

        // ② 第三轮改造：**不再从 bind 值打包推送**（值抓不到 —— 见 notifyWrite 的说明）。
        //    投递统一走"通知式"：msgpush::notifyWrite(db, table)，由 db_mgr.cpp 的 step 探针调用。
        //    这里只保留上面的 [PUSH-CAP] 行诊断（nbind 恒为 0 就是"值抓不到"的直接证据）。
    }

    // ── 通知式推送（第三轮改造的主路）────────────────────────────────
    // 只发"某个 Msg_ 表刚被写了"，**不带任何列/值**。桥收到后立刻针对该群查一次库。
    // 为什么不带值：Msg_ 的 INSERT 是挂钩前就 prepare 好的缓存语句，标记只能在 step 时补、
    // 且保持不住（实测 [PUSH-CAP] nbind=0 一条都没有、[PUSH-LATE] 反复 20 次）→ 值永远抓不到。
    // 通知式绕开整个语句缓存问题；而且通知触发那一刻库必然是开着的（微信刚写完）——
    // 这才是真正根治"轮询空窗"的点。
    void notifyWrite(const std::string& db, const std::string& table) {
        if (table.empty()) return;

        if (!g_enabled.load(std::memory_order_relaxed)) {
            logCapped(g_cNotify, 20,
                      "[PUSH-NOTIFY] " + stamp() + " db=" + db + " table=" + table
                      + " push=no(开关关)\r\n");
            return;
        }

        // 同表 500ms 去重：一次消息写入往往伴随多条语句（还有 message_fts 等），避免刷屏。
        // 纯内存 + 独立锁，不跟 bind 路径抢锁。
        {
            const long long now = epochMillis();
            std::lock_guard<std::mutex> lg(g_nMtx);
            long long& last = g_lastNotify[table];
            if (last != 0 && now - last < (long long)kNotifyGapMs) return;
            last = now;
            // 防表名无限增长（正常就几个群；顺手清掉 60s 前的陈旧项）
            if (g_lastNotify.size() > 256) {
                for (std::map<std::string, long long>::iterator it = g_lastNotify.begin();
                     it != g_lastNotify.end(); ) {
                    if (now - it->second > 60000) it = g_lastNotify.erase(it);
                    else ++it;
                }
            }
        }

        std::string json = "{\"t\":\"msg\",\"db\":\"" + jsonEscape(db)
                         + "\",\"table\":\"" + jsonEscape(table)
                         + "\",\"notify\":1"
                         + ",\"ts\":" + std::to_string(epochMillis()) + "}";
        logCapped(g_cNotify, kLogCapNotify,
                  "[PUSH-NOTIFY] " + stamp() + " db=" + db + " table=" + table
                  + " 通知入队（通知式：不抓值，桥自行查库）\r\n");
        pushQueue(std::move(json), table);
    }

    bool rowDone(sqlite3_stmt* stmt) {
        if (g_markedCount.load(std::memory_order_relaxed) == 0) return false;
        if (stmt == nullptr) return false;

        Cap c;
        {
            std::lock_guard<std::mutex> lg(g_mtx);
            auto it = g_caps.find(stmt);
            if (it == g_caps.end()) return false;
            c = it->second;                 // 拷贝出来，出锁后再打包
            // 复位：WCDB 会把同一个 stmt 反复复用（bind → step → reset → bind → step）
            it->second.val.clear();
            it->second.typ.clear();
            it->second.truncated = false;
        }
        if (c.typ.empty()) {
            logCapped(g_cSkip, 10,
                      "[PUSH] " + stamp() + " " + c.table + " 写成行但没抓到任何 bind 值（可能全是字面量）\r\n");
            return true;                    // 已标记，只是没值
        }
        emitRow(stmt, c);
        return true;
    }

    void finalizeStmt(sqlite3_stmt* stmt) {
        if (stmt == nullptr || g_markedCount.load(std::memory_order_relaxed) == 0) return;
        std::lock_guard<std::mutex> lg(g_mtx);
        auto it = g_caps.find(stmt);
        if (it == g_caps.end()) return;
        g_caps.erase(it);
        g_markedCount.store((long long)g_caps.size());
    }

    void stats(long long& marked, long long& queued, long long& sent,
               long long& failed, long long& dropped) {
        marked = g_markedCount.load();
        queued = g_queued.load();
        sent = g_sent.load();
        failed = g_failed.load();
        dropped = g_dropped.load();
    }

} // namespace msgpush
