// ═════════════════════════════════════════════════════════════════════════════
//  SendMoment.cpp —— /SendMoment（发朋友圈）
//
//  逆向依据（Weixin.dll 4.1.10.27）：
//    0x04EB0B90  构造 mmsnspost 请求 + CoCgiSendRequest 发送
//      5 参：rcx=P1 输出对象(0x38+ 字节)、rdx=P2(单例虚方法返回)、
//            r8=P3(栈结构)、r9=P4(std::string)、栈上第5参=P5
//      P5 = { DWORD type; DWORD flag; std::string text; void* extra; }
//          type=0、flag=0x1D4C0，text 在 +0x08（MSVC std::string）
//    P2 来源：读全局单例 [base+0x0A7F9B20]，再 call [[singleton]+0x10]
//
//  分阶段（stage 参数）便于先验证低风险部分：
//    stage=1  只读单例 + 取 P2（不调 mmsnspost，用来确认单例/虚表正常）
//    stage=2  完整调用 mmsnspost（有崩溃风险，默认关）
//
//  安全默认：默认 stage=1；要真发必须显式 stage=2 且开关文件存在。
// ═════════════════════════════════════════════════════════════════════════════
#include "httplib.h"
#include "json.hpp"
#include <windows.h>
#include <string>
#include <cstring>
#include <cstdio>
#include <ctime>
#include <intrin.h>
#include "global.h"
#include "SendMoment.h"
#include <MinHook.h>   // MOMENT-CAPTURE: 勾住 mmsnspost 构造函数录真实参数

using json = nlohmann::json;

std::string BuildMomentXml(const std::string& text, const std::string& wxid, bool priv);

namespace
{
    inline uintptr_t WxBase() { return (uintptr_t)GetModuleHandleA("Weixin.dll"); }

    // 纯 C 版：避免在带 __try 的函数里引入 std::string（C2712）
    inline void BuildMsStringC(void* dst, const char* s)
    {
        char* p = (char*)dst;
        ::memset(p, 0, 32);
        size_t n = s ? ::strlen(s) : 0;
        if (n <= 15) { if (n) ::memcpy(p, s, n); *(size_t*)(p + 0x10) = n; *(size_t*)(p + 0x18) = 15; }
        else {
            char* heap = new char[n + 1];
            ::memcpy(heap, s, n); heap[n] = 0;
            *(char**)p = heap; *(size_t*)(p + 0x10) = n; *(size_t*)(p + 0x18) = n;
        }
    }

    // MSVC std::string 布局（32 字节）：buf[16] @+0x00、size @+0x10、cap @+0x18
    // 本函数把 s 写入 dst（dst 指向 string 起点）
    inline void BuildMsString(void* dst, const std::string& s)
    {
        char* p = (char*)dst;
        ::memset(p, 0, 32);
        if (s.size() <= 15)
        {
            if (!s.empty()) ::memcpy(p, s.data(), s.size());
            *(size_t*)(p + 0x10) = s.size();
            *(size_t*)(p + 0x18) = 15;
        }
        else
        {
            char* heap = new char[s.size() + 1];
            ::memcpy(heap, s.data(), s.size());
            heap[s.size()] = 0;
            *(char**)p          = heap;
            *(size_t*)(p + 0x10) = s.size();
            *(size_t*)(p + 0x18) = s.size();
        }
    }

    // P5：{ DWORD type; DWORD flag; std::string text(@+0x08); void* extra(@+0x28) }
    struct MomentParam5
    {
        unsigned int type;     // +0x00
        unsigned int flag;     // +0x04
        char         str[32];  // +0x08  MSVC std::string
        void*        extra;    // +0x28
    };

    // __try 不能与需要对象展开（有析构函数）的函数共存（C2712），
    // 因此把 SEH 保护抽成只吃裸指针的独立函数。
    typedef int (*MomentFn5)(void*, void*, void*, void*, void*);

    // 崩溃现场（给 stage=2 迭代用）：异常码 / 异常地址 / 读写地址 / 关键寄存器
    volatile int       g_lastVariant = 0;
    volatile DWORD     g_exCode = 0;
    volatile ULONG_PTR g_exAddr = 0;
    volatile ULONG_PTR g_exAccess = 0;
    volatile ULONG_PTR g_exAddrRva = 0;
    volatile ULONG_PTR g_exRcx = 0, g_exRdx = 0, g_exR8 = 0, g_exR9 = 0;
    volatile ULONG_PTR g_exRsi = 0, g_exRdi = 0, g_exRsp = 0, g_exRbp = 0;
    volatile ULONG_PTR g_stack[12] = {0};   // 栈上落在 Weixin.dll 内的返回地址（RVA）
    volatile int       g_stackN = 0;

    void ScanStack(ULONG_PTR rsp, uintptr_t base)
    {
        g_stackN = 0;
        __try
        {
            const ULONG_PTR* p = (const ULONG_PTR*)rsp;
            for (int i = 0; i < 0x200 && g_stackN < 12; ++i)
            {
                ULONG_PTR v = p[i];
                if (v >= base && v < base + 0x0AF0E000)
                {
                    g_stack[g_stackN] = v - base;
                    ++g_stackN;
                }
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER) { }
    }

    int RecordCrash(struct _EXCEPTION_POINTERS* ep)
    {
        if (ep && ep->ExceptionRecord)
        {
            g_exCode = ep->ExceptionRecord->ExceptionCode;
            g_exAddr = (ULONG_PTR)ep->ExceptionRecord->ExceptionAddress;
            if (ep->ExceptionRecord->NumberParameters >= 2)
                g_exAccess = (ULONG_PTR)ep->ExceptionRecord->ExceptionInformation[1];
            {
                uintptr_t b = (uintptr_t)GetModuleHandleA("Weixin.dll");
                g_exAddrRva = (b && g_exAddr > b) ? (g_exAddr - b) : 0;
            }
        }
        if (ep && ep->ContextRecord)
        {
            CONTEXT* c = ep->ContextRecord;
            g_exRcx = c->Rcx; g_exRdx = c->Rdx; g_exR8 = c->R8; g_exR9 = c->R9;
            g_exRsi = c->Rsi; g_exRdi = c->Rdi; g_exRsp = c->Rsp; g_exRbp = c->Rbp;
            ScanStack(c->Rsp, (uintptr_t)GetModuleHandleA("Weixin.dll"));
        }
        return 1;
    }

    int CallVirtualProvoke(void* singleton, void** out)
    {
        __try
        {
            using Vfn = void* (*)(void*);
            void** vtbl = *(void***)singleton;
            if (!vtbl) return -1;
            Vfn vf = (Vfn)vtbl[2];          // [vtable + 0x10]
            if (!vf) return -1;
            *out = vf(singleton);
            return 0;
        }
        __except (EXCEPTION_EXECUTE_HANDLER) { return -1; }
    }

    int CallCtorGuarded(MomentFn5 fn, void* p1, void* p2, void* p3, void* p4, void* p5)
    {
        g_exCode = g_exAddr = g_exAccess = 0;
        g_exRcx = g_exRdx = g_exR8 = g_exR9 = 0;
        g_exRsi = g_exRdi = g_exRsp = g_exRbp = 0;
        __try { return fn(p1, p2, p3, p4, p5); }
        __except (RecordCrash(GetExceptionInformation()), EXCEPTION_EXECUTE_HANDLER) { return -99; }
    }

    int CallP3Ctor(void (*ctor)(void*), void* obj)
    {
        __try { ctor(obj); return 0; }
        __except (RecordCrash(GetExceptionInformation()), EXCEPTION_EXECUTE_HANDLER) { return -1; }
    }

    std::string DiagJson(uintptr_t base, void* singleton, void* p2, int stage, int ret)
    {
        // 崩溃地址落在哪个模块？(0x400000 = MEMORY_BASIC_INFORMATION.AllocationBase 偏移)
        uintptr_t exModule = 0;
        if (g_exAddr)
        {
            MEMORY_BASIC_INFORMATION mbi;
            if (VirtualQuery((LPCVOID)g_exAddr, &mbi, sizeof(mbi)))
                exModule = (uintptr_t)mbi.AllocationBase;
        }
        uintptr_t selfBase = (uintptr_t)GetModuleHandleA("version.dll");
        if (!selfBase) selfBase = (uintptr_t)GetModuleHandleA("Weixin.dll");

        char buf[1900];
        std::snprintf(buf, sizeof(buf),
            "{\"base\":\"0x%llX\",\"selfBase\":\"0x%llX\",\"exModule\":\"0x%llX\","
            "\"exIsSelf\":%d,\"exIsWeixin\":%d,"
            "\"singleton\":\"0x%llX\",\"p2\":\"0x%llX\","
            "\"stage\":%d,\"variant\":%d,\"ret\":%d,\"ctorRva\":\"0x%llX\",\"singletonRva\":\"0x%llX\","
            "\"exCode\":\"0x%llX\",\"exAddr\":\"0x%llX\",\"exAddrRva\":\"0x%llX\",\"exAccess\":\"0x%llX\","
            "\"reg\":{\"rcx\":\"0x%llX\",\"rdx\":\"0x%llX\",\"r8\":\"0x%llX\",\"r9\":\"0x%llX\","
            "\"rsi\":\"0x%llX\",\"rdi\":\"0x%llX\",\"rsp\":\"0x%llX\",\"rbp\":\"0x%llX\"}",
            (unsigned long long)base,
            (unsigned long long)selfBase,
            (unsigned long long)exModule,
            (exModule && selfBase && exModule == selfBase) ? 1 : 0,
            (exModule && base && exModule == base) ? 1 : 0,
            (unsigned long long)(uintptr_t)singleton,
            (unsigned long long)(uintptr_t)p2,
            stage, g_lastVariant, ret,
            (unsigned long long)offset::mmsnspost_ctor,
            (unsigned long long)offset::sns_singleton_ptr,
            (unsigned long long)g_exCode,
            (unsigned long long)g_exAddr,
            (unsigned long long)(base && g_exAddr ? (g_exAddr - base) : 0),
            (unsigned long long)g_exAccess,
            (unsigned long long)g_exRcx, (unsigned long long)g_exRdx,
            (unsigned long long)g_exR8,  (unsigned long long)g_exR9,
            (unsigned long long)g_exRsi, (unsigned long long)g_exRdi,
            (unsigned long long)g_exRsp, (unsigned long long)g_exRbp);
        std::string out(buf);
        // 追加栈回溯（崩溃时栈上落在 Weixin.dll 内的返回地址，RVA）
        out += ",\"stack\":[";
        for (int i = 0; i < g_stackN; ++i)
        {
            char t[24];
            std::snprintf(t, sizeof(t), "%s\"0x%llX\"", i ? "," : "",
                          (unsigned long long)g_stack[i]);
            out += t;
        }
        out += "]}";
        return out;
    }
}

// 返回：0 成功；-1 参数错；-2 模块未找到；-3 单例为空；-4 虚表异常；-99 未实现/未开启
int WeixinMoment::SendMoment(const std::string& text, int stage, std::string* diag, int variant, const std::string& wxid)
{
    g_lastVariant = variant;
    uintptr_t base = WxBase();
    if (!base) { if (diag) *diag = "{\"why\":\"Weixin.dll not loaded\"}"; return -2; }

    void* singleton = *(void**)(base + offset::sns_singleton_ptr);
    if (!singleton)
    {
        if (diag) *diag = DiagJson(base, nullptr, nullptr, stage, -3);
        return -3;
    }

    // P2 = singleton 的虚方法 [vtbl + 0x10] 的返回值
    void* p2 = nullptr;
    if (CallVirtualProvoke(singleton, &p2) != 0)
    {
        if (diag) *diag = DiagJson(base, singleton, nullptr, stage, -4);
        return -4;
    }

    if (stage < 2)
    {
        if (diag) *diag = DiagJson(base, singleton, p2, stage, 0);
        return 0;   // 只做探测
    }


    // ── stage 3：自己拼 XML 放进 P1+0x40，再调构造函数 ───────────────────────
    // 实测：真实调用时 P1+0x40 已是 std::string(buf@+0x40/size@+0x50/cap@+0x58)，
    //       内容就是 TimelineObject XML；P1+0x38 是 Weixin.dll 内函数指针(RVA 0x2BD9B9)
    if (stage == 3)
    {
        struct Q5 { unsigned int type; unsigned int flag; char str[32]; void* extra; };
        typedef void (*P3CtorT)(void*);
        MomentFn5 fn3 = (MomentFn5)(base + offset::mmsnspost_ctor);

        static char p1x[0x200];
        static char p3x[0x200];
        static char p4x[0x100];
        ::memset(p1x, 0, sizeof(p1x));
        ::memset(p3x, 0, sizeof(p3x));
        ::memset(p4x, 0, sizeof(p4x));
        *(void**)(p1x + 0x38) = (void*)(base + 0x2BD9B9);
        BuildMsString(p1x + 0x40, BuildMomentXml(text, wxid, false));

        P3CtorT p3c = (P3CtorT)(base + offset::moment_p3_ctor);
        if (CallP3Ctor(p3c, p3x) != 0)
        {
            if (diag) *diag = "{\"why\":\"P3 ctor crashed\",\"stage\":3}";
            return -5;
        }
        BuildMsString(p4x, "");

        Q5 q5;
        ::memset(&q5, 0, sizeof(q5));
        q5.type = 0;
        q5.flag = 0x1D4C0;
        // 假设：回调链由 P5 的字符串构建，空串会导致后续空指针 —— 把正文放进去试试
        BuildMsStringC(q5.str, text.c_str());

        int r3 = CallCtorGuarded(fn3, p1x, p2, p3x, p4x, &q5);
        if (diag) *diag = DiagJson(base, singleton, p2, stage, r3);
        return r3;
    }

    // ── stage 2：真正调用 mmsnspost ───────────────────────────────────────────
    MomentFn5 fn = (MomentFn5)(base + offset::mmsnspost_ctor);
    typedef void (*P3Ctor)(void*);

    static struct { char b[0x100]; } p1;
    static char p3[0x200];          // 真实大小 0x1A0，留余量
    static char p4[0x100];
    ::memset(&p1, 0, sizeof(p1));
    ::memset(p3, 0, sizeof(p3));
    ::memset(p4, 0, sizeof(p4));

    // P3 必须先构造（真实调用方：memset(0xAA, 0x1A0) 后 call 0x04DA2BB0）
    if (variant != 8)               // variant=8 故意不构造，作对照
    {
        P3Ctor p3ctor = (P3Ctor)(base + offset::moment_p3_ctor);
        int cr = CallP3Ctor(p3ctor, p3);
        if (cr != 0)
        {
            if (diag) *diag = DiagJson(base, singleton, p2, stage, -5);
            return -5;              // P3 构造就崩了
        }
    }

    MomentParam5 p5;
    ::memset(&p5, 0, sizeof(p5));
    p5.type = 0;          // 普通朋友圈
    p5.flag = 0x1D4C0;    // 调用方常量 0x1D4C000000000 的高 32 位
    BuildMsString(p5.str, text);

    // variant：逐项试探哪个参数不能为空（崩了 SEH 兜住，只记录现场）
    switch (variant)
    {
    case 1:  p5.extra = p2;              break;  // extra = P2
    case 2:  p5.extra = singleton;       break;  // extra = 单例
    case 3:  p5.extra = &p1;             break;  // extra = P1
    case 4:  *(void**)((char*)&p1 + 0x28) = p2;   break;  // P1+0x28 = P2
    case 5:  p5.type = 1;                break;
    case 6:  p5.type = 0x10;             break;
    case 7:  p5.flag = 0;                break;
    case 8:  break;                      // 故意不构造 P3（对照）
    // ★ P1 在 +0x18 处有 std::string（buf@0x18 / size@0x28 / cap@0x30），
    //   小函数 0x04EB3910 从这里把它拷进 P3+0x18 —— 正文很可能在这里而不是 P5
    case 10: BuildMsString((char*)&p1 + 0x18, text); break;
    case 11: BuildMsString((char*)&p1 + 0x18, text);
             BuildMsString(p5.str, text); break;
    default: break;
    }

    int ret = CallCtorGuarded(fn, &p1, p2, p3, p4, &p5);

    if (diag) *diag = DiagJson(base, singleton, p2, stage, ret);
    return ret;
}

void Route_SendMoment(httplib::Server& svr)
{
    // POST /SendMoment { "text": "...", "stage": 1|2 }
    svr.Post("/SendMoment", [](const httplib::Request& req, httplib::Response& res)
        {
            json resp;
            json reqJson;
            try { reqJson = json::parse(req.body); }
            catch (...)
            {
                resp["ret"] = -1;
                resp["retmsg"] = "invalid json";
                res.set_content(resp.dump(), "application/json");
                return;
            }

            std::string text = reqJson.value("text", "");
            int stage = 1;
            if (reqJson.contains("stage") && reqJson["stage"].is_number())
                stage = reqJson["stage"].get<int>();

            if (stage >= 2 && text.empty())
            {
                resp["ret"] = -1;
                resp["retmsg"] = "stage2 requires non-empty text";
                res.set_content(resp.dump(), "application/json");
                return;
            }

            int variant = 0;
            if (reqJson.contains("variant") && reqJson["variant"].is_number())
                variant = reqJson["variant"].get<int>();

            std::string diag = "{}";
            std::string wxid = reqJson.value("wxid", "wxid_3odtthhn7u5t22");
            int ret = WeixinMoment::SendMoment(text, stage, &diag, variant, wxid);

            resp["ret"] = ret;
            resp["retmsg"] = (ret == 0) ? "ok" : "failed";
            try { resp["diag"] = json::parse(diag); }
            catch (...) { resp["diag"] = diag; }
            res.set_content(resp.dump(), "application/json");
        });

    // GET /SendMoment 看能力探测
    svr.Get("/SendMoment", [](const httplib::Request&, httplib::Response& res)
        {
            uintptr_t base = WxBase();
            json j;
            j["base"] = (unsigned long long)base;
            j["ctorRva"] = (unsigned long long)offset::mmsnspost_ctor;
            j["singletonRva"] = (unsigned long long)offset::sns_singleton_ptr;
            j["singleton"] = base ? (unsigned long long)(uintptr_t)(*(void**)(base + offset::sns_singleton_ptr)) : 0;
            j["note"] = "POST {text, stage:1} 只探测；stage:2 才真正调用 mmsnspost（有崩溃风险）";
            res.set_content(j.dump(), "application/json");
        });
}


// ═════════════════════════════════════════════════════════════════════════════
//  MOMENT-CAPTURE：勾住 0x04EB0B90，让用户手动发一条朋友圈，把真实参数与调用栈全录下来
//
//  为什么这么做：调试器会被微信反调试干掉，但本 DLL 已经在进程内，
//  MinHook 只是改函数入口跳转（和现有 send_message/xlog 的 hook 同一种技术），
//  不会被反调试判定为"被调试"。录到的是真实 UI 发表流程的参数与栈，
//  这样就不必再盲猜 P1..P5 的语义。
// ═════════════════════════════════════════════════════════════════════════════
typedef int (*MomentFn5T)(void*, void*, void*, void*, void*);

namespace
{
    MomentFn5T      g_momentOrig = nullptr;
    bool            g_momentHooked = false;
    volatile LONG   g_capHits = 0;
    volatile DWORD  g_capTid = 0;
    volatile ULONGLONG g_capP[5] = {0,0,0,0,0};
    volatile ULONG  g_capType = 0, g_capFlag = 0;
    volatile ULONGLONG g_capTextSize = 0, g_capTextCap = 0;
    char            g_capText[260] = {0};
    volatile ULONGLONG g_capP1Size = 0, g_capP1Cap = 0;
    char            g_capP1[260] = {0};
    volatile int    g_capFrames = 0;
    volatile int    g_p1Len = 0, g_p3Len = 0, g_p4Len = 0, g_p5Len = 0;
    unsigned char   g_p1Raw[0x100] = {0};   // P1 原始字节
    unsigned char   g_p3Raw[0x1C0] = {0};   // P3 原始字节（0x1A0 + 余量）
    unsigned char   g_p4Raw[0x40]  = {0};   // P4 原始字节
    unsigned char   g_p5Raw[0x60]  = {0};   // P5 原始字节（type/flag/string）
    volatile int    g_p3aLen = 0, g_p3bLen = 0;
    unsigned char   g_p3aRaw[0x200] = {0};  // P3+0x10 指向对象
    unsigned char   g_p3bRaw[0x200] = {0};  // P3+0x38 指向对象
    volatile int    g_p1PostLen = 0;        // ★ 调用返回后的 P1（已构建的请求）
    unsigned char   g_p1PostRaw[0x400] = {0};
    volatile int    g_q28Len = 0, g_q30Len = 0, g_q40Len = 0;
    volatile int    g_p2Len = 0, g_p2aLen = 0, g_p2bLen = 0, g_p2cLen = 0;
    unsigned char   g_p2Raw[0x300] = {0};   // P2 本身
    unsigned char   g_p2aRaw[0x300] = {0};  // *(P2+0x00)
    unsigned char   g_p2bRaw[0x300] = {0};  // *(P2+0x08)
    unsigned char   g_p2cRaw[0x300] = {0};  // *(P2+0x10)
    unsigned char   g_q28Raw[0x400] = {0};  // *(P1+0x28)
    unsigned char   g_q30Raw[0x400] = {0};  // *(P1+0x30)
    unsigned char   g_q40Raw[0x400] = {0};  // *(P1+0x40)
    volatile ULONGLONG g_capStack[20] = {0};

    void SafeCopy(void* src, void* dst, int n, volatile int* pLen)
    {
        __try { for (int i = 0; i < n; ++i) ((unsigned char*)dst)[i] = ((const unsigned char*)src)[i]; *pLen = n; }
        __except (EXCEPTION_EXECUTE_HANDLER) { *pLen = 0; }
    }

    void TakeString(const void* base, size_t off, volatile ULONGLONG* pSize,
                    volatile ULONGLONG* pCap, char* dst, size_t dstLen)
    {
        const char* p = (const char*)base + off;
        size_t sz  = *(const size_t*)(p + 0x10);
        size_t cap = *(const size_t*)(p + 0x18);
        *pSize = sz;
        *pCap  = cap;
        if (sz > dstLen - 1) sz = dstLen - 1;
        const char* src = (cap >= 0x10) ? *(const char**)p : p;
        if (!src) return;
        for (size_t i = 0; i < sz; ++i) dst[i] = src[i];
        dst[sz] = 0;
    }

    int MomentDetourImpl(void* p1, void* p2, void* p3, void* p4, void* p5)
    {
        __try
        {
            g_capTid = GetCurrentThreadId();
            g_capP[0] = (ULONGLONG)(uintptr_t)p1;
            g_capP[1] = (ULONGLONG)(uintptr_t)p2;
            g_capP[2] = (ULONGLONG)(uintptr_t)p3;
            g_capP[3] = (ULONGLONG)(uintptr_t)p4;
            g_capP[4] = (ULONGLONG)(uintptr_t)p5;

            // 先做原始内存 dump（放在读字符串之前，避免后者异常把它们跳过）
            // P2 及其头三个指针（正文可能挂在 P2 上）
            if (p2)
            {
                SafeCopy(p2, (void*)g_p2Raw, 0x100, &g_p2Len);
                void* a = *(void**)((char*)p2 + 0x00);
                void* b = *(void**)((char*)p2 + 0x08);
                void* c = *(void**)((char*)p2 + 0x10);
                if (a) SafeCopy(a, (void*)g_p2aRaw, 0x100, &g_p2aLen);
                if (b) SafeCopy(b, (void*)g_p2bRaw, 0x100, &g_p2bLen);
                if (c) SafeCopy(c, (void*)g_p2cRaw, 0x100, &g_p2cLen);
            }

            if (p1) SafeCopy(p1, (void*)g_p1Raw, 0x100, &g_p1Len);
            if (p3) SafeCopy(p3, (void*)g_p3Raw, 0x1C0, &g_p3Len);
            if (p4) SafeCopy(p4, (void*)g_p4Raw, 0x40,  &g_p4Len);
            if (p5) SafeCopy(p5, (void*)g_p5Raw, 0x60,  &g_p5Len);
            if (p3)
            {
                void* q1 = *(void**)((char*)p3 + 0x10);
                void* q2 = *(void**)((char*)p3 + 0x38);
                if (q1) SafeCopy(q1, (void*)g_p3aRaw, 0x200, &g_p3aLen);
                if (q2) SafeCopy(q2, (void*)g_p3bRaw, 0x200, &g_p3bLen);
            }

            // P5 = { DWORD type; DWORD flag; std::string text@+08; void* extra@+28 }
            if (p5)
            {
                g_capType = *(ULONG*)p5;
                g_capFlag = *((ULONG*)p5 + 1);
                TakeString(p5, 0x08, &g_capTextSize, &g_capTextCap, g_capText, sizeof(g_capText));
            }
            // P1 +0x18 处也有一个 string（小函数会把它拷进 P3+0x18）
            if (p1)
            {
                TakeString(p1, 0x18, &g_capP1Size, &g_capP1Cap, g_capP1, sizeof(g_capP1));
            }

            // 原始内存 dump：P1 / P3 / P4（含正文可能在 P3 内部）

            // 真实调用栈（转成相对 Weixin.dll 的 RVA，只留模块内的帧）
            void* frames[20] = {0};
            USHORT n = RtlCaptureStackBackTrace(1, 20, frames, nullptr);
            uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
            int k = 0;
            for (USHORT i = 0; i < n && k < 20; ++i)
            {
                uintptr_t a = (uintptr_t)frames[i];
                if (base && a >= base && a < base + 0x0AF0E000)
                    g_capStack[k++] = a - base;
            }
            g_capFrames = k;
        }
        __except (EXCEPTION_EXECUTE_HANDLER) { }
        InterlockedIncrement(&g_capHits);

        int r = g_momentOrig(p1, p2, p3, p4, p5);
        // ★ 调用返回后再 dump P1：此时 mmsnspost 请求已构建，序列化正文应在其中
        if (p1)
        {
            SafeCopy(p1, (void*)g_p1PostRaw, 0x400, &g_p1PostLen);
            void* q28 = *(void**)((char*)p1 + 0x28);
            void* q30 = *(void**)((char*)p1 + 0x30);
            void* q40 = *(void**)((char*)p1 + 0x40);
            if (q28) SafeCopy(q28, (void*)g_q28Raw, 0x400, &g_q28Len);
            if (q30) SafeCopy(q30, (void*)g_q30Raw, 0x400, &g_q30Len);
            if (q40) SafeCopy(q40, (void*)g_q40Raw, 0x400, &g_q40Len);
        }
        return r;
    }

    // 无 SEH 的包一层，保证对象展开不冲突
    int MomentDetour(void* p1, void* p2, void* p3, void* p4, void* p5)
    {
        return MomentDetourImpl(p1, p2, p3, p4, p5);
    }

    bool InstallMomentHook()
    {
        if (g_momentHooked) return true;
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (!base) return false;
        MH_STATUS st = MH_Initialize();
        if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) return false;
        LPVOID target = (LPVOID)(base + offset::mmsnspost_ctor);
        if (MH_CreateHook(target, (LPVOID)&MomentDetour, (LPVOID*)&g_momentOrig) != MH_OK)
            return false;
        if (MH_EnableHook(target) != MH_OK)
        {
            MH_RemoveHook(target);
            return false;
        }
        g_momentHooked = true;
        return true;
    }

    bool RemoveMomentHook()
    {
        if (!g_momentHooked) return true;
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (base)
        {
            LPVOID target = (LPVOID)(base + offset::mmsnspost_ctor);
            MH_DisableHook(target);
            MH_RemoveHook(target);
        }
        g_momentHooked = false;
        g_momentOrig = nullptr;
        return true;
    }

    std::string CaptureJson()
    {
        std::string j = "{\"hooked\":";
        j += g_momentHooked ? "true" : "false";
        char buf[512];
        std::snprintf(buf, sizeof(buf),
            ",\"hits\":%ld,\"tid\":%lu,\"type\":%lu,\"flag\":%lu,"
            "\"p1\":\"0x%llX\",\"p2\":\"0x%llX\",\"p3\":\"0x%llX\",\"p4\":\"0x%llX\",\"p5\":\"0x%llX\"",
            (long)g_capHits, (unsigned long)g_capTid,
            (unsigned long)g_capType, (unsigned long)g_capFlag,
            g_capP[0], g_capP[1], g_capP[2], g_capP[3], g_capP[4]);
        j += buf;

        j += ",\"textSize\":";
        j += std::to_string((unsigned long long)g_capTextSize);
        j += ",\"textCap\":";
        j += std::to_string((unsigned long long)g_capTextCap);
        j += ",\"text\":\"";
        for (const char* p = g_capText; *p; ++p)
        {
            unsigned char c = (unsigned char)*p;
            if (c == 0x22 || c == 0x5C) { j += (char)0x5C; j += (char)c; }
            else if (c < 0x20) { char t[8]; std::snprintf(t, sizeof(t), "%04X", c); j += (char)0x5C; j += 'u'; j += t; }
            else j += (char)c;
        }
        j += "\",\"p1Text\":\"";
        for (const char* p = g_capP1; *p; ++p)
        {
            unsigned char c = (unsigned char)*p;
            if (c == 0x22 || c == 0x5C) { j += (char)0x5C; j += (char)c; }
            else if (c < 0x20) { char t[8]; std::snprintf(t, sizeof(t), "%04X", c); j += (char)0x5C; j += 'u'; j += t; }
            else j += (char)c;
        }
        auto hexOf = [](const unsigned char* b, int n)
        {
            std::string h;
            static const char* D = "0123456789abcdef";
            for (int i = 0; i < n; ++i) { h += D[b[i] >> 4]; h += D[b[i] & 0xF]; }
            return h;
        };
        j += "\",\"p1Raw\":\"";
        j += hexOf(g_p1Raw, (int)g_p1Len);
        j += "\",\"p3Raw\":\"";
        j += hexOf(g_p3Raw, (int)g_p3Len);
        j += "\",\"p4Raw\":\"";
        j += hexOf(g_p4Raw, (int)g_p4Len);
        j += "\",\"p5Raw\":\"";
        j += hexOf(g_p5Raw, (int)g_p5Len);
        j += "\",\"p3aRaw\":\"";
        j += hexOf(g_p3aRaw, (int)g_p3aLen);
        j += "\",\"p3bRaw\":\"";
        j += hexOf(g_p3bRaw, (int)g_p3bLen);
        j += "\",\"p1PostRaw\":\"";
        j += hexOf(g_p1PostRaw, (int)g_p1PostLen);
        j += "\",\"q28Raw\":\"";
        j += hexOf(g_q28Raw, (int)g_q28Len);
        j += "\",\"q30Raw\":\"";
        j += hexOf(g_q30Raw, (int)g_q30Len);
        j += "\",\"q40Raw\":\"";
        j += hexOf(g_q40Raw, (int)g_q40Len);
        j += "\",\"p2Raw\":\"";
        j += hexOf(g_p2Raw, (int)g_p2Len);
        j += "\",\"p2aRaw\":\"";
        j += hexOf(g_p2aRaw, (int)g_p2aLen);
        j += "\",\"p2bRaw\":\"";
        j += hexOf(g_p2bRaw, (int)g_p2bLen);
        j += "\",\"p2cRaw\":\"";
        j += hexOf(g_p2cRaw, (int)g_p2cLen);
        j += "\",\"stack\":[";
        for (int i = 0; i < g_capFrames; ++i)
        {
            char t[28];
            std::snprintf(t, sizeof(t), "%s\"0x%llX\"", i ? "," : "", g_capStack[i]);
            j += t;
        }
        j += "]}";
        return j;
    }
}

void Route_SendMomentCapture(httplib::Server& svr)
{
    // POST /SendMoment/Hook { "on": true|false }  —— 装上/卸下 mmsnspost 捕获钩子
    svr.Post("/SendMoment/Hook", [](const httplib::Request& req, httplib::Response& res)
        {
            json resp;
            json body;
            try { body = json::parse(req.body); } catch (...) { body = json::object(); }
            bool on = body.value("on", true);
            bool ok = on ? InstallMomentHook() : RemoveMomentHook();
            resp["ok"] = ok;
            resp["hooked"] = g_momentHooked;
            resp["hits"] = (long)g_capHits;
            res.set_content(resp.dump(), "application/json");
        });

    // GET /SendMoment/Capture —— 读录制结果
    svr.Get("/SendMoment/Capture", [](const httplib::Request&, httplib::Response& res)
        {
            res.set_content(CaptureJson(), "application/json");
        });

    // POST /SendMoment/Capture  {"reset":true} —— 清空计数，重新录
    svr.Post("/SendMoment/Capture", [](const httplib::Request&, httplib::Response& res)
        {
            InterlockedExchange(&g_capHits, 0);
            g_capFrames = 0;
            g_capText[0] = 0;
            g_capP1[0] = 0;
            g_capType = g_capFlag = 0;
            g_capTextSize = g_capTextCap = g_capP1Size = g_capP1Cap = 0;
            for (int i = 0; i < 5; ++i) g_capP[i] = 0;
            json resp; resp["ok"] = true; resp["hits"] = 0;
            res.set_content(resp.dump(), "application/json");
        });
}


// ── BIZ-CAPTURE：勾住业务层 0x04EAE7F0(rcx=对象, rdx=&结构)，看"内容"从哪来 ──
namespace
{
    extern volatile unsigned long long g_svcObj;
    typedef int (*BizFn)(void*, void*);
    BizFn           g_bizOrig = nullptr;
    bool            g_bizHooked = false;
    volatile LONG   g_bizHits = 0;
    volatile ULONGLONG g_bizRcx = 0, g_bizRdx = 0;
    volatile int    g_bizRcxLen = 0, g_bizRdxLen = 0;
    unsigned char   g_bizRcxRaw[0x200] = {0};
    unsigned char   g_bizRdxRaw[0x300] = {0};
    volatile int    g_bizP1Len = 0, g_bizP2Len = 0;
    unsigned char   g_bizP1Raw[0x300] = {0};   // *(rdx+0x00) 之类的首指针
    unsigned char   g_bizP2Raw[0x300] = {0};
    volatile ULONGLONG g_bizA = 0, g_bizB = 0, g_bizC = 0, g_bizD = 0;

    int BizDetour(void* rcx, void* rdx)
    {
        __try
        {
            g_bizRcx = (ULONGLONG)(uintptr_t)rcx;
            if (rcx) g_svcObj = (unsigned long long)(uintptr_t)rcx;   // 供 /Moment/Internal 使用
            g_bizRdx = (ULONGLONG)(uintptr_t)rdx;
            if (rcx) SafeCopy(rcx, (void*)g_bizRcxRaw, 0x200, &g_bizRcxLen);
            if (rdx)
            {
                SafeCopy(rdx, (void*)g_bizRdxRaw, 0x300, &g_bizRdxLen);
                void* a = *(void**)((char*)rdx + 0x00);
                void* b = *(void**)((char*)rdx + 0x08);
                void* c = *(void**)((char*)rdx + 0x10);
                void* d = *(void**)((char*)rdx + 0x18);
                g_bizA = (ULONGLONG)(uintptr_t)a; g_bizB = (ULONGLONG)(uintptr_t)b;
                g_bizC = (ULONGLONG)(uintptr_t)c; g_bizD = (ULONGLONG)(uintptr_t)d;
                if (a) SafeCopy(a, (void*)g_bizP1Raw, 0x300, &g_bizP1Len);
                if (b) SafeCopy(b, (void*)g_bizP2Raw, 0x300, &g_bizP2Len);
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER) { }
        InterlockedIncrement((volatile LONG*)&g_bizHits);
        return g_bizOrig(rcx, rdx);
    }

    bool InstallBizHook()
    {
        if (g_bizHooked) return true;
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (!base) return false;
        MH_STATUS st = MH_Initialize();
        if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) return false;
        LPVOID t = (LPVOID)(base + 0x04EAE7F0);
        if (MH_CreateHook(t, (LPVOID)&BizDetour, (LPVOID*)&g_bizOrig) != MH_OK) return false;
        if (MH_EnableHook(t) != MH_OK) { MH_RemoveHook(t); return false; }
        g_bizHooked = true;
        return true;
    }

    bool RemoveBizHook()
    {
        if (!g_bizHooked) return true;
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (base)
        {
            LPVOID t = (LPVOID)(base + 0x04EAE7F0);
            MH_DisableHook(t); MH_RemoveHook(t);
        }
        g_bizHooked = false; g_bizOrig = nullptr;
        return true;
    }

    std::string BizJson()
    {
        auto hexOf = [](const unsigned char* b, int n) {
            std::string h; static const char* D = "0123456789abcdef";
            for (int i = 0; i < n; ++i) { h += D[b[i] >> 4]; h += D[b[i] & 0xF]; }
            return h;
        };
        std::string j = "{\"hooked\":";
        j += g_bizHooked ? "true" : "false";
        char buf[256];
        std::snprintf(buf, sizeof(buf), ",\"hits\":%d,\"rcx\":\"0x%llX\",\"rdx\":\"0x%llX\","
            "\"a\":\"0x%llX\",\"b\":\"0x%llX\",\"c\":\"0x%llX\",\"d\":\"0x%llX\"",
            (int)g_bizHits, g_bizRcx, g_bizRdx, g_bizA, g_bizB, g_bizC, g_bizD);
        j += buf;
        j += ",\"rcxRaw\":\"" + hexOf(g_bizRcxRaw, (int)g_bizRcxLen) + "\"";
        j += ",\"rdxRaw\":\"" + hexOf(g_bizRdxRaw, (int)g_bizRdxLen) + "\"";
        j += ",\"p1Raw\":\"" + hexOf(g_bizP1Raw, (int)g_bizP1Len) + "\"";
        j += ",\"p2Raw\":\"" + hexOf(g_bizP2Raw, (int)g_bizP2Len) + "\"";
        j += "}";
        return j;
    }
}

void Route_SendMomentBiz(httplib::Server& svr)
{
    svr.Post("/SendMoment/BizHook", [](const httplib::Request& req, httplib::Response& res)
        {
            json body; try { body = json::parse(req.body); } catch (...) { body = json::object(); }
            bool on = body.value("on", true);
            bool ok = on ? InstallBizHook() : RemoveBizHook();
            json r; r["ok"] = ok; r["hooked"] = g_bizHooked; r["hits"] = (int)g_bizHits;
            res.set_content(r.dump(), "application/json");
        });
    svr.Get("/SendMoment/BizCapture", [](const httplib::Request&, httplib::Response& res)
        {
            res.set_content(BizJson(), "application/json");
        });
}

// 生成朋友圈请求体 XML（结构照实测抓包）
std::string BuildMomentXml(const std::string& text, const std::string& wxid, bool priv)
{
    auto esc = [](const std::string& s) {
        std::string o;
        for (char c : s) {
            switch (c) {
            case '&': o += "&amp;"; break;
            case '<': o += "&lt;"; break;
            case '>': o += "&gt;"; break;
            case '"': o += "&quot;"; break;
            case 0x27: o += "&apos;"; break;
            default: o += c;
            }
        }
        return o;
    };
    long long ts = (long long)time(nullptr);
    std::string x;
    x.reserve(700);
    x += "<TimelineObject><id>0</id><username>";
    x += esc(wxid);
    x += "</username><createTime>";
    x += std::to_string(ts);
    x += "</createTime><contentDesc>";
    x += esc(text);
    x += "</contentDesc><contentDescShowType>0</contentDescShowType><contentDescScene>0</contentDescScene><private>";
    x += priv ? "1" : "0";
    x += "</private><sourceUserName></sourceUserName><sourceNickName></sourceNickName>"
         "<publicPhotoAccountUserName></publicPhotoAccountUserName><publicPhotoAccountNickName></publicPhotoAccountNickName>"
         "<sightFolded>0</sightFolded><showFlag>0</showFlag>"
         "<ContentObject><contentStyle>2</contentStyle><title></title><description></description><mediaList/></ContentObject>"
         "</TimelineObject>";
    return x;
}


// ── DISPATCH-CAPTURE：勾住 0x3C9080（任务投递/调用器），记录 5 个参数 ──────────
namespace
{
    typedef int (*DispFn)(void*, void*, void*, void*, void*);
    DispFn          g_dispOrig = nullptr;
    bool            g_dispHooked = false;
    volatile LONG   g_dispHits = 0;
    volatile ULONGLONG g_dA[5] = {0,0,0,0,0};      // 原始参数
    volatile ULONGLONG g_dV[5] = {0,0,0,0,0};      // 解引用后的值（参数多为 &slot）
    volatile ULONGLONG g_dW[5] = {0,0,0,0,0};      // 再解一层（若是对象再取 +0）
    volatile ULONGLONG g_dDispRcx = 0;             // rcx 指向结构的首 8 字节
    volatile ULONGLONG g_f2 = 0, g_f4 = 0;
    volatile ULONGLONG g_f2_368 = 0, g_f4_368 = 0;
    volatile ULONGLONG g_f2_350 = 0, g_f4_350 = 0;
    volatile LONG      g_fHits = 0;
    volatile ULONGLONG g_retRva = 0;

    int DispDetour(void* a, void* b, void* c, void* d, void* e)
    {
        __try
        {
            void* p[5] = { a, b, c, d, e };
            for (int i = 0; i < 5; ++i)
            {
                g_dA[i] = (ULONGLONG)(uintptr_t)p[i];
                g_dV[i] = 0;
                g_dW[i] = 0;
                if (!p[i]) continue;
                __try { g_dV[i] = *(volatile ULONGLONG*)p[i]; } __except (1) {}
                ULONGLONG v = g_dV[i];
                if (v >= 0x10000) { __try { g_dW[i] = *(volatile ULONGLONG*)(uintptr_t)v; } __except (1) {} }
            }
            g_dDispRcx = 0;

            // 只关心「调用者位于朋友圈代码区 0x4E0000~0x4F0000」的那一次投递
            uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
            ULONGLONG retRva = 0;
            if (base)
            {
                void* fr[24] = {0};
                USHORT nf = RtlCaptureStackBackTrace(1, 24, fr, nullptr);
                for (USHORT i = 0; i < nf; ++i)
                {
                    uintptr_t a = (uintptr_t)fr[i];
                    if (a <= base) continue;
                    ULONGLONG r = (ULONGLONG)(a - base);
                    if (r >= 0x4E0000 && r < 0x4F0000) { retRva = r; break; }
                }
            }
            if (retRva)
            {
                g_f2 = g_dV[2];
                g_f4 = g_dV[4];
                g_f2_368 = g_f4_368 = 0;
                g_f2_350 = g_f4_350 = 0;
                if (g_f2) {
                    __try { g_f2_368 = *(volatile ULONGLONG*)((uintptr_t)g_f2 + 0x368); } __except (1) {}
                    __try { g_f2_350 = *(volatile ULONGLONG*)((uintptr_t)g_f2 + 0x350); } __except (1) {}
                }
                if (g_f4) {
                    __try { g_f4_368 = *(volatile ULONGLONG*)((uintptr_t)g_f4 + 0x368); } __except (1) {}
                    __try { g_f4_350 = *(volatile ULONGLONG*)((uintptr_t)g_f4 + 0x350); } __except (1) {}
                }
                g_retRva = retRva;
                InterlockedIncrement(&g_fHits);
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER) { }
        InterlockedIncrement(&g_dispHits);
        return g_dispOrig(a, b, c, d, e);
    }

    bool InstallDispHook()
    {
        if (g_dispHooked) return true;
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (!base) return false;
        MH_STATUS st = MH_Initialize();
        if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) return false;
        LPVOID t = (LPVOID)(base + 0x3C9080);
        if (MH_CreateHook(t, (LPVOID)&DispDetour, (LPVOID*)&g_dispOrig) != MH_OK) return false;
        if (MH_EnableHook(t) != MH_OK) { MH_RemoveHook(t); return false; }
        g_dispHooked = true;
        return true;
    }

    bool RemoveDispHook()
    {
        if (!g_dispHooked) return true;
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (base) { LPVOID t = (LPVOID)(base + 0x3C9080); MH_DisableHook(t); MH_RemoveHook(t); }
        g_dispHooked = false; g_dispOrig = nullptr;
        return true;
    }

    std::string DispJson()
    {
        char buf[900];
        std::snprintf(buf, sizeof(buf),
            "{\"hooked\":%s,\"hits\":%ld,"
            "\"a\":[\"0x%llX\",\"0x%llX\",\"0x%llX\",\"0x%llX\",\"0x%llX\"],"
            "\"v\":[\"0x%llX\",\"0x%llX\",\"0x%llX\",\"0x%llX\",\"0x%llX\"],"
            "\"w\":[\"0x%llX\",\"0x%llX\",\"0x%llX\",\"0x%llX\",\"0x%llX\"],"
            "\"fHits\":%ld,\"retRva\":\"0x%llX\",\"f2\":\"0x%llX\",\"f2_368\":\"0x%llX\",\"f2_350\":\"0x%llX\","
            "\"f4\":\"0x%llX\",\"f4_368\":\"0x%llX\",\"f4_350\":\"0x%llX\"}",
            g_dispHooked ? "true" : "false", (long)g_dispHits,
            g_dA[0], g_dA[1], g_dA[2], g_dA[3], g_dA[4],
            g_dV[0], g_dV[1], g_dV[2], g_dV[3], g_dV[4],
            g_dW[0], g_dW[1], g_dW[2], g_dW[3], g_dW[4],
            (long)g_fHits, g_retRva, g_f2, g_f2_368, g_f2_350, g_f4, g_f4_368, g_f4_350);
        return std::string(buf);
    }
}

void Route_SendMomentDispatch(httplib::Server& svr)
{
    svr.Post("/SendMoment/DispHook", [](const httplib::Request& req, httplib::Response& res)
        {
            json body; try { body = json::parse(req.body); } catch (...) { body = json::object(); }
            bool on = body.value("on", true);
            bool ok = on ? InstallDispHook() : RemoveDispHook();
            json r; r["ok"] = ok; r["hooked"] = g_dispHooked; r["hits"] = (long)g_dispHits;
            res.set_content(r.dump(), "application/json");
        });
    svr.Get("/SendMoment/DispCapture", [](const httplib::Request&, httplib::Response& res)
        {
            res.set_content(DispJson(), "application/json");
        });
    svr.Post("/SendMoment/DispCapture", [](const httplib::Request&, httplib::Response& res)
        {
            InterlockedExchange(&g_dispHits, 0);
            InterlockedExchange(&g_fHits, 0);
            g_f2 = g_f4 = 0; g_f2_368 = g_f4_368 = 0; g_f2_350 = g_f4_350 = 0;
            for (int i = 0; i < 5; ++i) { g_dA[i] = g_dV[i] = g_dW[i] = 0; }
            json r; r["ok"] = true; res.set_content(r.dump(), "application/json");
        });
}


// ═════════════════════════════════════════════════════════════════════════════
//  UI-THREAD-EXEC：把 mmsnspost 调用搬到微信 UI 线程上执行
//
//  假设：真实发表运行在 UI 线程（Qt 事件循环），任务调度器上下文在那里已就绪；
//        我们之前在工作线程直接调用，上下文为空 → 空指针。
//  做法：SetWindowsHookEx(WH_CALLWNDPROC) 挂到 UI 线程 → SendMessage(WM_NULL)
//        → 钩子过程在 UI 线程被调用 → 在钩子里执行真正的调用。
// ═════════════════════════════════════════════════════════════════════════════
namespace
{
    volatile LONG   g_uiPending = 0;
    volatile unsigned long long g_p2VtRva = 0;
    volatile int    g_vtIdxUsed = -1;
    volatile LONG   g_uiDone = 0;
    int             g_uiRet = 0x7FFFFFFF;
    char            g_uiXml[2048] = {0};
    HHOOK           g_uiHook = nullptr;
    DWORD           g_uiTid = 0;

    // 在调用线程执行：构造 P1(含 XML)/P3/P5 并调用 mmsnspost
    int DoMomentOnThisThread()
    {
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (!base) return -2;

        struct Q5 { unsigned int type; unsigned int flag; char str[32]; void* extra; };
        typedef void (*P3CtorT)(void*);
        typedef int (*Fn5)(void*, void*, void*, void*, void*);

        void* singleton = *(void**)(base + offset::sns_singleton_ptr);
        if (!singleton) return -3;

        // P2 = [[singleton]+0x10]()
        void* p2 = nullptr;
        g_p2VtRva = 0;
        g_vtIdxUsed = -1;
        __try {
            using Vfn = void* (*)(void*);
            void** vt = *(void***)singleton;
            if (vt && vt[2]) p2 = ((Vfn)vt[2])(singleton);
            if (p2) {
                uintptr_t v = *(uintptr_t*)p2;
                if (v > base) g_p2VtRva = (unsigned long long)(v - base);
                g_vtIdxUsed = 2;
            }
        } __except (EXCEPTION_EXECUTE_HANDLER) { return -4; }

        static char p1[0x200];
        static char p3[0x200];
        static char p4[0x100];
        ::memset(p1, 0, sizeof(p1));
        ::memset(p3, 0, sizeof(p3));
        ::memset(p4, 0, sizeof(p4));
        *(void**)(p1 + 0x38) = (void*)(base + 0x2BD9B9);
        BuildMsStringC(p1 + 0x40, g_uiXml);

        P3CtorT p3c = (P3CtorT)(base + offset::moment_p3_ctor);
        __try { p3c(p3); } __except (EXCEPTION_EXECUTE_HANDLER) { return -5; }

        Q5 q5;
        ::memset(&q5, 0, sizeof(q5));
        q5.type = 0;
        q5.flag = 0x1D4C0;
        BuildMsStringC(q5.str, "");

        Fn5 fn = (Fn5)(base + offset::mmsnspost_ctor);
        __try { return fn(p1, p2, p3, p4, &q5); }
        __except (EXCEPTION_EXECUTE_HANDLER) { return -99; }
    }

    LRESULT CALLBACK UiCallWndProc(int nCode, WPARAM wParam, LPARAM lParam)
    {
        if (nCode >= 0 && InterlockedCompareExchange(&g_uiPending, 0, 1) == 1)
        {
            g_uiRet = DoMomentOnThisThread();
            InterlockedExchange(&g_uiDone, 1);
        }
        return CallNextHookEx(g_uiHook, nCode, wParam, lParam);
    }

    DWORD FindUiThread()
    {
        struct Ctx { DWORD pid; DWORD tid; };
        static Ctx c;
        c.pid = GetCurrentProcessId();
        c.tid = 0;
        EnumWindows([](HWND h, LPARAM lp) -> BOOL {
            DWORD pid = 0;
            GetWindowThreadProcessId(h, &pid);
            if (pid != ((Ctx*)lp)->pid) return TRUE;
            if (!IsWindowVisible(h)) return TRUE;
            wchar_t cls[128] = {0};
            GetClassNameW(h, cls, 128);
            if (wcsstr(cls, L"QWindowIcon") || wcsstr(cls, L"Qt5"))
            {
                ((Ctx*)lp)->tid = GetWindowThreadProcessId(h, nullptr);
                return FALSE;
            }
            return TRUE;
        }, (LPARAM)&c);
        return c.tid;
    }

    int RunOnUiThread(const std::string& xml, std::string* diag)
    {
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (!base) { if (diag) *diag = "{\"why\":\"no weixin\"}"; return -2; }
        if (xml.size() >= sizeof(g_uiXml)) { if (diag) *diag = "{\"why\":\"xml too long\"}"; return -1; }
        ::memcpy(g_uiXml, xml.c_str(), xml.size() + 1);

        DWORD tid = FindUiThread();
        if (!tid) { if (diag) *diag = "{\"why\":\"ui thread not found\"}"; return -6; }
        g_uiTid = tid;

        HWND hwnd = nullptr;
        {
            struct C2 { DWORD pid; HWND h; };
            static C2 c2;
            c2.pid = GetCurrentProcessId(); c2.h = nullptr;
            EnumWindows([](HWND h, LPARAM lp) -> BOOL {
                DWORD pid = 0;
                GetWindowThreadProcessId(h, &pid);
                if (pid != ((C2*)lp)->pid) return TRUE;
                if (!IsWindowVisible(h)) return TRUE;
                ((C2*)lp)->h = h;
                return FALSE;
            }, (LPARAM)&c2);
            hwnd = c2.h;
        }
        if (!hwnd) { if (diag) *diag = "{\"why\":\"no window\"}"; return -7; }

        InterlockedExchange(&g_uiDone, 0);
        InterlockedExchange(&g_uiPending, 1);
        g_uiHook = SetWindowsHookExW(WH_CALLWNDPROC, UiCallWndProc,
                                     (HINSTANCE)GetModuleHandleW(nullptr), tid);
        if (!g_uiHook)
        {
            InterlockedExchange(&g_uiPending, 0);
            if (diag) { char b[96]; std::snprintf(b, sizeof(b), "{\"why\":\"SetWindowsHookEx failed %lu\"}", GetLastError()); *diag = b; }
            return -8;
        }

        // 投递一个无害消息，迫使 UI 线程进入我们的钩子
        for (int i = 0; i < 20 && !g_uiDone; ++i)
        {
            SendMessageTimeoutW(hwnd, WM_NULL, 0, 0, SMTO_ABORTIFHUNG, 2000, nullptr);
            if (g_uiDone) break;
            ::Sleep(30);
        }

        if (g_uiHook) { UnhookWindowsHookEx(g_uiHook); g_uiHook = nullptr; }
        InterlockedExchange(&g_uiPending, 0);

        if (diag)
        {
            char b[256];
            std::snprintf(b, sizeof(b),
                "{\"uiTid\":%lu,\"done\":%ld,\"ret\":%d,\"xmlLen\":%d,\"p2VtRva\":\"0x%llX\",\"vtIdx\":%d}",
                (unsigned long)tid, (long)g_uiDone, g_uiRet, (int)xml.size(), g_p2VtRva, g_vtIdxUsed);
            *diag = b;
        }
        return g_uiRet;
    }
}

void Route_SendMomentUi(httplib::Server& svr)
{
    // POST /SendMoment/Ui { "text": "...", "wxid": "..." } —— 在 UI 线程上直接调用
    svr.Post("/SendMoment/Ui", [](const httplib::Request& req, httplib::Response& res)
        {
            json resp;
            json body;
            try { body = json::parse(req.body); } catch (...) { body = json::object(); }
            std::string text = body.value("text", "");
            std::string wxid = body.value("wxid", "wxid_3odtthhn7u5t22");

            std::string xml = BuildMomentXml(text, wxid, false);
            std::string diag = "{}";
            int ret = RunOnUiThread(xml, &diag);

            resp["ret"] = ret;
            resp["retmsg"] = (ret == 0) ? "ok" : "failed";
            try { resp["diag"] = json::parse(diag); } catch (...) { resp["diag"] = diag; }
            res.set_content(resp.dump(), "application/json");
        });

    // GET /SendMoment/Ui —— 探测 UI 线程
    svr.Get("/SendMoment/Ui", [](const httplib::Request&, httplib::Response& res)
        {
            json j;
            j["uiTid"] = (unsigned long)FindUiThread();
            j["note"] = "POST {text,wxid} 在 UI 线程执行 mmsnspost";
            res.set_content(j.dump(), "application/json");
        });
}


// ── BIZ-CALL：在 UI 线程上调用业务层 0x04EAE7F0(rcx=对象, rdx=&结构) ─────────
namespace
{
    volatile unsigned long long g_bizRcxTried = 0;
    volatile int g_bizCallRet = 0x7FFFFFFF;

    int DoBizOnThisThread()
    {
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (!base) return -2;
        typedef int (*BizFn2)(void*, void*);
        BizFn2 fn = (BizFn2)(base + 0x04EAE7F0);

        void* singleton = *(void**)(base + offset::sns_singleton_ptr);
        if (!singleton) return -3;

        void* p2 = nullptr;
        __try {
            using Vfn = void* (*)(void*);
            void** vt = *(void***)singleton;
            if (vt && vt[2]) p2 = ((Vfn)vt[2])(singleton);
        } __except (EXCEPTION_EXECUTE_HANDLER) { return -4; }

        static char rdxbuf[0x300];
        ::memset(rdxbuf, 0, sizeof(rdxbuf));

        g_bizRcxTried = (unsigned long long)(uintptr_t)p2;
        __try { return fn(p2, rdxbuf); }
        __except (EXCEPTION_EXECUTE_HANDLER) { return -99; }
    }

    LRESULT CALLBACK BizCallWndProc(int nCode, WPARAM wParam, LPARAM lParam)
    {
        if (nCode >= 0 && InterlockedCompareExchange(&g_uiPending, 0, 1) == 1)
        {
            g_bizCallRet = DoBizOnThisThread();
            InterlockedExchange(&g_uiDone, 1);
        }
        return CallNextHookEx(g_uiHook, nCode, wParam, lParam);
    }

    int RunBizOnUiThread(std::string* diag)
    {
        DWORD tid = FindUiThread();
        if (!tid) { if (diag) *diag = "{\"why\":\"no ui tid\"}"; return -6; }
        HWND hwnd = nullptr;
        {
            struct C3 { DWORD pid; HWND h; };
            static C3 c3;
            c3.pid = GetCurrentProcessId(); c3.h = nullptr;
            EnumWindows([](HWND h, LPARAM lp) -> BOOL {
                DWORD pid = 0; GetWindowThreadProcessId(h, &pid);
                if (pid != ((C3*)lp)->pid) return TRUE;
                if (!IsWindowVisible(h)) return TRUE;
                ((C3*)lp)->h = h; return FALSE;
            }, (LPARAM)&c3);
            hwnd = c3.h;
        }
        if (!hwnd) { if (diag) *diag = "{\"why\":\"no window\"}"; return -7; }

        InterlockedExchange(&g_uiDone, 0);
        InterlockedExchange(&g_uiPending, 1);
        g_uiHook = SetWindowsHookExW(WH_CALLWNDPROC, BizCallWndProc,
                                     (HINSTANCE)GetModuleHandleW(nullptr), tid);
        if (!g_uiHook) { InterlockedExchange(&g_uiPending, 0); return -8; }
        for (int i = 0; i < 20 && !g_uiDone; ++i)
        {
            SendMessageTimeoutW(hwnd, WM_NULL, 0, 0, SMTO_ABORTIFHUNG, 2000, nullptr);
            if (g_uiDone) break;
            ::Sleep(30);
        }
        if (g_uiHook) { UnhookWindowsHookEx(g_uiHook); g_uiHook = nullptr; }
        InterlockedExchange(&g_uiPending, 0);
        if (diag) {
            char b[256];
            std::snprintf(b, sizeof(b), "{\"done\":%ld,\"ret\":%d,\"rcxTried\":\"0x%llX\"}",
                          (long)g_uiDone, g_bizCallRet, g_bizRcxTried);
            *diag = b;
        }
        return g_bizCallRet;
    }
}

void Route_SendMomentBizCall(httplib::Server& svr)
{
    svr.Post("/SendMoment/BizCall", [](const httplib::Request&, httplib::Response& res)
        {
            std::string diag = "{}";
            int ret = RunBizOnUiThread(&diag);
            json r;
            r["ret"] = ret;
            r["retmsg"] = (ret == 0) ? "ok" : "failed";
            try { r["diag"] = json::parse(diag); } catch (...) { r["diag"] = diag; }
            res.set_content(r.dump(), "application/json");
        });
}


// ── MEM-SCAN：在进程内存里按 8 字节值搜索（找某类的实例/全局指针）──────────
namespace
{
    // 无对象的读取辅助（避免 C2712）
    bool SafeReadBlock(const unsigned char* p, size_t n, unsigned char* dst)
    {
        __try { ::memcpy(dst, p, n); return true; }
        __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
    }

    std::string ScanValue(unsigned long long target, int maxHits, int readOff)
    {
        std::string out = "[";
        int hits = 0;
        MEMORY_BASIC_INFORMATION mbi;
        unsigned char* addr = nullptr;
        while (VirtualQuery(addr, &mbi, sizeof(mbi)) && hits < maxHits)
        {
            unsigned char* rbase = (unsigned char*)mbi.BaseAddress;
            size_t size = mbi.RegionSize;
            bool readable = (mbi.State == MEM_COMMIT) &&
                            ((mbi.Protect & PAGE_READONLY) || (mbi.Protect & PAGE_READWRITE) ||
                             (mbi.Protect & PAGE_EXECUTE_READ) || (mbi.Protect & PAGE_EXECUTE_READWRITE) ||
                             (mbi.Protect & PAGE_WRITECOPY) || (mbi.Protect & PAGE_EXECUTE_WRITECOPY));
            if (readable && size >= 8)
            {
                size_t chunk = size > 0x10000 ? 0x10000 : size;
                for (size_t off0 = 0; off0 < size && hits < maxHits; off0 += chunk)
                {
                    size_t len = (size - off0 > chunk) ? chunk : (size - off0);
                    static unsigned char buf[0x10000];
                    if (!SafeReadBlock(rbase + off0, len, buf)) continue;
                    for (size_t i = 0; i + 8 <= len && hits < maxHits; i += 8)
                    {
                        unsigned long long v = *(unsigned long long*)(buf + i);
                        if (v != target) continue;
                        unsigned long long extra = 0;
                        if (readOff >= 0 && readOff >= 0)
                        {
                            unsigned char tmp[8];
                            if (SafeReadBlock(rbase + off0 + i + readOff, 8, tmp))
                                extra = *(unsigned long long*)tmp;
                            else
                                extra = 0xDEAD;
                        }
                        char b[128];
                        std::snprintf(b, sizeof(b), "%s\"0x%llX:0x%llX\"", hits ? "," : "",
                                      (unsigned long long)(uintptr_t)(rbase + off0 + i), extra);
                        out += b;
                        ++hits;
                    }
                }
            }
            unsigned char* next = rbase + size;
            if (next <= addr) break;
            addr = next;
        }
        out += "]";
        return out;
    }
}

void Route_MemScan(httplib::Server& svr)
{
    // GET /Debug/ScanVt?rva=0x8397020&off=0xf0&max=8
    svr.Get("/Debug/ScanVt", [](const httplib::Request& req, httplib::Response& res)
        {
            uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
            unsigned long long rva = 0;
            int off = 0xF0, maxHits = 8;
            try {
                if (req.has_param("rva")) rva = std::stoull(req.get_param_value("rva"), nullptr, 0);
                if (req.has_param("off")) off = (int)std::stoul(req.get_param_value("off"), nullptr, 0);
                if (req.has_param("max")) maxHits = (int)std::stoul(req.get_param_value("max"), nullptr, 0);
            } catch (...) { }
            json j;
            j["target"] = (unsigned long long)(base + rva);
            j["hits"] = ScanValue((unsigned long long)(base + rva), maxHits, off);
            res.set_content(j.dump(), "application/json");
        });
}


// ═════════════════════════════════════════════════════════════════════════════
//  /Moment/Post —— 内部调用入口（UI 自动化已按用户要求移除）
//
//  当前状态：mmsnspost 构造函数会把请求投递给微信的"任务调度器"，
//  任务对象的 +0x368 来自 dispatchObj->+0xf0->+0x20 —— 该 dispatchObj 是
//  真实发表流程里现造的一次性会话对象，外部调用时为空，因此会崩溃。
//  正在复刻这个调度器的数据结构（见 0xCC10A0 / 0x3CEED0 / 0x8397020 vtable）。
// ═════════════════════════════════════════════════════════════════════════════
void Route_AutoPost(httplib::Server& svr)
{
    svr.Post("/Moment/Post", [](const httplib::Request&, httplib::Response& res)
        {
            json r;
            r["ret"] = -1001;
            r["retmsg"] = "内部调用尚未打通（调度器复刻中，UI 自动化已移除）";
            res.set_content(r.dump(), "application/json");
        });
    svr.Get("/Moment/Post", [](const httplib::Request&, httplib::Response& res)
        {
            json j;
            j["ret"] = -1001;
            j["note"] = "内部调用尚未打通；UI 自动化已移除";
            res.set_content(j.dump(), "application/json");
        });
}


// ═════════════════════════════════════════════════════════════════════════════
//  DISPATCHER-PROBE：勾住 0xCC10A0（调度器的虚方法），抓它的 this 与 this->+0xf0 链路
//  目标：搞清楚任务对象 +0x368 的来源对象到底长什么样、怎么来的
// ═════════════════════════════════════════════════════════════════════════════
namespace
{
    typedef int (*DispFn5)(void*, void*, void*, void*, void*);
    DispFn5 g_dpOrig = nullptr;
    bool    g_dpHooked = false;
    volatile LONG g_dpHits = 0;
    volatile unsigned long long g_dpThis = 0, g_dpThisVt = 0;
    volatile unsigned long long g_dpF0 = 0, g_dpF0Vt = 0;
    volatile unsigned long long g_dpF0_20 = 0, g_dpF0_28 = 0, g_dpF0_30 = 0, g_dpF0_38 = 0;
    volatile unsigned long long g_dpThis_1f0 = 0, g_dpThis_8 = 0;
    volatile LONG g_dpMatched = 0;
    volatile unsigned char g_dpF0Raw[0x60] = {0};

    int DpDetour(void* a, void* b, void* c, void* d, void* e)
    {
        __try
        {
            uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
            uintptr_t th = (uintptr_t)a;
            g_dpThis = th;
            g_dpThisVt = 0; g_dpF0 = 0; g_dpF0Vt = 0;
            g_dpF0_20 = g_dpF0_28 = g_dpF0_30 = g_dpF0_38 = 0;
            g_dpThis_1f0 = 0; g_dpThis_8 = 0;
            if (th && base)
            {
                __try { g_dpThisVt = *(unsigned long long*)th > base ? (*(unsigned long long*)th - base) : 0; } __except (1) {}
                __try { g_dpThis_8 = *(unsigned long long*)(th + 8); } __except (1) {}
                __try { g_dpThis_1f0 = *(unsigned long long*)(th + 0x1f0); } __except (1) {}
                unsigned long long f0 = 0;
                __try { f0 = *(unsigned long long*)(th + 0xf0); } __except (1) {}
                g_dpF0 = f0;
                // 只关心「调用栈里有朋友圈代码区 0x4E0000~0x4F0000 帧」的那次投递
                bool interesting = false;
                {
                    void* fr[32] = {0};
                    USHORT nf = RtlCaptureStackBackTrace(1, 32, fr, nullptr);
                    for (USHORT i = 0; i < nf; ++i)
                    {
                        uintptr_t a = (uintptr_t)fr[i];
                        if (a <= base) continue;
                        unsigned long long r = (unsigned long long)(a - base);
                        if (r >= 0x4E0000 && r < 0x4F0000) { interesting = true; break; }
                    }
                }
                if (f0 > 0x10000 && interesting)
                {
                    __try { unsigned long long v = *(unsigned long long*)(uintptr_t)f0; g_dpF0Vt = (base && v > base) ? (v - base) : v; } __except (1) {}
                    __try { g_dpF0_20 = *(unsigned long long*)((uintptr_t)f0 + 0x20); } __except (1) {}
                    __try { g_dpF0_28 = *(unsigned long long*)((uintptr_t)f0 + 0x28); } __except (1) {}
                    __try { g_dpF0_30 = *(unsigned long long*)((uintptr_t)f0 + 0x30); } __except (1) {}
                    __try { g_dpF0_38 = *(unsigned long long*)((uintptr_t)f0 + 0x38); } __except (1) {}
                }
                g_dpMatched = 1;
                if (f0 > 0x10000)
                {
                    for (int i = 0; i < 0x60; ++i)
                    {
                        unsigned char ch = 0;
                        __try { ch = *((unsigned char*)(uintptr_t)f0 + i); } __except (1) { ch = 0xEE; }
                        g_dpF0Raw[i] = ch;
                    }
                }
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER) { }
        InterlockedIncrement(&g_dpHits);
        return g_dpOrig(a, b, c, d, e);
    }

    bool InstallDpHook()
    {
        if (g_dpHooked) return true;
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (!base) return false;
        MH_STATUS st = MH_Initialize();
        if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) return false;
        LPVOID t = (LPVOID)(base + 0xCC10A0);
        if (MH_CreateHook(t, (LPVOID)&DpDetour, (LPVOID*)&g_dpOrig) != MH_OK) return false;
        if (MH_EnableHook(t) != MH_OK) { MH_RemoveHook(t); return false; }
        g_dpHooked = true;
        return true;
    }

    bool RemoveDpHook()
    {
        if (!g_dpHooked) return true;
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (base) { LPVOID t = (LPVOID)(base + 0xCC10A0); MH_DisableHook(t); MH_RemoveHook(t); }
        g_dpHooked = false; g_dpOrig = nullptr;
        return true;
    }

    std::string DpJson()
    {
        static const char* HEX = "0123456789abcdef";
        std::string rawHex;
        for (int i = 0; i < 0x60; ++i) { rawHex += HEX[g_dpF0Raw[i] >> 4]; rawHex += HEX[g_dpF0Raw[i] & 0xF]; }
        char b[900];
        std::snprintf(b, sizeof(b),
            "{\"hooked\":%s,\"hits\":%ld,"
            "\"this\":\"0x%llX\",\"thisVtRva\":\"0x%llX\",\"this8\":\"0x%llX\",\"this1f0\":\"0x%llX\","
            "\"f0\":\"0x%llX\",\"f0VtRva\":\"0x%llX\","
            "\"matched\":%ld,\"f0_20\":\"0x%llX\",\"f0_28\":\"0x%llX\",\"f0_30\":\"0x%llX\",\"f0_38\":\"0x%llX\"}",
            g_dpHooked ? "true" : "false", (long)g_dpHits,
            g_dpThis, g_dpThisVt, g_dpThis_8, g_dpThis_1f0,
            g_dpF0, g_dpF0Vt, (long)g_dpMatched, g_dpF0_20, g_dpF0_28, g_dpF0_30, g_dpF0_38);
        std::string out(b);
        out += ",\"f0raw\":\"" + rawHex + "\"}";
        return out;
    }
}

void Route_DispatcherProbe(httplib::Server& svr)
{
    svr.Post("/Debug/DpHook", [](const httplib::Request& req, httplib::Response& res)
        {
            json body; try { body = json::parse(req.body); } catch (...) { body = json::object(); }
            bool on = body.value("on", true);
            bool ok = on ? InstallDpHook() : RemoveDpHook();
            json r; r["ok"] = ok; r["hooked"] = g_dpHooked;
            res.set_content(r.dump(), "application/json");
        });
    svr.Get("/Debug/DpProbe", [](const httplib::Request&, httplib::Response& res)
        {
            res.set_content(DpJson(), "application/json");
        });
    svr.Post("/Debug/DpProbe", [](const httplib::Request&, httplib::Response& res)
        {
            InterlockedExchange(&g_dpHits, 0);
            json r; r["ok"] = true; res.set_content(r.dump(), "application/json");
        });
}


// ═════════════════════════════════════════════════════════════════════════════
//  TASK-SRC-PROBE：勾 0x3CEED0（任务构造），第 5 个参数 r15 就是"任务字段来源对象"
//  （= dispatchObj->+0xf0）。任务 +0x368/+0x370/+0x380 直接取它的 +0x20/+0x28/+0x30。
//  只要 r15->+0x20 非空，这次就是朋友圈投递 —— 抓到它就知道要复刻什么对象。
// ═════════════════════════════════════════════════════════════════════════════
namespace
{
    typedef int (*TaskFn5)(void*, void*, void*, void*, void*);
    TaskFn5 g_tsOrig = nullptr;
    bool    g_tsHooked = false;
    volatile LONG g_tsHits = 0, g_tsMatch = 0;
    volatile unsigned long long g_tsSrc = 0, g_tsSrcVt = 0;
    volatile unsigned long long g_ts20 = 0, g_ts28 = 0, g_ts30 = 0, g_ts38 = 0;
    volatile unsigned long long g_tsTask = 0;
    volatile unsigned char g_tsSrcRaw[0x80] = {0};
    volatile unsigned char g_tsP20Raw[0x80] = {0};   // *(src+0x00) 对象
    volatile unsigned char g_tsF20Raw[0x80] = {0};   // *(src+0x20) 对象
    volatile unsigned long long g_tsP20Vt = 0, g_tsF20Vt = 0;
    volatile unsigned long long g_tsP20 = 0;
    // 覆盖用的"任务来源结构"：只有 +0x20 必须有效；其余按真实抓包填
    volatile unsigned long long g_ctxObj = 0;      // 有效上下文对象（真实发表时捕获）
    volatile LONG g_ctxOverride = 0;               // 1 = 对"空上下文"的调用做替换
    unsigned char g_ctxSrc[0x80] = {0};            // 伪造的 src 结构（真实 src 的模板副本）
    volatile LONG g_ctxHasTemplate = 0;
    char g_ctxStr[64] = "co_with_timeout@/360";    // 常驻字符串（真实值）

    int TsDetour(void* a, void* b, void* c, void* d, void* e)
    {
        __try
        {
            uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
            uintptr_t src = (uintptr_t)e;      // 第 5 个参数 = 来源对象
            if (src > 0x10000)
            {
                unsigned long long v20 = 0;
                __try { v20 = *(unsigned long long*)(src + 0x20); } __except (1) {}
                if (v20 > 0x10000)             // 只有朋友圈任务的 +0x20 才是有效指针
                {
                    g_tsTask = (unsigned long long)(uintptr_t)a;
                    g_tsSrc = src;
                    g_tsSrcVt = 0;
                    __try {
                        unsigned long long vt = *(unsigned long long*)src;
                        g_tsSrcVt = (base && vt > base) ? (vt - base) : vt;
                    } __except (1) {}
                    __try { g_ts20 = v20; } __except (1) {}
                    __try { g_ts28 = *(unsigned long long*)(src + 0x28); } __except (1) {}
                    __try { g_ts30 = *(unsigned long long*)(src + 0x30); } __except (1) {}
                    __try { g_ts38 = *(unsigned long long*)(src + 0x38); } __except (1) {}
                    for (int i = 0; i < 0x80; ++i)
                    {
                        unsigned char ch = 0;
                        __try { ch = *((unsigned char*)src + i); } __except (1) { ch = 0xEE; }
                        g_tsSrcRaw[i] = ch;
                    }
                    // 追 src+0x00 和 src+0x20 两个对象
                    g_tsP20 = 0; g_tsP20Vt = 0; g_tsF20Vt = 0;
                    __try { g_tsP20 = *(unsigned long long*)src; } __except (1) {}
                    if (g_tsP20 > 0x10000)
                    {
                        __try { unsigned long long v = *(unsigned long long*)(uintptr_t)g_tsP20;
                                g_tsP20Vt = (base && v > base) ? (v - base) : v; } __except (1) {}
                        for (int i = 0; i < 0x80; ++i) {
                            unsigned char ch = 0;
                            __try { ch = *((unsigned char*)(uintptr_t)g_tsP20 + i); } __except (1) { ch = 0xEE; }
                            g_tsP20Raw[i] = ch;
                        }
                    }
                    if (v20 > 0x10000)
                    {
                        __try { unsigned long long v = *(unsigned long long*)(uintptr_t)v20;
                                g_tsF20Vt = (base && v > base) ? (v - base) : v; } __except (1) {}
                        for (int i = 0; i < 0x80; ++i) {
                            unsigned char ch = 0;
                            __try { ch = *((unsigned char*)(uintptr_t)v20 + i); } __except (1) { ch = 0xEE; }
                            g_tsF20Raw[i] = ch;
                        }
                    }
                    InterlockedExchange(&g_tsMatch, 1);
                }
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER) { }

        // ★ 上下文覆盖：真实发表时把有效对象记下来；我们自己的调用 src+0x20 为空，
        //   就换成「带有效上下文」的伪造 src，让任务对象 +0x368 落在合法对象上。
        if (g_ctxOverride)
        {
            void* e2 = e;
            __try
            {
                uintptr_t src = (uintptr_t)e;
                unsigned long long v20 = 0;
                if (src > 0x10000) { __try { v20 = *(unsigned long long*)(src + 0x20); } __except (1) {} }
                if (v20 > 0x10000)
                {
                    g_ctxObj = v20;   // 记住真实上下文对象
                    // 把整个真实 src 拷成模板（含字符串头/长度/容量/+0x38/+0x40）
                    for (int i = 0; i < 0x80; ++i)
                    {
                        unsigned char ch = 0;
                        __try { ch = *((unsigned char*)src + i); } __except (1) { ch = 0; }
                        g_ctxSrc[i] = ch;
                    }
                    // 字符串缓冲换成常驻副本，避免原 buffer 释放后悬空
                    ::strncpy(g_ctxStr, "co_with_timeout@/360", sizeof(g_ctxStr) - 1);
                    *(unsigned long long*)(g_ctxSrc + 0x00) = (unsigned long long)(uintptr_t)g_ctxStr;
                    InterlockedExchange(&g_ctxHasTemplate, 1);
                }
                else if (v20 <= 0x10000 && g_ctxHasTemplate)
                {
                    e2 = g_ctxSrc;    // 用真实 src 模板覆盖（+0x20 已是有效上下文）
                }
            }
            __except (EXCEPTION_EXECUTE_HANDLER) { e2 = e; }
            InterlockedIncrement(&g_tsHits);
            return g_tsOrig(a, b, c, d, e2);
        }

        InterlockedIncrement(&g_tsHits);
        return g_tsOrig(a, b, c, d, e);
    }

    bool InstallTsHook()
    {
        if (g_tsHooked) return true;
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (!base) return false;
        MH_STATUS st = MH_Initialize();
        if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) return false;
        LPVOID t = (LPVOID)(base + 0x3CEED0);
        if (MH_CreateHook(t, (LPVOID)&TsDetour, (LPVOID*)&g_tsOrig) != MH_OK) return false;
        if (MH_EnableHook(t) != MH_OK) { MH_RemoveHook(t); return false; }
        g_tsHooked = true;
        return true;
    }

    bool RemoveTsHook()
    {
        if (!g_tsHooked) return true;
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (base) { LPVOID t = (LPVOID)(base + 0x3CEED0); MH_DisableHook(t); MH_RemoveHook(t); }
        g_tsHooked = false; g_tsOrig = nullptr;
        return true;
    }

    std::string TsJson()
    {
        static const char* HEX = "0123456789abcdef";
        std::string raw, p20raw, f20raw;
        for (int i = 0; i < 0x80; ++i) {
            raw += HEX[g_tsSrcRaw[i] >> 4]; raw += HEX[g_tsSrcRaw[i] & 0xF];
            p20raw += HEX[g_tsP20Raw[i] >> 4]; p20raw += HEX[g_tsP20Raw[i] & 0xF];
            f20raw += HEX[g_tsF20Raw[i] >> 4]; f20raw += HEX[g_tsF20Raw[i] & 0xF];
        }
        char b[700];
        std::snprintf(b, sizeof(b),
            "{\"hooked\":%s,\"hits\":%ld,\"match\":%ld,"
            "\"task\":\"0x%llX\",\"src\":\"0x%llX\",\"srcVtRva\":\"0x%llX\","
            "\"f20\":\"0x%llX\",\"f28\":\"0x%llX\",\"f30\":\"0x%llX\",\"f38\":\"0x%llX\"",
            g_tsHooked ? "true" : "false", (long)g_tsHits, (long)g_tsMatch,
            g_tsTask, g_tsSrc, g_tsSrcVt, g_ts20, g_ts28, g_ts30, g_ts38);
        std::string out(b);
        char b2[256];
        std::snprintf(b2, sizeof(b2), ",\"p20\":\"0x%llX\",\"p20VtRva\":\"0x%llX\",\"f20VtRva\":\"0x%llX\"",
                      g_tsP20, g_tsP20Vt, g_tsF20Vt);
        out += b2;
        out += ",\"srcRaw\":\"" + raw + "\"";
        out += ",\"p20Raw\":\"" + p20raw + "\"";
        out += ",\"f20Raw\":\"" + f20raw + "\"}";
        return out;
    }
}

void Route_TaskSrcProbe(httplib::Server& svr)
{
    svr.Post("/Debug/TsHook", [](const httplib::Request& req, httplib::Response& res)
        {
            json body; try { body = json::parse(req.body); } catch (...) { body = json::object(); }
            bool on = body.value("on", true);
            bool ok = on ? InstallTsHook() : RemoveTsHook();
            json r; r["ok"] = ok; r["hooked"] = g_tsHooked;
            res.set_content(r.dump(), "application/json");
        });
    svr.Get("/Debug/TsProbe", [](const httplib::Request&, httplib::Response& res)
        {
            res.set_content(TsJson(), "application/json");
        });
    svr.Post("/Debug/CtxOverride", [](const httplib::Request& req, httplib::Response& res)
        {
            json body; try { body = json::parse(req.body); } catch (...) { body = json::object(); }
            InterlockedExchange(&g_ctxOverride, body.value("on", true) ? 1 : 0);
            json r; r["ok"] = true; r["override"] = (long)g_ctxOverride;
            r["ctxObj"] = (unsigned long long)g_ctxObj;
            r["hasTemplate"] = (long)g_ctxHasTemplate;
            res.set_content(r.dump(), "application/json");
        });
    svr.Get("/Debug/CtxOverride", [](const httplib::Request&, httplib::Response& res)
        {
            json r; r["override"] = (long)g_ctxOverride;
            r["ctxObj"] = (unsigned long long)g_ctxObj;
            r["hasTemplate"] = (long)g_ctxHasTemplate;
            res.set_content(r.dump(), "application/json");
        });
    svr.Post("/Debug/TsProbe", [](const httplib::Request&, httplib::Response& res)
        {
            InterlockedExchange(&g_tsHits, 0);
            InterlockedExchange(&g_tsMatch, 0);
            g_tsSrc = 0; g_ts20 = 0;
            json r; r["ok"] = true; res.set_content(r.dump(), "application/json");
        });
}


// ═════════════════════════════════════════════════════════════════════════════
//  XML-PROBE：勾 0x03EC68C0（TimelineObject XML 生成器），dump「草稿对象」
//  调用点：0x04EAE893  mov rcx,[service+0x258] / lea rdx,&out / call 0x03EC68C0
//  真实发表时草稿里带着正文 → dump 出来找字段偏移，就能"改草稿再走正规流程"
// ═════════════════════════════════════════════════════════════════════════════
namespace
{
    typedef int (*XmlFn2)(void*, void*);
    XmlFn2 g_xmlOrig = nullptr;
    bool   g_xmlHooked = false;
    volatile LONG g_xmlHits = 0;
    volatile unsigned long long g_xmlDraft = 0, g_xmlOut = 0;
    volatile unsigned long long g_xmlDraftVt = 0;
    volatile unsigned char g_xmlDraftRaw[0x300] = {0};

    int XmlDetour(void* a, void* b)
    {
        __try
        {
            uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
            uintptr_t d = (uintptr_t)a;
            if (d > 0x10000)
            {
                g_xmlDraft = d;
                g_xmlOut = (unsigned long long)(uintptr_t)b;
                g_xmlDraftVt = 0;
                __try {
                    unsigned long long vt = *(unsigned long long*)d;
                    g_xmlDraftVt = (base && vt > base) ? (vt - base) : vt;
                } __except (1) {}
                for (int i = 0; i < 0x300; ++i)
                {
                    unsigned char ch = 0;
                    __try { ch = *((unsigned char*)d + i); } __except (1) { ch = 0xEE; }
                    g_xmlDraftRaw[i] = ch;
                }
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER) { }
        InterlockedIncrement(&g_xmlHits);
        return g_xmlOrig(a, b);
    }

    bool InstallXmlHook()
    {
        if (g_xmlHooked) return true;
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (!base) return false;
        MH_STATUS st = MH_Initialize();
        if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) return false;
        LPVOID t = (LPVOID)(base + 0x03EC68C0);
        if (MH_CreateHook(t, (LPVOID)&XmlDetour, (LPVOID*)&g_xmlOrig) != MH_OK) return false;
        if (MH_EnableHook(t) != MH_OK) { MH_RemoveHook(t); return false; }
        g_xmlHooked = true;
        return true;
    }

    bool RemoveXmlHook()
    {
        if (!g_xmlHooked) return true;
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (base) { LPVOID t = (LPVOID)(base + 0x03EC68C0); MH_DisableHook(t); MH_RemoveHook(t); }
        g_xmlHooked = false; g_xmlOrig = nullptr;
        return true;
    }

    std::string XmlJson()
    {
        static const char* HEX = "0123456789abcdef";
        std::string raw;
        for (int i = 0; i < 0x300; ++i) { raw += HEX[g_xmlDraftRaw[i] >> 4]; raw += HEX[g_xmlDraftRaw[i] & 0xF]; }
        char b[300];
        std::snprintf(b, sizeof(b),
            "{\"hooked\":%s,\"hits\":%ld,\"draft\":\"0x%llX\",\"draftVtRva\":\"0x%llX\",\"out\":\"0x%llX\"",
            g_xmlHooked ? "true" : "false", (long)g_xmlHits, g_xmlDraft, g_xmlDraftVt, g_xmlOut);
        std::string out(b);
        out += ",\"draftRaw\":\"" + raw + "\"}";
        return out;
    }
}

void Route_XmlProbe(httplib::Server& svr)
{
    svr.Post("/Debug/XmlHook", [](const httplib::Request& req, httplib::Response& res)
        {
            json body; try { body = json::parse(req.body); } catch (...) { body = json::object(); }
            bool on = body.value("on", true);
            bool ok = on ? InstallXmlHook() : RemoveXmlHook();
            json r; r["ok"] = ok; r["hooked"] = g_xmlHooked;
            res.set_content(r.dump(), "application/json");
        });
    svr.Get("/Debug/XmlProbe", [](const httplib::Request&, httplib::Response& res)
        {
            res.set_content(XmlJson(), "application/json");
        });
    svr.Post("/Debug/XmlProbe", [](const httplib::Request&, httplib::Response& res)
        {
            InterlockedExchange(&g_xmlHits, 0);
            g_xmlDraft = 0;
            json r; r["ok"] = true; res.set_content(r.dump(), "application/json");
        });
}


// ═════════════════════════════════════════════════════════════════════════════
//  MOMENT-INTERNAL：改「草稿」正文，再走真实业务层 0x04EAE7F0
//
//  依据（实测）：
//    service->+0x258 = 草稿对象
//    草稿+0x60 = 正文 std::string（buf@0x60 / size@0x70 / cap@0x78）
//    业务层 0x04EAE7F0(rcx=service, rdx=&tempstruct) 会用草稿拼 XML 并发布
//  这与"硬造请求"完全不同：走的是微信自己的管线，对象都是真的。
// ═════════════════════════════════════════════════════════════════════════════
namespace
{
    volatile unsigned long long g_svcObj = 0;     // 业务层 rcx（服务对象），由 BizHook 捕获
    volatile LONG g_internalRet = 0x7FFFFFFF;

    bool WriteDraftText(const char* text, unsigned long long* outDraft)
    {
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (!base || !g_svcObj) return false;
        uintptr_t svc = (uintptr_t)g_svcObj;
        unsigned long long draft = 0;
        __try { draft = *(unsigned long long*)(svc + 0x258); } __except (1) { return false; }
        if (draft < 0x10000) return false;
        if (outDraft) *outDraft = draft;

        // 写 std::string @ draft+0x60
        __try
        {
            char* p = (char*)(uintptr_t)draft + 0x60;
            size_t n = text ? ::strlen(text) : 0;
            // 先判断原缓冲是否堆（cap>=16）→ 不释放，直接覆盖（可能泄漏，但不影响功能）
            if (n <= 15)
            {
                ::memcpy(p, text, n);
                p[n] = 0;
                *(size_t*)(p + 0x10) = n;
                *(size_t*)(p + 0x18) = 15;
            }
            else
            {
                char* heap = new char[n + 1];
                ::memcpy(heap, text, n); heap[n] = 0;
                *(char**)p = heap;
                *(size_t*)(p + 0x10) = n;
                *(size_t*)(p + 0x18) = n;
            }
            return true;
        }
        __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
    }

    // 在 UI 线程上：改草稿 → 调业务层
    volatile unsigned long long g_internalDraft = 0;
    char g_internalText[1024] = {0};

    int DoInternalOnThisThread()
    {
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (!base) return -2;
        unsigned long long draft = 0;
        if (!WriteDraftText(g_internalText, &draft)) return -3;
        g_internalDraft = draft;

        extern volatile unsigned long long g_svcObj;
    typedef int (*BizFn)(void*, void*);
        BizFn fn = (BizFn)(base + 0x04EAE7F0);
        static char rdxbuf[0x300];
        ::memset(rdxbuf, 0, sizeof(rdxbuf));
        __try { return fn((void*)(uintptr_t)g_svcObj, rdxbuf); }
        __except (RecordCrash(GetExceptionInformation()), EXCEPTION_EXECUTE_HANDLER) { return -99; }
    }

    LRESULT CALLBACK InternalWndProc(int nCode, WPARAM wParam, LPARAM lParam)
    {
        if (nCode >= 0 && InterlockedCompareExchange(&g_uiPending, 0, 1) == 1)
        {
            g_internalRet = DoInternalOnThisThread();
            InterlockedExchange(&g_uiDone, 1);
        }
        return CallNextHookEx(g_uiHook, nCode, wParam, lParam);
    }

    int RunInternalOnUiThread(const std::string& text, std::string* diag)
    {
        if (text.size() >= sizeof(g_internalText)) { if (diag) *diag = "{\"why\":\"text too long\"}"; return -1; }
        ::memcpy(g_internalText, text.c_str(), text.size() + 1);
        if (!g_svcObj) { if (diag) *diag = "{\"why\":\"service object unknown (need one real post with BizHook on)\"}"; return -4; }

        DWORD tid = FindUiThread();
        if (!tid) { if (diag) *diag = "{\"why\":\"no ui tid\"}"; return -6; }
        HWND hwnd = nullptr;
        {
            struct C9 { DWORD pid; HWND h; };
            static C9 c9;
            c9.pid = GetCurrentProcessId(); c9.h = nullptr;
            EnumWindows([](HWND h, LPARAM lp) -> BOOL {
                DWORD pid = 0; GetWindowThreadProcessId(h, &pid);
                if (pid != ((C9*)lp)->pid) return TRUE;
                wchar_t cls[128] = {0};
                GetClassNameW(h, cls, 128);
                if (!wcsstr(cls, L"QWindowIcon")) return TRUE;
                RECT r; if (!GetWindowRect(h, &r)) return TRUE;
                if ((r.right - r.left) < 500) return TRUE;
                ((C9*)lp)->h = h; return FALSE;
            }, (LPARAM)&c9);
            hwnd = c9.h;
        }
        if (!hwnd) { if (diag) *diag = "{\"why\":\"no window\"}"; return -7; }

        InterlockedExchange(&g_uiDone, 0);
        InterlockedExchange(&g_uiPending, 1);
        g_uiHook = SetWindowsHookExW(WH_CALLWNDPROC, InternalWndProc, (HINSTANCE)GetModuleHandleW(nullptr), tid);
        if (!g_uiHook) { InterlockedExchange(&g_uiPending, 0); return -8; }
        for (int i = 0; i < 30 && !g_uiDone; ++i)
        {
            SendMessageTimeoutW(hwnd, WM_NULL, 0, 0, SMTO_ABORTIFHUNG, 2000, nullptr);
            if (g_uiDone) break;
            ::Sleep(30);
        }
        if (g_uiHook) { UnhookWindowsHookEx(g_uiHook); g_uiHook = nullptr; }
        InterlockedExchange(&g_uiPending, 0);

        if (diag) {
            char b[320];
            std::snprintf(b, sizeof(b),
                "{\"done\":%ld,\"ret\":%d,\"draft\":\"0x%llX\",\"svc\":\"0x%llX\","
                "\"exRva\":\"0x%llX\",\"exAcc\":\"0x%llX\",\"stack\":[",
                (long)g_uiDone, g_internalRet, g_internalDraft, g_svcObj,
                (unsigned long long)g_exAddrRva, (unsigned long long)g_exAccess);
            std::string out(b);
            for (int i = 0; i < g_stackN; ++i) {
                char t[24];
                std::snprintf(t, sizeof(t), "%s\"0x%llX\"", i ? "," : "", (unsigned long long)g_stack[i]);
                out += t;
            }
            out += "]}";
            *diag = out;
        }
        return g_internalRet;
    }
}

void Route_MomentInternal(httplib::Server& svr)
{
    // POST /Moment/Internal {"text":"..."} —— 改草稿 + 走真实业务层
    svr.Post("/Moment/Internal", [](const httplib::Request& req, httplib::Response& res)
        {
            json body; try { body = json::parse(req.body); } catch (...) { body = json::object(); }
            std::string text = body.value("text", "");
            std::string diag = "{}";
            int ret = RunInternalOnUiThread(text, &diag);
            json r;
            r["ret"] = ret;
            r["retmsg"] = (ret == 0) ? "ok" : "failed";
            try { r["diag"] = json::parse(diag); } catch (...) { r["diag"] = diag; }
            res.set_content(r.dump(), "application/json");
        });
    svr.Get("/Moment/Internal", [](const httplib::Request&, httplib::Response& res)
        {
            json r;
            r["svc"] = (unsigned long long)g_svcObj;
            r["note"] = "需要先开 BizHook 并真实发表一次以捕获 service 对象";
            res.set_content(r.dump(), "application/json");
        });
}


// ═════════════════════════════════════════════════════════════════════════════
//  PUBLISH-ENTRY-PROBE：勾发表流程入口 0x04EABFBA，抓真实参数与栈
//  若参数只是 service/上下文对象，我们就能在 UI 线程直接调它 —— 程序化建编辑会话
// ═════════════════════════════════════════════════════════════════════════════
namespace
{
    typedef void (*PubFn)(void*, void*, void*, void*);
    PubFn g_peOrig = nullptr;
    bool  g_peHooked = false;
    volatile LONG g_peHits = 0;
    volatile unsigned long long g_peA[4] = {0,0,0,0};
    volatile unsigned long long g_peV[4] = {0,0,0,0};   // 解引用
    volatile unsigned long long g_peVt[4] = {0,0,0,0};  // 若是对象，vtable RVA
    volatile unsigned char g_peARaw[0x40] = {0};        // rcx 对象前 0x40
    volatile unsigned long long g_peStk20 = 0, g_peStk28 = 0;  // 第5参(栈)

    int PeDetour(void* a, void* b, void* c, void* d)
    {
        __try
        {
            uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
            void* p[4] = { a, b, c, d };
            for (int i = 0; i < 4; ++i)
            {
                g_peA[i] = (unsigned long long)(uintptr_t)p[i];
                g_peV[i] = 0; g_peVt[i] = 0;
                if ((uintptr_t)p[i] > 0x10000)
                {
                    __try { g_peV[i] = *(unsigned long long*)p[i]; } __except (1) {}
                    if (base && g_peV[i] > (unsigned long long)base)
                        g_peVt[i] = g_peV[i] - (unsigned long long)base;
                }
            }
            if ((uintptr_t)a > 0x10000)
            {
                for (int i = 0; i < 0x40; ++i)
                {
                    unsigned char ch = 0;
                    __try { ch = *((unsigned char*)a + i); } __except (1) { ch = 0xEE; }
                    g_peARaw[i] = ch;
                }
            }
            g_peStk20 = g_peStk28 = 0;
        }
        __except (EXCEPTION_EXECUTE_HANDLER) { }
        InterlockedIncrement(&g_peHits);
        return 0;   // 原函数是 void？保险：不调 original 可能破坏流程，还是调
    }

    int PeDetour2(void* a, void* b, void* c, void* d)
    {
        int r = (int)PeDetour(a, b, c, d);
        g_peOrig(a, b, c, d);
        return r;
    }

    bool InstallPeHook()
    {
        if (g_peHooked) return true;
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (!base) return false;
        MH_STATUS st = MH_Initialize();
        if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) return false;
        LPVOID t = (LPVOID)(base + 0x04EABFBA);
        if (MH_CreateHook(t, (LPVOID)&PeDetour2, (LPVOID*)&g_peOrig) != MH_OK) return false;
        if (MH_EnableHook(t) != MH_OK) { MH_RemoveHook(t); return false; }
        g_peHooked = true;
        return true;
    }

    bool RemovePeHook()
    {
        if (!g_peHooked) return true;
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (base) { LPVOID t = (LPVOID)(base + 0x04EABFBA); MH_DisableHook(t); MH_RemoveHook(t); }
        g_peHooked = false; g_peOrig = nullptr;
        return true;
    }

    std::string PeJson()
    {
        static const char* HEX = "0123456789abcdef";
        std::string raw;
        for (int i = 0; i < 0x40; ++i) { raw += HEX[g_peARaw[i] >> 4]; raw += HEX[g_peARaw[i] & 0xF]; }
        char b[800];
        std::snprintf(b, sizeof(b),
            "{\"hooked\":%s,\"hits\":%ld,"
            "\"a\":[\"0x%llX\",\"0x%llX\",\"0x%llX\",\"0x%llX\"],"
            "\"v\":[\"0x%llX\",\"0x%llX\",\"0x%llX\",\"0x%llX\"],"
            "\"vt\":[\"0x%llX\",\"0x%llX\",\"0x%llX\",\"0x%llX\"]",
            g_peHooked ? "true" : "false", (long)g_peHits,
            g_peA[0], g_peA[1], g_peA[2], g_peA[3],
            g_peV[0], g_peV[1], g_peV[2], g_peV[3],
            g_peVt[0], g_peVt[1], g_peVt[2], g_peVt[3]);
        std::string out(b);
        out += ",\"aRaw\":\"" + raw + "\"}";
        return out;
    }
}

void Route_PublishEntryProbe(httplib::Server& svr)
{
    svr.Post("/Debug/PeHook", [](const httplib::Request& req, httplib::Response& res)
        {
            json body; try { body = json::parse(req.body); } catch (...) { body = json::object(); }
            bool on = body.value("on", true);
            bool ok = on ? InstallPeHook() : RemovePeHook();
            json r; r["ok"] = ok; r["hooked"] = g_peHooked;
            res.set_content(r.dump(), "application/json");
        });
    svr.Get("/Debug/PeProbe", [](const httplib::Request&, httplib::Response& res)
        {
            res.set_content(PeJson(), "application/json");
        });
    svr.Post("/Debug/PeProbe", [](const httplib::Request&, httplib::Response& res)
        {
            InterlockedExchange(&g_peHits, 0);
            json r; r["ok"] = true; res.set_content(r.dump(), "application/json");
        });
}


// ── /Debug/SetSvc：手动指定 service 对象（免真实发表捕获；用 /Debug/ScanVt 找实例）──
void Route_SetSvc(httplib::Server& svr)
{
    svr.Post("/Debug/SetSvc", [](const httplib::Request& req, httplib::Response& res)
        {
            json body; try { body = json::parse(req.body); } catch (...) { body = json::object(); }
            unsigned long long v = 0;
            try { v = std::stoull(body.value("svc", "0"), nullptr, 0); } catch (...) {}
            g_svcObj = v;
            json r; r["ok"] = (v != 0); r["svc"] = (unsigned long long)g_svcObj;
            res.set_content(r.dump(), "application/json");
        });
    svr.Get("/Debug/SetSvc", [](const httplib::Request&, httplib::Response& res)
        {
            json r; r["svc"] = (unsigned long long)g_svcObj;
            r["hint"] = "POST {\"svc\":\"0x...\"} 手动设置 service；地址可用 /Debug/ScanVt?rva=0x8B5D308 扫描";
            res.set_content(r.dump(), "application/json");
        });
}


// ═════════════════════════════════════════════════════════════════════════════
//  DRAFT-WRITER-PROBE：同时钩 4 个「写草稿槽」的函数入口，抓谁创建草稿
//    ① 0x04EA08C0 (写点 +0xCE3)   ② 0x04EA2E90 (+0x13C)
//    ③ 0x04EA8220 (+0x3E7)        ④ 0x04EA8CE4 (+0x196)
//  都是函数入口，MinHook 安全（BizHook 同款先例）
// ═════════════════════════════════════════════════════════════════════════════
namespace
{
    struct DWP { void* fn; void** orig; };
    // 统一签名：这四个都是成员函数，至少 (rcx, rdx)
    typedef int (*DW2)(void*, void*);

    DW2 g_dwOrig[4] = {nullptr,nullptr,nullptr,nullptr};
    bool g_dwHooked[4] = {false,false,false,false};
    const unsigned long long RVA_SITES[4] = {0x04EA08C0, 0x04EA2E90, 0x04EA8220, 0x04EA8CE4};
    // 各函数里写 +0x258 的 RVA（判断"是否已写到"）
    const unsigned long long RVA_WRITES[4] = {0x04EA15A3, 0x04EA2FCC, 0x04EA8607, 0x04EA8E7A};

    volatile LONG g_dwHits[4] = {0,0,0,0};
    volatile unsigned long long g_dwRcx[4] = {0,0,0,0};
    volatile unsigned long long g_dwRdx[4] = {0,0,0,0};
    volatile LONG g_dwSlotBefore[4] = {0,0,0,0};   // 入口时 [rcx+0x258]
    volatile LONG g_dwSlotAfter[4]  = {0,0,0,0};   // 返回后 [rcx+0x258]

    static char g_dwDraftSnap[0x100] = {0};        // 最近一次"草稿被创建"时草稿对象快照

    int DWDetour(int idx, void* rcx, void* rdx)
    {
        unsigned long long before = 0, after = 0;
        __try { before = *(unsigned long long*)((uintptr_t)rcx + 0x258); } __except (1) {}
        InterlockedIncrement(&g_dwHits[idx]);
        g_dwRcx[idx] = (unsigned long long)(uintptr_t)rcx;
        g_dwRdx[idx] = (unsigned long long)(uintptr_t)rdx;
        InterlockedExchange(&g_dwSlotBefore[idx], (long)(before >> 32));   // 低位展示
        g_dwSlotBefore[idx] = (long)(before & 0xFFFFFFFF);

        int r = g_dwOrig[idx](rcx, rdx);

        __try { after = *(unsigned long long*)((uintptr_t)rcx + 0x258); } __except (1) {}
        g_dwSlotAfter[idx] = (long)(after & 0xFFFFFFFF);
        if (after > 0x10000 && before <= 0x10000)
        {
            // 草稿被创建了 —— 抓它的内存
            unsigned long long d = after;
            for (int i = 0; i < 0x100; ++i)
            {
                unsigned char ch = 0;
                __try { ch = *((unsigned char*)(uintptr_t)d + i); } __except (1) { ch = 0xEE; }
                g_dwDraftSnap[i] = (char)ch;
            }
        }
        return r;
    }

    int DW0(void* a, void* b) { return DWDetour(0, a, b); }
    int DW1(void* a, void* b) { return DWDetour(1, a, b); }
    int DW2_(void* a, void* b) { return DWDetour(2, a, b); }
    int DW3(void* a, void* b) { return DWDetour(3, a, b); }
    void* g_dwDetours[4] = { (void*)&DW0, (void*)&DW1, (void*)&DW2_, (void*)&DW3 };

    // 注意：这些函数参数个数可能 >2，统一 detour 会吃掉 r8/r9 ——封掉风险：只钩 ②/④（进函数越小越可能全用 (rcx,rdx)）
    bool InstallDwHook()
    {
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        if (!base) return false;
        MH_STATUS st = MH_Initialize();
        if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) return false;
        int idxs[2] = {1, 3};
        for (int k = 0; k < 2; ++k)
        {
            int i = idxs[k];
            LPVOID t = (LPVOID)(base + RVA_SITES[i]);
            if (MH_CreateHook(t, g_dwDetours[i], (LPVOID*)&g_dwOrig[i]) == MH_OK &&
                MH_EnableHook(t) == MH_OK)
                g_dwHooked[i] = true;
        }
        return g_dwHooked[1] || g_dwHooked[3];
    }

    bool RemoveDwHook()
    {
        uintptr_t base = (uintptr_t)GetModuleHandleA("Weixin.dll");
        for (int i = 0; i < 4; ++i)
        {
            if (!g_dwHooked[i]) continue;
            if (base) { LPVOID t = (LPVOID)(base + RVA_SITES[i]); MH_DisableHook(t); MH_RemoveHook(t); }
            g_dwHooked[i] = false; g_dwOrig[i] = nullptr;
        }
        return true;
    }

    std::string DwJson()
    {
        std::string j = "[";
        for (int i = 0; i < 4; ++i)
        {
            char b[256];
            std::snprintf(b, sizeof(b),
                "%s{\"site\":\"0x%llX\",\"hooked\":%d,\"hits\":%ld,\"rcx\":\"0x%llX\",\"rdx\":\"0x%llX\","
                "\"slotBefore\":\"0x%X\",\"slotAfter\":\"0x%X\"}",
                i ? "," : "", RVA_SITES[i], g_dwHooked[i], (long)g_dwHits[i],
                g_dwRcx[i], g_dwRdx[i], (unsigned)g_dwSlotBefore[i], (unsigned)g_dwSlotAfter[i]);
            j += b;
        }
        j += "]";
        return j;
    }
}

void Route_DraftWriterProbe(httplib::Server& svr)
{
    svr.Post("/Debug/DwHook", [](const httplib::Request& req, httplib::Response& res)
        {
            json body; try { body = json::parse(req.body); } catch (...) { body = json::object(); }
            bool on = body.value("on", true);
            bool ok = on ? InstallDwHook() : RemoveDwHook();
            json r; r["ok"] = ok; r["state"] = DwJson();
            res.set_content(r.dump(), "application/json");
        });
    svr.Get("/Debug/DwProbe", [](const httplib::Request&, httplib::Response& res)
        {
            json r;
            r["sites"] = DwJson();
            static const char* HEX = "0123456789abcdef";
            std::string raw;
            char* p = g_dwDraftSnap;
            for (int i = 0; i < 0x100; ++i) { unsigned char c = (unsigned char)p[i]; raw += HEX[c >> 4]; raw += HEX[c & 0xF]; }
            r["draftSnap"] = raw;
            res.set_content(r.dump(), "application/json");
        });
    svr.Post("/Debug/DwProbe", [](const httplib::Request&, httplib::Response& res)
        {
            for (int i = 0; i < 4; ++i) { InterlockedExchange(&g_dwHits[i], 0); g_dwRcx[i]=0; g_dwRdx[i]=0; g_dwSlotBefore[i]=0; g_dwSlotAfter[i]=0; }
            ::memset(g_dwDraftSnap, 0, sizeof(g_dwDraftSnap));
            json r; r["ok"] = true; res.set_content(r.dump(), "application/json");
        });
}


// ═════════════════════════════════════════════════════════════════════════════
//  SILENT-POST：消息级静默发表（不移动鼠标、不抢前台、可在后台运行）
//
//  实测流程（本机 4.1.10.27 验证通过）：
//    ① PostMessage WM_RBUTTONDOWN/UP 到主窗口相机图标(762,55)  → 弹菜单
//    ② PostMessage 左键到菜单(Qt51514QWindowToolSaveBits)项「发表文字」(105,88) → 开编辑器
//    ③ 逐字节 PostMessage WM_CHAR（GBK 编码！微信用 ANSI 解码）→ 中文正确
//    ④ PostMessage 左键到编辑器「发表」按钮(145,378) → 发布
//  验证：contentDesc 在 XML 里为正确 UTF-8
// ═════════════════════════════════════════════════════════════════════════════
namespace silentpost
{
    struct RECTS { LONG l, t, r, b; };

    // 最近一次发表的定位信息（诊断用：证实"自适应定位"真的生效）
    volatile LONG g_btnGreenHit = 0;
    volatile LONG g_btnX = 0, g_btnY = 0;
    volatile LONG g_camX = 0;
    volatile LONG g_menuItemY = 0;

    // 该 pid 是否是 Weixin.exe（用于"跨进程找主窗口"时排除其它程序的 Qt 窗口）
    bool IsWeixinProcess(DWORD pid)
    {
        HANDLE hp = ::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (!hp) return false;
        wchar_t path[MAX_PATH] = {0};
        DWORD sz = MAX_PATH;
        bool ok = false;
        if (::QueryFullProcessImageNameW(hp, 0, path, &sz))
        {
            const wchar_t* base = ::wcsrchr(path, L'\\');
            base = base ? base + 1 : path;
            ok = (::_wcsicmp(base, L"Weixin.exe") == 0);
        }
        ::CloseHandle(hp);
        return ok;
    }

    // pid == 0 表示"任意 Weixin 进程"。
    // ★ 为什么需要：version.dll 被注入到 Weixin 的全部子进程里，HTTP 端口(30001)最终
    //   落在哪一个进程上是**不确定的**（可能落在没有主窗口的辅助进程）。
    //   以前这里按"本进程 pid"过滤 → 服务在辅助进程时永远找不到主窗口，
    //   面板就报 hookOk=false、朋友圈发不出去（实测时好时坏，正是这个原因）。
    bool EnumWinsByClass(DWORD pid, const wchar_t* cls, int minW, int maxW,
                         HWND* out, int maxOut, int* count)
    {
        struct Ctx { DWORD pid; const wchar_t* cls; int minW, maxW; HWND* out; int maxOut; int* n; };
        Ctx ctx = { pid, cls, minW, maxW, out, maxOut, count };
        *count = 0;
        EnumWindows([](HWND h, LPARAM lp) -> BOOL {
            Ctx* c = (Ctx*)lp;
            DWORD pid = 0; GetWindowThreadProcessId(h, &pid);
            if (c->pid != 0) { if (pid != c->pid) return TRUE; }
            else if (!IsWeixinProcess(pid)) return TRUE;
            wchar_t buf[256] = {0};
            GetClassNameW(h, buf, 256);
            if (::wcsicmp(buf, c->cls) != 0) return TRUE;
            RECTS r; ::GetWindowRect(h, (LPRECT)&r);
            int w = r.r - r.l;
            if (w < c->minW || w > c->maxW) return TRUE;
            if (*c->n < c->maxOut) c->out[(*c->n)++] = h;
            return TRUE;
        }, (LPARAM)&ctx);
        return *count > 0;
    }

    void PostLClick(HWND h, int rx, int ry)
    {
        RECTS r; ::GetWindowRect(h, (LPRECT)&r);
        POINT p; p.x = r.l + rx; p.y = r.t + ry;
        ::ScreenToClient(h, &p);
        LPARAM lp = MAKELPARAM((p.x & 0xFFFF), (p.y & 0xFFFF));
        ::PostMessageW(h, WM_MOUSEMOVE, 0, lp);
        ::Sleep(90);
        ::PostMessageW(h, WM_LBUTTONDOWN, MK_LBUTTON, lp);
        ::Sleep(80);
        ::PostMessageW(h, WM_LBUTTONUP, 0, lp);
    }

    void PostRClick(HWND h, int rx, int ry)
    {
        RECTS r; ::GetWindowRect(h, (LPRECT)&r);
        POINT p; p.x = r.l + rx; p.y = r.t + ry;
        ::ScreenToClient(h, &p);
        LPARAM lp = MAKELPARAM((p.x & 0xFFFF), (p.y & 0xFFFF));
        ::PostMessageW(h, WM_RBUTTONDOWN, MK_RBUTTON, lp);
        ::Sleep(110);
        ::PostMessageW(h, WM_RBUTTONUP, 0, lp);
    }

    bool IsWindowGone(HWND h)
    {
        return !::IsWindow(h) || !::IsWindowVisible(h);
    }

    struct ChildCtx { int kind; HWND edit; HWND openBtn; };
    std::wstring Utf8ToWideFile(const std::string& utf8);   // fwd

    static BOOL CALLBACK ChildProc(HWND h, LPARAM lp)
    {
        ChildCtx* c = (ChildCtx*)lp;
        wchar_t cls[128] = {0};
        ::GetClassNameW(h, cls, 128);
        if (!::IsWindowVisible(h)) return TRUE;
        if (c->kind == 1)
        {
            if (::wcsicmp(cls, L"Edit") == 0) c->edit = h;
        }
        else
        {
            if (::wcsicmp(cls, L"Button") == 0)
            {
                wchar_t txt[128] = {0};
                ::GetWindowTextW(h, txt, 128);
                if (::wcsstr(txt, L"\u6253\u5F00") || ::wcsstr(txt, L"Open"))
                    c->openBtn = h;
            }
        }
        return TRUE;
    }

    HWND FindDialog()
    {
        struct C { HWND h; } c = { nullptr };
        ::EnumWindows([](HWND h, LPARAM lp) -> BOOL {
            DWORD pid = 0; ::GetWindowThreadProcessId(h, &pid);
            if (pid != ::GetCurrentProcessId()) return TRUE;
            wchar_t cls[64] = {0}; ::GetClassNameW(h, cls, 64);
            if (::wcsicmp(cls, L"#32770") == 0 && ::IsWindowVisible(h))
            {
                ((C*)lp)->h = h; return FALSE;
            }
            return TRUE;
        }, (LPARAM)&c);
        return c.h;
    }

    bool FillFileDialog(HWND dlg, const std::vector<std::string>& paths)
    {
        std::wstring w;
        for (size_t i = 0; i < paths.size(); ++i)
        {
            std::wstring one = Utf8ToWideFile(paths[i]);
            if (one.empty()) continue;
            if (paths.size() > 1) { if (!w.empty()) w += L' '; w += L'"' + one + L'"'; }
            else w = one;
        }
        if (w.empty()) return false;

        ChildCtx c1 = { 1, nullptr, nullptr };
        ::EnumChildWindows(dlg, ChildProc, (LPARAM)&c1);
        if (!c1.edit) return false;
        ::SendMessageW(c1.edit, WM_SETTEXT, 0, (LPARAM)w.c_str());
        ::Sleep(500);

        ChildCtx c2 = { 2, nullptr, nullptr };
        ::EnumChildWindows(dlg, ChildProc, (LPARAM)&c2);
        if (c2.openBtn) { ::PostMessageW(c2.openBtn, BM_CLICK, 0, 0); return true; }
        ::PostMessageW(dlg, WM_COMMAND, 1, 0);
        return true;
    }

    // 编辑器特征：宽 250~700，高 >= 380（提示框只有 ~199 高，不能用）
    HWND WaitEditor(HWND main, int tries)
    {
        DWORD pid = ::GetCurrentProcessId();
        for (int i = 0; i < tries; ++i)
        {
            HWND ws[16]; int n = 0;
            if (EnumWinsByClass(0, L"Qt51514QWindowIcon", 250, 700, ws, 16, &n))
            {
                for (int k = 0; k < n; ++k)
                {
                    if (ws[k] == main || !::IsWindowVisible(ws[k])) continue;
                    RECTS r; ::GetWindowRect(ws[k], (LPRECT)&r);
                    if ((r.b - r.t) >= 380) return ws[k];
                }
            }
            ::Sleep(500);
        }
        return nullptr;
    }

    // 检测"格式不支持"这类小提示框（宽 250~700、高 < 380）
    HWND FindSmallPopup(HWND main)
    {
        DWORD pid = ::GetCurrentProcessId();
        HWND ws[16]; int n = 0;
        if (EnumWinsByClass(pid, L"Qt51514QWindowIcon", 250, 700, ws, 16, &n))
        {
            for (int k = 0; k < n; ++k)
            {
                if (ws[k] == main || !::IsWindowVisible(ws[k])) continue;
                RECTS r; ::GetWindowRect(ws[k], (LPRECT)&r);
                if ((r.b - r.t) < 380) return ws[k];
            }
        }
        return nullptr;
    }

    // 抓窗口像素（PrintWindow → 32bpp DIB，top-down）
    bool GrabPixels(HWND h, std::vector<unsigned>& out, int& W, int& H)
    {
        RECTS r; if (!::GetWindowRect(h, (LPRECT)&r)) return false;
        W = (int)(r.r - r.l); H = (int)(r.b - r.t);
        if (W <= 0 || H <= 0 || W > 3000 || H > 3000) return false;

        HDC hdc = ::GetWindowDC(h);
        HDC mdc = ::CreateCompatibleDC(hdc);
        HBITMAP bmp = ::CreateCompatibleBitmap(hdc, W, H);
        HGDIOBJ old = ::SelectObject(mdc, bmp);
        BOOL ok = ::PrintWindow(h, mdc, 2);
        BITMAPINFO bi = {};
        bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        bi.bmiHeader.biWidth = W;
        bi.bmiHeader.biHeight = -H;
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB;
        out.resize((size_t)W * (size_t)H);
        int lines = ::GetDIBits(mdc, bmp, 0, H, out.data(), &bi, DIB_RGB_COLORS);
        ::SelectObject(mdc, old);
        ::DeleteObject(bmp);
        ::DeleteDC(mdc);
        ::ReleaseDC(h, hdc);
        return ok && lines > 0;
    }

    // 找微信绿按钮（#07C160 附近）→ 返回窗口内中心坐标
    // 用来定位「发表」：不再依赖「高度-72」这类写死值
    bool FindGreenButton(HWND h, int& cx, int& cy)
    {
        std::vector<unsigned> px; int W = 0, H = 0;
        if (!GrabPixels(h, px, W, H)) return false;
        int minX = W, minY = H, maxX = -1, maxY = -1, cnt = 0;
        for (int y = 0; y < H; ++y)
        {
            for (int x = 0; x < W; ++x)
            {
                unsigned p32 = px[(size_t)y * (size_t)W + (size_t)x];
                int b = (int)(p32 & 0xFF);
                int g = (int)((p32 >> 8) & 0xFF);
                int r = (int)((p32 >> 16) & 0xFF);
                if ((r - 7) * (r - 7) < 1600 && (g - 193) * (g - 193) < 1600 && (b - 96) * (b - 96) < 2025)
                {
                    ++cnt;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (cnt < 300 || maxX < 0) return false;
        // 只接受"按钮形状"：宽高都要有量，且不会占满整窗
        int bw = maxX - minX, bh = maxY - minY;
        if (bw < 40 || bh < 16 || bw > W || bh > H / 2) return false;
        cx = (minX + maxX) / 2;
        cy = (minY + maxY) / 2;
        return true;
    }

    HWND WaitDialog(int tries)
    {
        for (int i = 0; i < tries; ++i)
        {
            HWND d = FindDialog();
            if (d) return d;
            ::Sleep(400);
        }
        return nullptr;
    }

    std::wstring Utf8ToWideFile(const std::string& utf8)
    {
        int n = ::MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.c_str(), (int)utf8.size(), nullptr, 0);
        UINT cp = (n > 0) ? CP_UTF8 : 936;
        n = ::MultiByteToWideChar(cp, 0, utf8.c_str(), (int)utf8.size(), nullptr, 0);
        if (n <= 0) return std::wstring();
        std::wstring w((size_t)n, 0);
        ::MultiByteToWideChar(cp, 0, utf8.c_str(), (int)utf8.size(), &w[0], n);
        return w;
    }

    std::wstring Utf8ToWide(const std::string& utf8)
    {
        int n = ::MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), (int)utf8.size(), nullptr, 0);
        if (n <= 0) return std::wstring();
        std::wstring w((size_t)n, 0);
        ::MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), (int)utf8.size(), &w[0], n);
        return w;
    }

    std::string Utf8ToGbk(const std::string& utf8)
    {
        int n = ::MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), (int)utf8.size(), nullptr, 0);
        if (n <= 0) return std::string();
        std::wstring w((size_t)n, L'\0');
        ::MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), (int)utf8.size(), &w[0], n);
        int m = ::WideCharToMultiByte(936, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
        if (m <= 0) return std::string();
        std::string g((size_t)m, '\0');
        ::WideCharToMultiByte(936, 0, w.c_str(), (int)w.size(), &g[0], m, nullptr, nullptr);
        return g;
    }

    // 返回值：0 成功；负数失败
    int Post(const std::string& utf8Text, const std::vector<std::string>& images, std::string* err)
    {
        DWORD pid = ::GetCurrentProcessId();
        HWND ws[16]; int n = 0;

        if (!EnumWinsByClass(0, L"Qt51514QWindowIcon", 700, 4000, ws, 16, &n) || n == 0)
        { if (err) *err = "no main window"; return -1; }
        HWND main = ws[0];

        // ⓪ 导航到朋友圈页（幂等：发现 → 朋友圈）
        PostLClick(main, 30, 240);
        ::Sleep(1400);
        PostLClick(main, 133, 104);
        ::Sleep(1800);

        HWND ed = nullptr;
        if (images.empty())
        {
            // ① 右键相机（菜单偶发不弹 -> 重试 3 次）
            HWND menus[8]; int mn = 0;
            for (int attempt = 0; attempt < 3; ++attempt)
            {
                RECTS mr; ::GetWindowRect(main, (LPRECT)&mr);
                int camX = (int)(mr.r - mr.l) - 44;      // 相机是最右侧倒数第二个图标
                g_camX = camX;
                PostRClick(main, camX, 55);
                ::Sleep(1700);
                if (EnumWinsByClass(pid, L"Qt51514QWindowToolSaveBits", 100, 600, menus, 8, &mn) && mn > 0) break;
                PostLClick(main, 133, 104);      // 重新点一下朋友圈，恢复页面状态
                ::Sleep(1500);
            }
            if (mn == 0)
            { if (err) *err = "no menu (camera icon not found?)"; return -2; }
            {
                RECTS mr2; ::GetWindowRect(menus[0], (LPRECT)&mr2);
                int mw = (int)(mr2.r - mr2.l), mh = (int)(mr2.b - mr2.t);
                g_menuItemY = (int)(mh * 0.72);
                PostLClick(menus[0], mw / 2, (int)g_menuItemY);   // 第 2 项：发表文字
            }
            ::Sleep(2400);

            // ③ 编辑器
            HWND eds[8]; int en = 0;
            if (!EnumWinsByClass(0, L"Qt51514QWindowIcon", 250, 700, eds, 8, &en) || en == 0)
            { if (err) *err = "no editor"; return -3; }
            ed = eds[0];
            for (int i = 0; i < en; ++i) if (eds[i] != main) { ed = eds[i]; break; }
        }
        else
        {
            // ① 右键相机（菜单偶发不弹 -> 重试 3 次）
            HWND menus[8]; int mn = 0;
            for (int attempt = 0; attempt < 3; ++attempt)
            {
                RECTS mr; ::GetWindowRect(main, (LPRECT)&mr);
                int camX = (int)(mr.r - mr.l) - 44;
                g_camX = camX;
                PostRClick(main, camX, 55);
                ::Sleep(1700);
                if (EnumWinsByClass(pid, L"Qt51514QWindowToolSaveBits", 100, 600, menus, 8, &mn) && mn > 0) break;
                PostLClick(main, 133, 104);
                ::Sleep(1500);
            }
            if (mn == 0)
            { if (err) *err = "no menu (camera icon not found?)"; return -2; }

            // ② 菜单 -> 选照片或视频（第一项）
            {
                RECTS mr2; ::GetWindowRect(menus[0], (LPRECT)&mr2);
                int mw = (int)(mr2.r - mr2.l), mh = (int)(mr2.b - mr2.t);
                g_menuItemY = (int)(mh * 0.36);
                PostLClick(menus[0], mw / 2, (int)g_menuItemY);   // 第 1 项：选照片或视频
            }
            ::Sleep(2500);

            // ③ 文件对话框 -> 填路径 -> 打开
            HWND dlg = WaitDialog(15);
            if (!dlg)
            {
                HWND pop = FindSmallPopup(main);
                if (pop) { ::PostMessageW(pop, WM_CLOSE, 0, 0); ::Sleep(300); }
                if (err) *err = "no file dialog"; return -6;
            }
            if (!FillFileDialog(dlg, images)) { if (err) *err = "fill file dialog failed"; return -7; }
            ::Sleep(3200);

            // ④ 编辑器
            ed = WaitEditor(main, 20);
            if (!ed) { if (err) *err = "no editor (image rejected?)"; return -8; }
            ::Sleep(1800);

            // ★ 校验图片是否真的挂上了：有图时编辑器明显更高（约 528 vs 450）
            {
                RECTS cr; ::GetWindowRect(ed, (LPRECT)&cr);
                int hh = (int)(cr.b - cr.t);
                if (hh < 500)
                {
                    if (err) *err = "image not attached (editor height " + std::to_string(hh) + ", expected >=500)";
                    return -9;   // 不留半成品：让调用方知道没带图
                }
            }
        }

        // 清空
        for (int i = 0; i < 40; ++i) { ::PostMessageW(ed, WM_CHAR, 8, 1); ::Sleep(25); }
        ::Sleep(400);

        // 输入：UTF-16 码点（微信按 Unicode 处理 WM_CHAR）
        std::wstring w = silentpost::Utf8ToWide(utf8Text);
        if (w.empty() && !utf8Text.empty()) { if (err) *err = "utf8->utf16 failed"; return -4; }
        for (wchar_t wc : w)
        {
            if (wc == 10) { ::PostMessageW(ed, WM_CHAR, 13, 1); ::Sleep(45); continue; }
            if (wc == 13) continue;
            ::PostMessageW(ed, WM_CHAR, (WPARAM)wc, 1);
            ::Sleep(45);
        }
        ::Sleep(700);

        // ⑤ 点发表：优先按「微信绿按钮」像素定位（自适应布局/皮肤），失败才退回高度推算
        int px = 0, py = 0;
        int bx = 144, by;
        RECTS er; ::GetWindowRect(ed, (LPRECT)&er);
        by = (int)(er.b - er.t) - 72;
        if (by < 100) by = 378;
        g_btnGreenHit = FindGreenButton(ed, px, py) ? 1 : 0;
        if (g_btnGreenHit) { bx = px; by = py; }
        g_btnX = bx; g_btnY = by;
        PostLClick(ed, bx, by);
        ::Sleep(3800);

        if (!IsWindowGone(ed))
        { if (err) *err = "editor still open (publish may have failed)"; return -5; }
        return 0;
    }
}

void Route_SilentMoment(httplib::Server& svr)
{
    svr.Post("/Moment/PostSilent", [](const httplib::Request& req, httplib::Response& res)
        {
            json body; try { body = json::parse(req.body); } catch (...) { body = json::object(); }
            std::string text = body.value("text", "");
            std::vector<std::string> images;
            if (body.contains("images") && body["images"].is_array())
            {
                for (const auto& v : body["images"])
                    if (v.is_string()) images.push_back(v.get<std::string>());
            }
            if (text.empty() && images.empty())
            { json r; r["ret"] = -400; r["retmsg"] = "empty text and images"; res.set_content(r.dump(), "application/json"); return; }
            std::string err;
            int ret = silentpost::Post(text, images, &err);
            json r;
            r["ret"] = ret;
            r["retmsg"] = (ret == 0) ? "ok" : err;
            r["text"] = text;
            r["images"] = (int)images.size();
            r["pos"] = {
                {"btnGreen", (int)silentpost::g_btnGreenHit},
                {"btnX", (int)silentpost::g_btnX},
                {"btnY", (int)silentpost::g_btnY},
                {"camX", (int)silentpost::g_camX},
                {"menuY", (int)silentpost::g_menuItemY}
            };
            res.set_content(r.dump(), "application/json");
        });
    svr.Get("/Moment/Ready", [](const httplib::Request&, httplib::Response& res)
        {
            // 体检：主窗口 + 是否已有编辑器打开（供面板状态显示）
            DWORD pid = ::GetCurrentProcessId();
            HWND ws[16]; int n = 0;
            bool hasMain = silentpost::EnumWinsByClass(0, L"Qt51514QWindowIcon", 700, 4000, ws, 16, &n) && n > 0;
            HWND eds[8]; int en = 0;
            bool hasEditor = silentpost::EnumWinsByClass(0, L"Qt51514QWindowIcon", 250, 700, eds, 8, &en) && en > 0;   // 跨进程：编辑器可能在另一个子进程
            json r;
            r["ok"] = hasMain;
            r["main"] = hasMain ? (unsigned long long)(uintptr_t)ws[0] : 0;
            r["editor"] = hasEditor ? (unsigned long long)(uintptr_t)eds[0] : 0;
            r["flow"] = "右键相机 → 发表文字 → WM_CHAR(UTF-16) → 点发表";
            res.set_content(r.dump(), "application/json");
        });
    svr.Get("/Moment/PostSilent", [](const httplib::Request&, httplib::Response& res)
        {
            json r;
            r["usage"] = "POST {\"text\":\"...\"} —— 消息级静默发表（不动鼠标/不抢前台）";
            r["flow"] = "右键相机 → 发表文字 → WM_CHAR(GBK) → 点发表";
            res.set_content(r.dump(), "application/json");
        });
}

