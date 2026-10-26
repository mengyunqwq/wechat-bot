# 微信拟人化群聊机器人

一个跑在本机的微信群聊机器人：**实时收消息 → 按拟人策略决定要不要回 → LLM 生成口语化回复 → 像真人一样延迟发送**，并能在群里发表情包。

**当前实测可用状态：机器人已进群，能收群里消息、能回话（用户已确认收到回复）。**

```
微信群 ⇄ 微信 4.1.10.27（本机客户端）
              ↑ version.dll 代理（aixed/WeChat-Hook，免注入）
              ↓ HTTP 30001（发消息） + 回调 18998（收消息）
        wx-bridge（接入层，Node）
              ↕ WebSocket JSON
   @dsh-external/dsh-wechat-bot（DSH 插件 = 大脑：拟人策略 + LLM + 表情包）
```

## 目录

| 路径 | 作用 |
|---|---|
| `wx-bridge/` | 接入层：收/发消息、表情包库、mock 模拟器、自研注入器 |
| `wechat-group-agent/` | DSH 插件：拟人策略、LLM 生成、表情包挑选、GUI 控制工具 |
| `data/` | 表情包库、消息日志、桥日志 |
| `D:\wxhook\wx4110\` | 微信 4.1.10.27 客户端 + `version.dll`（hook） |

## 快速开始

1. **双击 `启动机器人.cmd`** —— 会拉起微信客户端（带回调参数）和 wx-bridge。
2. 若客户端要求扫码，用**机器人小号**扫码登录（会话通常会被记住，无需每次扫）。
3. 把机器人拉进群，@ 它即可。
4. 用 `状态检查.cmd` 看连接与决策日志。

## 为什么是这个技术路线（踩坑记录，很重要）

| 方案 | 结果 |
|---|---|
| WeChatFerry + 微信 3.9.12.17 | ❌ 腾讯"版本过低"拦截，伪装版本也绕不过 |
| 官方 iLink/ClawBot（2026 腾讯开放） | ⚠️ 可用但**仅支持私聊**，做不了群聊 |
| wxhook（wxhelper 系）DLL 注入 | ❌ DLL 能加载，但 HTTP 服务一请求就崩，微信跟着崩 |
| **aixed/WeChat-Hook（version.dll 代理）** | ✅ **可用**：免注入、API 正常、收发都通 |

关键点：**`version.dll` 代理式加载**（把 DLL 放进客户端目录，微信启动时自己加载），
完全避开"注入"这一整类问题。

## 该 hook 构建的已知限制（实测）

- ❌ `/QueryDB/*` 与 `IsLogin` 是坏的 → **拿不到联系人昵称**（机器人看到的是 wxid），群列表也读不到。
- ❌ `/ForwardXMLMsg` 一调就把微信弄崩 → **不能发微信原生表情**，表情包改用图片发送（视觉一致）。
- ❌ 没有下载附件的接口 → 群里别人发的图片/表情**只能收到 XML，存不下图片文件**。
- ✅ `/SendTextMsg`、`/SendImgMsg`、`/set_callback`、回调推送 都正常。

## 拟人化设计

| 机制 | 默认值 | 说明 |
|---|---|---|
| 被 @ / 被点名 | 必回 | 昵称必须在插件里配对（`botName`） |
| 问句 | 概率 ×2.2 | |
| 纯闲聊 | 0.3 | **不是有问必答**，这条最像人 |
| 打字延迟 | 600~900ms + 45~70ms/字 + 抖动 | 被@时更快，上限 14s |
| 拆句 | 15% 概率拆两条 | |
| 补表情包 | 22% 概率 | 模型输出 `[表情]` 时只发图 |
| 同群冷却 / 10 分钟上限 | 15s / 6 条 | 防刷屏 + 像人 |
| 连续自说自话 | 2 条后闭嘴 | |
| 安静时段 | 01:00-07:30 | 除了被@ |
| 每群记忆 | 300 条 | 重启不失忆 |

## 🔊 语音识别（群里发语音 → 转成文字 → 当普通消息回复）

微信语音（`local_type=34`）是 **SILK v3** 编码，而音频**不在文件系统里**，
在 `media_0.db` 的 **`VoiceInfo.voice_data`（BLOB，明文 SILK，不需要 AES 解密）**，
用 `local_id` 与消息表 `Msg_<hash>` 关联（两边同一个值）。链路：

```
微信语音消息（local_type=34，XML 里只有元数据）
   → wx-bridge 查 media_0.db / VoiceInfo.voice_data（local_id 关联；磁盘目录只作兜底）
   → 剥掉容器前缀（1 字节 0x02，从 #!SILK_V3 处开始取）
   → decode-wechat-voice.py（pilk 解 SILK + 纯 Python 重采样）
   → 16kHz / 单声道 / PCM16 WAV（DSH 语音服务的硬要求）
   → 事件字段 voiceWav → 插件调 ctx.speechToText 转写
   → 转写文字**当普通消息文本**（记忆/@ 识别/回复都按文本走）→ 删临时 WAV
```

实测样例（一条 1.4 秒语音）：`voice_data` 2488 字节 → 剥前缀后 2487 字节 SILK →
WAV 1.42s / 45484 字节 → 转写结果「干什么干什么？」（CPU 推理 0.08s）。

### 需要什么（**不需要任何额外 API key**）

| 依赖 | 说明 | 不装会怎样 |
|---|---|---|
| DSH 的**「语音输入」bundle** | 提供 `ctx.speechToText` 服务，provider id = `sensevoice-local` | 插件日志打印"没有 speechToText 服务" → 语音保持 `[语音]` |
| **本地 SenseVoice 模型（约 239MB）** | 首次自动下载到 `%DSH_HOME%\speech-to-text\sensevoice\models\`（本机 `DSH_HOME=D:\dsh\data`）；也可在 DSH 设置里手动"准备" | 转写报错 → 保持 `[语音]`（下载会继续，下一条语音即可用） |
| `pip install pilk` | 纯 Python SILK 解码（**本机没有 ffmpeg，所以不依赖它**） | 解码失败只记日志 → 保持 `[语音]` |

- 服务侧只接受 **canonical 16kHz/mono/PCM16 WAV**（逐字段校验头部），本仓库的
  `decode-wechat-voice.py` 就是按这个契约产出的（`--selftest` 会逐项校验头部）。
- 语音处理是**纯旁路**：定位不到音频、解码失败、模型没准备、转写报错 —— 全都只记日志，
  消息照旧按 `[语音]` 走，**不会阻塞回复、不会抛错**。
- 关掉语音识别：环境变量 `WECHAT_VOICE=0`（桥侧），或插件配置 `voiceOnVoice: false`。

### 排查（实测时看这几条日志）

| 日志（桥：`data\logs\bridge-*.log`） | 含义 |
|---|---|
| `语音：VoiceInfo 命中 N 字节（local_id=…）｜XML length=… ✓一致｜时长约 N.Ns` | **主路命中**（含与 XML 的交叉校验） |
| `语音解码成功（已剥前缀 1 字节）：VoiceInfo blob N 字节 → data\voice\voice-<id>-<ts>.wav` | 解码成功 |
| `语音：VoiceInfo 里没有 local_id=… 的音频（可能没同步/已被清理）` | 库里没有 → 转磁盘兜底 |
| `语音定位：查了 N 个目录 → 候选 M 个（…）` / `语音定位：命中 <文件>（…偏离 Ns…）` | 磁盘兜底找过哪些目录、命中哪个文件 |
| `语音定位：没找到任何候选音频（…按需下载…）` | 磁盘上也没有 → 保持 `[语音]` |
| `语音解码失败（库 blob N 字节）：…` | 解码失败的具体原因（pilk/容器格式） |

| 日志（插件：`%DSH_HOME%\super-injector\dsh-wechat-bot.log`） | 含义 |
|---|---|
| `语音转写成功（音频 Ns / 推理 Ns）：<文字>` | 转写成功 |
| `语音转写文字已当文本处理：…` | 已替换 `text`（记忆/@/回复按文本走） |
| `已删除语音临时 WAV` | 临时文件已清理 |
| `语音模型未就绪（phase=unprepared）→ 触发准备…` | 模型没准备时才会出现（首次下载约 239MB） |
| `没有 speechToText 服务（…bundle 没启用？）` | 服务不可用 → 降级 `[语音]` |
| `语音转写失败（保持 [语音]）：…` | 具体失败原因（服务侧会拒绝非 16k/mono/PCM16） |

## 在 DSH 里控制它

| 工具 | 用途 |
|---|---|
| `wechat_bot_status` | 连接/登录、模型、计数、各群节流与最近消息 |
| `wechat_bot_say` | 手动让它发一条（可带表情包） |
| `wechat_bot_config` | 实时改参数：`persona`/`replyProbability`/`quietHours`/`botName`… |
| `wechat_bot_stickers` | 看表情包库 / 试挑一张 |
| `wechat_bot_history` | 看某群记忆上下文 |

> ⚠️ 改 `botName` 必须与机器人在微信里的**群昵称**一致，否则"被@必回"识别不出来。

## 🎛 Web 控制面板（`/wechat-bot`）

浏览器打开 **http://127.0.0.1:3080/wechat-bot**（与 DSH 共用登录态，不用另配账号）。

| 页面 | 能做什么 |
|---|---|
| 总览 | 桥/微信/hook 三色灯、收发计数、各群节流、最近消息、一键自检 |
| 功能开关 | 20 张卡：识图/识表情/识视频/链接视频/语音听与说/表情包/拆句/主动找话题/抖音/自愈…点一下即时生效 |
| 参数 | 100+ 项：回复概率、冷却、安静时段、拆句、@、模型/人设、记忆、健康告警…带范围校验与默认值提示 |
| 表情包 | 图库（试挑/发送/生成）、补图概率、题材库 |
| 记忆 | 每群长期记忆：查看 / 追加 / 清空 / 立即提炼（**只读磁盘，不会惊动机器人主动发言**） |
| 群与人 | 群白名单、成员名字映射、机器人昵称/别名 |
| 运维日志 | 自检报告、插件日志 / 桥日志、配置导入导出 |
| 手动操作 | 以机器人身份发文字/语音/表情、拍一拍、查历史 |

- 写操作复用 DSH 的 cookie + Host/Origin 栅栏，另要求同源 JSON；高危项二次确认。
- 审计：`D:\dsh\data\wechat-bot\panel-audit.log`（时间/IP/UA/动作）。
- **回滚**：改动前备份在 `backup-wechat-panel-*/`（含插件 `lib` 与 `config.json`，步骤见 `RESTORE.md`）。

### 🧩 模型接口

面板新增「模型接口」页，服务商直接从 DSH 的 pi-ai 目录读取，支持：

**Claude / GPT / DeepSeek / Grok / GLM / Qwen / Kimi / MiMo / Gemini / OpenRouter / MiniMax / Groq** 等 40+ 路由。

- 填 API Key → 写进 DSH 凭据库（界面只显示引用名，**不回显明文**）→ **保存即注册路由，不用重启 DSH**
- 每个服务商可单独「测试」（真实发一条极小请求）、「设为聊天」、「设为视觉」
- 模型清单留空 = 用 pi-ai 内置目录；也可手填模型 id
- 图像生成单独一栏：Agnes / OpenAI / xAI / GLM 预设，写 `data/image-gen.json`
  - 只换地址/模型即时生效；切「请求格式」或让桥读取新凭据需重启 `wx-bridge`

### 群名/人名从哪来（为什么以前显示 4739…@chatroom / wxid_xxx）

微信 4.x 的 `contact.db` 经常被卸载、句柄失效（`/QueryDB/execute` 直接 500），
但 `contact_fts.db` 一直可读：群名和联系人昵称都在 `contact_fts_v5_content.c0`（`\b` 分隔），
用 `name2id.rowid` ↔ `username` 对上即可（第一个非空字段就是显示名）。

- 插件侧已内置这个查询（面板/状态/消息/群选择器直接显示真名，**不需要重启桥**）
- 桥侧也加了同样的兜底（重启 `wx-bridge` 后，其他消费 `bridge.rooms()` / `senderName` 的地方也会带名字）
- 查不到时仍退回显示 roomId / wxid，不会报错

## 手动启动

```powershell
# 1) 客户端（必须带这两个参数，否则收不到消息）
cd D:\wxhook\wx4110
.\Weixin.exe StartPort=30001 RecvType=1 CallBackURL=http://127.0.0.1:18998

# 2) 接入层
cd D:\微信deepseek\wx-bridge
node server.mjs --transport=wechat-hook --api-port=30001 --cb-port=18998 --wechat=D:\wxhook\wx4110\Weixin.exe

# 模拟模式（不需要微信，调策略用）
node server.mjs --mock
# 自检
node server.mjs --self-test
node test-policy.mjs   # 策略回归（在 wechat-group-agent 目录）
```

## 🔒 版本锁定与防自动更新（血泪教训，必读）

**hook 与微信版本强绑定**：本 hook（`version.dll`，aixed/WeChat-Hook）只支持 **4.1.10.27**。

> 事故记录：微信曾**自己更新**到 4.1.15.55，把 `4.1.10.27` 版本目录删掉重建，
> 而 hook 是按 4.1.10.27 编译的 → **整个接入层静默失效**（HTTP 30001 不通、收不到消息）。
> 而且更新器/更新缓存**被改名后客户端还会重新创建**。

现在有三道防线：

1. **客户端版本必须自洽**：`D:\wxhook\wx4110\` 里的 `Weixin.exe`（启动器）与 `4.1.10.27\`（payload）
   版本要一致；不一致时客户端**直接退出**（连界面都不出，只有个"启动提示"对话框一闪而过）。
2. **防更新守卫（自愈）**：`wx-bridge` 看门狗每 10 秒巡检，发现就改名禁用：
   - 客户端里的 `4.1.10.27\WeixinUpdate.exe`
   - `%APPDATA%\Tencent\xwechat\xplugin\plugins\WeixinUpdate`
   - `%APPDATA%\Tencent\xwechat\update\download` 与 `\patch`
3. **绝不碰用户日常微信**：这台机器上 `D:\Program Files\Tencent\Weixin` 是用户自己用的微信
   （正好也是 4.1.10.27）。机器人用**另一份独立副本**；杀进程一律**按可执行文件路径精确匹配**，
   绝不用 `taskkill /IM Weixin.exe`（那会把用户的微信一起杀掉）。

**哪天又失效了，按这个顺序查**：

```powershell
# 1) 客户端实际用哪个版本目录？（不是 4.1.10.27 → 版本被换了）
Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | ForEach-Object { $_.CommandLine }
# 2) hook HTTP 通不通？
curl http://127.0.0.1:30001/QueryDB/status
# 3) 客户端进程在不在（正常 5 个）？只有 0~1 个 → 版本不匹配，启动即退出
Get-Process Weixin
```

修复：从 `D:\Program Files\Tencent\Weixin`（用户那份 4.1.10.27）**只读复制**一份到
`D:\wxhook\wx4110`，再把 hook 的 `version.dll` 放进去（见上面"手动启动"）。

## ⚠️ 风险

- **封号风险**：hook 属非官方协议，违反微信使用条款。**务必用新注册的小号**，别绑支付。
- **版本锁定**：hook 与微信版本强绑定（4.1.10.27）。已禁自动更新（更新器 + 更新插件 + 缓存目录，看门狗每 10 秒自愈），**别手动升级**。
- **电脑关机 = 人下线**。
- 桥自带看门狗：客户端被关掉会自动重新拉起（新实例可能需要重新扫码）；HTTP 服务死了也会重启客户端。

## 微信 Hook 改造（群成员昵称）

我们**自编译并部署了改造版 ersion.dll**，修复了上游 QueryDB 永久失效的问题，
现在能直接读微信数据库拿群成员真实昵称（不再靠 @ 提及猜）。

- 改造内容、编译步骤、**回滚方法**、数据库表结构：见 [docs/hook改造说明.md](docs/hook改造说明.md)
- 源码：`E:\wxhook-src\WeChat-Hook`（3 处补丁已应用）
- 旧 DLL 备份：`D:\wxhook\wx4110\version.dll.bak-606208-20261016-0932`r
