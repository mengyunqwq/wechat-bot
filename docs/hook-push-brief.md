# 交接书：把「收消息」从数据库轮询改成 hook 推送

> 给新会话看的自包含任务书。读完这份 + 按「快速开始」执行即可，不需要重新摸环境。
> 写于 2026-10-18 凌晨，作者：上一个会话的 agent。

---

## 0. 一句话目标

**让 hook 在消息写库的那一刻就把消息推给我们，从而彻底去掉"数据库轮询"这个脆弱前提。**

现状：收消息靠每 2.5 秒查微信的 `message_0.db`。而微信的库是**懒加载 + 会轮换重建**的，
库一关就查不到 → 表现为「机器人突然听不见 / 不回复」。
（已加 4 层自愈：0 会话视为失败、每 5 分钟重扫、第 4 次失败广播 wake、
唤醒改发文件传输助手 —— 实测 17 秒自动恢复。但这是**兜底**，不是**根治**。）

---

## 1. 环境事实（都已验证过，别怀疑）

| 项 | 值 |
|---|---|
| 微信客户端（被 hook 的那份） | `D:\wxhook\wx4110\Weixin.exe`，版本 **4.1.10.27**（自动更新已锁死） |
| hook DLL | `D:\wxhook\wx4110\version.dll`，**516608 字节 / MD5 前缀 CB38DD658D9F**（自编译版） |
| hook 源码 | `E:\wxhook-src\WeChat-Hook`（上游 aixed/WeChat-Hook 的 clone，我们的改动已本地提交 `aa9f681`，工作区干净） |
| 构建 | `MSBuild.exe x64_Version_dll.vcxproj /m /t:Build /p:Configuration=Release /p:Platform=x64` |
| hook HTTP | `127.0.0.1:30001`（只监听本机） |
| hook 回调 | `http://127.0.0.1:18998`（启动参数 `CallBackURL=` 传入，**目前 hook 只解析不实现**） |
| bridge | `<项目目录>\wx-bridge`（运行版，有 node_modules），`127.0.0.1:17300`，数据目录 `<项目目录>\data` |
| 发布仓库 | `D:\dsh-wechat-bot`（公开，**脱敏**，`git add -A` 前必须复查个人路径） |
| 插件 | `<项目目录>\wechat-group-agent\lib\index.js`（DSH 插件，热重载用 `dev_reload_package`） |
| 逆向工具 | Ghidra 12.1.4 `D:\ghidra\ghidra_12.1.4_PUBLIC`（`analyzeHeadless.bat` 可用）+ 项目 `D:\rea\ghproj` + 现成脚本 `D:\rea\*.java`（`FindDbGate/FindHooks/FindQueryDB/FindSearchDatabases/DumpHead/FindHookTargets`）；rea 6.5.0 `D:\rea\rea.cmd`（**可用性未验证**，先跑 `rea --help` / 一个 analyze 试试） |
| Weixin.dll | `D:\wxhook\wx4110\4.1.10.27\Weixin.dll`，**175 MB，无符号** |

**当前时间线**：客户端 01:50 由 bridge 自动拉起过；bridge 重启后靠 wake 自愈成功（6 个会话）。

---

## 2. 已有资产（这是捷径成立的全部理由）

| 资产 | 位置 | 说明 |
|---|---|---|
| `sqlite3_api_routines* g_api` 表 | `xdb/db_mgr.cpp:57` | **已拿到整张 API 函数表** → `bind_blob`/`bind_text`/`step`/`finalize` 都在里面，伸手就能挂 |
| `detourPrepare` 已生效 | `xdb/db_mgr.cpp:74`（安装于 `:83` `installPrepare`） | **每条 SQL 都经过我们** → 能识别 `INSERT INTO Msg_%` |
| `detourOpenV2` 已生效 | `xdb/db_mgr.cpp:39`（安装于 `:108` `installCode`） | 能拿到新开的库句柄 → 配合句柄登记表可判断"是不是 message_0.db 家族" |
| 句柄登记表 | `db_mgr.cpp` 的 `noteHandle` / `m_dbs` | 已有"哪个 sqlite3* 对应哪个库名"的映射 |
| 数据库轮询（现有通路） | `wx-bridge/lib/db-poller.mjs` | 有 `decodeContent`（hex + zstd 解压）→ **推送内容可以直接复用它解码** |
| 回调接收端 | `wx-bridge/lib/wechat-hook.mjs:131`（`http.createServer`）`:137`（`onCallback`） | **白送的**：端口已在监听，只认 JSON |
| bridge 发给插件的事件形状 | `wechat-hook.mjs` → `server.mjs` 广播 `{t:'msg', m:{...}}` | **保持这个形状，插件一行都不用改** |

### 关键洞察（为什么不需要密钥、也不需要逆向微信）
微信的加密发生在**分页/文件层**（pager/VFS）。所以 **SQLite API 层拿到的 `bind_blob` 值就是明文**
（准确说是 **zstd 压缩后的明文** —— 也就是桥现在用 `decodeContent` 解的那种字节）。
→ 我们**不需要解密密钥**，也**不需要在 175MB 里找任何函数**。

---

## 3. 路线 A（推荐，先做）：在 SQLite 层做推送

**目标：影子模式**（推送只观察、不接管），跑稳了再关轮询。

### 步骤

1. **`detourPrepare` 打标记**（`xdb/db_mgr.cpp`）
   - 判断 SQL 是否为 `INSERT INTO Msg_...`（大小写/空白不敏感；`INSERT OR REPLACE` 也要认）
   - 用句柄登记表确认该 `sqlite3*` 属于 message 库（拿不到就放宽，仅按 SQL 判断）
   - 在 `std::unordered_map<sqlite3_stmt*, Capture>` 里为该 stmt 建一条记录
2. **挂 `bind_blob` / `bind_text` / `bind_int64`**（同一张 `g_api` 表）
   - 只对**已标记**的 stmt 抓值（其余立即转发原函数 → 开销可忽略）
   - 记下 `(参数序号, 类型, 值)`；`bind_blob` 的值**按 hex 存**（不要试图解压，交给桥）
3. **挂 `step` / `finalize`**
   - `step` 返回 `SQLITE_DONE`（或 `finalize`）时认为该行写完
   - 把捕获的列值打包成 JSON，**POST 到 `CallBackURL`**
   - 字段建议与轮询保持一致：`{ t:'msg', roomId, localId, createTime, senderId, contentHex, sourceHex }`
     （列名从 `prepare` 的 SQL 里解析，或按 `PRAGMA table_info` 缓存列序 —— 两者都行）
4. **用起 `g_CallBack_Url`（已就绪，不用再解析）**
   - 它已在 `include/global.h:29` 声明、`src/global.cpp:21` 定义、`dllmain.cpp:70-81` 从启动参数解析赋值、
     `src/wx_ini_reader.cpp:12,39` 还有 wx.ini 兜底 —— **只赋值、从未使用**
     （`wx-bridge/lib/db-poller.mjs:5-6` 的注释也这么写）
   - 所以这一步只剩"去用它（POST）"
   - POST 用 `httplib::Client`（httplib 已随源码引入）或 WinHTTP；**必须设短超时（1~2s）**，
     推送失败只记日志，**绝不阻塞微信线程**（这是硬要求：hook 里阻塞会拖死客户端）
5. **桥侧接住**（`wx-bridge/lib/wechat-hook.mjs` 的 `onCallback`）
   - 加 `t:'msg'` 分支：用**现成的 `decodeContent`** 解 `contentHex`/`sourceHex`
   - 复用现有逻辑把 roomId/sender 映射成昵称（`Name2Id` 映射桥已有）
   - **发出与轮询完全相同的 `{t:'msg', m}` 事件** → 插件零改动
6. **影子模式开关 + 对比**
   - 环境变量/配置控制：`PUSH_ONLY=1` 时**只记日志不发事件**（先观察推送内容对不对）
   - 对比一段时间（建议 1~2 天）：推送条数 vs 轮询条数、内容是否一致
   - 一致率 100% 后再把轮询关掉（`db-poller` 加个开关，别删代码）

### 验收标准
- 群里发消息后，**推送在 1 秒内**到达桥（轮询是 2.5 秒 + 库可能没开）
- 内容（含图片/表情消息的占位）与轮询完全一致
- 客户端**不崩**、内存不涨、CPU 不飙（用任务管理器看 30 分钟）
- 把库"关掉"（让客户端闲置一段时间）后，推送**照常工作**（这就是根治的证明）

### 预计工作量
**30~60k tokens**（不含调试反复）。比"在 175MB 里找函数"省一个数量级。

---

## 4. 路线 B（备选，只在 A 受阻时启用）

**什么时候启用**：如果发现消息**根本不经过** `sqlite3_api_routines->bind_*`
（例如 WCDB 有自己的绑定路径、或走了别的写入方式）→ 那就必须找微信内部的接收/分发函数。

**怎么做**：
1. 先花 5 分钟验证 rea 可用（`D:\rea\rea.cmd`，看它能不能连上 Ghidra；不行就直接 headless）
2. 用现成脚本起步：`FindDbGate.java` / `FindSearchDatabases.java` 是找 DB 层的，
   新写一个"从消息表写入点反向找调用者"的脚本（`D:\rea\*.java` 里加）
3. 目标：找到**解密后、分发前**的那个函数（入参里有消息结构体）
4. 挂 detour → 按结构体偏移取字段 → POST（同路线 A 的第 3~6 步）
5. 偏移要配合 `scripts/gen-offset-patterns.py` + `src/offset_resolver.cpp` 做自动定位
   （微信升级后偏移会变，别硬编码）

**这条路的现实预期**：慢（这是之前估 150~400k 的那条），但工具链齐全、能做。

---

## 5. 红线（务必遵守）

1. **不要动正在跑的微信客户端** —— 不要为了测试反复重启它（今天已经踩过：反复重启导致
   数据库句柄失效、失聪；而且重启要手机确认的风险始终在）
2. **不要在没有影子对比前关掉轮询** —— 推送没验证就接管 = 拿机器人的可用性赌博
3. **不要 `git add -A` 到 `D:\dsh-wechat-bot`** —— 那个目录里可能有本机路径的文件；
   提交前必须跑一遍脱敏复查（`wxid_[0-9a-z]{8,}` / `47390425951` / `<项目目录>` / `D:\wxhook`）
4. **hook 里绝不阻塞** —— 推送/网络调用必须短超时 + 失败静默，阻塞会拖死客户端
5. **hook 改动攒一批只部署一次** —— 每次部署都要重启客户端（有手机确认风险），别改一行部署一次
6. **每步都要能回滚** —— DLL 是单文件替换；`D:\wxhook\archive\4.1.10.27-20261018-0130`
   有归档、`D:\wxhook\还原全部改动(需管理员).cmd` 可一键还原

---

## 6. 快速开始（第一条命令）

```powershell
# 0) 确认环境还在
Get-Item 'D:\wxhook\wx4110\version.dll' | Select-Object Length, LastWriteTime   # 应为 516608
(Invoke-WebRequest 'http://127.0.0.1:30001/QueryDB/debug' -TimeoutSec 20).Content | ConvertFrom-Json | Select scan_hits, @{n='dbs';e={$_.dbs.Count}}
(Invoke-WebRequest 'http://127.0.0.1:17300/api/status' -TimeoutSec 10).Content

# 1) 读 hook 里现有的 sqlite detour（路线 A 的落点）
#    E:\wxhook-src\WeChat-Hook\xdb\db_mgr.cpp   （看 detourPrepare / g_api / noteHandle）

# 2) 顺手验证 rea 能不能用（不行就走 headless）
D:\rea\rea.cmd --help
```

**先做的第一件事**：在 `db_mgr.cpp` 的 `detourPrepare` 里**只加一行日志**，
打印所有 `INSERT INTO Msg_` 的 SQL（写进 hook 的日志/OutputDebugString），
编译部署一次，然后**在群里发一条消息**，确认：
- ① 消息确实是走 `prepare` 进来的（捷径成立）
- ② 能拿到表名与列序（后面解析字段要用）

**这一步就能决定走 A 还是 B** —— 花不了多少时间，但省掉后面所有猜测。

---

## 7. 进度更新（2026-10-18 02:20，探针已完成）

**探针已写好并编译通过，尚未部署**（等合适时间人工部署）：

| 项 | 值 |
|---|---|
| 改动 | 仅 `xdb/db_mgr.cpp`，**+225 行 / −0 行**（纯增量，既有语句一字未改，`rc`/出参/控制流原样） |
| 产物 | `E:\wxhook-src\WeChat-Hook\x64\Release\version.dll`，**534016 字节**，MD5 `CC88631554D724CD49C8C5760FD6CB35` |
| 在跑的 DLL | 仍是 516608 / `CB38DD658D9FA0EF5052CDDA97AC7318`（**未部署**） |
| 导出表 | 与在跑的 DLL **17 = 17 一致**（代理接口没动） |
| 日志 | `D:\wxhook\wx4110\hook-probe.log`（部署后由探针创建；机器没装 DbgView 所以落文件） |
| 探针行 | `[PROBE-MSG]`（命中 Msg_ 插入）/ `[PROBE-WRITE]`（首次见到每张写目标表，兜底给出真实表名）/ `[probe] prepare 钩子已安装|被调用`（证明钩子活着） |

**探针日志怎么读（决定 A 还是 B）**：
- 有 `[PROBE-MSG] ... table=Msg_xxxx db=message_0.db ... sql=INSERT INTO Msg_xxxx(...)` → **A 成立**，且直接拿到表名+列序
- 只有 `[PROBE-WRITE]`、没有 `[PROBE-MSG]` → 走 prepare 但表名不是 `Msg_` → 按它给出的真实表名改判定即可，**A 仍成立**
- 连"钩子被调用"都没有 → 钩子没装上（查 `installPrepare` 失败日志）
- 有"钩子被调用"但无 `[PROBE-WRITE]` → **消息写库不经过 `sqlite3_prepare_v2`** → 先补挂 `api->prepare16` / `sqlite3_prepare_v3`；都挂不上才转路线 B

**两个已知逃生口（探针就是为了排除它们）**：
1. `message_0.db` 可能是经 `detourOpenV2`（而非 `noteHandle`）入的登记表 → 那样就不能证明 prepare
2. **"prepare 被调用过" ≠ "消息 INSERT 走 prepare"**（同句柄做 SELECT 也会经过）→ 且 `prepare16` / `prepare_v3` **没有**被 hook

**部署注意**：部署 + 重启客户端**必须在有人在场时做**（重启有手机确认的小概率风险，凌晨做=可能整夜掉线）。
备份/部署/验证/回滚命令见第 6 节与「下一步精确命令」（回滚 = 单文件替换 + 重启）。


---

## 8. 判决结果（2026-10-18 02:50 实测，**路线 A 成立** ✓✓）

**结论：走路线 A，不要走路线 B。** 证据（第二轮探针，群里真发一条消息触发）：

| 证据 | 数值/内容 | 含义 |
|---|---|---|
| `[PROBE-SUM]` wx 计数 | `wx=0` → `1` → `10` → `70+` | **微信确实在用这台 sqlite 实例** → ③（另一份静态 sqlite）**排除** |
| 写语句入口 | 全部 `via=prepare_v3` | **入口是 `sqlite3_prepare_v3`，不是 `prepare_v2`**（第一轮零命中的原因） |
| `[PROBE-STEP]` | 60 条，全部 `from=wx` | step 钩子工作正常，能看到微信的执行流 |
| 消息相关写入 | `INSERT INTO 'main'.'message_fts_v4_0_content'`（`message_fts.db`，`via=prepare_v3`） | **消息确实走这台实例**（FTS 索引与 Msg_ 行同事务） |
| 微信调用点 RVA | DB 层 `wx+0x3329DD8`；FTS 写 `0x5099932` / `0x5084F39` / `0x509A319` / `0x509B697`；exec `0x506DE31` | 路线 B 若需要，入口已现成 |
| 副作用 | CPU 0%（基线 0%）、客户端不崩、轮询在消息到达后恢复正常（6 会话） | 探针安全 |

**实现要点（下一轮照这个做）**：
1. **挂 `api->prepare_v3` + `api->prepare16_v3`**（不是 `prepare_v2`）—— 但**不要依赖 prepare 抓内容**：WCDB 用 `SQLITE_PREPARE_PERSISTENT` 缓存语句，很多 INSERT 在我们挂钩前就 prepare 好了。
2. **真正的内容抓取放在 `bind_blob` / `bind_text` / `bind_int64` + `step` 上** —— 这两个入口**免疫语句缓存**（bind 每次插值都调用；step 每行都调用）。
3. 判定"这条是不是消息写入"：在 `prepare*` 时用 **`api->sql(stmt)` 或参数 SQL** 判断目标库属于 message 家族、且语句是 INSERT/REPLACE；把该 stmt 标记进表；`bind_*`/`step` 只处理被标记的 stmt。
4. **表名解析要修**：现有探针对 `INSERT INTO 'main'.'xxx'`（带引号/带库名前缀）解析失败（日志里 `table=-`）→ 先把 SQL 里的引号/`库名.` 前缀剥掉再匹配，否则 `Msg_` 的写入会被漏判。
5. 抓到的值按 hex 打包 POST 到 `g_CallBack_Url`；桥侧用现成的 `decodeContent`（hex+zstd）解，发出与轮询**相同形状**的 `{t:'msg', m}` 事件 → 插件零改动。
6. **影子模式**先跑（推送只记日志不接管），对比轮询一致后再关轮询。

**遗留未解**：`Msg_xxx` 那条 INSERT 本轮**未被捕获**（`STEP-MSG=0`）—— 原因是"语句缓存 + 表名解析失效"两条叠加，按上面第 1/4 点处理即可；不需要因此转向路线 B。
