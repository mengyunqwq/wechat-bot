# 部署指南

> 目标：从零把机器人跑起来。**约 30 分钟**（不含下载 VS 编译环境）。
> 文末有 **「AI 一键部署」** 小节，可直接把整段喂给另一个 AI 让它替你装。

---

## 0. 前置条件

| 需要 | 版本 | 说明 |
|---|---|---|
| Windows | 10/11 x64 | Hook 只支持 Windows |
| Node.js | **18+**（建议 20+） | 跑接入层 |
| Python | **3.10+** | 解密图片 / 画气泡 |
| 微信客户端 | **4.1.10.27** | Hook 只适配这个版本 |
| Visual Studio | 2022 Build Tools（含 C++ 工作负载）+ Windows SDK | **仅当你要自己编译 Hook 时**需要 |
| 一个微信小号 | — | ⚠️ **强烈建议用小号，不要用你日常微信** |

```powershell
# 装 Python 依赖
python -m pip install pycryptodome zstandard
# 装 Node 依赖（在 wx-bridge 目录）
npm install
```

---

## 1. 准备一份独立的微信客户端（重要）

**绝对不要**直接改你日常用的微信目录 —— 万一出问题会影响你正常使用。

```powershell
# 假设你的微信装在 D:\Program Files\Tencent\Weixin
# 复制一份到独立目录（例如 D:\wxhook\wx4110）
robocopy "D:\Program Files\Tencent\Weixin" "D:\wxhook\wx4110" /E
```

复制完**先确认版本是 4.1.10.27**（客户端目录下有 `4.1.10.27\` 文件夹）。

> 微信会自动更新，更新后 Hook 可能失效。接入层内置了「防更新守卫」，会周期性禁用更新器。

---

## 2. 获取微信 Hook（二选一）

### 方案 A：下载官方预编译版（最快，但没有群昵称）

1. 到 [aixed/WeChat-Hook Releases](https://github.com/aixed/WeChat-Hook/releases) 下载 `version.dll`
2. 放到 `D:\wxhook\wx4110\version.dll`

**优点**：省事。**缺点**：官方版 **`QueryDB` 是坏的**（上游 bug：`g_IsLogin` 永远是 0）→ **拿不到群成员昵称**、**收不到消息**（公开源码里没有回调推送实现）。

### 方案 B：跑脚本自动构建（推荐，功能完整）

**一条命令搞定**（脚本会自动装 VS Build Tools → 克隆上游 → 打补丁 → 编译 → 部署）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-hook.ps1
```

> **为什么本仓库不发编译好的 `version.dll`？**
> 上游 aixed/WeChat-Hook **没有 LICENSE 文件**（默认"保留所有权利"），
> 直接再分发其衍生二进制法律风险高。所以改成**脚本让你自己在本机构建** ——
> 效果一样，但更干净。脚本会自动备份你原来的 `version.dll`。

<details>
<summary>想手动编译（等价于脚本做的事）</summary>



```powershell
# 1) 克隆上游
git clone https://github.com/aixed/WeChat-Hook.git E:\wxhook-src\WeChat-Hook
cd E:\wxhook-src\WeChat-Hook

# 2) 应用本项目的补丁（修复 QueryDB + 加调试路由）
git apply <本仓库>\patches\wechat-hook-querydb-fix.patch

# 3) 装编译环境（若没有）
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# 4) 编译（补丁里已把工具集改成 v143，适配 VS 2022）
& "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe" `
  x64_Version_dll.vcxproj /m /t:Build /p:Configuration=Release /p:Platform=x64

# 5) 部署（先备份原文件！）
copy E:\wxhook-src\WeChat-Hook\x64\Release\version.dll D:\wxhook\wx4110\version.dll
```

补丁做了什么、为什么这么做，见 [docs/hook-patch-notes.md](docs/hook-patch-notes.md)。

</details>

---

## 3. 配置接入层

复制模板并填写：

```powershell
copy config.example.json config.json
notepad config.json
```

```jsonc
{
  "wechatExe": "D:\\wxhook\\wx4110\\Weixin.exe",   // 机器人专用微信（工作目录必须是它所在目录）
  "apiPort": 30001,                                 // Hook 的 HTTP 端口
  "cbPort": 18998,                                  // 回调端口（本版 Hook 用不到，但保留兼容）
  "bridgePort": 17300,                              // 接入层端口
  "pythonExe": "python",                            // 或写绝对路径
  "dataDir": "./data",
  "hosted": {
    "enabled": false,                               // 用外部 agent 时才开
    "webhookUrl": ""
  }
}
```

也可以用环境变量（优先级更高）：`WECHAT_EXE` / `PYTHON_EXE` / `WECHAT_ATTACH_DIR` / `WX_BRIDGE_URL`。

> **`WECHAT_ATTACH_DIR`**：微信数据目录下的 `msg\attach`，例如
> `D:\Users\<你>\xwechat_files\wxid_xxx_hash\msg\attach`
> 用于解密群图片。不知道在哪？启动微信后运行 `python wx-bridge/list-sessions.py` 会打印出来（或看 `docs/` 里的说明）。

---

## 4. 启动

### 4.1 一键启动脚本（推荐）

仓库自带启动器：会**按正确参数**拉起微信（`RecvType=1` + 回调地址）再启动 bridge；
已经在跑的两端都会**跳过**（避免开出第二个 bridge 抢同一个端口）。

```powershell
# 只需设置一次微信客户端路径（就是第 1、2 节准备好的那份）
setx WECHAT_EXE "D:\wxhook\wx4110\Weixin.exe"

# 之后双击 scripts\start-bot.cmd，或：
powershell -ExecutionPolicy Bypass -File .\scripts\start-bot.ps1
```

可选环境变量（都有默认值）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WECHAT_EXE` | —（必填） | 你复制的 hooked 微信的 `Weixin.exe` |
| `WECHAT_BOT_DATA` | `<仓库>\wx-bridge\data` | 数据目录（表情包库、日志等） |
| `WECHAT_BOT_PORT` | `17300` | bridge 的 WS/HTTP 端口（插件连这个） |
| `WECHAT_HOOK_PORT` | `30001` | Hook 的 HTTP 端口 |
| `WECHAT_CB_PORT` | `18998` | Hook 的回调端口 |

> ⚠️ **为什么是「一个 `.ps1` + 一个纯 ASCII 的 `.cmd` 壳」，而不是单个 `.cmd`**：
> 批处理是按**控制台当前码页**解析文件字节的。只要路径里出现中文，双击运行（码页 936）
> 和从 PowerShell 里调用（码页 65001）就会一个正常一个乱码，严重时中文碎片还会被当成命令执行。
> PowerShell 脚本用 UTF-8+BOM，与码页无关，所以中文路径交给它。

### 4.2 手动启动

```powershell
cd wx-bridge
npm start
# 或指定参数：
# node server.mjs --transport=wechat-hook --api-port=30001 --wechat="D:\wxhook\wx4110\Weixin.exe"
```

启动后它会：
1. 拉起微信客户端（若没在跑）并等 Hook 就绪
2. 启动**数据库轮询**（收消息 + 取真实昵称）
3. 启动 WebSocket + REST + MCP 服务
4. 周期性**禁用微信自动更新**

**验证**：

```powershell
curl http://127.0.0.1:17300/api/status          # 应看到 loggedIn: true
curl http://127.0.0.1:30001/QueryDB/debug       # 补丁版才有这条路由（官方版没有）
curl "http://127.0.0.1:17300/api/members?room=<群id>"   # 群成员真实昵称
```

---

## 5. 接入大脑（二选一）

### 5.1 用 DSH 插件（人设 + LLM + 记忆）

见 [wechat-group-agent/README.md](wechat-group-agent/README.md)（装进 DSH profile 的 node_modules 并在 patch 里启用）。
**记得保持 `hosted.enabled = false`**，否则双重回复。

### 5.2 用外部 agent（托管模式）

桥替 agent 管节流/作息/记忆/打字节奏，agent 只需回一段文字：

```powershell
# 打开托管模式，指向你的 agent
curl -X POST http://127.0.0.1:17300/api/hosted -H 'content-type: application/json' -d '{
  "enabled": true,
  "webhookUrl": "http://127.0.0.1:9999/reply",
  "botName": "我的机器人"
}'
```

桥会在**判定该回**时 POST 给你（详见 [wx-bridge/PROTOCOL.md](wx-bridge/PROTOCOL.md) 第四节），你回：

```json
{ "text": "在呢，咋了", "sticker": { "subject": "摸鱼", "bubble": "别叫我" } }
```

### 5.3 用 MCP 客户端（Claude Desktop / Cursor / Cline …）

```json
{
  "mcpServers": {
    "wechat": {
      "command": "node",
      "args": ["<绝对路径>/wx-bridge/mcp-server.mjs"]
    }
  }
}
```

---

## 6. 排错

| 现象 | 原因 / 解决 |
|---|---|
| `/api/status` 里 `loggedIn: false` | 微信没登录完，等 30 秒；或看 `wx-bridge` 日志 |
| `GetAllDBName` 返回 `[]` | **Hook 没加载或被系统 `version.dll` 抢了**：确认客户端加载的是你放的那份；用 `/QueryDB/debug` 判断（404 = 不是补丁版）。桥内置自愈：连续 3 次探测失败会自动重启客户端 |
| 收不到消息 | 数据库轮询没起来 → 看日志 `数据库轮询就绪`；DB 坏了会导致收不到消息（同上一条） |
| 群里回复两次 | DSH 插件和托管模式同时开着 → 关掉一个 |
| 图片识别失败 | 原图没下载（微信只拉了缩略图）或解密密钥失效 → 在微信里点开一次图片可让密钥进内存，然后 `python wx-bridge/decode-wechat-image.py --find-key` |
| 微信自动更新导致 Hook 失效 | 换回 4.1.10.27，或重新编译适配新版（见 `docs/`） |

---

## 7. 🤖 AI 一键部署（把这段直接喂给 AI）

> 下面是一段给 AI agent 的可执行说明。**请逐条执行并在每步后验证**，不要跳步。

```
务务：在本机部署 dsh-wechat-bot（微信群聊机器人）。系统是 Windows。请按顺序执行，每步验证后再继续。

前置检查：
1. 确认 node -v >= 18、python --version >= 3.10；缺则用 winget 安装。
2. python -m pip install pycryptodome zstandard
3. 确认本机有微信 4.1.10.27 客户端（目录下有 4.1.10.27\ 子目录）。没有则停止并告知用户。

准备独立的微信副本：
4. robocopy "<用户日常微信目录>" "D:\wxhook\wx4110" /E
   （严禁直接修改用户日常微信目录）

获取 Hook：
5. git clone https://github.com/aixed/WeChat-Hook.git E:\wxhook-src\WeChat-Hook
6. 在仓库内执行 git apply <本项目>\patches\wechat-hook-querydb-fix.patch
7. 若无 MSBuild：winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
8. 用 MSBuild 编译 x64_Version_dll.vcxproj（Release|x64），把产物复制到 D:\wxhook\wx4110\version.dll
   （复制前先备份原文件为 version.dll.bak）

配置与启动：
9. 复制 config.example.json 为 config.json，把 wechatExe 改成 D:\wxhook\wx4110\Weixin.exe
10. cd wx-bridge && npm install && npm start（后台运行，日志重定向到文件）
11. 等待 40 秒，验证：
    - curl http://127.0.0.1:17300/api/status  → loggedIn 应为 true
    - curl http://127.0.0.1:30001/QueryDB/debug → 应有 JSON（若无此路由说明加载的不是补丁版 DLL，
      需停掉客户端、确认 version.dll 就位、重新启动客户端）
    - curl http://127.0.0.1:17300/api/rooms → 应列出群

完成标准：/api/status 返回 loggedIn=true 且 /api/rooms 能列出至少一个群。
若失败，请按 DEPLOY.md 第 6 节排错，并把日志贴给用户。
```

---

## 8. 可选：常驻运行

```powershell
# 用务务计划程序开机自启（示例）
schtasks /create /tn "wx-bridge" /tr "node <绝对路径>\wx-bridge\server.mjs" /sc onlogon /rl highest
```
