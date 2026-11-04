#include <cstdint>
#include <cstdio>
#include <string>
#include <Windows.h>
#include <winternl.h>
#include <cstring>
#include <sstream>

#include "http_server.h"
#include "Hook_Method.h"

#include "global.h"
#include "offset_resolver.h"

// 前置声明（不 include db_mgr.h：那会带进 json/httplib，和 winsock 头顺序打架）
namespace xmgr { void StartEarlyArmThread(); }
#include <MinHook.h>
#include "tools.h"
#include "HookManager.h"
#include "json.hpp"
#include "wx_ini_reader.h"
#include "inline_weixin_dll_load.h"
#include "hook_xlog.h"
#include "wx_send.h"
#include "VoiceUploadProbe.h"



using json = nlohmann::json;

typedef NTSTATUS(NTAPI* PFN_NtQueryInformationProcess)(
    HANDLE,
    PROCESSINFOCLASS,
    PVOID,
    ULONG,
    PULONG
    );



DWORD GetParentProcessId()
{
    PFN_NtQueryInformationProcess NtQueryInformationProcess =
        (PFN_NtQueryInformationProcess)GetProcAddress(
            GetModuleHandleW(L"ntdll.dll"),
            "NtQueryInformationProcess"
        );

    if (!NtQueryInformationProcess)
        return 0;

    PROCESS_BASIC_INFORMATION pbi = { 0 };

    NTSTATUS status = NtQueryInformationProcess(
        GetCurrentProcess(),
        ProcessBasicInformation,
        &pbi,
        sizeof(pbi),
        nullptr
    );

    if (status != 0)
        return 0;

    return (DWORD)(ULONG_PTR)pbi.Reserved3;
}


// ── 版本检测：按 Weixin.dll 所在目录名判断（4.1.15.56 / 4.1.10.27 等）──
//    新版迁移中：目前只把 sqlite API 表换成 4.1.15.56 已确认的值，
//    其余依赖旧偏移的 hook（防撤回 / 语音探针 / 眼睛）在新版一律不装。
static void DetectWxVersion()
{
    wchar_t path[MAX_PATH] = { 0 };
    if (g_hWeixinDll != nullptr) GetModuleFileNameW(g_hWeixinDll, path, MAX_PATH);
    if (wcsstr(path, L"4.1.15") != nullptr) {
        g_WxVersion = 1;
        XWECHAT_SQLITE3_API_ROUTINES_OFFSET = 0x9A907C0;   // 4.1.15.56 已确认
        OutputDebugStringA("[version] 检测到 4.1.15.56：DB-only 模式（api 表已切换）\n");
    } else {
        g_WxVersion = 0;
        OutputDebugStringA("[version] 按 4.1.10.27 偏移运行\n");
    }
}
DWORD WINAPI AfterLoginInitThread(LPVOID)
{
    // 等待登录成功
    while (g_IsLogin != 1)
    {
        Sleep(300);
    }

    return 0;
}

// 过低版本
void Patch_Low_Version()
{
    // XWECHAT_MAIN_CLAZZ_OFFSET 4.1.8.67
    DWORD_PTR baseAddress = (DWORD_PTR)g_hWeixinDll + reinterpret_cast<uintptr_t>(XWECHAT_MAIN_CLAZZ_OFFSET);

    DWORD_PTR* pPointer = (DWORD_PTR*)baseAddress;
    if (*pPointer == NULL) {
        // 处理空指针情况
        return;
    }

    DWORD_PTR targetAddress = (*pPointer) + 0xB8 + 0x90;        //80  = 00000000F2541843



    // 直接通过指针修改
    BYTE* pTarget = (BYTE*)targetAddress;

    // 修改内存保护属性
    DWORD oldProtect;
    VirtualProtect(pTarget, 4, PAGE_EXECUTE_READWRITE, &oldProtect);

    *(pTarget) = 0x43;      // 低位字节 = 67
    *(pTarget + 1) = 0x18;
    *(pTarget + 2) = 0x54;  // 高位字节
    *(pTarget + 3) = 0xF2;  

    // 恢复保护属性
    VirtualProtect(pTarget, 4, oldProtect, &oldProtect);
}


void Patch_Low_Version_m2()
{
    // 4.1.8.67 addresses
    struct PatchInfo {
        DWORD_PTR addr;
        BYTE bytes[4];
    };

    // F2510201
    // F2541843
    PatchInfo patches[] = {
        { (DWORD_PTR)g_hWeixinExe + 0x36E2, { 0x43, 0x19, 0x6C, 0xF2 } },
        { (DWORD_PTR)g_hWeixinDll + 0x18EB, { 0x43, 0x19, 0x6C, 0xF2 } },
        { (DWORD_PTR)g_hWeixinDll + 0x1B0E, { 0x43, 0x19, 0x6C, 0xF2 } },
        { (DWORD_PTR)g_hWeixinDll + 0x204B, { 0x43, 0x19, 0x6C, 0xF2 } },
        { (DWORD_PTR)g_hWeixinDll + 0xDE4C33, { 0x43, 0x19, 0x6C, 0xF2 } },
        { (DWORD_PTR)g_hWeixinDll + 0x2AC9481, { 0x43, 0x19, 0x6C, 0xF2 } },
        { (DWORD_PTR)g_hWeixinDll + 0x3248CE9, { 0x43, 0x19, 0x6C, 0xF2 } },
        { (DWORD_PTR)g_hWeixinDll + 0x379D66E, { 0x43, 0x19, 0x6C, 0xF2 } },
        { (DWORD_PTR)g_hWeixinExe + 0x204FA0, { 0x43, 0x19, 0x6C, 0xF2 } },
        { (DWORD_PTR)g_hWeixinDll + 0xDE540C, { 0x43, 0x19, 0x6C, 0xF2 } }, 
        { (DWORD_PTR)g_hWeixinDll + 0xA3518D0, { 0x43, 0x19, 0x6C, 0xF2 } },
        { (DWORD_PTR)g_hWeixinDll + 0xA3518D4, { 0x43, 0x19, 0x6C, 0xF2 } }
    };

    DWORD oldProtect;
    for (int i = 0; i < 3; i++) {
        VirtualProtect((LPVOID)patches[i].addr, 4, PAGE_EXECUTE_READWRITE, &oldProtect);
        memcpy((void*)patches[i].addr, patches[i].bytes, 4);
        VirtualProtect((LPVOID)patches[i].addr, 4, oldProtect, &oldProtect);
    }

}


//启用防撤回
void Patch_Revoke()
{
    // 计算目标地址
    DWORD_PTR targetAddress = (DWORD_PTR)g_hWeixinDll + g_Patch_Revoke;

    // 直接通过指针修改
    BYTE* pTarget = (BYTE*)targetAddress;

    // 修改内存保护属性
    DWORD oldProtect;
    VirtualProtect(pTarget, 2, PAGE_EXECUTE_READWRITE, &oldProtect);

    *pTarget = 0x90;           // 第一个字节改为 nop
    *(pTarget + 1) = 0xE9;     // 第二个字节改为 jmp 操作码

    // 恢复保护属性
    VirtualProtect(pTarget, 2, oldProtect, &oldProtect);
}


using FnWcProbe = void(__fastcall*)(void* out_buffer, void* out_len, void* input_param);
FnWcProbe g_Original = nullptr;





void Evt_WeixinLoad()
{
    g_hWeixinDll = GetModuleHandleW(L"Weixin.dll");
    if (!g_hWeixinDll)
    {
        return;
    }

#ifdef _DEBUG
    char debugMsg[256];
    snprintf(debugMsg, sizeof(debugMsg),"[Evt_WeixinLoad] Weixin.dll: 0x%p\n",g_hWeixinDll);
    OutputDebugStringA(debugMsg);
#endif


    进程PID = GetCurrentProcessId();
    父进程PID = GetParentProcessId();

    //过低版本 4.1.8.67
    //Patch_Low_Version_m2();

    //get base DirPath
    //InitStandardPaths();
    
    DetectWxVersion();

    // ── 二分：新版先只起 HTTP 服务，其余初始化全部跳过 ──
    if (g_WxVersion != 0) {
        if (!g_httpServer) {
            g_httpServer = new HttpServer();
            g_httpServer->Start("127.0.0.1", g_StartPort);
        }
        xmgr::StartEarlyArmThread();   // 二分第 2 步：加回 DB 钩子（open16/prepare）
        OutputDebugStringA("[init] 新版：仅 HTTP 服务（二分模式）\n");
        return;
    }

    if (g_WxVersion == 0) Patch_Revoke();   // 防撤回补丁：旧偏移，新版跳过

    // ── VOICE-DUMP：只读埋点（默认关）──────────────────────────────
    // 起一条一次性线程，延迟 1.5s 再挂 send_message / 语音构造器的只读 detour。
    // 刻意不在这里直接挂：本函数跑在 DllMain 里（loader lock），MinHook 挂钩会
    // 挂起线程 —— 万一撞上就卡启动。挂不上最多是没数据，绝不影响微信。
    if (g_WxVersion == 0) WeixinSend::StartVoiceDumpHookThread();   // 语音探针：旧偏移

    // ── VUPROBE：语音"上传"链路只读埋点（默认关，开关文件 hook-vuprobe.on）
    // 挂的是 CDN 上传入口 / uploadvoice CGI / 语音消息工厂等候选点；
    // 只读 dump 入参、返回值、SILK 魔数、本地路径，绝不改控制流。
    if (g_WxVersion == 0) VuProbe::StartThread();   // 眼睛探针：旧偏移


    // 创建并启动HTTP服务器
    if (!g_httpServer)
    {
        g_httpServer = new HttpServer();
        // ⚠️ 安全：只监听本机回环地址。
        // 原来写的是 "0.0.0.0" —— 那等于把 /SendTextMsg（以本账号发消息）、
        // /QueryDB/execute（任意 SQL 读改微信数据库）暴露给**同一局域网内任何人**，且无鉴权。
        // 接入层（wx-bridge）在同一台机器上，用 127.0.0.1 足够；
        // 若确实需要远程访问，请自行加反向代理 + 鉴权，不要直接改回 0.0.0.0。
        g_httpServer->Start("127.0.0.1", g_StartPort);
    }
#ifdef _DEBUG
    //xLog 日志
    // 启动时用特征模式重新定位所有偏移（微信升级后自动适配；失败则回退硬编码）
        ResolveOffsets();
        Hook_Call(WeixinDll_Offset(g_xlogHookTarget), 5, hook::MyCallHandler_xLog);
#endif

    // 数据库钩子早装（Release 也要跑）：登录前就把 open16/prepare 挂好，
    // 否则客户端秒登录时 DB 在装钩子之前就打开了，句柄永远登记不上。
    if (g_WxVersion == 0) xmgr::StartEarlyArmThread();   // 新版先空跑（不装 DB 钩子）验证稳定性
    

    
    //取回调URL
    if (g_WxVersion == 0) GetWxRecvUrl();   // 新版偏移未适配：回调地址由命令行给，够用
}



