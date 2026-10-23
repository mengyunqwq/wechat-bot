# 部署指南

> 目标：从零把机器人跑起来。**约 30 分钟**（不含下载 VS 编译环境）。
>
> 🤖 **一键部署（推荐）**：把 **[docs/AI-一键部署.md](docs/AI-一键部署.md)** 第 2 节整段复制给任意 AI 客户端
> （豆包电脑版 / Claude Desktop / Cursor / Cline / DSH…），它会自己查环境 → 装依赖 → 复制独立微信 →
> 拿 Hook → 改配置 → 启动 → 逐项验证。人类只需提供 **2 样东西**（微信安装目录 + 一个可以牺牲的微信号）。
> 本文档是人读的完整版；AI 版含**逐字段配置说明、完整验证清单、装好之后怎么用**。
> 文末第 7 节保留了简版「AI 一键部署」段落。

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

## 2. 获取微信 Hook（version.dll）

> ⚠️ **上游官方的预编译版不能用**：`QueryDB` 是坏的（`g_IsLogin` 恒为 0），也没有回调推送实现
> → 收不到群消息、拿不到群昵称。必须用本项目构建的 DLL。

### 方案 A：下载成品包（推荐，不用编译）

1. 拿成品：**克隆仓库后直接用 `release/` 目录里的文件**（或从 [Releases 页](https://github.com/mengyunqwq/wechat-bot/releases/latest) 下载同样 4 个文件）：`version.dll`、`install.ps1`（一键安装）、`rollback.ps1`（一键回滚）、`SHA256.txt`
2. **完全退出微信**（任务管理器里 `Weixin.exe` 进程数为 0）
3. 解压到任意目录（**不要解压到 `%TEMP%`**，Defender 可能删掉里面的 dll），运行 `install.ps1`（一键安装）
   —— 它会自动备份旧 DLL、覆盖、配置重放开关
4. 启动微信 → 登录后**点一次左侧「通讯录」**（让 `contact.db` 打开）

成品包里有什么：

```
version.dll        编译好的 Hook（含语音发送 + 数据库 late-arm 修复）
install.ps1         退出微信 → 备份 → 覆盖 → 配重放
rollback.ps1        还原到安装前的 DLL
README.txt / SHA256.txt
```

> 想用一条命令走完部署：
> ```powershell
> 手动步骤见本文第 1~4 节；也可以把 [docs/AI-一键部署.md](docs/AI-一键部署.md) 整段交给 AI 代为执行。
> ```

### 方案 B：自行编译（需要源码 + 补丁，不推荐新手）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-hook.ps1
```

前提：本机已有上游源码与本项目补丁（补丁不随仓库发布）。脚本会装/检查 VS Build Tools、
克隆上游、应用补丁、编译、备份并部署旧 DLL。

> **只有原版源码时请先读 [docs/安装流程.md](docs/安装流程.md) 第 2.2 节** ——
> 原版是 3.9.x 的，偏移与接口都对不上 4.1.10.27，编出来也接不上；文档里写了缺什么、接口契约是什么。

<details>
<summary>手动编译（等价于脚本做的事）</summary>

```powershell
# 1) 克隆上游
git clone https://github.com/aixed/WeChat-Hook.git C:\wxhook-src\WeChat-Hook
cd C:\wxhook-src\WeChat-Hook
git submodule update --init --recursive

# 2) 应用本项目补丁（补丁需另行获取）
git apply <补丁目录>\wechat-hook-querydb-fix.patch

# 3) 装编译环境（若没有）
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# 4) 编译
& "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe" `
  x64_Version_dll.vcxproj /m /t:Build /p:Configuration=Release /p:Platform=x64

# 5) 部署（先备份原文件！）
copy C:\wxhook-src\WeChat-Hook\x64\Release\version.dll D:\wxhook\wx4110\version.dll
```

编译细节与常见错误见 [docs/安装流程.md](docs/安装流程.md)。

</details>

> **为什么 DLL 放在 Release 附件而不是仓库里？**
> 仓库保持"纯源码"，`.gitignore` 挡住 `*.dll` / `*.zip`；二进制作为 Release 附件分发，
> 方便不会编译的用户，也便于随时替换/下架。

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

## 3.1 接入你自己的图片生成 key（表情包 / 视频，可选）

**本仓库不含任何密钥。** 表情包的"现场生成"和视频生成都需要**你自己**接入一个图像服务。

### 用哪个服务

| 用途 | 后端 | 环境变量 | 说明 |
|---|---|---|---|
| 表情包（图生图） | Agnes AI | `AGNES_API_KEY` | 主要用途；接口 `POST https://apihub.agnes-ai.com/v1/images/generations` |
| 视频（可选） | Agnes AI | `AGNES_API_KEY` | 同一个 key 即可 |
| 视频（可选） | xAI (Grok Imagine) | `XAI_API_KEY` | 想换后端时用 |

### 怎么配（二选一，推荐环境变量）

```powershell
# 方式一：环境变量（推荐 —— key 不落进任何文件）
$env:AGNES_API_KEY = "你自己的key"                                            # 只对当前会话
[Environment]::SetEnvironmentVariable('AGNES_API_KEY','你自己的key','User')   # 永久（用户级）
```

```yaml
# 方式二：写进 DSH 的凭据文件 ~/.dsh/.credentials.yaml（与其它凭据放一起）
refs:
  AGNES_API_KEY: 你自己的key
```

**取用顺序**：环境变量优先，没有才读凭据文件（两个插件都是这个逻辑，改完立即生效、不用重启）。

### 不配会怎样

- **表情包**：只用图库里**现成的图**（挑选 + 发送都正常）→ 功能完整可用，只是不会现场生成
- **视频**：工具会显示"缺凭据"，调用报错 → 不影响其它功能

### 两个必须知道的点

1. **参考图要自己准备**：表情包走的是"**图生图**"，会把一张角色基准图作为主体参考（`genSticker` 的 `refImage` 参数）。
   你得自己准备这个角色的基准图；不提供的话，生成出来的角色会飘（换脸/换配色）。
2. **存在后台自动生成**：当"群里有话题但图库里没有合适表情"时，接入层会**自动排队补生成**
   （见 `wx-bridge/server.mjs` 的后台补生成队列）。**不想让它自动消耗额度的话，把那段关掉即可。**

⚠️ **不要把 key 写进仓库、也不要提交到 git。** 也**不建议**把 key 放进 `config.json` ——
本项目的设计就是"**环境变量 / 本地凭据文件**"，仓库里永远只有占位符。

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

> **控制面板（v1.2.0 起是 DSH 原生插件 UI）**
>
> 插件把 `panel/index.html` 注册进了 DSH 界面本体 —— DSH 左侧面板列表会出现
> **🐋 微信机器人**，点开就是完整控制面板；独立地址 `/wechat-bot` 保留（手机/局域网用）。
>
> **三个必须知道的点**：
>
> 1. **必须走官方装配**（profile `bundles` / cordis patch）。运行时 `loader.create`
>    注入的 entry 名是随机 hex，`dsh-client-modules` 不会扫描它 → 图标不出现；
> 2. 装好后**重启一次 `dsh web`** —— 宿主只在启动时组合 client 启动图；
> 3. 改过面板源码要重跑 `node build-client.mjs`（在 `wechat-group-agent/` 下，
>    生成 `lib/client.js`）。
>
> 验证：`curl "http://127.0.0.1:3080/plugins/??@dsh-external/dsh-wechat-bot/client.js&rev=<rev>"`
> 返回 200 表示已进组合图；404 表示宿主没扫到（回查上面三条）。

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

### 5.4 用豆包电脑版（让 AI 自己装 / 手动加连接器）

豆包电脑版支持挂 **MCP 连接器**。注意：**本项目自带的 MCP 服务是 `stdio` 的**
（本地子进程，不是 HTTP 服务），所以按下面两种方式接入。

#### 方式一：让豆包自己装（推荐，最省事）

新建一个对话，把下面这**整段**（含花括号，看起来像代码但直接发就行）发给它：

```
帮我安装一个本机微信机器人的 MCP，配置信息如下：
{
  "mcpServers": {
    "wechat": {
      "command": "node",
      "args": ["<绝对路径>\\wx-bridge\\mcp-server.mjs"]
    }
  }
}
```

把 `<绝对路径>` 换成你 clone 本项目的路径（例如 `D:\dsh-wechat-bot`）。
过程中它若请求确认，选同意即可。**装好的标志**：连接器列表里出现名为 `wechat` 的条目。

#### 方式二：手动新建自定义连接器

左侧进入「**技能 · 连接器 · 伙伴**」→ 右上角「**新建**」→「**新建自定义连接器**」，
然后按界面实际提供的字段填：

| 界面字段 | 填什么 |
|---|---|
| 服务名称 | `wechat` |
| 传输类型 | 若有 **stdio / 本地命令 / command** 之类的选项 → 选它；命令填 `node`，参数填 `<绝对路径>\wx-bridge\mcp-server.mjs` |
| 传输类型 | 若**只有 HTTP / SSE** → 见下面「⚠️ 只支持 HTTP 怎么办」 |

保存后按提示启用（若有「去授权」就点一下），确认 `wechat` 右侧开关已打开即接入完成。

#### ⚠️ 只支持 HTTP 怎么办

部分版本的豆包（以及「豆包工作」）的自定义连接器**只接受 HTTP 类型的 MCP**，
而本项目的 `mcp-server.mjs` 是 **stdio**。遇到这种情况：

1. **先试方式一** —— 不少客户端能识别 `command` / `args` 这种本地命令配置；
2. **不行就换入口**（都不需要 MCP）：
   - **REST API**：桥自带 HTTP 接口，任何能发 HTTP 请求的工具都能用；
   - **托管模式**：桥把消息 webhook 给你的 agent，agent 回一个 HTTP 请求就能发言（见 §5.2）；
   - **DSH 插件**：直接用本项目自带的大脑（见 §5.1）。

> 如果你的豆包版本确实只收 HTTP，可以在 issue 里提一句 —— 给桥加一个 HTTP 版 MCP 端点是可行的。

#### 接好之后怎么验证

在对话里说：

```
请用 wechat MCP 列出当前有哪些群。
```

能列出群名就说明通了。之后可以自然语言驱动它发言：

```
请用 wechat MCP 往「XXX 群」发一条：大家好，我来了。
```

⚠️ **安全提醒**：这个 MCP 能让 AI **以你的微信身份发消息**。不要把它暴露到公网，
也不要在不受信任的对话里挂着它。用完随手关掉连接器开关。

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

> 📄 **完整版见 [docs/AI-一键部署.md](docs/AI-一键部署.md)** —— 那份是自包含的，含：
> 逐字段配置说明（`config.json` 每个字段 + 环境变量 + hook 开关文件 + 插件热改键）、
> 完整验证清单（24 项可勾选）、装好之后怎么用、12 条常见问题、**已知文档/代码不一致清单**。
> 下面这段是**精简版**，赶时间可以用它，但更容易在细节上卡住。
> ⚠️ **AI 同时看到两段时，以 [docs/AI-一键部署.md](docs/AI-一键部署.md) 第 2 节为准** ——
> 那段包含本段缺失的「起桥前必须先补的两个缺失模块」，否则 `npm start` 会直接退出。
>
> 下面是一段给 AI agent 的可执行说明。**请逐条执行并在每步后验证**，不要跳步。
> 适用任何能读写本机文件的 AI 客户端（豆包电脑版 / Claude Desktop / Cursor / Cline …）。
> 在**豆包电脑版**里就是新建对话 → 把下面整段贴进去 → 它自己一步步做（见 §5.4 的截图同款流程）。

```
任务：在本机部署 dsh-wechat-bot（微信群聊机器人）。系统是 Windows。请按顺序执行，每步验证后再继续。
前置检查：
1. 确认 node -v >= 18、python --version >= 3.10；缺则用 winget 安装。
2. python -m pip install pycryptodome zstandard
3. 确认本机有微信 4.1.10.27 客户端（目录下有 4.1.10.27\ 子目录）。没有则停止并告知用户。

准备独立的微信副本：
4. robocopy "<用户日常微信目录>" "D:\wxhook\wx4110" /E
   （严禁直接修改用户日常微信目录）

获取 Hook：
5. git clone https://github.com/aixed/WeChat-Hook.git C:\wxhook-src\WeChat-Hook
6. 应用补丁（补丁需另行获取）：git apply <补丁目录>\wechat-hook-querydb-fix.patch
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
# 用任务计划程序开机自启（示例）
schtasks /create /tn "wx-bridge" /tr "node <绝对路径>\wx-bridge\server.mjs" /sc onlogon /rl highest
```
