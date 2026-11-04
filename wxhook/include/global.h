#include <mutex>
#pragma once
#include <windows.h>
#include <string>
#include <cstdint>

// 前向声明，不需要完整类型
class HttpServer;



extern int g_receive_type;
extern int g_StartPort;
extern int g_MsgSendPort;
extern HMODULE g_hWeixinDll;
extern HMODULE g_hWeixinExe;


extern HANDLE g_hLoginMonitor;
extern HANDLE g_hAfterLoginInit;

extern DWORD g_MainThreadId;
extern DWORD 进程PID;
extern DWORD 父进程PID;
extern HWND  g_WeixinMainHwnd;
extern volatile uint64_t g_IsLogin;   // 0=未登录 1=已登录
extern volatile uint64_t g_getprofile;

extern volatile bool g_LoginMonitorRunning;
extern std::string g_CallBack_Url;
extern CRITICAL_SECTION g_dbMgrCriticalSection;
extern std::recursive_mutex g_clientCallMutex;   // 串行化 hook 对客户端的调用（sqlite/发送）

extern std::wstring g_AppDataDir;
extern std::wstring g_DocumentDir;
extern std::wstring g_UsersDir;
extern HMODULE g_hModule;

extern uint64_t g_MyModuleBase;
extern uint64_t g_MyModuleSize;
extern uint64_t g_MyModuleEnd;


struct SelfInfo_t
{
    std::string wxid;
    std::string alias;
    std::string nickname;
    std::string phone;
    std::string email;

    uint64_t qq;
    std::string proiv;
    std::string area;
    std::string signinfo;


};
// 全局唯一实例
extern SelfInfo_t SelfInfo;

#define WX_ADDR(offset) ((void*)((uintptr_t)g_hWeixinDll + (offset)))
#define XWECHAT_MAIN_CLAZZ_OFFSET            ((void*)((uintptr_t)g_hWeixinDll + 0xA83AB20))

inline std::wstring g_MyDir;

inline HttpServer* g_httpServer = nullptr;

inline uint64_t g_Patch_Revoke = 0x22D09E7;                      // 可被 offset_resolver 覆盖
inline uint64_t g_xlogHookTarget = 0x108678;                     // xlog 钩子目标（原来硬编码在 inline_weixin_dll_load.cpp）
inline uint64_t g_xwechatMainClazz = 0xA83AB20;                  // 主类对象地址


// 微信版本：0 = 4.1.10.27（原始适配），1 = 4.1.15.56（迁移中）
inline int g_WxVersion = 0;

inline size_t XWECHAT_SQLITE3_VFS_OFFSET = 0xA6C0490;            // 可被 offset_resolver 覆盖
inline size_t XWECHAT_SQLITE3_API_ROUTINES_OFFSET = 0x8BB0D38;   // 可被覆盖
inline size_t XWECHAT_SQLCIPHER_API_ROUTINES_OFFSET = 0x8BB1570; // 可被覆盖
inline size_t XWECHAT_SQLITE3_CODEC_GET_KEY_FUNC = 0x4EE64D0;    // 可被覆盖	//可以废弃不用

namespace offset
{
    inline uint64_t dec_pic_call = 0x493E70;
    inline uint64_t create_param2 = 0xDF40;
    inline uint64_t send_message = 0x1677A30;
    inline uint64_t param1_vtable = 0x84EC9C8; 

    inline uint64_t param2 = 0xA0CE0B0;
    inline uint64_t param2_1 = 0x8595F58;
    inline uint64_t param2_2 = 0x8595E98; 
    inline uint64_t param2_3 = 0x8595DD8; 
    inline uintptr_t txt_message_ctr = 0x6B2C30; 
    inline uintptr_t txt_message_vtbl = 0x8279358;
    inline uint64_t img_msg_vtbl = 0x84F96B8; 
    inline uint64_t img_msg_vtb2 = 0x84F9748;

    // ── 语音消息（4.1.10.27 实测）────────────────────────────────────
    // 微信自己的语音构造器：new(0x208) → [+0x00] = voice_msg_vtbl（外层包装 vtable）
    //                                    [+0x08] = 0x100000001
    //                                    [+0x10] = voice_msg_vtbl2（内层 vtable，真正的类型判别）
    // 消息类型字段：内层 +0x0C == 34 / 0x22 表示语音（判定函数 Weixin.dll+0xA4BBF0）
    // 内层字段（相对内层 = 对象 +0x10）：+0x140 commenturl、+0x180 aeskey、+0x1A0 length、
    //   +0x1A4 voicelength(ms)、+0x1A8 voiceformat、+0x1AC endflag、+0x1B0 cancelflag、
    //   +0x1B4 forwardflag、+0x1B8 voiceurl、+0x1D8 string（转 XML 时没用到的槽，本地 SILK 路径的头号嫌疑）
    // ⚠️ 两个 vtable 都是"数据目标"：按 offset_resolver.cpp:143-145 的闸门，
    //    数据目标永远用硬编码值（特征码只对代码目标生效），所以这里就是最终值。
    inline uint64_t voice_msg_ctr = 0xA203B0;      // 代码目标 → 可被特征码覆盖
    inline uint64_t voice_msg_vtbl = 0x82FCB68;    // 数据目标 → 永远硬编码
    inline uint64_t voice_msg_vtbl2 = 0x82FCBF8;   // 数据目标 → 永远硬编码
    // ⚠️ 上面三个是【解析/DB 侧】的语音类（0x208 字节，ctor 0xA203B0，唯一调用者 = 解析工厂 0xA1FB00）。
    //    发语音气泡用的是【发送侧】那一族（0x778 字节），见下面 4 个：

    // ── 发送侧语音消息（4.1.10.27 静态分析 + 实测，/SendVoiceMsg 用）────────
    //   真实发送链：0x54B02A0(录音状态机) → 0x6199D10 → 工厂 0x619A190 → 0x1649B50
    //   工厂签名（与调用点 0x619A1E5..0x619A1F6 逐条对齐）：
    //     factory(out[2] /*rcx: out[0]=内层 inner, out[1]=外层 outer*/,
    //             const std::string* 收件人 /*rdx*/,
    //             const std::string* str0   /*r8, 拷到 inner+0x708*/,
    //             const uint32_t*    时长ms /*r9, 取值 *r9 → inner+0x728*/,
    //             const void*        arg5   /*栈, 16B→inner+0x730, [0x10]→inner+0x740,
    //                                          +0x18 的 std::string → inner+0x748*/)
    //   工厂内部：new(0x778) → [+0x00]=外层 vtable、[+0x08]=tag 0x100000001、
    //             [+0x18]=inner、[+0x20]=控制块（自引用 shared_ptr）→ 调内层 ctor。
    //   内层 ctor 只做"拷贝字符串 + 存标量"，并调基类 ctor 0x6B2D30
    //   （基类 ctor 里用 0x4DF240 生成的 GUID 写 inner+0x6A8）。
    inline uint64_t voice_send_factory = 0x619A190;   // 代码目标（工厂）
    inline uint64_t voice_send_ctr     = 0x619B3B0;   // 代码目标（内层 ctor）
    inline uint64_t voice_send_outer_vtbl = 0x8DCFF98;// 数据目标（外层包装 vtable）
    inline uint64_t voice_send_inner_vtbl = 0x8DD0028;// 数据目标（内层 vtable，类型判别）
    inline uint64_t voice_send_inner_dtor = 0x619B7C0;// 数据目标（内层 vtable[0]，预检用）
    inline uint64_t voice_send_outer_slot0 = 0xA7F0;  // 数据目标（外层 vtable[0]，预检用）

    // ── MOMENT-SEND：/SendMoment（发朋友圈）────────────────────────────────
    //  逆向结论（4.1.10.27，RVA 相对 Weixin.dll 的 0x180000000 基址）：
    //    0x04EB0B90  构造 mmsnspost 请求并 CoCgiSendRequest 发送（唯一调用点在 0x04EAF2EA）
    //    5 个参数：rcx=输出对象 P1（0x38 字节起，栈上）、rdx=P2（单例虚方法返回）、
    //              r8=P3（栈结构）、r9=P4（std::string）、栈上第 5 参=P5
    //    P5 = { DWORD type; DWORD flag; std::string text; void* extra; }
    //        type=0（普通朋友圈），flag=0x1D4C0（调用方常量 0x1D4C000000000）
    //    P2 来源：0x180410C0 = { mov rax,[rip+0xA7F9A59]; ret } 读全局单例，
    //             再 call [[singleton]+0x10] 取虚方法返回值
    inline uint64_t mmsnspost_ctor    = 0x04EB0B90;  // mmsnspost 请求构造 + 发送
    // 0x180410C0: mov rax,[rip+0xA7F9A59]; ret
    //   下一条指令 RVA = 0x410C7，目标 = 0x410C7 + 0xA7F9A59 = 0x0A83AB20
    inline uint64_t sns_singleton_ptr = 0x0A83AB20;  // SNS 管理器全局单例指针
    // P3 是 0x1A0 字节对象，必须先调这个构造函数（它把 vtable 写进 +0x00）
    inline uint64_t moment_p3_ctor    = 0x04DA2BB0;  // P3 构造函数
}


//4.1.5.30  xml
namespace Offsets
{
    inline constexpr uintptr_t IMAGE_FIELD_VTABLE = 0x80D1098;          //ok  41930 ? 41923
    inline constexpr uintptr_t IMAGE_FIELD_VTABLE2 = 0x80D1128;         //ok
    inline constexpr uintptr_t IMAGE_DATA_VTABLE = 0x7415D28;
    inline constexpr uintptr_t IMAGE_DATA_VTABLE2 = 0x7415DB8;
    inline constexpr uintptr_t VIDEO_FIELD_VTABLE = 0x750C7F8;
    inline constexpr uintptr_t VIDEO_FIELD_VTABLE2 = 0x750C888;
    inline constexpr uintptr_t ANIMATION_FIELD_VTABLE = 0x750CC18;
    inline constexpr uintptr_t ANIMATION_FIELD_VTABLE2 = 0x750CCA8;
    inline constexpr uintptr_t MESSAGE_STRUCT_VTABLE = 0x76BD388;
    inline constexpr uintptr_t MESSAGE_STRUCT_VTABLE2 = 0x76BD338;
    inline constexpr uintptr_t MESSAGE_PARAM_VTABLE = 0x76BCF38;
    inline constexpr uintptr_t FORWARD_XML_CALL = 0x1CF3D20;
}



