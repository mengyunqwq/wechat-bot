#pragma once
#include "httplib.h"

// ═════════════════════════════════════════════════════════════════════════════
//  /SendVoiceMsg —— 把一段本地 SILK 发成真正的微信语音气泡（type 34）
//
//  请求（与 /SendImgMsg 同风格）：
//    { "wxidorgid": "<群/人>", "path": "<本地 SILK 绝对路径>" }
//  可选：
//    "durationMs": <毫秒>      不给就从 SILK 帧头估（微信按 20ms/帧 折算）
//    "str0Mode":  "path" | "bytes" | "raw"   默认 "path"
//    "str0Raw":   str0Mode=="raw" 时的字面串
//  返回：{ "ret": 0|错误码, "retmsg": "...", "diag": {...} }
//
//  默认关（安全第一）：开关关着时直接返回 ret=-1001，一个字节都不碰客户端内存。
//    开：建 <Weixin.exe 目录>\hook-voice-send.on，或 POST /Debug/VoiceSend {"on":true}
//  日志：<Weixin.exe 目录>\voice-send.log（每次调用一行完整记录）
// ═════════════════════════════════════════════════════════════════════════════
void Route_SendVoiceMsg(httplib::Server& svr);
