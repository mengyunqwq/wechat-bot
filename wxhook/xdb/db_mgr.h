#pragma once
#include "sqlite3.h"
#include <json/json.hpp>
#include <iostream>
#include <map>
#include <mutex>

namespace xmgr {
    // 尽早触发 DatabaseMgr 构造（起线程 + 延迟；DLL 加载时调用一次）
    void StartEarlyInitThread();
    void StartEarlyArmThread();   // 登录前就装钩子（open16/prepare）
    class DatabaseMgr
    {
    public:
        static DatabaseMgr& getInstance() {
            static DatabaseMgr cls;
            return cls;
        }
        const std::map<std::string, LPVOID>& searchDatabases();
        LPVOID getDatabaseHandle(const std::string& dbname);
        std::string codec_get_key(const std::string& dbname);
        std::string codec_get_key(sqlite3* db);
        nlohmann::ordered_json execute(const std::string& dbname, const std::string& sql);
        nlohmann::ordered_json execute(sqlite3* db, const std::string& sql);
        int backup(const std::string& dbname, const std::string& out_path);
        int backup(sqlite3* db, const std::string& out_path);
        void backup_xprogress(int remaining, int pagecount);
        sqlite3_api_routines* getSqlite3Rountines() const {
            return m_sqlite3Rountines;
        }
        sqlcipher_api_routines* getSqlcipherRountines() const {
            return m_sqlcipherRountines;
        }
        nlohmann::ordered_json getDatabaseInfo();
        // ── 句柄注册表诊断/自愈（说明见 db_mgr.cpp 顶部 db_registry 命名空间）──
        // GET  /Debug/DBRescan → **纯只读**快照：库名 / 句柄 / 连续失败次数 /
        //                        上次成功多久以前 / 取名扫描次数与上次扫描时间。
        //                        不跑任何 SQL、不改任何状态。
        // POST /Debug/DBRescan {"force":true} → 触发一次取名扫描（**带 30 秒节流**，
        //                        节流窗口内直接返回"太快了"，不硬扫）。
        nlohmann::ordered_json dbRescanReport();
        sqlite3* ownConnectionFor(sqlite3* clientDb);   // 自开只读连接的缓存（方案 A）
        void forgetOwn(sqlite3* clientDb);              // 独立连接出错时丢弃它（回退客户端连接）
        nlohmann::ordered_json dbRescanForce();
        // GET /Debug/ApiTable → **纯只读**快照：sqlite3_api_routines 各关键槽位的地址、
        //                        是否落在 Weixin.dll 模块内、各 hook 是否已安装。
        //                        用来区分「钩子没装上」和「钩子装了但入口不对」。
        nlohmann::ordered_json apiTableReport();
        // 给"已登记但还没名字"的句柄补名字：30 秒节流 + 单飞（扫描中其他线程直接返回缓存）。
        // 返回 >0 = 本次补上的条数；0 = 扫了没收获；<0 = 没扫（节流中 / 别人正在扫）
        int namePass();
        // 线程安全地查"缓存里有没有这个库"（自愈路径用，避免读被并发修改的 map）
        bool hasDb(const std::string& dbname);
    private:
        DatabaseMgr();
        ~DatabaseMgr();
        DatabaseMgr& operator=(const DatabaseMgr&) = delete;
        DatabaseMgr(const DatabaseMgr&) = delete;
        sqlite3_api_routines* m_sqlite3Rountines = nullptr;
        sqlcipher_api_routines* m_sqlcipherRountines = nullptr;
        sqlite3CodecGetKey m_codecGetKey = nullptr;
        std::map<std::string, LPVOID> m_dbs;
        std::mutex m_searchDbMtx;
        std::map<std::string, sqlite3*> m_ownDbs;   // path → 我们自己的只读连接
        std::mutex m_ownMtx;
        std::vector<BYTE> m_backupAsmCode;
    };
}
