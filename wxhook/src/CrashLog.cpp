// CrashLog.cpp -- 崩溃现场记录器（只读观察，绝不改变客户端行为）
//
// 为什么需要：语音 + 发图片同时进行时客户端会偶发崩溃，但 Windows 事件日志与 WER
// 查不到记录（不是标准未处理异常退出，或被客户端自己的异常处理器吞掉），也没有 dump。
// 本模块在进程内装一个 Vectored Exception Handler：
//   - 致命异常（AV / 堆损坏 / fail-fast / 栈溢出）发生时先把现场写进 hook-crash.log，
//     再原样交还后续处理器（EXCEPTION_CONTINUE_SEARCH）——不拦截、不吞异常。
//   - 同时维护"最近操作"环形缓冲，崩溃时一并落盘，能看出崩在语音/图片/查库哪一步之后。
//
// 输出：<微信客户端目录>\hook-crash.log
// 正常路径近乎零开销（一次 InterlockedIncrement，不分配内存）。

#include <windows.h>
#include <stdio.h>
#include <stdarg.h>
#include <string>
#include "CrashLog.h"

namespace crashlog
{
    static const int RING = 64;
    struct Op
    {
        volatile LONG seq;
        DWORD tid;
        DWORD tick;
        char  what[112];
    };
    static Op g_ring[RING];
    static volatile LONG g_seq = 0;
    static volatile LONG g_installed = 0;
    static PVOID g_veh = nullptr;

    void Note(const char* fmt, ...)
    {
        LONG n = InterlockedIncrement(&g_seq);
        Op& o = g_ring[n % RING];
        o.seq = n;
        o.tid = ::GetCurrentThreadId();
        o.tick = ::GetTickCount();
        va_list ap;
        va_start(ap, fmt);
        _vsnprintf_s(o.what, sizeof(o.what), _TRUNCATE, fmt, ap);
        va_end(ap);
    }

    static std::string LogPath()
    {
        char path[MAX_PATH] = { 0 };
        HMODULE hm = nullptr;
        if (::GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                                 (LPCSTR)&Note, &hm) && hm)
        {
            DWORD n = ::GetModuleFileNameA(hm, path, MAX_PATH);
            if (n > 0)
            {
                char* slash = strrchr(path, '\\');
                if (slash) { *(slash + 1) = '\0'; return std::string(path) + "hook-crash.log"; }
            }
        }
        char tmp[MAX_PATH] = { 0 };
        ::GetTempPathA(MAX_PATH, tmp);
        return std::string(tmp) + "hook-crash.log";
    }

    static void DescribeAddr(HANDLE hProc, uint64_t addr, char* out, size_t cb)
    {
        out[0] = '\0';
        if (!addr) { _snprintf_s(out, cb, _TRUNCATE, "0x0"); return; }
        MEMORY_BASIC_INFORMATION mbi = { 0 };
        if (!::VirtualQueryEx(hProc, (LPCVOID)addr, &mbi, sizeof(mbi)) || !mbi.AllocationBase)
        {
            _snprintf_s(out, cb, _TRUNCATE, "0x%llX (unmapped)", (unsigned long long)addr);
            return;
        }
        char mod[MAX_PATH] = { 0 };
        if (!::GetModuleFileNameA((HMODULE)mbi.AllocationBase, mod, MAX_PATH))
            _snprintf_s(mod, sizeof(mod), _TRUNCATE, "<unknown>");
        const char* base = strrchr(mod, '\\');
        base = base ? base + 1 : mod;
        _snprintf_s(out, cb, _TRUNCATE, "%s+0x%llX", base,
                    (unsigned long long)(addr - (uint64_t)mbi.AllocationBase));
    }

    static const char* CodeName(DWORD code)
    {
        switch (code)
        {
        case EXCEPTION_ACCESS_VIOLATION:      return "EXCEPTION_ACCESS_VIOLATION";
        case EXCEPTION_ARRAY_BOUNDS_EXCEEDED: return "EXCEPTION_ARRAY_BOUNDS_EXCEEDED";
        case EXCEPTION_INT_DIVIDE_BY_ZERO:    return "EXCEPTION_INT_DIVIDE_BY_ZERO";
        case EXCEPTION_STACK_OVERFLOW:        return "EXCEPTION_STACK_OVERFLOW";
        case EXCEPTION_ILLEGAL_INSTRUCTION:   return "EXCEPTION_ILLEGAL_INSTRUCTION";
        case EXCEPTION_PRIV_INSTRUCTION:      return "EXCEPTION_PRIV_INSTRUCTION";
        case EXCEPTION_IN_PAGE_ERROR:         return "EXCEPTION_IN_PAGE_ERROR";
        case 0xC0000374:                      return "STATUS_HEAP_CORRUPTION";
        case 0xC0000409:                      return "STATUS_STACK_BUFFER_OVERRUN";
        case 0xC000000D:                      return "STATUS_INVALID_PARAMETER";
        case 0x80000003:                      return "BREAKPOINT";
        case 0xE06D7363:                      return "CPP_EXCEPTION";
        default:                              return "EXCEPTION_OTHER";
        }
    }

    // 扫栈上"像模块内代码地址"的值 —— 廉价调用栈。
    // 单独成函数（只用 POD）：__try 不能出现在含 std::string 等需析构对象的函数里（C2712）
    static void ScanStack(uint64_t rsp, char* out, size_t cb)
    {
        size_t n = 0;
        uint64_t* sp = (uint64_t*)rsp;
        int shown = 0;
        n += _snprintf_s(out + n, cb - n, _TRUNCATE, "stack (code addrs):\r\n");
        __try
        {
            for (int i = 0; i < 64 && shown < 16 && n < cb - 400; i++)
            {
                uint64_t v = sp[i];
                MEMORY_BASIC_INFORMATION mbi = { 0 };
                if (v < 0x10000) continue;
                if (!::VirtualQuery((LPCVOID)v, &mbi, sizeof(mbi))) continue;
                if (mbi.Type != MEM_IMAGE) continue;
                char d[300] = { 0 };
                DescribeAddr(::GetCurrentProcess(), v, d, sizeof(d));
                n += _snprintf_s(out + n, cb - n, _TRUNCATE, "  [rsp+0x%03X] %s\r\n", i * 8, d);
                shown++;
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER)
        {
            n += _snprintf_s(out + n, cb - n, _TRUNCATE, "  <stack unreadable>\r\n");
        }
    }

    static LONG CALLBACK Handler(EXCEPTION_POINTERS* ep)
    {
        if (!ep || !ep->ExceptionRecord) return EXCEPTION_CONTINUE_SEARCH;
        DWORD code = ep->ExceptionRecord->ExceptionCode;

        bool fatal = (code == EXCEPTION_ACCESS_VIOLATION || code == EXCEPTION_STACK_OVERFLOW
                   || code == EXCEPTION_ILLEGAL_INSTRUCTION || code == EXCEPTION_IN_PAGE_ERROR
                   || code == 0xC0000374 || code == 0xC0000409 || code == 0xC000000D
                   || code == EXCEPTION_ARRAY_BOUNDS_EXCEEDED);
        if (!fatal) return EXCEPTION_CONTINUE_SEARCH;

        static volatile LONG seen = 0;
        if (InterlockedIncrement(&seen) > 8) return EXCEPTION_CONTINUE_SEARCH;

        std::string path = LogPath();
        HANDLE hf = ::CreateFileA(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                  nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (hf == INVALID_HANDLE_VALUE) return EXCEPTION_CONTINUE_SEARCH;

        char buf[8192];
        int n = 0;
        SYSTEMTIME st; ::GetLocalTime(&st);
        char addrDesc[300] = { 0 };
        DescribeAddr(::GetCurrentProcess(), (uint64_t)ep->ExceptionRecord->ExceptionAddress,
                     addrDesc, sizeof(addrDesc));

        n += _snprintf_s(buf + n, sizeof(buf) - n, _TRUNCATE,
            "\r\n========== HOOK CRASH CAPTURE ==========\r\n"
            "time    : %04d-%02d-%02d %02d:%02d:%02d.%03d\r\n"
            "pid/tid : %lu / %lu\r\n"
            "code    : 0x%08X  %s\r\n"
            "rip     : %s\r\n",
            st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds,
            (unsigned long)::GetCurrentProcessId(), (unsigned long)::GetCurrentThreadId(),
            code, CodeName(code), addrDesc);

        if (code == EXCEPTION_ACCESS_VIOLATION && ep->ExceptionRecord->NumberParameters >= 2)
        {
            ULONG_PTR kind = ep->ExceptionRecord->ExceptionInformation[0];
            uint64_t bad = (uint64_t)ep->ExceptionRecord->ExceptionInformation[1];
            char badDesc[300] = { 0 };
            DescribeAddr(::GetCurrentProcess(), bad, badDesc, sizeof(badDesc));
            n += _snprintf_s(buf + n, sizeof(buf) - n, _TRUNCATE, "access  : %s %s\r\n",
                kind == 0 ? "READ" : (kind == 1 ? "WRITE" : (kind == 8 ? "EXECUTE" : "?")), badDesc);
        }

        if (ep->ContextRecord)
        {
            CONTEXT* c = ep->ContextRecord;
            n += _snprintf_s(buf + n, sizeof(buf) - n, _TRUNCATE,
                "regs    : rax=%016llX rbx=%016llX rcx=%016llX rdx=%016llX\r\n"
                "          rsi=%016llX rdi=%016llX rbp=%016llX rsp=%016llX\r\n"
                "          r08=%016llX r09=%016llX r10=%016llX r11=%016llX\r\n"
                "          r12=%016llX r13=%016llX r14=%016llX r15=%016llX\r\n",
                (unsigned long long)c->Rax, (unsigned long long)c->Rbx,
                (unsigned long long)c->Rcx, (unsigned long long)c->Rdx,
                (unsigned long long)c->Rsi, (unsigned long long)c->Rdi,
                (unsigned long long)c->Rbp, (unsigned long long)c->Rsp,
                (unsigned long long)c->R8,  (unsigned long long)c->R9,
                (unsigned long long)c->R10, (unsigned long long)c->R11,
                (unsigned long long)c->R12, (unsigned long long)c->R13,
                (unsigned long long)c->R14, (unsigned long long)c->R15);
            char stackDump[3072] = { 0 };
            ScanStack((uint64_t)c->Rsp, stackDump, sizeof(stackDump));
            n += _snprintf_s(buf + n, sizeof(buf) - n, _TRUNCATE, "%s", stackDump);
        }

        n += _snprintf_s(buf + n, sizeof(buf) - n, _TRUNCATE, "recent hook ops (newest first):\r\n");
        LONG top = g_seq;
        for (int k = 0; k < 20 && n < (int)sizeof(buf) - 200; k++)
        {
            LONG idx = top - k;
            if (idx <= 0) break;
            Op& o = g_ring[idx % RING];
            if (o.seq != idx) continue;
            n += _snprintf_s(buf + n, sizeof(buf) - n, _TRUNCATE, "  #%ld tid=%lu t=%lu  %s\r\n",
                (long)idx, (unsigned long)o.tid, (unsigned long)o.tick, o.what);
        }
        n += _snprintf_s(buf + n, sizeof(buf) - n, _TRUNCATE, "========================================\r\n");

        DWORD wrote = 0;
        ::WriteFile(hf, buf, (DWORD)n, &wrote, nullptr);
        ::CloseHandle(hf);
        return EXCEPTION_CONTINUE_SEARCH;
    }

    void Install()
    {
        if (InterlockedExchange(&g_installed, 1)) return;
        g_veh = ::AddVectoredExceptionHandler(1, Handler);
        Note("crashlog installed veh=%p", g_veh);
    }
}
