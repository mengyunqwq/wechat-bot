# 微信机器人

把微信变成一个有性格、有记忆、会发表情包、看得懂图的**群聊机器人**，并提供 **MCP / WebSocket / HTTP** 三种接口，让**任意 AI agent** 都能驱动它。

---

## ⚠️ 二次开发声明（请务必先读）

**本项目属于「二次开发」产物，不是从零原创的完整方案。** 具体边界如下：

| 组成 | 来源 | 我们的工作 |
|---|---|---|
| **微信 Hook（`version.dll`）** | 第三方项目 [aixed/WeChat-Hook](https://github.com/aixed/WeChat-Hook)（**无 LICENSE**） | **我们改了它的 C++ 源码并自行编译部署**（共 5 处：修 QueryDB 门禁/自愈/JSON 加固/懒加载重扫 + 调试路由）。**源码与算法版权归原作者**；本仓库**只给补丁、不给二进制**，你需自行获取源码后 `git apply` |
| **微信客户端** | 腾讯 | 仅本地调用，**不修改、不分发** |
| **接入层 / 拟人策略 / MCP / REST / 托管模式 / 图片解密工具** | 本项目原创 | 全部自研 |
| **DSH 插件形态** | 运行于 [DeepSeek Harness](https://github.com/deepseek-ai) 的插件体系 | 按平台规范自研 |
| **图片解密格式（V2）** | 社区公开资料（[吾爱破解分析帖](https://www.52pojie.cn/thread-2092367-1-1.html) 等） | 我们做的是**适配与工程化**，非从零逆向 |

**因此**：

1. 使用本项目需要你**自行获取**微信 Hook 项目（并遵守其许可），本项目只给补丁与说明。
2. **请自行评估合规风险**：修改/挂钩微信客户端可能违反腾讯的用户协议，账号存在被封禁的可能。**请仅用于个人学习研究，不要用于商业用途或骚扰他人。**
3. 本项目**不含任何微信账号、密钥、聊天数据**。所有配置都需要你自己填写。

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| **拟人聊天** | 不是"有问必答"：闲聊按概率插话、被 @ 必回、打字延迟、偶尔拆成两条、会走神（延迟变长）、深夜睡觉 |
| **作息** | 23:00 睡 / 08:00 醒（可配）。睡觉时**不主动插话，但被 @ 仍会回**；睡前道晚安、醒来打招呼 |
| **长期记忆** | 本地 JSON 保存；自动提炼"谁是谁、谁喜欢什么、约定、事件"；**每个群记忆独立** |
| **认识群里的人** | 从微信数据库读**真实昵称**（备注优先），会 @ 对人；也能自动认出"哪个是自己" |
| **表情包** | 图库挑选 + 用 Agnes 图生图**现场生成**（角色固定、场景自由、**文字气泡本地绘制**保证字清楚）；**回复不等图**，生成好了再补发 |
| **识图** | 群里发的图片**自动解密**（微信本地是加密存储的）→ 视觉模型识别 → 参与聊天；识别完**删除临时文件** |
| **联网搜索** | 模型自己判断什么时候该查（新闻/天气/事实核实），日常闲聊不搜 |
| **防重复** | 同一句话不重复回、同一问题不追问、回复内容不重发 |
| **多 agent 接入** | **MCP Server**（Claude Desktop / Cursor / Cline 等直接挂）、**REST API**、**WebSocket**、**托管模式**（桥替 agent 管节流，agent 只管"说什么"） |

---

## 架构

```
微信客户端（含改造版 version.dll）
        │  HTTP 30001 + 回调
        ▼
   wx-bridge（独立 Node 服务）
        ├── 数据库轮询收消息（不依赖回调，还能拿到真实昵称）
        ├── 图片解密（内存取密钥 + V2 解密）
        ├── 表情包库 / Agnes 生图 / 气泡绘制
        ├── REST API  ← 控制面板 / 脚本 / 任意 agent
        ├── MCP Server ← Claude Desktop / Cursor / Cline …
        └── 托管模式（拟人策略 + webhook 调外部 agent）
        │  WebSocket
        ▼
   大脑（二选一）
        ├── DSH 插件 wechat-group-agent（人设 + LLM + 记忆）
        └── 外部 agent（经托管模式）
```

**重要**：`DSH 插件` 与 `托管模式` 是**两个大脑**，同时开启会导致**每条消息回复两次**。用哪个就开哪个（桥会打印警告提醒）。

---

## 快速开始

```powershell
# 1) 前置：Node 18+、Python 3.10+（含 pycryptodome）
# 2) 克隆
git clone <本仓库地址> wechat-bot
cd wechat-bot

# 3) 一键安装（装依赖 + 生成配置模板 + 检查环境）
powershell -ExecutionPolicy Bypass -File .\install.ps1

# 4) 填配置（微信路径、Python 路径、可选 LLM key）
notepad .\config.json

# 5) 起桥
cd wx-bridge
npm start
```

**完整部署步骤（含微信 Hook 编译、回调/轮询、排错）见 [DEPLOY.md](DEPLOY.md)。**

> 给 AI agent 的部署说明也在 DEPLOY.md 里（"AI 一键部署"小节），可直接喂给另一个 AI。

---

## 目录结构

```
wx-bridge/                  接入层（独立 Node 服务）
  server.mjs                WebSocket + REST 主服务
  mcp-server.mjs            MCP Server（stdio JSON-RPC）
  PROTOCOL.md               接口协议（MCP / WS / HTTP / 托管 / 策略服务）
  decode-wechat-image.py    微信加密图片解密（V2）
  add-bubble.py             给表情包画文字气泡
  lib/
    wechat-hook.mjs         hook 传输（发消息、取媒体、防更新守卫、看门狗）
    db-poller.mjs           数据库轮询收消息（替代缺失的回调推送）
    wechat-image.mjs        定位/解密聊天图片
    policy.mjs              拟人策略（延迟/拆分/作息/节流）—— 零依赖
    hosted.mjs              托管模式（webhook 调外部 agent）
    api-http.mjs            REST API
    stickers.mjs            表情包库
    genimage.mjs            Agnes 图生图

wechat-group-agent/         DSH 插件（人设大脑，可选）
patches/                    对第三方微信 Hook 的补丁
docs/                       补充文档
install.ps1                 一键安装
scripts/build-hook.ps1      自动构建我们改造过的 Hook（上游无 LICENSE，故不发二进制）
config.example.json         配置模板
```

---

## 已知限制（诚实说明）

| 限制 | 原因 |
|---|---|
| **发不出真正的 @ 提醒**（只是文本"@名字"） | Hook 的 `BuildTextMessage` 不写 `atlist` 字段 |
| **群图片依赖本地缓存** | 微信未下载原图时只能拿到缩略图；解密密钥在微信进程内存里，客户端重启后偶发失效（桥已内置自愈：连续探测失败自动重启客户端） |
| **不支持视频/语音识别** | 未实现 |
| **依赖第三方 Hook** | 微信升级后偏移可能失效，需要自行适配（见 `docs/`） |

---

## 致谢

- [aixed/WeChat-Hook](https://github.com/aixed/WeChat-Hook) —— 微信 Hook 本体（本项目在其之上做了二次开发）
- [DeepSeek Harness](https://github.com/deepseek-ai) —— 插件运行平台
- [吾爱破解相关分析帖](https://www.52pojie.cn/thread-2092367-1-1.html) —— 微信 4.x 媒体解密思路
- `fzstd` / `ws` / `jimp` / `pycryptodome` / `zstandard` 等开源库

## 许可

本项目**原创部分**采用 MIT（见 [LICENSE](LICENSE)）。
**第三方部分（微信 Hook、微信客户端）版权归各自作者**，本项目不分发其二进制，仅提供补丁。
使用前请阅读 [NOTICE.md](NOTICE.md)。
