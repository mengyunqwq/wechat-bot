// ═════════════════════════════════════════════════════════════════════════════
//  SendVoiceMsg.cpp —— /SendVoiceMsg 路由（薄壳；实现全在 wx_send.cpp 的
//  WeixinSend::SendVoice 里，与 /SendImgMsg 的分层方式一致）
//
//  与既有路由的关系：纯新增，不改 /SendTextMsg /SendImgMsg /QueryDB/* /Debug/* 行为。
//  默认关：开关关着时 SendVoice 直接返回 -1001，不碰客户端内存。
// ═════════════════════════════════════════════════════════════════════════════
#include "httplib.h"
#include "json.hpp"
#include <windows.h>
#include <string>
#include "wx_send.h"
#include "SendVoiceMsg.h"

using json = nlohmann::json;

void Route_SendVoiceMsg(httplib::Server& svr)
{
    // ── 发语音：{ "wxidorgid": "...", "path": "...", [durationMs], [str0Mode], [str0Raw] }
    svr.Post("/SendVoiceMsg", [](const httplib::Request& req, httplib::Response& res)
        {
            json reqJson;
            json resp;

            try
            {
                reqJson = json::parse(req.body);
            }
            catch (...)
            {
                resp["ret"] = -1;
                resp["retmsg"] = "invalid json";
                res.set_content(resp.dump(), "application/json");
                return;
            }

            std::string wxidorgid = reqJson.value("wxidorgid", "");
            std::string path = reqJson.value("path", "");
            std::string str0Mode = reqJson.value("str0Mode", "path");
            std::string str0Raw = reqJson.value("str0Raw", "");

            unsigned int durationMs = 0;
            if (reqJson.contains("durationMs") && reqJson["durationMs"].is_number())
            {
                long long d = reqJson["durationMs"].get<long long>();
                durationMs = (d > 0) ? (unsigned int)d : 0u;
            }

            std::string diag = "{}";
            int ret = WeixinSend::SendVoice(wxidorgid, path, durationMs, str0Mode, str0Raw, &diag);

            resp["ret"] = ret;
            resp["retmsg"] = (ret == 0) ? "success" : "voice send failed";
            try
            {
                resp["diag"] = json::parse(diag);
            }
            catch (...)
            {
                resp["diag"] = diag;
            }

            res.set_content(resp.dump(), "application/json");
        });

    // ── 开关/状态：GET 看状态；POST {"on":true|false} 运行时开关（优先级高于开关文件）
    svr.Get("/Debug/VoiceSend", [](const httplib::Request&, httplib::Response& res)
        {
            res.set_content(WeixinSend::VoiceSendReportJson(), "application/json");
        });

    svr.Post("/Debug/VoiceSend", [](const httplib::Request& req, httplib::Response& res)
        {
            bool on = WeixinSend::VoiceSendIsEnabled();
            try
            {
                json j = json::parse(req.body);
                if (j.contains("on") && j["on"].is_boolean())
                    on = j["on"].get<bool>();
            }
            catch (...)
            {
                // body 不是 JSON 时也接受纯文本 on/off/true/false
                const std::string& b = req.body;
                if (b.find("true") != std::string::npos || b.find("on") != std::string::npos)
                    on = true;
                else if (b.find("false") != std::string::npos || b.find("off") != std::string::npos)
                    on = false;
            }

            WeixinSend::VoiceSendSetEnabled(on);
            res.set_content(WeixinSend::VoiceSendReportJson(), "application/json");
        });
}
