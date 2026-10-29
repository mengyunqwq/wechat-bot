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
