# WeChat-Hook 改造说明（群成员昵称）

> 目标：让机器人拿到**微信群成员的真实昵称**。
> 原来只能靠"@ 提及"慢慢猜，现在直接从微信自己的数据库读，一次拿全。

---

## 一、为什么要改 hook

微信 hook（`version.dll` 代理）提供 HTTP 接口，其中 `/QueryDB/*` 是**进程内读微信数据库**的通道。
但它在这个版本里**永久失效**：

| 现象 | 根因 |
|---|---|
| `POST /QueryDB/GetAllDBName` 永远返回 `[]` | `db_mgr.cpp` 的 `searchDatabases()` 开头是 `if (!g_IsLogin) return 空`，而**全项目没有任何地方把 `g_IsLogin` 置 1**（`AfterLoginInitThread` 定义了却从未被调用） |
| `POST /QueryDB/execute` 报 `get database handle which named xxx failed` | 同上（拿不到句柄） |
| `GET /QueryDB/status` 永远 `IsLogin: 0` | 同上 |

即：**上游把这个功能写坏了**（不是我们环境的问题）。

---

## 二、改了哪三处（共 3 个文件）

源码目录：`E:\wxhook-src\WeChat-Hook`（`git clone https://github.com/aixed/WeChat-Hook.git`）

### 1. `xdb/db_mgr.cpp` —— 自愈登录标志 + 扫描加固

```cpp
// 原版：if (!g_IsLogin) { m_dbs.clear(); return m_dbs; }
// 改成：不靠这个永远为 0 的标志，直接扫描；扫到数据库就反推"已登录"
```
- 删掉 `searchDatabases()` 与 `getDatabaseInfo()` 里的 `!g_IsLogin` 门禁
- 扫到数据库后 `g_IsLogin = 1`（自愈）
- **加固**：扫描候选句柄时 `queryResult["data"][0]["file"].get<string>()` 会在 `data` 为空时**抛异常打断整个扫描**，改为先判 `is_array()/empty()`/`is_string()`

### 2. `src/GetSelfProfile.cpp` —— 双保险

```cpp
if (!SelfInfo.wxid.empty()) g_IsLogin = 1;
```
（能取到自己的 wxid 就说明已登录。注：自编译版这个接口返回空，所以真正生效的是第 1 处 + 桥侧判据）

### 3. `src/QueryDB.cpp` —— 新增调试路由 `/QueryDB/debug`

输出：模块基址/大小、`sqlite3_api_routines` 偏移处 8 个函数指针是否落在模块内（**校验偏移对不对**）、
VFS 扫描命中数、每个候选句柄的 `errcode`/`prepare_rc`、已发现的数据库列表。
定位问题时非常有用，保留着（只读，无副作用）。

### 4. `x64_Version_dll.vcxproj` —— 工具集降级

`<PlatformToolset>v145</PlatformToolset>` → `v143`（本机装的是 VS 2022 Build Tools，MSVC 14.44 = v143）

---

## 三、编译

```powershell
# 工具链：VS 2022 Build Tools（含 C++ 工作负载）+ Windows SDK 10.0.26100
winget install --id Microsoft.VisualStudio.2022.BuildTools `
  --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

cd E:\wxhook-src\WeChat-Hook
& "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe" `
  x64_Version_dll.vcxproj /m /t:Build /p:Configuration=Release /p:Platform=x64
# 产物：x64\Release\version.dll
```

依赖只有系统库（`psapi.lib`、`gdiplus.lib`）+ 仓库内的 httplib / md5 / minhook，无需额外包管理器。

---

## 四、部署与回滚

| 项 | 值 |
|---|---|
| 部署位置 | `D:\wxhook\wx4110\version.dll` |
| 当前版本 | 自编译，484864 字节（含调试路由） |
| **回滚备份** | `D:\wxhook\wx4110\version.dll.bak-606208-20261016-0932`（官方 release，606208 字节） |
| 官方 release 对应 | tag `v411027_`（2026-06-29），606208 字节 |

**回滚方法**（出问题一条命令还原）：
```powershell
# 1) 先停桥（否则看门狗会自动拉起客户端，DLL 文件被占用无法覆盖）
Get-NetTCPConnection -LocalPort 17300 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
# 2) 停客户端（只杀我们这份，绝不碰你日常微信）
Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" |
  Where-Object { $_.ExecutablePath -eq 'D:\wxhook\wx4110\Weixin.exe' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# 3) 还原 DLL
Copy-Item 'D:\wxhook\wx4110\version.dll.bak-606208-20261016-0932' 'D:\wxhook\wx4110\version.dll' -Force
# 4) 重新启动客户端 + 桥
Start-Process 'D:\wxhook\wx4110\Weixin.exe' -ArgumentList 'StartPort=30001 RecvType=1 CallBackURL=http://127.0.0.1:18998' -WorkingDirectory 'D:\wxhook\wx4110'
# 桥用桌面快捷方式或 启动机器人.cmd 拉起
```

> 注意：`D:\wxhook\wx4110` 是**机器人专用**的微信副本，和你日常用的 `D:\Program Files\Tencent\Weixin` 完全隔离，改这里不影响你平时用微信。

---

## 五、数据库结构（微信 4.x，`contact.db`）

修复后可用的关键表：

| 表 | 关键列 | 说明 |
|---|---|---|
| `contact` | `username`(wxid)、`nick_name`、`remark`、`alias` | 联系人/群成员资料。**备注优先于昵称**（更接近平时叫法） |
| `name2id` | 隐式 `rowid` ↔ `username` | wxid 与内部数字 id 的映射表 |
| `chatroom_member` | `room_id`、`member_id` | 群成员关系（存的是 `name2id.rowid`，不是 wxid） |
| `chat_room` | `id`、`username`、`owner` | 群信息 |

**取群成员昵称的 SQL**（已在 `wx-bridge/lib/wechat-hook.mjs` 的 `groupMembers()` 里实现）：

```sql
SELECT c.username AS wxid, c.nick_name AS nick, c.remark AS remark, c.alias AS alias
FROM chatroom_member m
JOIN name2id r ON r.rowid = m.room_id
JOIN name2id u ON u.rowid = m.member_id
JOIN contact c ON c.username = u.username
WHERE r.username = '47390425951@chatroom'
```

其余可用的库：`bizchat.db`、`emoticon.db`、`message_0.db`、`session.db`、`media_0.db`、`favorite.db`、
`head_image.db`、`sns.db`、`general.db`、`key_info.db` 等（共 21 个，`/QueryDB/GetAllDBName` 可列全）。

---

## 六、修好之后系统里多了什么

| 层 | 变化 |
|---|---|
| hook | `/QueryDB/*` 全部可用；新增 `/QueryDB/debug` |
| 桥 | 新增 `members` 命令（`contact.db` 关系查询）；`dbReady()` 判据；登录判定不再依赖坏的 `/GetSelfProfile` |
| 插件 | `useDbMembers`：每 10 分钟 + 群初始化时同步真实昵称到 `members.json`；并从成员列表里**认出自己**（昵称匹配机器人名）→ 补上了空的 self |

效果：`senderName`、@ 提及、提示词里的"群里的人"、长期记忆里的"谁是谁" 全部用上真实昵称，
不再需要靠 @ 提及慢慢学（那条路保留作为兜底）。

---

## 七、还能继续改什么（按性价比）

| 想修 | 改哪里 | 难度 |
|---|---|---|
| ~~**真 @ 提醒**~~ ✅ **已实现**（2026-10-18） | hook 侧 `BuildTextMessage` 会写 `atlist`（wx_send.cpp:1359）；**插件侧要传** `mentions:[wxid]`（走 `resolveMentions()` 把正文里的 "@群昵称" 解析成 wxid）→ 对方收到红点提醒。判据：消息 XML 里出现 `<atuserlist>` | 已做完 |
| 原生表情包发送 | 修 `ForwardXMLMsg`（现在一调就崩） | 中高 |
| 群图片下载（用于识图） | 新接口，逆 CDN + aeskey 解密链路；或利用已有的 `/Decode_Pic`（需图片落盘，目前客户端不落盘） | 高 |

---

## 八、后续重大发现与改造（识图 + 收消息）

### 8.1 公开源码缺"回调推送"，自编译 DLL 会收不到消息

- 事实：`g_CallBack_Url` 在源码里**只被赋值、从不使用**（git 历史里也从未出现）→ 作者把回调推送留在私有版本。
- 后果：官方 release DLL 有回调但 QueryDB 是坏的；我们自编译的修好了 QueryDB 却**收不到消息**。
- **解法：绕开回调，直接轮询数据库收消息** —— 见 `wx-bridge/lib/db-poller.mjs`
  - 每 2.5 秒查一次各 `Msg_*` 表里 `local_id > 上次` 的新行
  - 消息内容 zstd 压缩 → 用 `fzstd` 解压
  - 产出事件结构与 hook 回调**完全一致** → 桥和插件都不用改
  - 额外收益：能拿到发送者 wxid → **真实昵称**（回调里没有昵称字段）

### 8.2 关键映射（踩过坑）

| 数据 | 正确来源 | 坑 |
|---|---|---|
| 会话表 ↔ 群/人 | `md5(wxid)` = `Msg_<hash>` 的表名后缀 | 已验证：`47390425951@chatroom` → `faba2ca94574a850e8f86710890552de` |
| 发送者 | **`message_0.db.Name2Id`** 的 `rowid → user_name` | ✗ 不能用 `contact.db.Name2Id`（那是全局编号，实测映射成 weixin/notifymessage） |
| 自己发的消息 | 无 `wxid_xxx:` 前缀 + `real_sender_id` = 自己 | 自己 wxid 可从数据目录名 `xwechat_files\wxid_xxx_hash` 推出 |
| 消息时间 | `create_time`（Unix 秒） | 用于匹配图片文件，别用"当前时间" |

### 8.3 聊天图片解密（识图的关键）

微信把收到的图片加密存在：
```
<数据目录>\xwechat_files\<wxid>_<hash>\msg\attach\<md5(群id)>\<年-月>\Img\<md5>[_t|_h].dat
```
- 格式：**V2** `[6B 签名 07 08 "V2" 08 07][4B aes_size][4B xor_size][1B 填充][AES-128-ECB 密文][明文段][XOR 段]`
- **密钥不在文件里**，只在微信进程内存中（每份安装独立，且需客户端解密过一次图片才会出现）
- 消息 XML 里的 `aeskey` 是 **CDN 下载用的密钥，不是本地 .dat 的**（已穷举 7 种形态 × 33 偏移 × 2 模式 × 3 IV = 全部失败）
- hook 的 `/Decode_Pic` 偏移对这个构建失效；`/set_callback`、`/get_a8key` 都没注册（DLL 里的残留字符串）
- **做法**：`wx-bridge/decode-wechat-image.py`
  1. 扫微信进程内存找 16 字符 AES 密钥（只扫机器人那份进程）
  2. 密钥缓存到 `data/wechat-image-key.json`（一次拿到长期可用）
  3. 按**消息时间戳**匹配 mtime 最接近的 `.dat`（±6 分钟）
  4. 解密到 `data/wechat-image-tmp/` → 交给视觉模型 → **识别完立刻删掉**（微信原文件不动）

### 8.4 多群记忆隔离（本来就分开，已确认）

| 文件 | 粒度 |
|---|---|
| `memory/<roomId>.json` | **每群独立**（短期：最近 300 条） |
| `facts/<roomId>.json` | **每群独立**（长期：提炼出的事实） |
| `members.json` | 全局共享（wxid↔昵称映射、@ 学到的名字）—— 跨群通用更准 |
| `wechat-image-key.json` | 全局（每份安装一把） |

### 8.5 新增/改动文件一览

| 文件 | 作用 |
|---|---|
| `wx-bridge/lib/db-poller.mjs` | 数据库轮询收消息（替代回调） |
| `wx-bridge/lib/wechat-image.mjs` | 定位/解密聊天图片 |
| `wx-bridge/decode-wechat-image.py` | V2 解密 + 内存扫密钥 |
| `wx-bridge/find-decode-func.py` | PE 分析（证明解密逻辑不在主 DLL） |
| `wx-bridge/list-sessions.py` | 列出所有会话与记忆文件 |
| `wx-bridge/decrypt-from-db.py`、`try-key-variants.py`、`bruteforce-v2.py` | 排查用（证明本地密钥 ≠ 消息 aeskey） |
