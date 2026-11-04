// ─────────────────────────────────────────────────────────────────────────────
// VoiceUploadProbe.cpp — READ-ONLY probes on the WeChat 4.1.10.27 voice upload
//                        candidate call sites (found by static analysis).
//
// SAFETY CONTRACT (do not weaken):
//   * marker file absent  -> NO hook is created at all.
//   * every memory read goes through VirtualQuery + __try/__except.
//   * arguments are forwarded verbatim; return value is passed through as-is.
//   * output is bounded per event and per hook; a mutex serialises the log.
//   * no message is sent, no client state is written.
//
// Hooked RVAs (4.1.10.27, Weixin.dll):
//   0x0D84530  mars::cdn::CdnManager::StartC2CUpload            (this, param)
//   0x52F4990  CoCgiSendRequest  /cgi-bin/micromsg-bin/uploadvoice
//   0x52F3420  caller of the above (fills UploadVoiceRequest)
//   0x52F73B0  caller of the above (2nd site)
//   0x52DD5C0  CoCgiSendRequest  /cgi-bin/micromsg-bin/uploadvoicefortrans
//   0x619A190  voice message factory  (new 0x778, outer vt 0x8DCFF98)
//   0x619B3B0  voice message inner ctor (inner vt 0x8DD0028)
//   0x54B02A0  voice send path that calls the factory
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// 公开版构建（/DPUBLIC_BUILD）下整个文件为空：
//   探针（VUPROBE）与 CDN 下载重放属于本项目自己加的扩展，公开版不包含。
//   头文件里已提供空实现，所以调用点无需改动。
// ─────────────────────────────────────────────────────────────────────────────
#ifndef PUBLIC_BUILD

#include "VoiceUploadProbe.h"

#include <windows.h>
#include <atomic>
#include <mutex>
#include <string>
#include <cstdio>
#include <cstring>
#include <cstdint>

#include "MinHook.h"
#include "global.h"

namespace VuProbe
{
    // ── tuning ──────────────────────────────────────────────────────────────
    static const int kMaxEventsPerHook = 40;   // stop dumping after N hits
    static const size_t kMaxBytesPerEvent = 65536;   // 2026-10-21: 6144 太小，a1 一个大结构体就把额度吃光，看不到 a2 后半段
    static const size_t kRegionBytes = 0x400;  // raw hex window per argument（StartC2CDownload 的 param 有 0x3A0，够用）
    static const size_t kHexBytes = 0x400;     // 2026-10-21: 0x60 太小，看不到 param+0x380 的 std::string（filekey）
    static const int kMaxPtrFollow = 24;       // 1-level pointer chase budget

    // ── state ───────────────────────────────────────────────────────────────
    static std::mutex g_mtx;
    static std::atomic<bool> g_forceOn{ false };
    static std::atomic<bool> g_markerSeen{ false };
    static std::atomic<bool> g_installed{ false };
    static std::atomic<bool> g_announced{ false };
    static std::atomic<int>  g_events[16];
    static int g_hookCount = 0;
    static int g_hookOk = 0;
    static char g_logPath[MAX_PATH] = { 0 };
    static char g_markerPath[MAX_PATH] = { 0 };
    static bool g_pathsReady = false;

    // ── tiny logging ────────────────────────────────────────────────────────
    static void stamp(char* out, size_t n)
    {
        SYSTEMTIME st; GetLocalTime(&st);
        _snprintf_s(out, n, _TRUNCATE, "%02d:%02d:%02d.%03d",
                    st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
    }

    static void rawWrite(const char* s, size_t n)
    {
        if (g_logPath[0] == 0) return;
        HANDLE h = CreateFileA(g_logPath, FILE_APPEND_DATA, FILE_SHARE_READ,
                               nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h == INVALID_HANDLE_VALUE) return;
        DWORD wr = 0;
        WriteFile(h, s, (DWORD)n, &wr, nullptr);
        CloseHandle(h);
    }

    static void vlog(const std::string& s)
    {
        std::lock_guard<std::mutex> lg(g_mtx);
        rawWrite(s.data(), s.size());
        OutputDebugStringA(s.c_str());
    }

    // ── safe memory access ─────────────────────────────────────────────────
    // No object with a destructor may live in the __try scope (C2712).
    static bool sehCopy(const void* src, void* dst, size_t n)
    {
        if (src == nullptr || n == 0) return false;
        __try {
            memcpy(dst, src, n);
            return true;
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            return false;
        }
    }

    static bool readable(const void* p, size_t n)
    {
        if (p == nullptr || n == 0) return false;
        uintptr_t a = (uintptr_t)p;
        uintptr_t end = a + n;
        if (end < a) return false;                       // overflow
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
        return true;
    }

    static bool inModule(uint64_t p)
    {
        uintptr_t base = (uintptr_t)g_hWeixinDll;
        if (base == 0 || p < base) return false;
        uint32_t peOff = *(uint32_t*)(base + 0x3C);
        uint32_t sizeOfImage = *(uint32_t*)(base + peOff + 0x50);
        return p < base + sizeOfImage;
    }

    // ── pattern helpers ────────────────────────────────────────────────────
    static const unsigned char kSilk1[] = { 0x02,'#','!','S','I','L','K','_','V','3' };
    static const char kSilk2[] = "#!SILK_V3";
    static const char kSilk3[] = "#!SILK";

    static bool isPrintable(unsigned char c) { return c >= 0x20 && c < 0x7F; }

    // Find a byte pattern in a local buffer.
    static bool findBytes(const unsigned char* buf, size_t n,
                          const unsigned char* pat, size_t pn, size_t* at)
    {
        if (pn == 0 || n < pn) return false;
        for (size_t i = 0; i + pn <= n; ++i) {
            if (buf[i] == pat[0] && memcmp(buf + i, pat, pn) == 0) { if (at) *at = i; return true; }
        }
        return false;
    }

    // ── one-region dump ────────────────────────────────────────────────────
    static void dumpRegion(std::string& out, const char* label, uint64_t addr,
                           size_t want, int depth)
    {
        if (out.size() > kMaxBytesPerEvent) return;
        if (addr == 0) return;
        if (!readable((const void*)addr, 1)) {
            char b[128];
            _snprintf_s(b, sizeof(b), _TRUNCATE, "    %-14s 0x%llX  <unreadable>\n",
                        label, (unsigned long long)addr);
            out += b;
            return;
        }
        if (want > kRegionBytes) want = kRegionBytes;
        unsigned char buf[0x400 + 16];
        size_t got = 0;
        while (got < want) {
            size_t step = want - got;
            if (step > 64) step = 64;
            if (!sehCopy((const unsigned char*)addr + got, buf + got, step)) break;
            got += step;
        }
        if (got == 0) return;

        {
            char b[256];
            _snprintf_s(b, sizeof(b), _TRUNCATE,
                        "    %-14s 0x%llX  (%llu bytes, inModule=%d)\n",
                        label, (unsigned long long)addr, (unsigned long long)got,
                        inModule(addr) ? 1 : 0);
            out += b;
        }

        // hex prefix
        {
            size_t hn = got < kHexBytes ? got : kHexBytes;
            std::string hex = "      hex: ";
            char t[8];
            for (size_t i = 0; i < hn; ++i) {
                _snprintf_s(t, sizeof(t), _TRUNCATE, "%02X ", buf[i]);
                hex += t;
                if ((i % 16) == 15 && i + 1 < hn) hex += "\n           ";
            }
            hex += "\n";
            out += hex;
        }

        // SILK magic
        size_t at = 0;
        if (findBytes(buf, got, kSilk1, sizeof(kSilk1), &at)) {
            char b[160];
            _snprintf_s(b, sizeof(b), _TRUNCATE,
                        "      *** SILK MAGIC (02 23 21 53 49 4C 4B 5F 56 33) at +0x%llX  ***\n",
                        (unsigned long long)at);
            out += b;
        } else if (findBytes(buf, got, (const unsigned char*)kSilk2, sizeof(kSilk2) - 1, &at)) {
            char b[160];
            _snprintf_s(b, sizeof(b), _TRUNCATE,
                        "      *** SILK MAGIC (#!SILK_V3) at +0x%llX ***\n",
                        (unsigned long long)at);
            out += b;
        } else if (findBytes(buf, got, (const unsigned char*)kSilk3, sizeof(kSilk3) - 1, &at)) {
            char b[160];
            _snprintf_s(b, sizeof(b), _TRUNCATE,
                        "      *** SILK MAGIC (#!SILK) at +0x%llX ***\n",
                        (unsigned long long)at);
            out += b;
        }

        // ASCII runs
        {
            size_t i = 0; int shown = 0;
            std::string sec;
            while (i < got && shown < 14) {
                if (isPrintable(buf[i])) {
                    size_t j = i;
                    while (j < got && isPrintable(buf[j])) ++j;
                    if (j - i >= 4) {
                        char b[320];
                        _snprintf_s(b, sizeof(b), _TRUNCATE, "      ascii +0x%03llX: %.200s\n",
                                    (unsigned long long)i, (const char*)(buf + i));
                        sec += b;
                        ++shown;
                    }
                    i = j;
                } else ++i;
            }
            if (!sec.empty()) out += sec;
        }

        // UTF-16LE runs (this is how WeChat stores local file paths)
        {
            size_t i = 0; int shown = 0;
            std::string sec;
            while (i + 1 < got && shown < 14) {
                if (isPrintable(buf[i]) && buf[i + 1] == 0) {
                    size_t j = i;
                    std::string s;
                    while (j + 1 < got && isPrintable(buf[j]) && buf[j + 1] == 0) {
                        s += (char)buf[j];
                        j += 2;
                    }
                    if (s.size() >= 4) {
                        char b[384];
                        _snprintf_s(b, sizeof(b), _TRUNCATE, "      utf16 +0x%03llX: %.200s\n",
                                    (unsigned long long)i, s.c_str());
                        sec += b;
                        ++shown;
                    }
                    i = j;
                } else ++i;
            }
            if (!sec.empty()) out += sec;
        }

        // voice XML markers
        {
            static const char* kMarks[] = { "voicemsg", "voiceurl", "aeskey", "voicelength", "voiceformat" };
            for (int m = 0; m < 5; ++m) {
                size_t ln = strlen(kMarks[m]);
                if (findBytes(buf, got, (const unsigned char*)kMarks[m], ln, &at)) {
                    char b[160];
                    _snprintf_s(b, sizeof(b), _TRUNCATE, "      XML-FIELD \"%s\" at +0x%llX\n",
                                kMarks[m], (unsigned long long)at);
                    out += b;
                }
            }
        }

        // one-level pointer chase: find local file paths / SILK buffers behind pointers
        if (depth > 0) {
            int followed = 0;
            for (size_t off = 0; off + 8 <= got && followed < kMaxPtrFollow; off += 8) {
                if (out.size() > kMaxBytesPerEvent) break;
                uint64_t q = 0;
                memcpy(&q, buf + off, 8);
                if (q < 0x10000 || q > 0x00007FFFFFFFFFFFULL) continue;
                if (!readable((const void*)q, 1)) continue;
                if (inModule(q)) continue;                 // skip code/vtable hits
                unsigned char sb[0x100 + 16];
                size_t sgot = 0;
                while (sgot < 0x100) {
                    size_t step = 0x100 - sgot; if (step > 64) step = 64;
                    if (!sehCopy((const unsigned char*)q + sgot, sb + sgot, step)) break;
                    sgot += step;
                }
                if (sgot == 0) continue;

                size_t sat = 0;
                bool silk = findBytes(sb, sgot, kSilk1, sizeof(kSilk1), &sat)
                         || findBytes(sb, sgot, (const unsigned char*)kSilk2, sizeof(kSilk2) - 1, &sat);
                bool interesting = silk;
                std::string ascii, utf16;
                {
                    size_t i = 0;
                    while (i < sgot) {
                        if (isPrintable(sb[i])) {
                            size_t j = i;
                            while (j < sgot && isPrintable(sb[j])) ++j;
                            if (j - i >= 5) {
                                ascii.assign((const char*)(sb + i), j - i);
                                break;
                            }
                            i = j;
                        } else ++i;
                    }
                    i = 0;
                    while (i + 1 < sgot) {
                        if (isPrintable(sb[i]) && sb[i + 1] == 0) {
                            size_t j = i; std::string s;
                            while (j + 1 < sgot && isPrintable(sb[j]) && sb[j + 1] == 0) { s += (char)sb[j]; j += 2; }
                            if (s.size() >= 5) { utf16 = s; break; }
                            i = j;
                        } else ++i;
                    }
                }
                if (ascii.find(".silk") != std::string::npos || ascii.find("\\") != std::string::npos
                    || ascii.find(".amr") != std::string::npos) interesting = true;
                if (utf16.find(".silk") != std::string::npos || utf16.find('\\') != std::string::npos
                    || utf16.find(".amr") != std::string::npos) interesting = true;
                if (ascii.find("voice") != std::string::npos || utf16.find("voice") != std::string::npos) interesting = true;
                // ★ 2026-10-21：原来只打「含反斜杠/含 .silk/voice」的指针，
                //   导致 CDN 下载 param 里的 194 字符 blob / 37 字符 filekey / 32 字符 aeskey 被跳过。
                //   现在：任何 >=16 字符的可打印内容也打印。
                if (!interesting && ascii.size() < 16 && utf16.size() < 16) continue;
                // 原规则保留在下面（作为「必定打印」的判定）：
                // if (!interesting) continue;

                ++followed;
                char b[640];
                _snprintf_s(b, sizeof(b), _TRUNCATE,
                            "      ptr @+0x%03llX -> 0x%llX%s  ascii=\"%.120s\" utf16=\"%.120s\"\n",
                            (unsigned long long)off, (unsigned long long)q,
                            silk ? " [SILK]" : "", ascii.c_str(), utf16.c_str());
                out += b;
            }
        }
    }

    static void dumpArgs(std::string& out, const char* name, uint64_t a1, uint64_t a2,
                         uint64_t a3, uint64_t a4, uint64_t a5)
    {
        char b[512];
        _snprintf_s(b, sizeof(b), _TRUNCATE,
                    "  [VUPROBE] %s  a1=0x%llX a2=0x%llX a3=0x%llX a4=0x%llX a5=0x%llX\n",
                    name, (unsigned long long)a1, (unsigned long long)a2,
                    (unsigned long long)a3, (unsigned long long)a4, (unsigned long long)a5);
        out += b;
        const uint64_t args[5] = { a1, a2, a3, a4, a5 };
        const char* labels[5] = { "a1", "a2", "a3", "a4", "a5" };
        for (int i = 0; i < 5; ++i) {
            if (out.size() > kMaxBytesPerEvent) break;
            if (args[i] < 0x10000 || args[i] > 0x00007FFFFFFFFFFFULL) continue;
            if (!readable((const void*)args[i], 1)) continue;
            if (inModule(args[i])) continue;             // vtable/code pointers: skip
            dumpRegion(out, labels[i], args[i], kRegionBytes, 1);
        }
    }

    // ── event sink ─────────────────────────────────────────────────────────
    static bool takeSlot(int hookIdx)
    {
        if (hookIdx < 0 || hookIdx >= 16) return false;
        int v = g_events[hookIdx].fetch_add(1);
        return v < kMaxEventsPerHook;
    }

    static bool enabled()
    {
        if (g_forceOn.load()) return true;
        if (g_markerPath[0] == 0) return false;
        DWORD a = GetFileAttributesA(g_markerPath);
        bool on = (a != INVALID_FILE_ATTRIBUTES);
        g_markerSeen.store(on);
        return on;
    }

    static void emit(int hookIdx, const char* name, const std::string& body)
    {
        char ts[32]; stamp(ts, sizeof(ts));
        std::string s = "[VUPROBE] ";
        s += ts; s += " "; s += name; s += "\n"; s += body;
        if (s.size() > kMaxBytesPerEvent + 512) s.resize(kMaxBytesPerEvent + 512);
        vlog(s);
        (void)hookIdx;
    }

    // ── paths ───────────────────────────────────────────────────────────────
    static char g_replayMarker[MAX_PATH] = { 0 };
    static char g_replayDir[MAX_PATH] = { 0 };

    static void initPaths()
    {
        if (g_pathsReady) return;
        char exe[MAX_PATH] = { 0 };
        GetModuleFileNameA(nullptr, exe, MAX_PATH);
        char* slash = strrchr(exe, '\\');
        if (slash) *(slash + 1) = 0; else exe[0] = 0;
        _snprintf_s(g_logPath, sizeof(g_logPath), _TRUNCATE, "%svoice-upload-probe.log", exe);
        _snprintf_s(g_markerPath, sizeof(g_markerPath), _TRUNCATE, "%shook-vuprobe.on", exe);
        _snprintf_s(g_replayMarker, sizeof(g_replayMarker), _TRUNCATE, "%shook-cdn-replay.on", exe);
        _snprintf_s(g_replayDir, sizeof(g_replayDir), _TRUNCATE, "D:\\cdndl-replay");
        char dirFile[MAX_PATH] = { 0 };
        _snprintf_s(dirFile, sizeof(dirFile), _TRUNCATE, "%shook-cdn-replay.dir", exe);
        HANDLE h = CreateFileA(dirFile, GENERIC_READ, FILE_SHARE_READ, nullptr,
                               OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h != INVALID_HANDLE_VALUE) {
            char buf[MAX_PATH] = { 0 };
            DWORD rd = 0;
            ReadFile(h, buf, sizeof(buf) - 1, &rd, nullptr);
            CloseHandle(h);
            if (rd > 0) {
                for (DWORD i = 0; i < rd; ++i) if (buf[i] == '\r' || buf[i] == '\n') { buf[i] = 0; break; }
                if (buf[0]) _snprintf_s(g_replayDir, sizeof(g_replayDir), _TRUNCATE, "%s", buf);
            }
        }
        CreateDirectoryA(g_replayDir, nullptr);
        g_pathsReady = true;
    }

    // ── CDN download replay（搭便车：微信自己下载时，用同一份活 param 再调一次）──
    static bool replayEnabled()
    {
        if (g_replayMarker[0] == 0) return false;
        DWORD a = GetFileAttributesA(g_replayMarker);
        return a != INVALID_FILE_ATTRIBUTES;
    }

    static const int kReplaySlots = 8;
    static char g_replayParam[kReplaySlots][0x400];
    static char g_replayPath[kReplaySlots][512];
    static std::atomic<int> g_replaySeq{ 0 };
    typedef uint64_t (*CdnDl_t)(uint64_t, uint64_t, uint64_t, uint64_t,
                                uint64_t, uint64_t, uint64_t, uint64_t);
    static CdnDl_t g_origDl = nullptr;      // 原始 StartC2CDownload（在 installHooks 里赋值）

    // ★ 原地重放：不复制 param，只在原对象上临时改「输出路径」，调一次，再恢复。
    //   为什么：上一次「复制 param」重放触发 0xC0000005（副本里的回调对象指针失效）。
    //   原地修改时其它字段全是调用方活着的对象，安全得多。
    // ── 安全版重放（R14）：只对新消息、每图一次、限流、去重、有冷却 ──────────────
    static uint64_t g_lastReplayTick = 0;
    static int      g_replayBurst = 0;
    static uint64_t g_burstStart = 0;
    static uint64_t g_cooldownUntil = 0;
    static char     g_lastName[192] = { 0 };
    static uint64_t g_lastNameAt = 0;

    static long long nowUnixSafe()
    {
        FILETIME ft; GetSystemTimeAsFileTime(&ft);
        ULARGE_INTEGER u; u.LowPart = ft.dwLowDateTime; u.HighPart = ft.dwHighDateTime;
        return (long long)((u.QuadPart / 10000000ULL) - 11644473600ULL);
    }

    static void replayInline(uint64_t thisp, uint64_t param, uint64_t a3,
                             uint64_t a4, uint64_t a5, uint64_t a6, uint64_t a7, uint64_t a8)
    {
        if (!replayEnabled()) return;
        if (param < 0x10000 || !readable((const void*)param, 0x100)) return;
        if (!g_origDl) return;

        // ── 从任务名尾部解析时间戳：<roomId>_<unix秒>_<localId>_<seq> ──
        char name[192] = { 0 };
        const char* pname = *(const char**)(param + 0x50);
        size_t nlen = *(const size_t*)(param + 0x60);
        if (!pname || nlen == 0 || nlen >= sizeof(name) - 1 || !readable(pname, 1)) return;
        for (size_t i = 0; i < nlen; ++i) {
            char c = pname[i];
            if (c == '\\' || c == '/' || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|') c = '_';
            if (!c) { name[i] = 0; break; }
            name[i] = c;
        }
        name[nlen] = 0;

        char work[192];
        _snprintf_s(work, sizeof(work), _TRUNCATE, "%s", name);
        char* pSeq = strrchr(work, '_');   if (!pSeq) return;
        *pSeq = 0;
        char* pLoc = strrchr(work, '_');   if (!pLoc) return;
        *pLoc = 0;
        char* pTs = strrchr(work, '_');    if (!pTs) return;
        long long msgTs = _strtoi64(pTs + 1, nullptr, 10);

        // ① 只对新消息生效（登录/刷新会重下历史图，必须放过）
        long long now = nowUnixSafe();
        if (msgTs <= 0) { return; }
        if (now - msgTs > 60) {
            { char m[512]; _snprintf_s(m, sizeof(m), _TRUNCATE, "[VUPROBE] replay skip(old %llds) %s\n", now - msgTs, name); rawWrite(m, strlen(m)); }
            return;
        }

        // ② 判别图片 / 视频，决定目标档位
        //    实测语义：图片 3=缩略图 / 2=原图；视频 3=封面 / 4=整段视频
        uint32_t saveType = *(uint32_t*)(param + 0xD0);
        char origPath[512] = { 0 };
        {
            const char* pp = *(const char**)(param + 0xB0);
            size_t np = *(const size_t*)(param + 0xC0);
            if (pp && np > 0 && np < sizeof(origPath) - 1 && readable(pp, 1)) {
                size_t c = np < sizeof(origPath) - 1 ? np : sizeof(origPath) - 1;
                memcpy(origPath, pp, c); origPath[c] = 0;
            }
        }
        bool isVideo = (strstr(origPath, "\\Video") != nullptr) || (strstr(origPath, "\\video") != nullptr);
        uint32_t targetType = isVideo ? 4u : 2u;
        if (saveType == targetType) return;   // 客户端已在取目标档位

        // ③ 限流 / 去重 / 冷却
        uint64_t t = GetTickCount64();
        if (t < g_cooldownUntil) { return; }
        if (t - g_burstStart > 60000ULL) { g_replayBurst = 0; g_burstStart = t; }
        if (g_replayBurst >= 10) {
            g_cooldownUntil = t + 60000ULL;
            { char m[512]; _snprintf_s(m, sizeof(m), _TRUNCATE, "[VUPROBE] replay cooldown(1min) burst=%d %s\n", g_replayBurst, name); rawWrite(m, strlen(m)); }
            g_replayBurst = 0;
            return;
        }
        if (t - g_lastReplayTick < 2000ULL) return;                       // 2 秒内最多一次
        if (g_lastName[0] && strcmp(g_lastName, name) == 0 && t - g_lastNameAt < 60000ULL) return; // 同一条消息只补一次

        // ④ 执行：只补一次 type=2（原图档）
        g_lastReplayTick = t;
        g_replayBurst++;
        _snprintf_s(g_lastName, sizeof(g_lastName), _TRUNCATE, "%s", name);
        g_lastNameAt = t;

        uint64_t savePath = *(uint64_t*)(param + 0xB0);
        uint64_t saveSize = *(uint64_t*)(param + 0xC0);
        uint64_t saveCap = *(uint64_t*)(param + 0xC8);

        int slot = g_replaySeq.fetch_add(1) % kReplaySlots;
        char* path = g_replayPath[slot];
        _snprintf_s(path, 512, _TRUNCATE, "%s\\%s_%s_s%d.dat", g_replayDir, name, isVideo ? "hdvideo" : "hd", slot);

        *(uint64_t*)(param + 0xB0) = (uint64_t)path;
        *(uint64_t*)(param + 0xC0) = (uint64_t)strlen(path);
        *(uint64_t*)(param + 0xC8) = (uint64_t)strlen(path);
        *(uint32_t*)(param + 0xD0) = targetType;

        DWORD exc = 0;
        __try {
            g_origDl(thisp, param, a3, a4, a5, a6, a7, a8);
        }
        __except (EXCEPTION_EXECUTE_HANDLER) {
            exc = GetExceptionCode();
        }

        *(uint64_t*)(param + 0xB0) = savePath;
        *(uint64_t*)(param + 0xC0) = saveSize;
        *(uint64_t*)(param + 0xC8) = saveCap;
        *(uint32_t*)(param + 0xD0) = saveType;

        { char m[512]; _snprintf_s(m, sizeof(m), _TRUNCATE, "[VUPROBE] replay ok(type=%u%s exc=0x%08X) %s\n", (unsigned)targetType, isVideo ? " video" : "", (unsigned)exc, path); rawWrite(m, strlen(m)); }
    }

    static void doReplay(uint64_t thisp, uint64_t param, uint64_t a3)
    {
        {
            char dbg[256];
            _snprintf_s(dbg, sizeof(dbg), _TRUNCATE,
                        "[VUPROBE] replay-check enabled=%d this=0x%llX param=0x%llX dir=%s\n",
                        replayEnabled() ? 1 : 0, (unsigned long long)thisp,
                        (unsigned long long)param, g_replayDir);
            rawWrite(dbg, strlen(dbg));
        }
        char step[256];
        if (!replayEnabled()) return;
        if (param < 0x10000) return;
        bool rdo = readable((const void*)param, 1);
        _snprintf_s(step, sizeof(step), _TRUNCATE, "[VUPROBE] step1 readable=%d origDl=%p\n", rdo ? 1 : 0, (void*)g_origDl);
        rawWrite(step, strlen(step));
        if (!rdo) return;

        int slot = g_replaySeq.fetch_add(1) % kReplaySlots;
        char* pb = g_replayParam[slot];
        bool cok = sehCopy((const unsigned char*)param, (unsigned char*)pb, 0x400);
        _snprintf_s(step, sizeof(step), _TRUNCATE, "[VUPROBE] step2 slot=%d copy=%d\n", slot, cok ? 1 : 0);
        rawWrite(step, strlen(step));
        if (!cok) return;

        char name[160] = { 0 };
        const char* pname = *(const char**)(pb + 0x50);
        size_t nlen = *(const size_t*)(pb + 0x60);
        if (pname && nlen > 0 && nlen < 150 && readable(pname, 1)) {
            size_t i = 0;
            for (; i < nlen; ++i) {
                char c = pname[i];
                if (c == '\\' || c == '/' || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|') c = '_';
                name[i] = c;
            }
            name[i] = 0;
        }
        if (name[0] == 0) _snprintf_s(name, sizeof(name), _TRUNCATE, "cdn_%llu", (unsigned long long)GetTickCount64());

        int type = *(const int*)(pb + 0xD0);
        // ★ 任务名必须唯一：用微信自己的名字会冲突（CDN 框架按名字登记任务），追加 _r<seq>
        int seqNo = g_replaySeq.load();
        char uniq[200];
        _snprintf_s(uniq, sizeof(uniq), _TRUNCATE, "%s_r%d", name, seqNo);
        static char s_nameBuf[kReplaySlots][256];
        char* nb = s_nameBuf[slot];
        _snprintf_s(nb, 256, _TRUNCATE, "%s", uniq);
        // 替换 +0x50 的 std::string（ptr/size/cap）
        *(char**)(pb + 0x50) = nb;
        *(size_t*)(pb + 0x60) = strlen(nb);
        *(size_t*)(pb + 0x68) = strlen(nb);

        char* path = g_replayPath[slot];
        _snprintf_s(path, 512, _TRUNCATE, "%s\\%s_t%d_s%d.dat", g_replayDir, name, type, slot);

        // 替换输出路径 std::string at +0xB0（ptr / size / capacity）
        *(char**)(pb + 0xB0) = path;
        *(size_t*)(pb + 0xC0) = strlen(path);
        *(size_t*)(pb + 0xC8) = strlen(path);

        _snprintf_s(step, sizeof(step), _TRUNCATE,
                    "[VUPROBE] step3 name=%s type=%d path=%s\n", name, type, path);
        rawWrite(step, strlen(step));
        if (g_origDl) {
            DWORD exc = 0;
            __try {
                g_origDl(thisp, (uint64_t)pb, a3, 0, 0, 0, 0, 0);
            }
            __except (EXCEPTION_EXECUTE_HANDLER) {
                exc = GetExceptionCode();
            }
            char msg[512];
            _snprintf_s(msg, sizeof(msg), _TRUNCATE,
                        "[VUPROBE] CDN replay → type=%d exc=0x%08X name=%s\n", type, exc, nb);
            rawWrite(msg, strlen(msg));
        }
    }


    // ── probe bodies (NO __try here: these may use C++ objects) ─────────────
    static void probeEnter(int idx, const char* name,
                           uint64_t a1, uint64_t a2, uint64_t a3, uint64_t a4, uint64_t a5)
    {
        std::string out;
        dumpArgs(out, name, a1, a2, a3, a4, a5);
        emit(idx, name, out);
    }

    static void probeExit(int idx, const char* name, uint64_t ret, uint64_t a1)
    {
        std::string out;
        char b[256];
        _snprintf_s(b, sizeof(b), _TRUNCATE, "  ret=0x%llX  a1=0x%llX\n",
                    (unsigned long long)ret, (unsigned long long)a1);
        out += b;
        if (a1 >= 0x10000 && a1 <= 0x00007FFFFFFFFFFFULL
            && readable((const void*)a1, 1) && !inModule(a1))
            dumpRegion(out, "out(a1)", a1, kRegionBytes, 1);
        if (ret >= 0x10000 && ret <= 0x00007FFFFFFFFFFFULL
            && readable((const void*)ret, 1) && !inModule(ret))
            dumpRegion(out, "ret", ret, 0x100, 1);
        emit(idx, name, out);
    }

    // ── detours ─────────────────────────────────────────────────────────────
    // 8-argument superset forwarding: all integer/pointer arguments are passed
    // through unchanged.  Verified call sites of every hooked function pass at
    // most 6 arguments, so nothing can be lost.
    typedef uint64_t (*Gen8_t)(uint64_t, uint64_t, uint64_t, uint64_t,
                               uint64_t, uint64_t, uint64_t, uint64_t);

    static Gen8_t g_o[16] = { nullptr };

#define VU_DEF_HOOK(IDX, NAME, ENTERDUMP, EXITDUMP)                                    \
    static uint64_t detour_##IDX(uint64_t a1, uint64_t a2, uint64_t a3, uint64_t a4,    \
                                 uint64_t a5, uint64_t a6, uint64_t a7, uint64_t a8)    \
    {                                                                                   \
        if (!enabled()) {                                                               \
            return g_o[IDX] ? g_o[IDX](a1,a2,a3,a4,a5,a6,a7,a8) : 0;                    \
        }                                                                               \
        bool slot = takeSlot(IDX);                                                      \
        if (slot && (ENTERDUMP)) {                                                      \
            __try { probeEnter(IDX, NAME " ENTER", a1,a2,a3,a4,a5); }                    \
            __except (EXCEPTION_EXECUTE_HANDLER) {                                      \
                OutputDebugStringA("[VUPROBE] " NAME " ENTER probe exception\n");        \
            }                                                                           \
        }                                                                               \
        uint64_t ret = g_o[IDX] ? g_o[IDX](a1,a2,a3,a4,a5,a6,a7,a8) : 0;                 \
        if (slot && (EXITDUMP)) {                                                       \
            __try { probeExit(IDX, NAME " EXIT", ret, a1); }                             \
            __except (EXCEPTION_EXECUTE_HANDLER) {                                      \
                OutputDebugStringA("[VUPROBE] " NAME " EXIT probe exception\n");         \
            }                                                                           \
        }                                                                               \
        return ret;                                                                     \
    }

    VU_DEF_HOOK(0, "StartC2CUpload",       true,  false)
    VU_DEF_HOOK(1, "CgiUploadVoice",       true,  false)
    VU_DEF_HOOK(2, "CgiUploadVoicePrep",   true,  false)
    VU_DEF_HOOK(3, "CgiUploadVoicePrep2",  true,  false)
    VU_DEF_HOOK(4, "CgiUploadVoiceForTrans", true, false)
    VU_DEF_HOOK(5, "VoiceMsgFactory",      false, true)
    VU_DEF_HOOK(6, "VoiceInnerCtor",       false, true)
    VU_DEF_HOOK(7, "VoiceSendPath",        true,  false)
    // ★ 2026-10-21 自定义 detour：StartC2CDownload（探测 + 可选「搭便车重放」）
    //   先让微信自己的调用照常执行，再（若开启 hook-cdn-replay.on）用同一份活 param 换个输出路径再调一次。
    static uint64_t detour_8(uint64_t a1, uint64_t a2, uint64_t a3, uint64_t a4,
                             uint64_t a5, uint64_t a6, uint64_t a7, uint64_t a8)
    {
        bool probeOn = enabled();
        bool replayOn = replayEnabled();
        if (!probeOn && !replayOn) {
            return g_o[8] ? g_o[8](a1, a2, a3, a4, a5, a6, a7, a8) : 0;
        }
        if (probeOn) {
            bool slot = takeSlot(8);
            if (slot) {
                __try { probeEnter(8, "StartC2CDownload ENTER", a1, a2, a3, a4, a5); }
                __except (EXCEPTION_EXECUTE_HANDLER) {
                    OutputDebugStringA("[VUPROBE] StartC2CDownload ENTER probe exception\n");
                }
            }
        }
        // ★ 原地重放：先改路径调一次（落我们目录），再恢复原值走微信自己的调用
        if (replayOn) {
            __try { replayInline(a1, a2, a3, a4, a5, a6, a7, a8); }
            __except (EXCEPTION_EXECUTE_HANDLER) {
                OutputDebugStringA("[VUPROBE] CDN replayInline exception\n");
            }
        }
        uint64_t ret = g_o[8] ? g_o[8](a1, a2, a3, a4, a5, a6, a7, a8) : 0;
        return ret;
    }

    struct HookDef { int idx; const char* name; uint64_t rva; void* detour; };
    static const HookDef kHooks[] = {
        { 0, "StartC2CUpload",        0x0D84530ULL, (void*)&detour_0 },
        { 1, "CgiUploadVoice",        0x52F4990ULL, (void*)&detour_1 },
        { 2, "CgiUploadVoicePrep",    0x52F3420ULL, (void*)&detour_2 },
        { 3, "CgiUploadVoicePrep2",   0x52F73B0ULL, (void*)&detour_3 },
        { 4, "CgiUploadVoiceForTrans",0x52DD5C0ULL, (void*)&detour_4 },
        { 5, "VoiceMsgFactory",       0x619A190ULL, (void*)&detour_5 },
        { 6, "VoiceInnerCtor",        0x619B3B0ULL, (void*)&detour_6 },
        { 7, "VoiceSendPath",         0x54B02A0ULL, (void*)&detour_7 },
        { 8, "StartC2CDownload",      0xD84930ULL,  (void*)&detour_8 },
    };

    static void installHooks()
    {
        if (g_installed.load()) return;
        if (g_hWeixinDll == nullptr) return;
        MH_STATUS st = MH_Initialize();
        if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) {
            vlog("[VUPROBE] MH_Initialize failed\n");
            return;
        }
        g_hookCount = (int)(sizeof(kHooks) / sizeof(kHooks[0]));
        g_hookOk = 0;
        std::string line = "[VUPROBE] installing read-only probes:\n";
        for (int i = 0; i < g_hookCount; ++i) {
            const HookDef& h = kHooks[i];

            // ★ 2026-10-22：RVA == 0 表示这条 hook 在**公开版补丁里被刻意清零**（黑盒边界，
            //   kHooks 表里那些 0ULL 就是）。绝不能拿 0 去算地址 —— 那是 PE 头（"MZ"），
            //   MinHook 可能真的在那里下钩子，之后微信执行到就崩。
            //   直接跳过并标出来，让自行编译的人知道这是"故意关掉的"，不是安装失败。
            if (h.rva == 0) {
                line += "    ";
                line += h.name;
                line += "  (disabled in public build)\n";
                continue;
            }

            void* target = (void*)((uintptr_t)g_hWeixinDll + h.rva);
            MH_STATUS c = MH_CreateHook(target, h.detour, (LPVOID*)&g_o[h.idx]);
            MH_STATUS e = (c == MH_OK) ? MH_EnableHook(target) : c;
            if (c == MH_OK && e == MH_OK && h.idx == 8) {
                g_origDl = (CdnDl_t)g_o[8];      // 供 doReplay 调用原始函数
            }
            char b[192];
            _snprintf_s(b, sizeof(b), _TRUNCATE, "    %-22s Weixin.dll+0x%llX  %s\n",
                        h.name, (unsigned long long)h.rva,
                        (c == MH_OK && e == MH_OK) ? "OK" : "FAILED");
            line += b;
            if (c == MH_OK && e == MH_OK) ++g_hookOk;
        }
        g_installed.store(true);
        vlog(line);
    }

    // ── watcher thread ──────────────────────────────────────────────────────
    static DWORD WINAPI watchThread(LPVOID)
    {
        Sleep(1500);
        initPaths();
        for (;;) {
            if (enabled()) {
                installHooks();
                if (!g_announced.load()) {
                    g_announced.store(true);
                    char b[640];
                    _snprintf_s(b, sizeof(b), _TRUNCATE,
                        "[VUPROBE] ON -> %d/%d probes installed.\n"
                        "[VUPROBE] marker = %s\n"
                        "[VUPROBE] log    = %s\n"
                        "[VUPROBE] Now send ONE voice message (and, for calibration, one image).\n",
                        g_hookOk, g_hookCount, g_markerPath, g_logPath);
                    vlog(b);
                }
            } else if (!g_announced.load()) {
                g_announced.store(true);
                char b[512];
                _snprintf_s(b, sizeof(b), _TRUNCATE,
                    "[VUPROBE] idle (default OFF, no hook installed). marker = %s\n",
                    g_markerPath);
                vlog(b);
            }
            Sleep(1000);
        }
        return 0;
    }

    // ── public API ──────────────────────────────────────────────────────────
    void StartThread()
    {
        HANDLE h = CreateThread(nullptr, 0, watchThread, nullptr, 0, nullptr);
        if (h) CloseHandle(h);
    }

    void SetEnabled(bool on)
    {
        initPaths();
        g_forceOn.store(on);
        if (on) {
            installHooks();
            g_announced.store(false);
        }
    }

    bool IsEnabled() { return enabled(); }

    std::string ReportJson()
    {
        initPaths();
        std::string j;
        char b[512];
        j += "{\n";
        _snprintf_s(b, sizeof(b), _TRUNCATE, "  \"enabled\": %s,\n", enabled() ? "true" : "false");
        j += b;
        _snprintf_s(b, sizeof(b), _TRUNCATE, "  \"forceOn\": %s,\n", g_forceOn.load() ? "true" : "false");
        j += b;
        _snprintf_s(b, sizeof(b), _TRUNCATE, "  \"markerExists\": %s,\n", g_markerSeen.load() ? "true" : "false");
        j += b;
        _snprintf_s(b, sizeof(b), _TRUNCATE, "  \"installed\": %s,\n", g_installed.load() ? "true" : "false");
        j += b;
        _snprintf_s(b, sizeof(b), _TRUNCATE, "  \"hooksOk\": %d,\n", g_hookOk);
        j += b;
        _snprintf_s(b, sizeof(b), _TRUNCATE, "  \"hooksTotal\": %d,\n", g_hookCount);
        j += b;
        _snprintf_s(b, sizeof(b), _TRUNCATE, "  \"marker\": \"%s\",\n", g_markerPath);
        j += b;
        _snprintf_s(b, sizeof(b), _TRUNCATE, "  \"log\": \"%s\",\n", g_logPath);
        j += b;
        j += "  \"events\": {";
        for (int i = 0; i < 8; ++i) {
            _snprintf_s(b, sizeof(b), _TRUNCATE, "%s\"%s\": %d", i ? ", " : "",
                        kHooks[i].name, g_events[i].load());
            j += b;
        }
        j += "},\n";
        j += "  \"note\": \"read-only probes; no message is sent, nothing is modified\"\n";
        j += "}\n";
        return j;
    }
}

#endif // !PUBLIC_BUILD
