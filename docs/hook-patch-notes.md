# 微信 Hook 补丁说明

补丁文件：`patches/wechat-hook-querydb-fix.patch`（对 [aixed/WeChat-Hook](https://github.com/aixed/WeChat-Hook) 的改动）

## 一、为什么需要这个补丁

上游版本的 `QueryDB`（进程内读微信数据库的接口）**永久失效**：

```cpp
// xdb/db_mgr.cpp 原版
if (!g_IsLogin) { m_dbs.clear(); return m_dbs; }   // 门禁
```

而**全项目没有任何地方把 `g_IsLogin` 置 1**（`AfterLoginInitThread` 定义了却从未被调用）。
所以：

| 现象 | 根因 |
|---|---|
| `POST /QueryDB/GetAllDBName` 永远返回 `[]` | 被 `g_IsLogin` 挡住 |
| `POST /QueryDB/execute` 报 `get database handle which named xxx failed` | 同上 |
| `GET /QueryDB/status` 永远 `IsLogin: 0` | 同上 |

后果：**拿不到群成员真实昵称**（只能靠 @ 提及慢慢猜）。

## 二、补丁改了什么（4 个文件，+149 / -23 行）

### 1. `xdb/db_mgr.cpp` — 自愈登录标志 + 扫描加固

- 去掉 `searchDatabases()` / `getDatabaseInfo()` 里的 `!g_IsLogin` 门禁
- 扫到数据库后 `g_IsLogin = 1`（自愈）
- **加固**：扫描候选句柄时 `queryResult["data"][0]["file"].get<string>()` 在 `data` 为空时会**抛异常打断整个扫描**，改为先判 `is_array()/empty()/is_string()`

### 2. `src/GetSelfProfile.cpp` — 双保险

```cpp
if (!SelfInfo.wxid.empty()) g_IsLogin = 1;
```

### 3. `src/QueryDB.cpp` — 新增 `/QueryDB/debug` 调试路由

输出：模块基址/大小、`sqlite3_api_routines` 偏移处 8 个函数指针是否落在模块内（**校验偏移是否正确**）、
VFS 扫描命中数、每个候选句柄的 `errcode`/`prepare_rc`、已发现的数据库列表。
**判断"当前加载的是不是补丁版"就看这条路由存不存在**（只读，无副作用）。

### 4. `x64_Version_dll.vcxproj` — 工具集降级

`<PlatformToolset>v145</PlatformToolset>` → `v143`（适配 VS 2022 Build Tools，MSVC 14.44）

## 三、编译

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools `
  --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

cd <hook 仓库>
& "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe" `
  x64_Version_dll.vcxproj /m /t:Build /p:Configuration=Release /p:Platform=x64
# 产物：x64\Release\version.dll
```

依赖只有系统库（`psapi.lib`、`gdiplus.lib`）+ 仓库内的 httplib / md5 / minhook，无需额外包管理器。

## 四、数据库结构（微信 4.x）

修复后可用的关键表（`contact.db`）：

| 表 | 关键列 | 说明 |
|---|---|---|
| `contact` | `username`(wxid)、`nick_name`、`remark`、`alias` | 联系人资料，**备注优先于昵称** |
| `name2id` | 隐式 `rowid` ↔ `username` | wxid 与内部数字 id 的映射 |
| `chatroom_member` | `room_id`、`member_id` | 群成员关系（存的是 `name2id.rowid`，不是 wxid） |
| `chat_room` | `id`、`username`、`owner` | 群信息 |

**取群成员昵称的 SQL**：

```sql
SELECT c.username AS wxid, c.nick_name AS nick, c.remark AS remark
FROM chatroom_member m
JOIN name2id r ON r.rowid = m.room_id
JOIN name2id u ON u.rowid = m.member_id
JOIN contact c ON c.username = u.username
WHERE r.username = '<群id>'
```

其他可用库：`message_0.db`（消息，按会话分表 `Msg_<md5(会话id)>`）、`emoticon.db`、`session.db`、
`media_0.db`、`favorite.db`、`head_image.db`、`general.db` 等（`/QueryDB/GetAllDBName` 可列全）。

## 五、上游源码缺失的功能（我们绕开了）

公开源码里 **`g_CallBack_Url` 只被赋值、从不使用**（git 历史里也从未出现）→
**回调推送没有实现**，所以自编译版收不到消息。

**我们的解法**：不依赖回调，改为**轮询数据库收消息**（`wx-bridge/lib/db-poller.mjs`），
顺带还能拿到发送者 wxid → 真实昵称。

官方 release 的 DLL 有回调但 `QueryDB` 是坏的 —— 两者只能二选一，我们选了补丁版 + 轮询。

## 六、还能继续改什么

| 想修 | 改哪里 | 难度 |
|---|---|---|
| **真 @ 提醒**（现在只是文本"@名字"） | `BuildTextMessage` 里填 `atlist` 字段（数据格式需动态调试确认） | 中 |
| 原生表情包发送 | 修 `ForwardXMLMsg`（现在一调就崩） | 中高 |
| 群图片 CDN 下载 | 需构造 fileid + a8key 链路 | 高 |
