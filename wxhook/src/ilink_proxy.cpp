// ilink_wrapper proxy exports (for WeChat 4.1.15.56+)
// The real DLL is renamed to ilink_wrapper_orig.dll; all 8 exports are forwarded.
// Loaded by Weixin.dll at startup -> gives us code execution without version.dll hijack.
#include <windows.h>
#include <cstdio>
#include <cstdarg>

typedef void* (*Fn4)(void*, void*, void*, void*);

static HMODULE g_ilinkOrig = 0;
static Fn4 g_ilinkCreateNetworkManagerNoPB = 0;
static Fn4 g_ilinkDestroyContextNoPB = 0;
static Fn4 g_ilinkDestroyIlinkStreamContext = 0;
static Fn4 g_ilinkDestroyLogManagerNoPB = 0;
static Fn4 g_ilinkDestroyNetworkManagerNoPB = 0;
static Fn4 g_ilinkGetContextNoPB = 0;
static Fn4 g_ilinkGetIlinkStreamContext = 0;
static Fn4 g_ilinkGetLogManagerNoPB = 0;

static void IlinkLog(const wchar_t* fmt, ...)
{
    wchar_t path[MAX_PATH] = { 0 };
    HMODULE self = 0;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       (LPCWSTR)&IlinkLog, &self);
    GetModuleFileNameW(self, path, MAX_PATH);
    wchar_t* slash = wcsrchr(path, L'\\');
    if (slash) *(slash + 1) = 0;
    wcscat_s(path, MAX_PATH, L"hook-ilink.log");

    FILE* f = 0;
    if (_wfopen_s(&f, path, L"a, ccs=UTF-8") == 0 && f)
    {
        va_list ap;
        va_start(ap, fmt);
        vfwprintf(f, fmt, ap);
        va_end(ap);
        fwprintf(f, L"\n");
        fclose(f);
    }
}

void InitIlinkProxy(HMODULE self)
{
    wchar_t dir[MAX_PATH] = { 0 };
    GetModuleFileNameW(self, dir, MAX_PATH);
    wchar_t* slash = wcsrchr(dir, L'\\');
    if (slash) *(slash + 1) = 0;

    wchar_t full[MAX_PATH] = { 0 };
    wcscpy_s(full, MAX_PATH, dir);
    wcscat_s(full, MAX_PATH, L"ilink_wrapper_orig.dll");
    g_ilinkOrig = LoadLibraryW(full);
    if (!g_ilinkOrig)
    {
        IlinkLog(L"[ilink] orig load failed err=%lu path=%s", GetLastError(), full);
        return;
    }
    g_ilinkCreateNetworkManagerNoPB  = (Fn4)GetProcAddress(g_ilinkOrig, "CreateNetworkManagerNoPB");
    g_ilinkDestroyContextNoPB        = (Fn4)GetProcAddress(g_ilinkOrig, "DestroyContextNoPB");
    g_ilinkDestroyIlinkStreamContext = (Fn4)GetProcAddress(g_ilinkOrig, "DestroyIlinkStreamContext");
    g_ilinkDestroyLogManagerNoPB     = (Fn4)GetProcAddress(g_ilinkOrig, "DestroyLogManagerNoPB");
    g_ilinkDestroyNetworkManagerNoPB = (Fn4)GetProcAddress(g_ilinkOrig, "DestroyNetworkManagerNoPB");
    g_ilinkGetContextNoPB            = (Fn4)GetProcAddress(g_ilinkOrig, "GetContextNoPB");
    g_ilinkGetIlinkStreamContext     = (Fn4)GetProcAddress(g_ilinkOrig, "GetIlinkStreamContext");
    g_ilinkGetLogManagerNoPB         = (Fn4)GetProcAddress(g_ilinkOrig, "GetLogManagerNoPB");

    IlinkLog(L"[ilink] proxy ready orig=%p entries=%p %p %p %p %p %p %p %p",
            (void*)g_ilinkOrig,
            (void*)g_ilinkCreateNetworkManagerNoPB, (void*)g_ilinkDestroyContextNoPB,
            (void*)g_ilinkDestroyIlinkStreamContext, (void*)g_ilinkDestroyLogManagerNoPB,
            (void*)g_ilinkDestroyNetworkManagerNoPB, (void*)g_ilinkGetContextNoPB,
            (void*)g_ilinkGetIlinkStreamContext, (void*)g_ilinkGetLogManagerNoPB);
}

extern "C" __declspec(dllexport) void* __cdecl CreateNetworkManagerNoPB(void* a, void* b, void* c, void* d)
{
    return g_ilinkCreateNetworkManagerNoPB ? g_ilinkCreateNetworkManagerNoPB(a, b, c, d) : 0;
}
extern "C" __declspec(dllexport) void* __cdecl DestroyContextNoPB(void* a, void* b, void* c, void* d)
{
    return g_ilinkDestroyContextNoPB ? g_ilinkDestroyContextNoPB(a, b, c, d) : 0;
}
extern "C" __declspec(dllexport) void* __cdecl DestroyIlinkStreamContext(void* a, void* b, void* c, void* d)
{
    return g_ilinkDestroyIlinkStreamContext ? g_ilinkDestroyIlinkStreamContext(a, b, c, d) : 0;
}
extern "C" __declspec(dllexport) void* __cdecl DestroyLogManagerNoPB(void* a, void* b, void* c, void* d)
{
    return g_ilinkDestroyLogManagerNoPB ? g_ilinkDestroyLogManagerNoPB(a, b, c, d) : 0;
}
extern "C" __declspec(dllexport) void* __cdecl DestroyNetworkManagerNoPB(void* a, void* b, void* c, void* d)
{
    return g_ilinkDestroyNetworkManagerNoPB ? g_ilinkDestroyNetworkManagerNoPB(a, b, c, d) : 0;
}
extern "C" __declspec(dllexport) void* __cdecl GetContextNoPB(void* a, void* b, void* c, void* d)
{
    return g_ilinkGetContextNoPB ? g_ilinkGetContextNoPB(a, b, c, d) : 0;
}
extern "C" __declspec(dllexport) void* __cdecl GetIlinkStreamContext(void* a, void* b, void* c, void* d)
{
    return g_ilinkGetIlinkStreamContext ? g_ilinkGetIlinkStreamContext(a, b, c, d) : 0;
}
extern "C" __declspec(dllexport) void* __cdecl GetLogManagerNoPB(void* a, void* b, void* c, void* d)
{
    return g_ilinkGetLogManagerNoPB ? g_ilinkGetLogManagerNoPB(a, b, c, d) : 0;
}
