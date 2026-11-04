#pragma once
#include <string>

namespace WeixinSend
{
    void SendImage(const std::string& wxid, const std::string& imgPath);
    // atlist：真 @ 用。填被 @ 的人的 wxid（多个用英文逗号分隔），对方才会收到提醒。
    // 结构体布局自动校验报告（JSON 文本，供 /Debug/StructCheck 用）
    std::string StructCheckReportJson();

    void SendText(const std::string& wxidorgid, const std::string& msg,
                  const std::string& atlist = std::string());
    void DecodePic(const std::string& enc_pic_path, const std::string& dec_pic_path);

    // ══════════════════════════════════════════════════════════════════
    //  VOICE-SEND：/SendVoiceMsg —— 把本地 SILK 发成真语音气泡(type 34)
    //
    //  返回值：0 = 已交给发送器（异步上传由微信自己做）；<0 = 错误码：
    //    -1001 特性开关关着（默认）      -1002 参数不合法
    //    -1003 拿不到 Weixin.dll base    -1004 SILK 文件读不了/魔数不对
    //    -1005 造对象前布局预检没过      -1006 工厂调用异常
    //    -1007 造对象后逐字段校验没过    -1008 send_message 抛异常
    //    -1009 上一条还在发（串行化）
    //
    //  str0Mode（inner+0x708 那个 std::string 装什么，微信没钉死语义）：
    //    "path"  = SILK 绝对路径（默认；头号假设）
    //    "bytes" = SILK 原始字节（缺 0x02 前缀自动补上）
    //    "raw"   = 直接用 str0Raw 给的字符串
    //  detailJson：可选，返回一段诊断 JSON 对象文本（给 /SendVoiceMsg 用）
    //
    //  开关：<Weixin.exe 目录>\hook-voice-send.on 存在 = 开；
    //        或 POST /Debug/VoiceSend {"on":true}（运行时，优先级更高）
    //  日志：<Weixin.exe 目录>\voice-send.log
    // ══════════════════════════════════════════════════════════════════
    int SendVoice(const std::string& wxidorgid, const std::string& silkPath,
                  unsigned int durationMs, const std::string& str0Mode,
                  const std::string& str0Raw, std::string* detailJson);

    void VoiceSendSetEnabled(bool on);
    bool VoiceSendIsEnabled();
    std::string VoiceSendReportJson();

    // ══════════════════════════════════════════════════════════════════
    //  VOICE-DUMP：只读埋点（默认关）
    //  目的：实测"发语音时，本地 SILK 文件路径放在消息对象的哪个偏移"。
    //  开关文件：<Weixin.exe 目录>\hook-voicedump.on（存在 = 开）；也可走 /Debug/VoiceDump。
    //  红线：不发送、不改对象、不改任何既有行为；探针异常全部吞掉。
    // ══════════════════════════════════════════════════════════════════
    void StartVoiceDumpHookThread();     // 启动后延迟挂钩子（刻意不在 DllMain 的 loader lock 里挂）
    void VoiceDumpSetEnabled(bool on);   // 运行时开关（内存态，优先级高于开关文件）
    void VoiceDumpNow();                 // 立刻再 dump 一次最近捕获的对象（可能已释放，只读+吞异常）
    std::string VoiceDumpReportJson();   // 当前状态 + 最近一次 dump 全文（JSON）
}
