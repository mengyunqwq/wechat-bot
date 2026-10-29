# 微信拟人化群聊机器人（大肥鱼）

一个跑在本机 Windows 上的微信群聊机器人：**收消息 → 按拟人策略判断要不要回 → LLM 生成口语化回复 → 像真人一样延迟发送**，会发表情包、发语音气泡、自动发朋友圈。

**当前版本：v1.4.12**（`version.json` / 插件 `export const version` 同源）

**本机实测可用**（不是"理论上支持"）：收群消息、回复、真 @、发表情包（图库 + 现场生成）、发语音气泡、识图、识视频、语音转文字、每群长期记忆、朋友圈静默发布、Web 控制面板 16 页。

```
微信群 ⇄ 微信 4.1.10.27（机器人专用的独立副本）
              ↑ version.dll 代理式加载（放进客户端目录，微信启动时自己加载，免注入）
              ↓ HTTP 127.0.0.1:30001（读库 / 发消息 / 语音 / 朋友圈）
              ↓ 回调 127.0.0.1:18998（新消息）
        wx-bridge（接入层，Node，ws://127.0.0.1:17300）
              ↕ WebSocket JSON
   @dsh-external/dsh-wechat-bot（DSH 插件 = 大脑：策略 + LLM + 记忆 + 面板）
```

> `version.dll` 会被注入到微信的**全部子进程**（本机实测 5 个）。
> HTTP 端口最终落在哪个进程是**不确定的**——所以 hook 里所有"找窗口"的逻辑都必须跨进程（1.4.7 修）。

## 目录

| 路径 | 作用 |
|---|---|
| `wx-bridge/` | 接入层：收/发消息、数据库轮询、图片解密、语音编解码、视频抽帧、表情包库、链接视频、MCP server |
| `wechat-group-agent/` | DSH 插件：拟人策略、LLM、长期记忆、朋友圈、控制面板（`panel/index.html`）、DSH 工具 |
| `release/` | 成品 `version.dll` + `install.ps1` + `rollback.ps1` + `SHA256.txt` |
| `scripts/` | 一键脚本：启动/停止、编译 hook、部署、面板自检、E2E |
| `docs/` | 安装流程、AI 一键部署、运维规则（R1–R17）、排错、各能力实现说明 |
| `config.example.json` | 配置模板（107 项） |

运行时数据目录（本机）：`D:\微信deepseek\data`（表情库、日志、`rooms.json`、语音临时文件）
插件数据目录（本机）：`D:\dsh\data\wechat-bot`（记忆 `facts/`、`moment.json`、`moment-images/`）

## 能力清单

| 能力 | 实现要点 | 关掉的方式 |
|---|---|---|
| 收消息 | **数据库轮询**（默认 2.5s，`DB_POLL_MS`）+ 可选 hook 即时推送（`hook-push.on` + `WECHAT_PUSH=1`） | — |
| 发文字 / 真 @ | `/SendTextMsg`，@ 必须填 `atuserlist` 才有红点提醒 | — |
| 发图片 | `/SendImgMsg` | — |
| 发语音气泡 | `/SendVoiceMsg`（type 34，真气泡），需 `hook-voice-send.on` | `voiceSay=false`（默认关） |
| 识图 | 解密微信本地加密图（V2/AES）→ 视觉模型 | `visionOnImage=false` |
| 识表情 | 表情 XML → 下载图片 → 视觉模型 | `visionOnEmoticon=false` |
| 识视频 | 客户端点开后抽 6 帧拼"联系表" + 抽音轨转写 | `visionOnVideo=false` |
| 链接视频 | 群里发链接 → yt-dlp 下载 → 同样抽帧识别 | `linkVideo=false` |
| 语音转文字 | `media_0.db` 的 `VoiceInfo.voice_data`（明文 SILK）→ pilk 解码 → 16k/mono/PCM16 → DSH 本地 SenseVoice | `voiceOnVoice=false` / `WECHAT_VOICE=0` |
| 表情包 | 图库挑选 + **现场生成**（Agnes 图生图，角色锁定） | `stickerChance=0` / `genStickerChance=0` |
| 每群长期记忆 | 距上次 ≥10 分钟且新增 ≥8 条才提炼；面板可看/加/清/立即提炼 | `memoryExtract=false` |
| 朋友圈 | 定时 / 群聊事件触发；AI 写文案 + 图生图；**静默发布**（不动鼠标、不抢前台） | `momentAuto=false` / `momentFromChat=false` |
| 抖音 | `douyin-brush.py` 自动刷 / 分享 | `douyinShare=false` |
| 拟人策略 | 概率、同群冷却、10 分钟上限、安静时段、拆句、补表情、主动找话题 | 见面板「回复节奏/主动行为」 |

## 朋友圈（v1.4.x 新增）

两种触发方式，二选一或都开：

| 模式 | 开关 | 行为 |
|---|---|---|
| 定时 | `momentAuto`（默认 **false**） | 到点在 `momentHours` 内挑时间发，遵守 `momentMinGapMs`（默认 3 小时）/ `momentDailyMax`（默认 2 条） |
| 群聊事件 | `momentFromChat`（默认 **false**） | 群里聊到"好玩的事"→ 先由 LLM 打分（`momentChatMinScore`，默认 7）→ 够好玩才发；同群冷却 30 分钟、全文去重 |

- 文案由模型写；图片默认 `momentImageSource='char'`（**图生图**，用 `assets/char-ref.jpg` 锁角色，失败就放弃，绝不发错角色的图）
- **发布方式**：`PostMessage` 驱动微信自己的 UI（右键相机 → 发表文字 → `WM_CHAR` 逐字输入 → 点发表），全程**不移动鼠标、不抢前台**
- ⚠️ **前置条件：微信主窗口必须开着**。微信把主窗口收进托盘时会**销毁**它，此时谁都发不出去。
  调度器会先查 `/Moment/Ready`，窗口不在就**跳过且不消耗当日额度**，日志写明原因。

## 控制面板（`/wechat-bot`）

两种入口，同一份代码：DSH 左侧面板列表 **🐋 微信机器人**，或独立地址 `http://127.0.0.1:<DSH端口>/wechat-bot`。

**16 个页面**：总览 · 功能开关 · 回复节奏 · 主动行为 · 说话方式 · 表情包 · 感知 · 语音 · 记忆 · 群与人 · 朋友圈 · 人设模型 · 诊断 · 更新 · 运维日志 · 手动操作

- **操作白名单 38 项，面板实际用到 34 个**；启动时自检并写日志：`[自检] 面板操作覆盖 34/34 ✅（白名单 38 项）`
- 写操作复用 DSH 登录态 + Host/Origin 栅栏，另要求同源 JSON；高危项二次确认
- 审计日志：`<插件数据目录>/panel-audit.log`（超 5MB 自动轮转）

## DSH 工具（`wechat_bot_*`，11 个）

| 工具 | 作用 |
|---|---|
| `wechat_bot_status` | 桥连接/登录/模型路由/节流/最近消息 |
| `wechat_bot_selfcheck` | 一键全链路只读体检（✅❌⚠️ + 修复建议） |
| `wechat_bot_say` | 以机器人身份发一条（可带表情包） |
| `wechat_bot_config` | 实时改参数（无需重启） |
| `wechat_bot_stickers` | 看表情包库 / 试挑一张 |
| `wechat_bot_gensticker` | 现场生成表情包（可加文字气泡，可顺手发群） |
| `wechat_bot_vision` | 识别一张本地图片 |
| `wechat_bot_memory` | 查看/追加/清空/立即提炼长期记忆 |
| `wechat_bot_search` | 联网搜索（调试"要不要联网"） |
| `wechat_bot_names` | 群成员名字映射（wxid → 昵称） |
| `wechat_bot_history` | 某群最近消息 |

## 版本与更新

版本号在 `version.json` 与本机插件 `lib/index.js` 的 `export const version` 两处，**必须一致**。

最近修的都是"看起来能用、实际会静默坏掉"的问题：

| 版本 | 修了什么 |
|---|---|
| 1.4.5 | 拉进新群不理人 —— 新会话表按 max id 起步，建群消息被跳过（现在回补最近 30 条） |
| 1.4.6 | 新群不进群列表 —— 轮询路径不登记群，面板记忆页选不到（现在并入轮询会话表） |
| 1.4.7 | 朋友圈时好时坏 —— 只在本进程找主窗口，hook 落到辅助进程就永远找不到（改成跨进程） |
| 1.4.8 | 自检误报「数据库打不开」—— 唤醒后已恢复仍判 ❌（改成看"唤醒后有没有再收到消息"） |
| 1.4.9 | 清理「眼睛」遗留的 7 个 op（功能已内置）；补「刷新名字缓存」「微信状态/启动」按钮 |
| 1.4.10–1.4.12 | 热重载把面板搞成 404 —— 见下 |
| 1.4.13 | 面板「人设模型」的 provider/model 改成 DSH 那样联动下拉（provider 只列已注册、模型清单跟着 provider 变、视觉模型只列能读图的；仍可自定义手填、也可选回留空跟随 DSH） |
| 1.4.14 | 「当前生效」卡片显示旧模型 —— 原来优先显示“上一次实际请求”且改完不重绘，现在以配置为准、上次实际调用单列 |
| 1.4.15 | 面板新增 **TTS 服务控制**（状态/启动/停止/重启/试合成）；移除阻塞式 `execSync`（它会同归于尽 DSH 主线程 → 面板卡死、只能重启）；「语音模型 常驻」并入「开机自启」并真正实现启动时自动拉起；hook 加崩溃现场记录器 `hook-crash.log` |
| 未发版 | 音色还原：`tts-silk.py` 的参考音曾被改成“御姐”（`data\voice\yujie-ref.wav`），已改回雌小鬼（`sexy-loli-cn/.../cn-a.wav`）；合成结果新增 `voiceRef` 字段，换音色会在日志里立刻暴露 |
| 1.4.16 | 面板 12 处功能性缺陷修复：发送不判成败（rc≠0 也报“已发送”）、运维页自检不刷新、朋友圈误报“带图”、TTS 启停后勾选框不同步、记忆提炼不解释原因、清空 hires 无按钮、看诊断不跳转（无 hashchange）、手操默认行隐藏、检查更新 force 传错层级失效、「刷新名字缓存」其实是假的；移除无效的「音色预设」下拉；移除「模型接口」页 |
| 1.5.0 | **记忆系统 v2**：艾宾浩斯遗忘曲线 + 情绪加权。每条记忆带 `强度S/重要度/情绪`；被检索进上下文即复习（`S ← S×(1+γ(1−R)(1−D))`，间隔效应）；低权重（`R×重要度 < 0.06`）自动归档、30 天后才真删；重要度 ≥0.85 的「铁律记忆」永不自动忘；注入从「按时间取最后 18 条」改为「按 R×相关性×重要度×情绪 检索 top 12」；提炼改结构化输出（kind/emotion/intensity/importance/selfRelevant）；面板记忆页可看保持率进度条、固定/复习/归档、一键跑遗忘巡检 |
| **2.0.0** | **大版本**：记忆系统 v2（艾宾浩斯遗忘曲线 + 情绪加权 + IDF 检索 + 全局互通）、性格系统（状态机 / 自传 / 好恶 / 私人目标 / 反馈驱动漂移）、两轮人性化 14 项（回忆分级、情绪溯源、关系分层、学新梗、自我复盘、身体感、耐心、承诺追踪、纠错、沉默艺术、连续追击、自己的事、联想浮现）、精力负荷按群数+速率计算；稳定性：语音冷却、wake 限流、登录自动放闸、探针多候选、配置保存修复、桥轮询 6s、备份期静默 |
| **2.0.1** | 好感度七阶（讨厌→心动，50% 普通人；**只喜欢一个人**，别人封顶 70%，主人默认心动）+ 面板折叠与阶段查询；群梗可手动加/删；性格漂移改落盘队列（3 分钟/接话即结算/立即结算）；联想浮现改由模型挑选；抖音**静音刷**（volume=0 仍可录音轨）+ 作者/点赞/BGM/直链元数据；视频 1fps 多张联系表逐段识别；修复内心页 room 残留、新梗两振入表、精力基准 24 |
| **2.0.2** | 更像人六项（情景语气示例/幽默三招/不重复称呼/收尾日记/忘掉指令/不绝对服从/羁绊 Lv1-7，按说话人算）；统一出站队列（节流+去重+重试退避）；轮询游标落盘；跨群记忆边界（人事可跨群、事件只在本群）；**新增 R19：改完必须跑 `node scripts/test-all.mjs` 全绿**；修好 `trigger` 导致的完全不回话、羁绊显示陌生人、好感度条不显示 |

### ⚠️ 热重载的真相（R17，务必知道）

**插件无法在自身进程内安全替换自己**。三条路都实测失败：

1. 先 `dispose` 旧实例 → 旧 ctx 失效，新实例建不起来（`cannot create effect on inactive context`）
2. 先建新实例再拆旧的 → 挂载撞车（`duplicate prefix route`），且新实例的父 ctx 就是旧实例，父死子死
3. `entry.fiber=undefined` + `entry.refresh()` → 第一次成功、第二次 404，且留下"半死实例"，之后每次 reload 都卡死

所以 **1.4.12 起「热重载插件」只做预检**：验证新代码能否加载，然后提示你重启 DSH。面板永远不会因为它变砖。

**改代码的正确流程**：改 → 面板点「热重载」确认能加载 → **重启 DSH** 生效。

## 已知限制（都是实测过的，不是猜测）

| 限制 | 说明 |
|---|---|
| 版本强绑定 | hook 只适配微信 **4.1.10.27**；客户端自带更新器已被看门狗禁用（每 10 秒巡检） |
| 朋友圈需主窗口 | 微信把主窗口收进托盘会销毁它，此时发不出（调度器会自动跳过，不消耗额度） |
| 拍一拍 | hook 侧无实现，`/api/pat` 返回失败（已从面板移除） |
| `contact.db` 常失效 | 微信会卸载它；名字改从 `contact_fts.db` 取（`contact_fts_v5_content.c0` + `name2id`），所以名字正常显示 |
| 消息库分片会轮换 | `message_0.db` → `message_1.db`…，桥自动解析（看桥日志 `当前消息库分片：message_N.db`） |
| 语音/图片发送的对象所有权 | 发送后**未释放**微信内部对象（`HeapAlloc` 23 处 / `HeapFree` 1 处）。高频连发（实测 7 分钟内 7 条语音）可能让客户端偶发崩溃，**未完全定位**；建议把 `voiceSayProbability` 压低 |

## 手动启动（本机路径）

```powershell
# 1) 客户端（必须带这几个参数，否则收不到消息）
Start-Process 'D:\wxhook\wx4110\Weixin.exe' -ArgumentList `
  'StartPort=30001','RecvType=1','CallBackURL=http://127.0.0.1:18998' `
  -WorkingDirectory 'D:\wxhook\wx4110'

# 2) 接入层
cd D:\微信deepseek\wx-bridge
node server.mjs --transport=wechat-hook --api-port=30001 --cb-port=18998 `
  --data-dir=D:\微信deepseek\data --wechat=D:\wxhook\wx4110\Weixin.exe

# 模拟模式（不需要微信，调策略用）
node server.mjs --mock
# 桥自检
node server.mjs --self-test
```

> `server.mjs` 的 `--transport` 默认是 `wxhelper`（另一套已废弃的链路），**必须显式加 `--transport=wechat-hook`**。
> 参数只认 `--key=value` 形式，不能写 `--key value`。

## 一键脚本

| 脚本 | 作用 |
|---|---|
| `scripts/start-bot.ps1` / `启动机器人.cmd` | 按正确参数拉起微信 + 桥（已在跑的会跳过） |
| `scripts/stop` 系列 / `停止机器人.cmd` | 停桥（按 PID），不误杀其它 Node |
| `状态检查.cmd` | 看连接与决策日志 |
| `scripts/build-hook.ps1` | 克隆我们自己的 hook 源码 → 编译 → 备份部署 |
| `scripts/check-panel-ops.mjs` | 校验"面板用到的操作是否都在白名单"（加 `-v` 列未用项） |
| `scripts/wechat-power.ps1` | 客户端开关机（UIA 点「进入微信」） |

## 安全与风险

- **封号风险真实存在**：hook 属非官方协议，违反微信使用条款。**务必用小号**，别绑支付。
- **绝不碰日常微信**：机器人用 `D:\wxhook\wx4110` 这份独立副本；杀进程一律按可执行文件路径精确匹配，禁止 `taskkill /IM Weixin.exe`。
- **接口无鉴权**：hook 的 30001 与桥的 17300 都是"本机信任"模型，且只监听 `127.0.0.1`。不要暴露公网。
- **key 不进仓库**：图像服务 key 走环境变量或本地凭据文件，仓库里只有占位符。

## 相关文档

- [docs/安装流程.md](docs/安装流程.md) —— 完整安装流程（人看）
- [docs/记忆系统v2.md](docs/记忆系统v2.md) —— 记忆系统 v2（遗忘曲线 / 情绪加权）设计与参数
- [docs/性格系统.md](docs/性格系统.md)
- [wechat-group-agent/DEVELOPMENT-RULES.md](wechat-group-agent/DEVELOPMENT-RULES.md) —— **开发规矩（R19：改完必须跑测试）** —— 性格系统（状态机 / 自传 / 好恶 / 目标 / 反馈漂移）
- [docs/AI-一键部署.md](docs/AI-一键部署.md) —— 把这段喂给 AI，让它替你装
- [docs/OPERATIONS-RULES.md](docs/OPERATIONS-RULES.md) —— 运维铁律 R1–R17（**改代码前必读**）
- [docs/常见错误与排错.md](docs/常见错误与排错.md) —— 排错手册
- [docs/hook改造说明.md](docs/hook改造说明.md) —— 我们对 hook 做了什么改造
- [DEPLOY.md](DEPLOY.md) —— 部署与常驻运行
- [wx-bridge/PROTOCOL.md](wx-bridge/PROTOCOL.md) —— WS / HTTP / MCP / 托管模式协议

## 许可

见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。本项目不含任何微信账号、密钥或聊天数据。
