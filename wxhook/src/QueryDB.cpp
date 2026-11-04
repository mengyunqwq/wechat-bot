#include "CrashLog.h"
#include "httplib.h"
#include "json.hpp"
#include <windows.h>
#include "tools.h"
#include "global.h"
#include "db_mgr.h"
#include "SundaySearch.h"

#include "QueryDB.h"
#include "wx_send.h"
#include "VoiceUploadProbe.h"


using json = nlohmann::json;

// ── 调试辅助（用 IsBadReadPtr 守卫，不用 SEH：__try 不能和带析构的 C++ 对象共存）──
static size_t SafeModuleSize(size_t base)
{
    if (IsBadReadPtr((LPVOID)base, sizeof(IMAGE_DOS_HEADER))) return 0;
    auto dos = (IMAGE_DOS_HEADER*)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return 0;
    if (IsBadReadPtr((LPVOID)(base + dos->e_lfanew), sizeof(IMAGE_NT_HEADERS))) return 0;
    auto nt = (IMAGE_NT_HEADERS*)(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return 0;
    return nt->OptionalHeader.SizeOfImage;
}

static int SafeCountPtrsInModule(size_t base, size_t modSize, uint64_t* out8)
{
    const size_t addr = base + XWECHAT_SQLITE3_API_ROUTINES_OFFSET;
    if (IsBadReadPtr((LPVOID)addr, 8 * sizeof(void*))) return -1;
    auto** p = (void**)addr;
    int inMod = 0;
    for (int i = 0; i < 8; i++) {
        uint64_t v = (uint64_t)p[i];
        out8[i] = v;
        if (modSize && v > base && v < base + modSize) inMod++;
    }
    return inMod;
}

// ScanPattern 内部用 ReadProcessMemory（读不了就跳过），本身是安全的
static int SafeScanHits(size_t base)
{
    std::vector<LPVOID> hits;
    size_t vfsVal = base + XWECHAT_SQLITE3_VFS_OFFSET;
    ScanPattern(GetCurrentProcess(), (BYTE*)&vfsVal, sizeof(LPVOID), hits);
    return (int)hits.size();
}
//static xmgr::DatabaseMgr& g_dbMgr = xmgr::DatabaseMgr::getInstance();

static std::string BytesToHex(const uint8_t* data, size_t len)
{
    static const char hex[] = "0123456789ABCDEF";
    std::string out;
    out.reserve(len * 2);

    for (size_t i = 0; i < len; ++i)
    {
        out.push_back(hex[data[i] >> 4]);
        out.push_back(hex[data[i] & 0x0F]);
    }
    return out;
}


void Route_QueryDB(httplib::Server& svr)
{
    svr.Post("/QueryDB/execute", [](const httplib::Request& req, httplib::Response& res)
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
                resp["msg"] = "invalid json";
                res.set_content(resp.dump(), "application/json");
                return;
            }


            //初始化数据库管理器
            //OutputDebugStringA("[QueryDB] 初始化数据库管理器\n");
            xmgr::DatabaseMgr& g_dbMgr = xmgr::DatabaseMgr::getInstance();
            //OutputDebugStringA("[QueryDB] 初始化完成\n");


            std::string optDbName = reqJson.value("optDbName", "");         // MicroMsg.db
            std::string sql = reqJson.value("SQL", "");                     // 查询语句   SELECT * FROM ChatRoom LIMIT 10

            crashlog::Note("DB execute ENTER db=%s sql=%.40s", optDbName.c_str(), sql.c_str());
            auto result = g_dbMgr.execute(optDbName, sql);
            crashlog::Note("DB execute RETURN db=%s", optDbName.c_str());



            // 使用临界区保护数据库访问
            /*
            EnterCriticalSection(&g_dbMgrCriticalSection);
            try {
                auto start = std::chrono::high_resolution_clock::now();
                auto result = g_dbMgr.execute(optDbName, sql);
                auto end = std::chrono::high_resolution_clock::now();

                auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);

                resp["ret"] = result.value("status", 0);
                resp["msg"] = result.value("desc", "");
                resp["data"] = result.value("data", json::array());
                resp["duration_ms"] = duration.count();

                // 慢查询日志
                if (duration.count() > 1000) {
                    OutputDebugStringA(format_string("Slow query: %lldms - %s", duration.count(), sql.substr(0, 100)).c_str());
                }

            }
            catch (const std::exception& e) {
                resp["ret"] = -500;
                resp["msg"] = std::string("Database error: ") + e.what();
            }
            LeaveCriticalSection(&g_dbMgrCriticalSection);
            */


            res.set_content(result.dump(4, ' ', false), "application/json");


            //res.set_content(resp.dump(), "application/json");
        });
    svr.Post("/QueryDB/GetAllDBName", [](const httplib::Request& req, httplib::Response& res)
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
                resp["msg"] = "invalid json";
                res.set_content(resp.dump(), "application/json");
                return;
            }


            //初始化数据库管理器
            //OutputDebugStringA("[QueryDB] 初始化数据库管理器\n");
            xmgr::DatabaseMgr& g_dbMgr = xmgr::DatabaseMgr::getInstance();
            //OutputDebugStringA("[QueryDB] 初始化完成\n");

            // 方式2：获取所有数据库信息
            auto dbInfo = g_dbMgr.getDatabaseInfo();
            // 返回：{"dbName":"MicroMsg.db","dbHandle":140736870540544}

            res.set_content(dbInfo.dump(4, ' ', false), "application/json");


            //res.set_content(resp.dump(), "application/json");
        });

    // 添加状态查询接口
    svr.Get("/QueryDB/status", [](const httplib::Request&, httplib::Response& res) {
        json resp;
        resp["IsLogin"] = g_IsLogin;
        resp["hWeixin"] = (uint64_t)g_hWeixinDll;
        res.set_content(resp.dump(4, ' ', false), "application/json");
        });

    // ── 调试路由：判断偏移对不对、扫描能不能命中 ──────────────────
    // 用来定位 "GetAllDBName 返回 []" 的根因：是偏移错了，还是扫描没命中，
    // 还是客户端根本没打开数据库。
	// 结构体布局自动校验报告（发送路径的 TextMessage / WeixinString）
	// 布局一旦被微信改掉，这里会显示 probeOk=false / liveOk=false，便于第一时间发现。
	svr.Get("/Debug/StructCheck", [](const httplib::Request&, httplib::Response& res) {
		res.set_content(WeixinSend::StructCheckReportJson(), "application/json");
		});

	// ── VOICE-DUMP 只读埋点：开关 + 状态 + 最近一次 dump 全文 ──────────
	//   GET  /Debug/VoiceDump                → 查状态
	//   POST /Debug/VoiceDump {"on":true}    → 运行时开（{"on":false} 关）
	//   POST /Debug/VoiceDump {"dump":true}  → 立刻再 dump 一次最近捕获的对象
	// 只读诊断：不发消息、不改对象、不改任何既有行为。
	svr.Get("/Debug/VoiceDump", [](const httplib::Request&, httplib::Response& res) {
		res.set_content(WeixinSend::VoiceDumpReportJson(), "application/json");
		});
	svr.Post("/Debug/VoiceDump", [](const httplib::Request& req, httplib::Response& res) {
		bool on = false, hasOn = false, dumpNow = false;
		try {
			if (!req.body.empty()) {
				json r = json::parse(req.body);
				if (r.contains("on") && r["on"].is_boolean()) { on = r["on"].get<bool>(); hasOn = true; }
				if (r.contains("dump") && r["dump"].is_boolean()) dumpNow = r["dump"].get<bool>();
			}
		} catch (...) {
			// body 不是合法 JSON：不当错误，退化成"只查状态"
		}
		if (hasOn) WeixinSend::VoiceDumpSetEnabled(on);
		if (dumpNow) WeixinSend::VoiceDumpNow();
		res.set_content(WeixinSend::VoiceDumpReportJson(), "application/json");
		});

	// ── VUPROBE 只读埋点：语音"上传"链路（CDN 上传入口 / uploadvoice CGI /
	//    语音消息工厂）。默认关；只读 dump，不发消息、不改对象、不改行为。
	//   GET  /Debug/VuProbe               → 查状态
	//   POST /Debug/VuProbe {"on":true}   → 运行时开（{"on":false} 关）
	svr.Get("/Debug/VuProbe", [](const httplib::Request&, httplib::Response& res) {
		res.set_content(VuProbe::ReportJson(), "application/json");
		});
	svr.Post("/Debug/VuProbe", [](const httplib::Request& req, httplib::Response& res) {
		bool on = false, hasOn = false;
		try {
			if (!req.body.empty()) {
				json r = json::parse(req.body);
				if (r.contains("on") && r["on"].is_boolean()) { on = r["on"].get<bool>(); hasOn = true; }
			}
		} catch (...) {
			// body 不是合法 JSON：退化成"只查状态"
		}
		if (hasOn) VuProbe::SetEnabled(on);
		res.set_content(VuProbe::ReportJson(), "application/json");
		});

    // ── DB-RESCAN 诊断路由：句柄注册表快照 / 触发一次取名扫描 ──────────────
    //   GET  /Debug/DBRescan                → **纯只读**快照（库名、句柄、连续失败次数、
    //                                          最后一次成功多久以前、扫描次数/上次扫描时间）
    //   POST /Debug/DBRescan {"force":true} → 触发一次取名扫描（**带 30 秒节流**；
    //                                          节流窗口内返回"太快了"而不是硬扫）
    // 用途：修掉"数据库句柄丢失"缺陷后（见 xdb/db_mgr.cpp 顶部 db_registry 说明），
    //       这是现场诊断入口 —— 桥报 "get database handle ... failed" 时先看这里。
    // 红线：不发消息、不改库、不主动探测句柄（不发 SELECT 1、不用 SEH）。
    // ── API 表诊断：谁是 null / 谁不在模块内 / 钩子装了没 ──────────
    //   用途：区分「钩子没装上」和「钩子装了但入口不对」。
    //   典型现场：registry 里 prepare 抓到的句柄 db 名为空 → 查 db_filename 槽位。
    svr.Get("/Debug/ApiTable", [](const httplib::Request&, httplib::Response& res) {
        res.set_content(xmgr::DatabaseMgr::getInstance().apiTableReport().dump(2, ' ', false),
                        "application/json");
        });

    svr.Get("/Debug/DBRescan", [](const httplib::Request&, httplib::Response& res) {
        res.set_content(xmgr::DatabaseMgr::getInstance().dbRescanReport().dump(2, ' ', false),
                        "application/json");
        });
    svr.Post("/Debug/DBRescan", [](const httplib::Request& req, httplib::Response& res) {
        bool force = false;
        try {
            if (!req.body.empty()) {
                json r = json::parse(req.body);
                if (r.contains("force") && r["force"].is_boolean()) force = r["force"].get<bool>();
            }
        } catch (...) {
            // body 不是合法 JSON：退化成"只查状态"
        }
        xmgr::DatabaseMgr& mgr = xmgr::DatabaseMgr::getInstance();
        res.set_content((force ? mgr.dbRescanForce() : mgr.dbRescanReport()).dump(2, ' ', false),
                        "application/json");
        });

    svr.Get("/QueryDB/debug", [](const httplib::Request&, httplib::Response& res) {
        json j;
        const size_t base = (size_t)g_hWeixinDll;
        j["base"] = (uint64_t)base;
        j["IsLogin"] = g_IsLogin;

        const size_t modSize = SafeModuleSize(base);
        j["module_size"] = (uint64_t)modSize;

        // ① 校验 sqlite3_api_routines 偏移：结构体开头是一串函数指针，
        //    偏移正确的话它们应该全部落在 Weixin.dll 代码段内。
        const size_t rtAddr = base + XWECHAT_SQLITE3_API_ROUTINES_OFFSET;
        j["api_routines_addr"] = (uint64_t)rtAddr;
        uint64_t ptrs[8] = { 0 };
        const int inMod = SafeCountPtrsInModule(base, modSize, ptrs);
        json jp = json::array();
        for (int i = 0; i < 8; i++) jp.push_back(ptrs[i]);
        j["api_first_ptrs"] = jp;
        j["api_ptrs_in_module"] = inMod;          // 期望 8

        // ② VFS 偏移处的值
        const size_t vfsAddr = base + XWECHAT_SQLITE3_VFS_OFFSET;
        j["vfs_addr"] = (uint64_t)vfsAddr;
        j["vfs_value"] = IsBadReadPtr((LPVOID)vfsAddr, sizeof(void*)) ? 0 : (uint64_t)*(void**)vfsAddr;

        // ③ 注册表概况（**不再跑地址空间扫描、不再对候选句柄 prepare 试探**）
        //    原来的 ③/③b 每次调用都做两遍全地址空间扫描 + 对候选句柄 prepare 探测：
        //    · 又慢又危险（桥一催就越扫越慢、还会摸到假句柄）
        //    · 是"客户端启动被拖到 3 分钟"的直接原因之一
        //    现在只看注册表（prepare/open_v2 钩子的真实记录）+ 缓存，全部只读。
        {
            xmgr::DatabaseMgr& mgr = xmgr::DatabaseMgr::getInstance();
            json reg = json::parse(mgr.dbRescanReport().dump());
            j["registry"] = reg["registry"];
            j["name_pass"] = reg["name_pass"];
            j["counters"] = reg["counters"];
            j["hooks"] = reg["hooks"];
            j["db_count"] = reg["db_count"];
        }

        // ④ 句柄表（库名 → 句柄）
        j["dbs"] = xmgr::DatabaseMgr::getInstance().getDatabaseInfo();
        res.set_content(j.dump(2, ' ', false), "application/json");
        });


}
