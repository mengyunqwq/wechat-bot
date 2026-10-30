# 开发规矩（硬性）

> 这些不是建议。违反任何一条，改动视为**未完成**。

---

## R19 — 每次改完必须跑 `node scripts/test-all.mjs`，全绿才算改完

**用户 2026-10-29 明确要求"写入底层"。**

```bash
cd wechat-group-agent
node scripts/test-all.mjs        # 全绿才能提交/推送/说"好了"
```

一次跑完 7 类检查：

| # | 检查 | 拦住什么 |
|---|---|---|
| ① | 语法 | `node --check` 所有 js/mjs + 面板内联脚本 |
| ② | **提示词作用域** | 函数里引用了"别处的变量"——只在运行时炸的那类 |
| ③ | 面板操作白名单 | 面板点了没反应 / 被拦 |
| ④ | 面板产物一致 | 改了 HTML 忘了 `node build-client.mjs` |
| ⑤ | 单元测试 | 逻辑回归（persona / memory-v2 / human2 / outbox / traits / load） |
| ⑥ | 端到端 | 假 hook → 真轮询 → 游标（接线类问题） |
| ⑦ | 汇总 | 任一红 → 退出码 1 |

### 为什么有这条

2026-10-29 凌晨真实事故：把"好感度 / 印象卡 / 世界书"塞进 `buildSystem(r)` 时写了
`trigger.sender`，但 `buildSystem` 只接 `r` → 每次回话都 `ReferenceError` →
**她完全不说话**，而当时"单测全过"。

教训：纯函数单测覆盖不到"接线/作用域"，所以必须有 ② 和 ⑥。

### 改完的完整流程

```bash
# 1) 改代码
# 2) 全量检查（必须全绿）
node scripts/test-all.mjs
# 3) 改过 panel/index.html → 重新打包面板
node build-client.mjs
# 4) 改过 lib/*.js → 重载插件（dev_reload_package dsh-wechat-bot）
# 5) 看日志确认真起来了（模块自检 / bridge 状态）
```

### 快速模式（只用于迭代，不用于发布前）

```bash
node scripts/test-all.mjs --fast     # 跳过 e2e 与 outbox
```

---

## R20 — 不许只靠"看起来对"就宣布完成

凡是改动涉及：
- 拼提示词（buildSystem / 记忆注入 / 语气块）
- 发送路径（出站队列、语音、表情、图片）
- 面板操作（新增 op / 改 HTML）

**必须有一条可复现的验证**（日志行 / 测试断言 / 面板可点），并把它贴出来。

### R19 补充 — 发送类验证一律发「文件传输助手」

**验证语音 / 表情 / 图片这些"发送类"功能时，只能发 `filehelper`（文件传输助手），不许拿真实的群当试验场。**

```bash
cd wx-bridge
node scripts/verify-voice.mjs                 # 发一句默认测试语音
node scripts/verify-voice.mjs "自定义文本"     # 指定文本
```

脚本里写死了：

```js
const ROOM = process.env.VOICE_TEST_ROOM || 'filehelper'
if (ROOM !== 'filehelper') { console.error('❌ 只能发文件传输助手'); process.exit(1) }
```

输出示例：

```
发语音到「filehelper」：测试语音，只发文件传输助手
✅ 发送成功（3.1s）：10324 字节 / 4100ms
```

**为什么**：真实的群是用户和群友在看，不能因为我们要验证链路就往群里丢测试语音/表情。
文件传输助手只有自己看得见，失败也没人受影响。

**顺带记一个协议坑**：桥的 WS 消息是**扁平参数**（`const { id, op, ...args } = msg`），
不是 `{ id, op, args: {...} }`。写调试脚本时传错，参数全变 undefined，
表现为"文本为空 / 用了默认值"（我今天就踩了：语音报"文本为空"，刷抖音 count 传 2 却刷了 8 条）。

### R21 — 单元测试必须无副作用（R19 的前置红线）

**2026-10-29 真实事故**：`data/test-sendvoice.mjs` 是很久以前的手工探针，里面直接 POST hook 的
`/SendVoiceMsg` 到真实群（`47390425951@chatroom`，durationMs=2220）。而 R19 的 `test-all.mjs`
会跑 `data/test-*.mjs` —— **于是每跑一次 R19，群里就多一条一模一样的 2.2 秒语音**。
用户听到的就是"莫名其妙的语音"，排查了半天以为是自检在发。

现在的两道闸（`scripts/test-all.mjs`）：

```js
// ① 跑之前扫危险调用，命中就拒绝执行并让 R19 红
const DANGER = /(30001|SendVoiceMsg|SendTextMsg|SendStickerMsg|SendImageMsg|\/Send|sayVoice\()/
// ② 只用假 sender 的测试（test-outbox / test-e2e）在白名单里，允许出现 sayVoice 字样
```

规矩：

| 类别 | 放哪 | 说明 |
|---|---|---|
| 纯函数单测 | `data/test-*.mjs` | 只算逻辑、不碰网络/微信 |
| 需要发消息的验证 | `data/_debug/` 或 `wx-bridge/scripts/` | 手工跑，**不进 R19** |
| 发消息的目标 | **只能 filehelper** | `verify-voice.mjs` 已写死校验 |

**发现一个脚本里有 `30001` / `Send*` / 真实 `sayVoice` → 它就不是单测，挪出 `data/`。**

### R19 补充（语音）— 已核实：自检本身不发语音

- `healthCheck()` 里 `sendText / sayVoice / sendVoice` 调用次数 = 0
- 受控实验：重载插件后 40 秒内无任何新语音
- 真正原因是上面那个旧的 `test-sendvoice.mjs` 被 R19 带跑了

### R22 — 视觉/识图必须先声明模型图像能力

**2026-10-30 实测**：识图一直"看着能用"其实是**缓存命中**（缓存 277 条），真调用从没成功过。

原因在 DSH 的 `dsh-llm-pi-ai`：

```js
const DEFAULT_INPUT = ["text"];          // 没声明 input 的模型 = 只收文字
if (containsImage && !model.input.includes("image"))
  throw new LlmError(`pi-ai model "${model.id}" does not support image input`, "UNSUPPORTED_CONTENT");
```

所以 `~/.dsh/profiles/web/cordis.patch.yml` 里**每个要用来识图的模型都必须写**：

```yaml
          - id: deepseek-v4-flash-vision-exp
            name: deepseek-v4-flash-vision-exp
            input:
              - text
              - image
```

表现特征（遇到直接照这个查）：
- 模型回复「我这边没收到图片内容」「没看到图」
- 或返回空（只有 usage/finish，没有 text-delta）
- 插件日志：`视觉返回空：provider/model｜chunk 类型={"usage":1,"finish":1}`

改完 `cordis.patch.yml` **要重启 DSH 才生效**（不是热重载）。

视频链路（抽帧 + 音轨）不依赖这个：`video-probe.py --selftest` 应该 6 项全过；
但"看懂画面"这一步走的就是视觉模型，所以视频的最终描述同样受这条约束。
