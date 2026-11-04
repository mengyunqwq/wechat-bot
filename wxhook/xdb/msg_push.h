#pragma once
// ══════════════════════════════════════════════════════════════════════
//  消息写入抓取 + 推送（第三轮 → 第三轮改造：通知式）
//
//  分工（保持 db_mgr.cpp 只做"识别"，本文件只做"抓取与投递"）：
//    db_mgr.cpp  挂 SQL 入口钩子、解析 SQL、判断是不是消息写库，然后调这里的 mark()/notifyWrite()
//    本文件      有界队列 + 单工作线程 POST 到 g_CallBack_Url
//
//  ⚠️ 第三轮改造（实测结论，别退回旧路）：
//    "标记 + bind 抓值"这条路**走不通** —— Msg_ 的 INSERT 是挂钩前就 prepare 好的**缓存语句**，
//    标记只能在 step 时事后补、而且保持不住（实测 [PUSH-LATE] 反复出现、[PUSH-CAP] 一条都没有）
//    → 值永远抓不到。改成**通知式**：只告诉桥"某个 Msg_ 表刚被写了"，桥收到后立刻查一次库
//    （通知触发那一刻库必然是开着的 —— 这才是真正根治"聋窗"的点）。完全绕开语句缓存问题。
//    mark()/bindValue()/rowDone() 保留（**不再依赖**它们；[PUSH-CAP] 那类行诊断日志还有用）。
//
//  设计约束（对应任务书红线 4「hook 里绝不阻塞」）：
//    * 微信线程上**绝不做网络 I/O**：只做内存拷贝 + 入队（有界，满了丢最旧并计数）。
//    * POST 全部在一条独立工作线程上，WinHTTP 显式短超时（≤1.5s），失败只记日志。
//    * 开关运行时可切：标记文件存在 = 开；工作线程每 250ms 复查，**无需重启**。
//    * 所有日志量都有上限。
//    * 本文件不碰任何既有逻辑：只被 db_mgr.cpp 的 detour 调用，不返回任何值给 SQLite。
// ══════════════════════════════════════════════════════════════════════
#include <string>
#include <vector>
#include "sqlite3.h"

namespace msgpush {

    typedef void (*LogFn)(const std::string& line);

    // 安装：设日志出口、算好标记文件路径、起工作线程（只起一次）
    void arm(LogFn logger);

    bool enabled();                 // 当前开关状态
    std::string markerPath();       // 标记文件完整路径
    std::string postUrl();          // 推送目标（快照自 g_CallBack_Url）

    // prepare 时机：把这条 INSERT/REPLACE 标进表
    //   pushable = 是否是"要推给桥"的行（表名 Msg_*）
    //   注意：**通知式推送不依赖这个标记**（标记保持不住，见文件头说明）；保留仅为行诊断。
    void mark(sqlite3_stmt* stmt, const std::string& db, const std::string& table,
              const std::vector<std::string>& cols, bool pushable);

    // ── 通知式推送（第三轮改造的主路）────────────────────────────────
    // 只入队一条**轻量通知**：{"t":"msg","db":"…","table":"Msg_…","ts":<ms>}（不带任何列/值）。
    // 桥收到后立刻针对该表对应的会话查一次库 —— 那一刻库必然是开着的（微信刚写完）。
    // 同表 500ms 内只发一次（一次消息写入常伴随多条语句，防刷屏）。
    // 纯内存操作 + 短临界区：微信线程上零网络、零阻塞。
    void notifyWrite(const std::string& db, const std::string& table);

    // bind 时机：只处理已标记的 stmt；data/nbytes 仅对 TEXT/BLOB 有效
    void bindValue(sqlite3_stmt* stmt, int idx, int type,
                   const void* data, int nbytes, long long ival, double dval);

    // step 返回 SQLITE_DONE：成行 + 入队。
    // 返回 true = 该 stmt 已被标记（本次已处理）；false = 未标记（调用方可做"补标记"兜底）
    bool rowDone(sqlite3_stmt* stmt);

    // finalize：清理标记
    void finalizeStmt(sqlite3_stmt* stmt);

    // 统计（供日志/调试）
    void stats(long long& marked, long long& queued, long long& sent, long long& failed, long long& dropped);

} // namespace msgpush
