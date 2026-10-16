# wx-bridge 接口协议

机器人接入层（`wx-bridge`）的完整接口说明。三种接入方式，按推荐程度排序：

| 方式 | 适合谁 | 入口 |
|---|---|---|
| **① MCP**（推荐） | 任何支持 MCP 的 agent：Claude Desktop / Cursor / Cline / Windsurf / 自研 | `node mcp-server.mjs` |
| **② WebSocket** | 想自己写客户端的程序 | `ws://127.0.0.1:17300` |
| **③ HTTP** | 只会 HTTP 的脚本/agent | `http://127.0.0.1:17300/api/*` |

---

## 一、MCP 接入（给别的 agent 用）

在 MCP 客户端的配置里加一段即可：

```json
{
  "mcpServers": {
    "wechat": {
      "command": "node",
      "args": ["D:/微信deepseek/wx-bridge/mcp-server.mjs"],
      "env": { "WX_BRIDGE_URL": "ws://127.0.0.1:17300", "WX_DEFAULT_ROOM": "" }
    }
  }
}
```

暴露的工具：

| 工具 | 作用 |
|---|---|
| `wechat_status` | 登录状态、连接数、消息计数、表情包库、所在群 |
| `wechat_list_rooms` | 列出所有群/会话 |
| `wechat_read_messages` | 读某个群最近的消息（机器人记忆里的上下文） |
| `wechat_send_text` | 以机器人身份发文字（文字里写 `@昵称` 即为 @） |
| `wechat_list_members` | 群成员**真实昵称**（备注优先） |
| `wechat_list_stickers` | 表情包库 |
| `wechat_send_sticker` | 按语境挑一张发出去 |
| `wechat_generate_sticker` | Agnes 现场生成表情包（题材 + 场景 + 文字气泡） |
| `wechat_get_image` | 取群里最近一张图并**自动解密**，返回可读文件路径 |
| `wechat_pat` | 拍一拍某人 |

> ⚠️ **节流归谁管**：MCP 工具是**直发**的（调 `wechat_send_text` 立刻发出去）。机器人自己的拟人节流（回复间隔、频率上限、作息、防重复）由 **DSH 插件** 或 **桥的托管模式** 负责。外部 agent 接入时请自行控制节奏，或改用托管模式。

---

## 二、WebSocket 协议

### 连接与握手

```
客户端 → 服务端：{"id":"x","op":"identify","name":"my-agent","pid":1234}
服务端 → 客户端：{"t":"hello","mock":false,"status":{...},"counters":{...},"self":"wxid_..."}
```

**`identify` 很重要**：桥只把消息事件推给"已自报身份的最新连接"（防止热重载残留的旧实例重复处理消息 → 群里重复回答）。名字用 `dsh-wechat-bot` 会触发"踢掉其它连接"的独占行为；其它名字只是登记。

### 请求 / 应答

```
客户端 → 服务端：{"id":"1","op":"sendText","roomId":"12345678@chatroom","text":"你好"}
服务端 → 客户端：{"t":"reply","id":"1","op":"sendText","ok":true,"result":{"rc":0}}
失败时：        {"t":"reply","id":"1","op":"sendText","ok":false,"error":"..."}
```

### 事件推送

```
{"t":"msg","m":{ ...消息对象... }}      收到群/私聊消息
{"t":"sticker","id":"...","roomId":"...","sender":"...","senderName":"..."}
{"t":"login","self":"wxid_...","name":"..."}   /  {"t":"logout"}
{"t":"started","port":30001,"loggedIn":true,...}
```

**消息对象** `m` 的字段：

| 字段 | 说明 |
|---|---|
| `id` | 消息 id |
| `type` / `typeName` | 1=text、3=image、43=video、47=emoticon、48=location、49=link、34=voice |
| `ts` | 毫秒时间戳 |
| `isSelf` | 是否机器人自己发的 |
| `isGroup` / `roomId` / `roomName` | 会话信息 |
| `sender` / `senderName` | 发送者 wxid / **真实昵称** |
| `content` / `text` | 原文 / 展示文本 |
| `isAtMe` / `atAll` | 是否 @ 了机器人 / @所有人 |
| `xml` | 媒体类消息的原始 XML（图片/表情包下载用） |

### 全部 op

| op | 参数 | 说明 |
|---|---|---|
| `status` | — | 桥的状态快照 |
| `rooms` | — | 所有群/会话 |
| `members` | `roomId` | 群成员真实昵称（`contact.db` 关系查询） |
| `selfNames` | `roomId` | 机器人在该群的显示名 |
| `history` | `roomId`,`limit` | 最近消息 |
| `sendText` | `roomId`,`text`,`mentions?` | 发文字 |
| `sendImage` | `roomId`,`file` | 发图片 |
| `sendFile` | `roomId`,`file` | 发文件 |
| `sendSticker` | `roomId`,`stickerId` | 发指定表情包 |
| `pickSticker` | `text`,`roomId`,`minScore?`,`allowedSources?` | 按语境挑表情包 |
| `stickers` | `limit?` | 表情包库 |
| `importStickers` | `dir?` | 从目录导入表情包 |
| `pruneStickers` | — | 清理表情包库 |
| `genEmotions` | — | 可用题材列表 |
| `genSticker` | `emotion`,`extra?`,`bubble?`,`force?` | Agnes 生成表情包（题材/场景/气泡） |
| `addBubble` | `file`,`text`,`pos?` | 给已有图加文字气泡 |
| `fetchMedia` | `xml`,`type`,`roomId?`,`ts?` | 取媒体文件（图片会**自动解密**） |
| `pat` | `roomId`,`wxid` | 拍一拍 |
| `revoke` | `roomId`,`msgid` | 撤回 |
| `forward` | `roomId`,`msgid` | 转发 |

---

## 三、HTTP 接口

```bash
# 状态
curl http://127.0.0.1:17300/api/status

# 群列表 / 群成员
curl http://127.0.0.1:17300/api/rooms
curl "http://127.0.0.1:17300/api/members?room=12345678@chatroom"

# 读消息
curl "http://127.0.0.1:17300/api/messages?room=12345678@chatroom&limit=20"

# 发文字
curl -X POST http://127.0.0.1:17300/api/send \
  -H 'content-type: application/json' \
  -d '{"room":"12345678@chatroom","text":"大家好"}'

# 发表情包（按语境挑一张）
curl -X POST http://127.0.0.1:17300/api/sticker/send \
  -H 'content-type: application/json' \
  -d '{"room":"12345678@chatroom","text":"好累"}'

# 生成表情包
curl -X POST http://127.0.0.1:17300/api/sticker/gen \
  -H 'content-type: application/json' \
  -d '{"subject":"摸鱼","scene":"瘫在办公椅上刷手机","bubble":"别叫我"}'

# 取并解密群里最近的图
curl -X POST http://127.0.0.1:17300/api/image \
  -H 'content-type: application/json' -d '{"room":"12345678@chatroom"}'
```

`room` 参数可以是 **群名**、**roomId**，只有一个群时留空。所有响应都是 JSON。

---

## 四、托管模式（让桥替 agent 管节流）

开启后，桥收到消息会先过一遍**拟人策略**（是否该回、间隔、频率上限、作息、防重复），
判定要回时才把上下文 POST 给 agent 的 webhook，agent 回一段文字，桥负责**拟人投递**（打字延迟、拆条、记记忆）。

```json
// data/bridge-config.json
{
  "hosted": {
    "enabled": true,
    "webhookUrl": "http://127.0.0.1:9999/reply",
    "timeoutMs": 20000,
    "secret": ""
  }
}
```

桥发给 webhook 的请求：

```json
{
  "room": { "id": "12345678@chatroom", "name": "某某群" },
  "trigger": { "sender": "wxid_xxx", "senderName": "梦云", "text": "在吗", "typeName": "text", "isAtMe": true },
  "recent": [ { "senderName": "梦云", "text": "…" } ],
  "members": [ { "wxid": "wxid_xxx", "name": "梦云" } ],
  "memory": { "facts": ["…"], "pendingQuestion": "…" },
  "priority": "at"
}
```

agent 期望的响应：

```json
{ "text": "在呢，咋了", "sticker": { "subject": "摸鱼", "bubble": "别叫我" } }
```

- `text` 必填（可为空字符串表示"只发表情包"）
- `sticker` 可选：桥会按题材挑/生成表情包
- 返回空对象或不返回 → 桥放弃这次回复

---

## 五、策略服务（给外部 agent 复用拟人逻辑）

即使不用托管模式，也可以只借用"该不该回 / 怎么像人一样发"的判断：

```bash
# 该不该回这条消息？
curl -X POST http://127.0.0.1:17300/api/policy/decide \
  -H 'content-type: application/json' \
  -d '{"room":"12345678@chatroom","sender":"wxid_xxx","text":"在吗","priority":"at"}'
# → {"reply":true,"reason":"被@（必回）","delayMs":1200}

# 帮我把这句话"拟人地"发出去（延迟 + 拆条）
curl -X POST http://127.0.0.1:17300/api/policy/deliver \
  -H 'content-type: application/json' \
  -d '{"room":"12345678@chatroom","text":"在呢\n刚才在忙","priority":"at"}'
# → {"sent":2,"parts":["在呢","刚才在忙"],"totalDelayMs":3400}
```

---

## 六、⚠️ 两个大脑不能同时开

| 大脑 | 位置 | 负责 |
|---|---|---|
| **DSH 插件** | `wechat-group-agent`（跑在 DSH 里） | 拟人策略 + LLM + 记忆 + 表情包 |
| **托管模式** | `wx-bridge`（`hosted.enabled=true`） | 拟人策略 + 调用外部 agent 的 webhook |

**同时开启 → 每条消息会被回复两次**（群里看到重复回答）。

- 用 DSH 插件 → 保持 `hosted.enabled = false`
- 用外部 agent → 关掉 DSH 插件（或让它不要接同一个群），并开 `hosted.enabled = true`

桥会在 DSH 插件接管时**打印警告**提醒你。

## 七、已知问题：hook 的数据库扫描会偶发失效

**现象**：`/QueryDB/GetAllDBName` 返回空、`/QueryDB/execute` 报 `get database handle failed` → 群成员昵称和"轮询收消息"一起失效。

**原因**：我们修好的 hook 靠"扫内存找 sqlite 句柄"，微信客户端**自行重启**后偶尔扫不到（`/QueryDB/debug` 能看到 `scan_hits`）。

**已内置自愈**：桥的看门狗每分钟探测一次数据库，**连续 3 次失败就自动重启客户端**（重启后恢复正常，实测有效）。

**手动恢复**：停桥 → 杀掉 `D:\wxhook\wx4110\Weixin.exe` → 启动它（工作目录必须是客户端目录）→ 起桥。
验证：`curl http://127.0.0.1:30001/QueryDB/debug` 应有响应（这是自编译版的标记，官方版没有这条路由）。
