
> ⚠️ **动手改部署前请先读 [docs/OPERATIONS-RULES.md](docs/OPERATIONS-RULES.md)** ——
> 那里记着「为什么不能强杀微信 / 为什么不能自动拉起客户端 / 为什么看门狗只做进程内自愈」，
> 每一条都是真实事故换来的。重启客户端请用 [scripts/safe-restart-client.ps1](scripts/safe-restart-client.ps1)（会先备份、正常退出、等加载）。
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
   - 其中"**表情包现场生成 / 视频生成**"需要你自己接入一个图像服务的 key（**环境变量**或本地凭据文件，
     仓库里永远只有占位符）→ 见 [DEPLOY.md §3.1 接入你自己的图片生成 key](DEPLOY.md#31-接入你自己的图片生成-key表情包--视频可选)。
     **不配也能用**：表情包会自动退化为"只用现成图库"。

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| **拟人聊天** | 不是"有问必答"：闲聊按概率插话、被 @ 必回、打字延迟、偶尔拆成两条、会走神（延迟变长）、深夜睡觉 |
| **作息** | 23:00 睡 / 08:00 醒（可配）。睡觉时**不主动插话，但被 @ 仍会回**；睡前道晚安、醒来打招呼 |
| **长期记忆** | 本地 JSON 保存；自动提炼"谁是谁、谁喜欢什么、约定、事件"；**每个群记忆独立** |
| **认识群里的人** | 从微信数据库读**真实昵称**（备注优先），会 @ 对人；也能自动认出"哪个是自己" |
| **表情包** | 图库挑选 + 用 Agnes 图生图**现场生成**（角色固定、场景自由、**文字气泡本地绘制**保证字清楚）；**回复不等图**，生成好了再补发 |
| **识图** | 群里发的图片**自动解密**（微信本地是加密存储的）→ **优先取原图**（不再拿 8KB 缩略图去识别）→ 视觉模型识别 → 参与聊天；识别完**删除临时文件** |
| **视频识别** | 群里发的视频：**抽 N 帧拼成一张联系表**（一次视觉调用，省钱）+ **抽音轨走本地语音识别**（视频里说的话也能拿到）→ 参与聊天；**读完删除视频原文件**（省磁盘）；视频没下载时退化为**明文封面**，再不行就 `[视频]` |
| **🔊 语音识别** | 群里发的语音**自动转成文字**再当普通消息处理（本地 SenseVoice，**不需要任何 API key**）；详见下面「语音识别」一节 |
| **🎤 语音气泡（会说话）** | 机器人能**发出真正的微信语音**（type 34，可以点播的那种）——文字 → 本地 TTS 合成 → SILK → 调微信自己的语音发送链；详见下面「语音气泡」一节 |
| **真 @ 提醒** | 正文里写 `@群昵称`，同时把被 @ 人的 **wxid 传进 `atlist`** → 对方**真的会收到红点提醒**（不是只有文本"@名字"那种假 @）|
| **即时收消息** | hook 在写入消息表时**主动通知**桥（轻量通知 + 同表 500ms 去重）→ 桥立刻轮询该群，不再等 2.5 秒轮询周期 |
| **一键自检 / 失联监控** | `wechat_bot_selfcheck` 工具：桥连接/微信登录/hook 存活/数据库可读/消息轮询/自己是谁/群昵称一致性/语音识别/识图/表情包库/记忆/LLM 路由 **12 项只读体检**，逐项 ✅❌⚠️ 并给修复建议；另有**心跳监控**，失联时通过文件传输助手告警（静默期 30 分钟，避免刷屏） |
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
        ├── 图片解密（内存取密钥 + V2 解密，**优先取原图**而不是缩略图）
        ├── 语音解码（media_0.db 取明文 SILK → 16kHz WAV，交给大脑转写）
        ├── 视频处理（抽帧拼联系表 + 抽音轨；ffmpeg 走 imageio-ffmpeg，不依赖系统 ffmpeg）
        ├── 表情包库 / Agnes 生图 / 气泡绘制
        ├── REST API  ← 控制面板 / 脚本 / 任意 agent
        ├── MCP Server ← Claude Desktop / Cursor / Cline …
        └── 托管模式（拟人策略 + webhook 调外部 agent）
        │  WebSocket
        ▼
   大脑（二选一）
        ├── DSH 插件 wechat-group-agent（人设 + LLM + 记忆 + 语音/视频识别 + 一键自检与失联监控）
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

> 🤖 **想让 AI 替你装？** 把 **[docs/AI-一键部署.md](docs/AI-一键部署.md)** 第 2 节整段复制给任意 AI 客户端
> （豆包电脑版 / Claude Desktop / Cursor / Cline / DSH…），它会自己完成环境检查 → 装依赖 → 复制独立微信 →
> 编译 Hook → 改配置 → 启动 → 逐项验证。你只需提供**微信安装目录**和**一个可以牺牲的微信号**。

---

## 目录结构

```
wx-bridge/                  接入层（独立 Node 服务）
  server.mjs                WebSocket + REST 主服务
  mcp-server.mjs            MCP Server（stdio JSON-RPC）
  PROTOCOL.md               接口协议（MCP / WS / HTTP / 托管 / 策略服务）
  decode-wechat-image.py    微信加密图片解密（V2）
  decode-wechat-voice.py    微信语音解码（SILK → 16kHz/mono/PCM16 WAV，纯 Python）
  video-probe.py            视频抽帧 + 拼联系表 + 抽音轨（自带 --selftest）
  tts-silk.py               文字 → 语音（edge-tts → 24k PCM → pilk → SILK，自带 --selftest）
  test-tts.mjs              语音合成自测（node test-tts.mjs）
  add-bubble.py             给表情包画文字气泡
  lib/
    wechat-hook.mjs         hook 传输（发消息、取媒体、防更新守卫、看门狗）
    db-poller.mjs           数据库轮询收消息（替代缺失的回调推送）
    wechat-image.mjs        定位/解密聊天图片（优先原图）
    wechat-voice.mjs        语音元数据解析 + SILK 解码调度
    wechat-video.mjs        视频文件/封面定位 + 抽帧抽音轨调度
    tts.mjs                 语音合成（synthesizeVoice，含情绪预设与护栏）
    policy.mjs              拟人策略（延迟/拆分/作息/节流）—— 零依赖
    hosted.mjs              托管模式（webhook 调外部 agent）
    api-http.mjs            REST API
    stickers.mjs            表情包库
    genimage.mjs            Agnes 图生图
    mock.mjs                假数据源（本地调试用，不连微信）

wechat-group-agent/         DSH 插件（人设大脑，可选）
  lib/
    index.js                插件主逻辑（人设/记忆/语音/视频/自检/心跳）
    policy.mjs              回复决策策略
    bridge-client.mjs       与 wx-bridge 的 WebSocket 客户端
patches/                    对第三方微信 Hook 的补丁
docs/                       补充文档（含 hook-patch-notes.md、media-download-re.md）
DEPLOY.md                   部署文档（含"接入你自己的图片生成 key"）
NOTICE.md                   第三方声明与许可说明
install.ps1                 一键安装
scripts/build-hook.ps1      自动构建我们改造过的 Hook（上游无 LICENSE，故不发二进制）
scripts/gen-offset-patterns.py  从微信版本生成偏移特征（Hook 适配用）
scripts/start-bot.ps1       一键启动（.cmd 为快捷方式）
config.example.json         配置模板
```

---

## 安全提示

**Hook 的 HTTP 接口默认只监听 `127.0.0.1`**（不是 `0.0.0.0`）。

这些接口**没有任何鉴权**：`/SendTextMsg` 能以你的账号发消息，`/QueryDB/execute` 能执行任意 SQL 读写微信数据库。
如果监听在 `0.0.0.0`，**同一局域网内任何人都能直接控制你的微信账号**。
接入层（wx-bridge）在同一台机器上，用回环地址就够了；确需远程访问请自建反向代理 + 鉴权，不要直接改成 `0.0.0.0`。

（补丁里已改成 `127.0.0.1`；若你用的是官方预编译版，请自行确认监听地址。）

## 🔊 语音识别（群里发语音 → 转成文字 → 当普通消息回复）

微信语音（`local_type=34`）是 **SILK v3** 编码，音频**不在文件系统里**，而在
`media_0.db` 的 **`VoiceInfo.voice_data`（BLOB，明文 SILK，不需要 AES 解密）**，
用 `local_id` 与消息表 `Msg_<hash>` 关联（两边是同一个值）。链路：

```
微信语音消息（local_type=34，XML 里只有元数据）
  → wx-bridge 查 media_0.db / VoiceInfo.voice_data（local_id 关联；磁盘目录只作兜底）
  → 剥掉容器前缀（1 字节 0x02，从 #!SILK_V3 处开始取）
  → decode-wechat-voice.py（pilk 解 SILK + 纯 Python 重采样）
  → 16kHz / 单声道 / PCM16 WAV（DSH 语音服务的硬要求）
  → 事件字段 voiceWav → 插件调 ctx.speechToText 转写
  → 转写文字当普通消息文本（记忆 / @ 识别 / 回复都按文本走）→ 删临时 WAV
```

实测样例（一条 1.4 秒语音）：`voice_data` 2488 字节 → 剥前缀后 2487 字节 SILK →
WAV 1.42s / 45484 字节 → 转写结果「干什么干什么？」（CPU 推理 0.08s）。

### 需要什么（**不需要任何额外 API key**）

| 依赖 | 说明 | 不装会怎样 |
|---|---|---|
| DSH 的**「语音输入」bundle** | 提供 `ctx.speechToText` 服务，provider id = `sensevoice-local` | 插件日志打印"没有 speechToText 服务" → 语音保持 `[语音]` |
| **本地 SenseVoice 模型（约 239MB）** | 首次自动下载到 `<DSH_HOME>/speech-to-text/sensevoice/models/`；也可在 DSH 设置里手动"准备" | 转写报错 → 保持 `[语音]`（下载会继续，下一条语音即可用） |
| `pip install pilk` | 纯 Python SILK 解码（**不依赖 ffmpeg**） | 解码失败只记日志 → 保持 `[语音]` |

- 服务侧只接受 **canonical 16kHz / mono / PCM16 WAV**（逐字段校验头部），
  本仓库的 `decode-wechat-voice.py` 就是按这个契约产出的（`--selftest` 会逐项校验头部）。
- 语音处理是**纯旁路**：定位不到音频、解码失败、模型没准备、转写报错 —— 全都只记日志，
  消息照旧按 `[语音]` 走，**不会阻塞回复、不会抛错**。
- 关掉语音识别：环境变量 `WECHAT_VOICE=0`（桥侧），或插件配置 `voiceOnVoice: false`。

---

## 🎬 视频识别（群里发视频 → 抽帧 + 音轨 → 当普通消息回复）

微信视频消息（`local_type=43`）的画面和声音**都不在消息里**，而且视频文件**按需下载**。
本项目的做法是**三层降级**，每一层都确定"拿到的是这条视频"：

```
视频消息
 ├─ ① 视频文件已落盘（<数据根>\msg\video\<年-月>\<hash>.mp4）
 │     → ffmpeg 按时间均匀抽 N 帧（默认 6，短视频自动少抽）
 │     → Pillow 拼成一张带时间戳的【联系表】→ 一次视觉调用（省钱，不逐帧调）
 │     → 同时抽音轨成 canonical 16kHz/mono/PCM16 WAV → 走语音链路转写（视频里说的话）
 │     → 合成「[视频 6s：画面（抽了 6 帧）：…；音频转写：…]」→ 当普通消息进对话
 ├─ ② 视频没落盘 → 用【明文封面】`<hash>_thumb.jpg`（微信给每条视频都存了一张 JPG，未加密）
 │     + 后台 +60s / +180s 复查：这期间若有人点开、文件落盘 → 自动升级为全部内容 + 补一句话
 └─ ③ 连封面都没有 → 保持 `[视频]`，绝不阻塞回复
```

**匹配守卫（重要）**：靠 `mtime 最接近消息时间（±30 分钟）` 找文件，但**先用 XML 声明的字节数
硬筛**（差 >10% 的候选直接丢弃）。否则群里两条视频挨着、第二条还没落盘时，会拿**第一条的内容**
去描述这一条 —— 描述错的视频比只用封面更糟。

**读完删掉**：识别完成后删掉微信落盘的那个原文件（省磁盘；下次点开微信会重新下载）。
配置 `videoDeleteAfterRead`（默认开）；删除前再复核一次大小，只删校验通过的那一个，封面永不删。

### 关于"自动下载"（诚实说明）

微信 CDN 下载**不是普通 GET**，而是 mars 的 KV 协议 POST，硬断言要求非空 `authkey` + `META`，
而 `authkey` **不在** `videomsg` XML 里（那里只有 `aeskey`/`cdnvideourl`/`cdnthumburl`/`md5`/`length`）。
本项目**实测否掉了"自己拼直链下载"**：36 个主机 × 多种形态全部被 CDN 边缘拒绝（404/408/400，
无一个 200），而 `*/download` 路由确实存在但返回 408（鉴权不过，不是文件不存在）。

所以只能等"**在这个客户端上点开一次**" —— 上面的延迟复查就是把这个动作的收益最大化。
完整逆向结论（含全部 RVA、汇编片段、可复用的 AES 解密器）见 `docs/media-download-re.md`。

### 需要什么（**不需要任何额外 API key**）

| 依赖 | 说明 | 不装会怎样 |
|---|---|---|
| `pip install imageio-ffmpeg` | 自带**静态 ffmpeg**（本项目不依赖系统 ffmpeg） | 抽帧/抽音轨失败 → 只记日志 → 退回封面 |
| `pip install Pillow` | 拼联系表 | 同上 |
| DSH 的**「语音输入」bundle** | 音轨转写（与语音识别同一个服务） | 只有画面、没有音频文字 |
| 视觉模型 | 走 DSH 的 attachments（与识图同一个） | 退回封面 / `[视频]` |

- 抽帧 / 转码 / 转写全是**纯旁路**：找不到文件、解码失败、模型不可用 —— 都只记日志，
  消息照旧走封面或 `[视频]`，**不会阻塞回复、不会抛错**。
- 关掉视频识别：`visionOnVideo: false`；抽帧数：`videoFrames`（1~12）；
  关掉读完删掉：`videoDeleteAfterRead: false`。

---

## 🎤 语音气泡（让机器人"说话"）

机器人能发出**真正的微信语音**（`local_type=34`，可以点播的那种气泡）。链路：

```
文字
  → edge-tts 在线合成（微软，免费、不需要任何 key）
  → ffmpeg 转 24kHz 单声道 PCM（走 imageio-ffmpeg，不依赖系统 ffmpeg）
  → pilk 编码成 SILK v3（头部 #!SILK_V3，与微信自己的语音逐字节同构）
  → 调微信自己的语音发送链（hook 新增的 /SendVoiceMsg）
  → 群里出现一条真正的语音气泡
```

**关键实现点**：
- **语音对象不手搓，调微信自己的工厂**（`0x619A190`，`new(0x778)`）。原因：内层 ctor（`0x619B3B0`）会生成 GUID 并建立**自引用 shared_ptr 控制块**，手搓必须完整复刻这些，风险高；发图那套手搓能跑是因为图片类没有这个控制块。
- 音频内容放在 `inner+0x708`（一个 `std::string`）。**实测必须传 SILK 原始字节**，并自动补一个 `0x02` 前缀（与微信自己写进 `media_0.db` 的 `voice_data` 格式一致）。
  ⚠️ 传**文件路径**是不行的 —— 微信会把路径字符串本身当成音频（实测 `length=17`，正好是路径长度）。
- 构造前后都做**硬校验**（vtable 槽值、收件人、字符串、时长、GUID 逐项回读），任一不符就**不发**并返回错误码。
- **情绪化**：TTS 支持 `rate`/`pitch`，内置四个预设（主声 / 撒娇 / 生气 / 正经），可按上下文切换。

### 需要什么（**不需要任何额外 API key**）

| 依赖 | 说明 | 不装会怎样 |
|---|---|---|
| `pip install edge-tts` | 微软在线 TTS（免费、无需 key） | 合成失败 → 降级发文字 |
| `pip install pilk` | SILK 编解码（**不依赖 ffmpeg**） | 同上 |
| `pip install imageio-ffmpeg` | 自带静态 ffmpeg | 同上 |
| hook 里的 `/SendVoiceMsg` 路由 | 见 `patches/` 下的补丁 | 发不出语音 → 降级发文字 |

- 合成 / 发送全是**旁路**：失败一律降级发文字，**不阻塞回复、不抛错**。
- 开关：hook 侧 `<客户端目录>\hook-voice-send.on`（**默认关**）+ 插件侧 `voiceSay`（默认关）。

### 一个无害的小瑕疵（诚实说明）

发出的语音 XML 里 `length` 字段目前等于**时长（毫秒）**，而微信原生消息里它是**音频字节数**
（实测我们发的是 `length=6180`，微信原生的写法是 `length=15479`）。

**实测不影响播放**：音频本体（15480 字节 = SILK + `0x02`）完整正确地存在 `media_0.db` 里、
也成功上传（拿到了 `voiceurl`），接收端点开**能正常播放** ✓（已实测）。
追求与原生完全一致的话，这一项可以把 `length` 填成音频字节数。

---

## 已知限制（诚实说明）

| 限制 | 原因 |
|---|---|
| **真 @ 提醒** | 已实现：正文写 `@群昵称` + 把被 @ 人的 wxid 传进 `atlist`（**用备注名 @ 不会提醒，所以正文里的名字会被改写成群昵称**）。⚠️ 手动发送工具那条路径仍在修；判定真 @ 的唯一可靠依据是消息 XML 里有没有 `<atuserlist>` |
| **群图片依赖本地缓存** | 微信未下载原图时只能拿到缩略图；解密密钥在微信进程内存里，客户端重启后偶发失效（桥已内置自愈：连续探测失败自动重启客户端） |
| **视频只有"被点开过"的才能看全部内容** | 微信视频按需下载，而主动下载需要 `authkey`（拿不到，已实测否掉）→ 没人点开的视频只能用**明文封面**识别；有人点开后由"延迟复查"自动升级为全部内容 |
| **视频抽帧看的是"瞬间"不是"过程"** | 均匀抽 N 帧（默认 6）覆盖整段，但快速动作/一闪而过的画面可能抽不到；**音轨是完整转写**，不受影响 |
| **语音识别依赖 DSH 语音服务 + 约 239MB 本地模型** | 用 DSH 自带的本地 SenseVoice（`ctx.speechToText`）；没装/没准备模型时优雅降级成 `[语音]`，不影响其它功能 |
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
