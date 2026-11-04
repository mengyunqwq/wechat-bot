# 微信 Hook（WeChat 4.1.10.27 x64）

> ⚠️ **仅供个人学习研究**。修改/挂钩微信客户端可能违反腾讯用户协议，账号有被封禁的风险。
> 请勿用于商业用途、骚扰他人或任何违法场景。使用即表示你自行承担全部后果。

这是一个 **`version.dll` 代理型微信 Hook**，衍生自 [aixed/WeChat-Hook](https://github.com/aixed/WeChat-Hook)（**上游无 LICENSE**，版权归原作者）。
我们在其基础上做了大量修改，并整理成可维护的工程结构，供学习 Windows 逆向 / Hook / 微信本地数据结构使用。

## 它做了什么

把 `version.dll` 放进微信客户端目录后，微信启动时会加载它。它提供：

| 能力 | 说明 |
|---|---|
| **本地 HTTP 服务**（127.0.0.1:30001）| 读微信数据库、发消息、诊断 |
| **数据库查询** | `/QueryDB/execute`、`/QueryDB/status`、`/QueryDB/GetAllDBName` |
| **发消息** | `/SendTextMsg`（支持真 @）、`/SendImgMsg`、`/SendVoiceMsg`（真语音气泡，type 34）|
| **图片解密** | `/Decode_Pic` |
| **消息推送** | 新消息 POST 到 `http://127.0.0.1:18998/recv`（需 `hook-push.on`）|
| **眼睛（原图 / 整片视频）** | `VoiceUploadProbe` 探针 + CDN 重放（需 `hook-cdn-replay.on`）|
| **诊断** | `/Debug/ApiTable`、`/Debug/DBRescan`、`/Debug/VuProbe`、`/Debug/VoiceDump` |

## 构建

前置：

- Windows 10 / 11 x64
- Visual Studio 2022 **Build Tools**（勾选「使用 C++ 的桌面开发」）
- 子模块（MinHook 等）

```powershell
git clone https://github.com/mengyunqwq/wechat-hook.git
cd wechat-hook
git submodule update --init --recursive

pwsh -File scripts/build.ps1
```

产物：`x64\Release\version.dll`（约 776KB）

手动编译：

```powershell
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$msbuild = & $vswhere -latest -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
& $msbuild x64_Version_dll.sln /p:Configuration=Release /p:Platform=x64 /m
```

## 部署

1. **完全退出微信**（任务管理器里 `Weixin.exe` 进程数为 0）
2. 把 `version.dll` 放进 `Weixin.exe` 同目录
3. 带参数启动：

```powershell
Start-Process 'D:\wxhook\wx4110\Weixin.exe' `
  -ArgumentList 'StartPort=30001','RecvType=1','CallBackURL=http://127.0.0.1:18998/recv' `
  -WorkingDirectory 'D:\wxhook\wx4110'
```

4. 验证：

```powershell
Invoke-RestMethod http://127.0.0.1:30001/QueryDB/status
# 期望：{"IsLogin":1,"hWeixin":...}
```

> ⚠️ 登录后**点一次微信左侧「通讯录」**：`contact.db` 只在打开通讯录/搜索联系人时才打开，
> 不点的话查 contact.db 会失败（群成员/昵称/@ 都会退化）。

## 目录结构

```
include/              头文件
  global.h            全局变量 + 部分偏移常量
  offset_patterns.h   偏移特征码（自动生成，跨版本自适应）
  wx_send.h           发送实现声明
  SendVoiceMsg.h      语音发送
  VoiceUploadProbe.h  眼睛探针
src/
  QueryDB.cpp         数据库查询路由
  SendTextMsg.cpp     文本发送
  SendImageMsg.cpp    图片发送
  SendVoiceMsg.cpp    语音发送（真气泡）
  VoiceUploadProbe.cpp 眼睛探针（CDN 重放）
  wx_send.cpp         发送实现（结构体构造 + 调用客户端）
  http_routes.cpp     路由注册
  offset_resolver.cpp 运行时偏移解析（特征码扫描 + 兜底）
xdb/
  db_mgr.cpp          数据库句柄捕获（open/open16/open_v2/prepare）+ late-arm
  msg_push.cpp        新消息推送
docs/
  reverse-notes.md    逆向分析笔记（结构、端点、Hook 目标、崩溃分析）
scripts/build.ps1     构建脚本
VERSION               版本号
CHANGELOG.md          变更记录
```

## 已知问题

- **数据库并发（1.1.0 已修）**：此前 Hook 通过 `sqlite3_api_routines` 函数表调用 `prepare/step`，
  **绕过了 sqlite 的连接互斥锁**，与客户端线程并发时会踩坏 lookaside 空闲链表
  （崩溃点 `Weixin.dll+0x32BB50C`）。1.1.0 起用 `SqliteConnLock` 拿 sqlite 自己的连接锁，
  并加安装互斥、登录前早装。详见 [docs/reverse-notes.md](docs/reverse-notes.md) 第五节。
- 偏移与 **4.1.10.27 x64** 绑定；微信升级后需按 `docs/reverse-notes.md` 更新 `offset_patterns.h`。

## 免责声明

- 上游 [aixed/WeChat-Hook](https://github.com/aixed/WeChat-Hook) **没有 LICENSE 文件**，按著作权法默认「保留所有权利」。
  本项目是衍生作品，**不授予任何再分发许可**；仅供学习，请勿商用或再分发。
- 本项目不含任何微信账号、密钥或聊天数据。
- 使用风险（封号、数据损坏、法律风险）由使用者自行承担。

## 相关项目

- [mengyunqwq/wechat-bot](https://github.com/mengyunqwq/wechat-bot) —— 基于本 Hook 的微信机器人（接入层 / 拟人策略 / 控制面板）
