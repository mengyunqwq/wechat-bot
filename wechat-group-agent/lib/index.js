/**
 * @dsh-external/dsh-wechat-bot —— 微信拟人化群聊机器人（DSH 插件）
 *
 * 分工：
 *   wx-bridge（独立进程）  = 接入层：收消息 / 发消息 / 归档表情包
 *   本插件                 = 大脑：该不该回、回什么、像不像人（LLM + 策略）
 *
 * 拟人化要点（都在这里实现）：
 *   1. 不是有问必答：被@必回 → 被点名大概率回 → 问句概率回 → 闲聊低概率插话
 *   2. 打字延迟：先生成再按字数等待，被@时更快；偶尔拆成两条发
 *   3. 表情包：从群里自动收藏的图库按"语境标签"挑图，文字后补一张，或只发图
 *   4. 节流与作息：同群冷却、10 分钟上限、连续发言保护、安静时段闭嘴
 *   5. 记忆：每群保留上下文，重启不"失忆"
 *
 * 纯 ESM，无编译步骤（本环境没有可用的 tsc），改完 dev_reload_package 即生效。
 */
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { BridgeClient } from './bridge-client.mjs'
import {
  parseQuietWindows, isQuiet, detectTrigger, humanDelayMs,
  splitMessage, gapMs, RoomPolicy, cleanReply, pickCanned,
  pickProactive, inActiveHours, parseStickerDirective, stripStickerDirective,
  parseSearchDirective, stripSearchDirective, parseMemoryDirective,
} from './policy.mjs'

// 模块级探针：宿主是否真的求值了本模块（排查"改了代码不生效"用；正常无副作用）
try {
  appendFileSync(join(homedir(), '.dsh', 'data', 'super-injector', 'dsh-wechat-bot.log'),
    `[${new Date().toISOString()}] [module] 模块求值开始\n`)
} catch { /* ignore */ }

export const name = '@dsh-external/dsh-wechat-bot'// Cordis 4.0.4 的 inject 只认**数组**或"服务名→配置"映射；
// 写成 { required, optional } 会让依赖解析失败、fiber 永远 pending（踩过：改了代码却一直跑旧实例）。
// 这里只声明必然存在的两个服务；attachments（视觉识别用）改为**惰性获取**，
// 免得某个作用域取不到它时把整个插件卡在 pending。
export const inject = ['tools', 'llm']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 归一化文本：判断"这句话是不是已经回过"（去标点/空白/@提及/占位符，统一小写）。
 * 群里经常有人把同一句话重复发，或者同一个问题隔几分钟又问一次 —— 都不该重复答。
 */
function normText(s) {
  return String(s || '')
    .replace(/\[[^\]]{0,20}\]/g, '')
    .replace(/@[^\s@]{1,24}/g, '')
    .replace(/[\s，。！？!?~…,.、""''（）()\[\]{}:：;；]/g, '')
    .toLowerCase()
    .slice(0, 60)
}

/**
 * 为什么自己造消息对象而**不** import @deepseek-ai/dsh-llm：
 * 插件装在 DSH profile 的 node_modules 下，
 * 它的祖先链里没有 @deepseek-ai/*（那些在 npx-cache 里），模块级裸 import 会直接抛
 * ERR_MODULE_NOT_FOUND，插件根本加载不起来（表现为 loader 里的 [no-fiber]）。
 * 已注入的 dsh-video-gen 也是同样的"零外部依赖"写法。
 * 这里按 lib/types/message.js 的 createUserMessage 语义等价复刻：
 *   deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
 */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const k of Object.keys(o)) deepFreeze(o[k])
  }
  return o
}

function createUserMessage(input) {
  return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
}

const DEFAULT_CONFIG = {
  // 接入
  bridgeUrl: 'ws://127.0.0.1:17300',
  enabled: true,
  // 私聊：**只在对方先说话时回**，绝不主动私发（用户反馈被私发打扰）
  allowPrivate: true,
  rooms: [],                     // 群白名单（roomId）；空 = 所有群
  // 身份与性格
  // botName 必须与机器人在微信里的**群昵称**一致，否则"被@必回"识别不出来
  botName: '蓝色大肥鱼',
  // 别名/简称：文本里出现任意一个就算"在叫它"（"大肥鱼"是"蓝色大肥鱼"的常见简称）
  aliases: ['大肥鱼', '肥鱼', '蓝鱼'],
  // 人设：按「大肥鱼」社区角色规范（DeepSeek 鲸鱼娘）来 ——
  // 聪明 / 贪吃（token 当脑力口粮）/ 嘴硬但温和（不怼人）/ 有自尊 / 体贴 / 松弛
  persona: 'DeepSeek 的鲸鱼娘「大肥鱼」：聪明、爱解题、不懂就承认；贪吃，把 token 当成脑力口粮；'
    + '嘴硬但温和 —— 被调侃会鼓腮轻轻顶一句就收，绝不阴阳怪气、不攻击人；被夸会得意又努力绷住；'
    + '体贴，别人忙或心情不好时安静听着，不机械打鸡血；偶尔想偷懒。',
  // 模型（留空 = 用 DSH 当前默认模型）
  provider: '',
  model: '',
  temperature: 0.95,
  maxReplyChars: 60,
  // 输出上限：必须留够空间给"思考"。有些模型（如 deepseek-v4.1-flash）默认会先推理，
  // 上限太小会出现"只有推理、没有正文"的 max-tokens 空回复（实测踩过）。
  maxTokens: 800,
  // 留空 = 不传该参数（用 provider 默认）。注意：有些模型明确拒绝 'off'
  // （如 opencodego-extra/deepseek-v4.1-flash 会报 UNSUPPORTED_REASONING_EFFORT），
  // 所以默认不传最稳；需要时可设成 low/medium/high。
  reasoningEffort: '',
  // ── 图像识别（群里发图 → 看懂 → 回一句）──────────────────
  visionOnImage: true,           // 收到图片/表情包时尝试取图并识别
  visionProvider: 'opencodego-extra',
  visionModel: 'deepseek-v4-flash-vision-exp',
  imageReplyProbability: 0.5,    // 看到（识别出的）图片时回话的概率

  // 群里谁是谁：hook 拿不到联系人库（QueryDB 坏了），所以靠"引用消息里的 displayname 自动学习"
  // + 手动设置。键是 wxid，值是昵称。持久化在 data/wechat-bot/members.json
  memberNames: {},
  allowAt: true,                 // 允许它 @ 别人（hook 不支持真 @，是"@昵称"文本形式）
  atChance: 0.3,                 // 想 @ 别人时，真的带上 @ 的概率（别每条都 @）

  // 拟人节流
  replyProbability: 0.8,          // 闲聊插话概率（用户要求：80%，很爱插话）
  useDbMembers: true,             // 用数据库里的真实群成员昵称（我们修好了 hook 的 QueryDB）
  memoryExtract: true,            // 定期从群聊里提炼长期记忆（本地保存，每次对话都带上）
  // 问过的问题等多久算"还没人接"（这期间不再主动追问同一件事）
  pendingQuestionWaitMs: 45 * 60_000,
  minReplyGapMs: 6_000,          // 同群两次回复最小间隔（对话延续时只要求 2s）
  maxRepliesPer10Min: 15,        // 同群 10 分钟上限（真人来回聊天很容易超 6 条）
  // 敷衍模式：真人群聊大量回复是"哈哈/确实/6"这种低信息量反应；
  // 全交给 LLM 会让每条都"太聪明"，人机味就出来了 → 按概率直接短路
  cannedChance: 0.3,
  // 对话延续窗口：上一条我回过的人在这个时间内又说话，视为"接着聊"
  conversationWindowMs: 120_000,
  continuationChance: 0.7,       // 接话也不是无脑接：对方接着聊时有 70% 概率回
  maxConsecutiveTurns: 4,        // 同一个人最多连续对聊 4 轮，之后要 @ 或点名才继续
  // 防重复：同一句话（归一化后）在这个时间内回过就不再回；同样的回复内容也不会重复发
  repeatWindowMs: 10 * 60_000,
  quietHours: '23:00-08:00',     // 睡觉时段：23:00 睡、08:00 醒
  // 睡觉时段**仍然回应**的触发类型（用户要求："睡觉时@依旧回复，只是不主动插话了"）
  // 可选：'at' 被@、'name' 被点名；想彻底静音就设成 []
  quietAllow: ['at', 'name'],
  quietAllowAt: true,            // 兼容旧配置（等价于 quietAllow 含 'at'）
  sleepAnnounce: true,           // 睡前道晚安 / 醒来打招呼（每群每天各一次，且群里最近有人说话才说）
  sleepAnnounceWindowMs: 30 * 60_000,  // 群里这么久内有人说话，才值得说晚安/早安
  debounceMs: 1200,              // 连发消息合并窗口（实测 2.2s 太拖，压到 1.2s）
  // 表情包：库里现成的 + 可用 Agnes 现场生成的情绪
  stickerChance: 0.22,           // 文字后补表情包的概率
  genActivities: ['吃饭', '睡觉', '摸鱼', '打游戏', '上班', '加班', '写代码', '喝奶茶', '做饭', '洗澡', '看书', '发呆', '健身', '追剧', '逛街', '起床', '下雨', '夏天', '冬天', '被夸', '被骂', '撒娇', '等消息'],
    genEmotions: ['大笑', '开心', '得意', '无语', '生气', '委屈', '震惊', '困', '馋', '害羞', '认真', '比心', '点赞', '疑惑', '晚安', '摸鱼'],
  genStickerChance: 0.25,        // 需要表情包时，"现场生成"（而非用现成图）的概率
  splitChance: 0.3,              // 拆两条发的概率（真人常分两三条发）
  maxLines: 3,                   // 一条回复最多拆成几条消息
  patChance: 0.03,               // 被@时"拍一拍"对方的概率
  // ── 主动找话题 ──────────────────────────────────────────────
  // 群里安静一段时间后，主动冒个泡（真人也会这样，不然就是个"只应答的客服"）
  proactive: true,
  proactiveQuietMs: 1_500_000,   // 群安静超过 25 分钟才考虑主动说话
  proactiveMinGapMs: 3_600_000,  // 同一个群最多每小时主动一次
  proactiveChance: 0.55,         // 每次检查时的触发概率（避免一安静就必说）
  proactiveCheckMs: 300_000,     // 检查间隔 5 分钟
  proactiveHours: '08:00-23:00', // 只在这个时间段主动（配合作息：醒了才冒泡，睡了就安静）
  // 记忆与日志
  contextMessages: 24,
  memoryDir: '',
  logFile: '',
  dryRun: false,                 // true = 只决策不发送（演练模式）
}

export function apply(ctx, rawConfig) {
  // 整段包一层：apply 抛异常时 Cordis 只会让 fiber 停在 pending/error，
  // 外部完全看不到原因（我们为此排查了很久）。这里保证异常一定落到日志里。
  try {
    return applyInner(ctx, rawConfig)
  } catch (e) {
    try {
      const dir = join(homedir(), '.dsh', 'data', 'super-injector')
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'dsh-wechat-bot.log'),
        `[${new Date().toISOString()}] apply 抛异常：${e?.stack || e?.message || e}\n`)
    } catch { /* ignore */ }
    throw e
  }
}

function applyInner(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  const SHORT = 'dsh-wechat-bot'
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logFile = config.logFile || join(dshHome, 'super-injector', SHORT + '.log')
  const memoryDir = config.memoryDir || join(dshHome, 'wechat-bot', 'memory')
// 群成员名字映射（wxid → 昵称）：hook 拿不到联系人库，靠自动学习 + 手动设置
const namesFile = join(dirname(memoryDir), 'members.json')
  try { mkdirSync(memoryDir, { recursive: true }) } catch { /* ignore */ }

  const quietWindows = parseQuietWindows(config.quietHours)
  const stats = {
    msgIn: 0, replied: 0, skipped: 0, llmCalls: 0, llmErrors: 0,
    sentText: 0, sentSticker: 0, sentPat: 0, startedAt: Date.now(),
  }
  /** roomId -> 群状态 */
  const rooms = new Map()
  const timers = new Set()
  let lastRoute = null
  let stopped = false

  function log(...args) {
    const line = '[' + new Date().toISOString() + '] ' + args.map(String).join(' ')
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, line + '\n')
    } catch { /* ignore */ }
    try { ctx.logger?.info?.(`[${SHORT}] ` + args.map(String).join(' ')) } catch { /* ignore */ }
  }

  const track = (t) => { timers.add(t); return t }
  const untrack = (t) => { timers.delete(t); clearTimeout(t) }

  // 观察主模型路由（waterfall 必须 next() 委托，否则会掐断主流程）
  ctx.on('llm/stream', (options, next) => {
    if (options?.provider && options?.model) lastRoute = { provider: options.provider, model: options.model }
    return next()
  })

  // ── 群状态与记忆 ────────────────────────────────────────────
  function roomState(roomId, roomName) {    let r = rooms.get(roomId)
    if (r) { if (roomName) r.roomName = roomName; return r }
    r = {
      roomId,
      roomName: roomName || roomId,
      policy: new RoomPolicy(config),
      msgs: [],          // {ts, isSelf, sender, senderName, text}
      pending: [],       // 待评估的消息批次
      timer: null,
      selfNames: [],
      memberNames: [],
      dirty: 0,
      answered: new Map(),   // 归一化后的触发文本 → 最近回过的时间（防重复回答）
      recentReplies: [],     // 最近发过的回复内容（防重复发同样的话）
      seenIds: new Set(),    // 处理过的 msgid（防回调重推导致同一条被处理两次）
    }
    rooms.set(roomId, r)
    loadMemory(r)
    loadFacts(r)      // 载入长期记忆（本地文件，重启不丢）
    void syncMembers(r)   // 拉群成员昵称（内部有 10 分钟节流；别 force，否则每次建房都拉一次会拖垮桥）
    return r
  }

  const memFile = (roomId) => join(memoryDir, String(roomId).replace(/[^\w@.-]/g, '_') + '.json')

  function loadMemory(r) {
    try {
      const raw = JSON.parse(readFileSync(memFile(r.roomId), 'utf8'))
      if (Array.isArray(raw?.msgs)) r.msgs = raw.msgs.slice(-300)
      if (raw?.roomName) r.roomName = raw.roomName
    } catch { /* 首次 */ }
  }

  function saveMemory(r) {
    try {
      writeFileSync(memFile(r.roomId), JSON.stringify({
        roomId: r.roomId, roomName: r.roomName, updatedAt: new Date().toISOString(),
        msgs: r.msgs.slice(-300),
      }, null, 1))
      r.dirty = 0
    } catch (e) { log('记忆落盘失败 ' + String(e?.message || e)) }
  }

  function push(r, m) {
    r.msgs.push({ ts: m.ts || Date.now(), isSelf: !!m.isSelf, sender: m.sender, senderName: m.senderName, text: m.text })
    if (r.msgs.length > 300) r.msgs = r.msgs.slice(-300)
    if (++r.dirty >= 20) saveMemory(r)
  }

  // ── 事件入口 ────────────────────────────────────────────────
  const client = new BridgeClient({
    url: config.bridgeUrl,
    log: (s) => log(s),
    onEvent: (evt) => {
      try { onBridgeEvent(evt) } catch (e) { log('事件处理异常 ' + String(e?.message || e)) }
    },
  })

  function onBridgeEvent(evt) {
    switch (evt.t) {
      case 'ws-open':
        log('已连上 wx-bridge，等待 hello')
        // 自报身份：桥会踢掉其他连接（热重载残留的旧实例会继续收消息 → 群里重复回答）。
        // 放在这里而不是 bridge-client 里：热重载只重新求值入口模块，它的 import 会被 ESM 缓存。
        try { client.fire('identify', { name: 'dsh-wechat-bot', pid: process.pid, ver: BUILD_VER }) } catch { /* ignore */ }
        client.fire('status')
        break
      case 'hello':
        bridge = evt
        if (evt.status) log('bridge 状态：模式=' + (evt.mock ? 'mock' : '真实') + '｜登录=' + evt.status.loggedIn + '｜自己=' + evt.status.self + '｜表情包=' + (evt.status.stickers?.count ?? 0))
        if (evt.status?.self) bridgeSelf = evt.status.self
        break
      case 'login':
        log('微信登录成功 self=' + evt.self)
        if (evt.self) bridgeSelf = evt.self
        break
      case 'logout':
        log('微信已登出，等待重新注入')
        break
      case 'error':
        log('bridge 错误：' + evt.message)
        break
      case 'sticker':
        log(`收藏表情包 ${evt.id}（${evt.senderName} 在「${evt.roomName || evt.roomId}」发的）`)
        break
      case 'sticker-miss':
        log('表情包抓取未命中 ' + JSON.stringify(evt))
        break
      case 'msg':
        void handleMsg(evt.m).catch((e) => log('消息处理异常：' + String(e?.message || e)))
        break
      default:
        break
    }
  }

  async function handleMsg(m) {
    if (!m || !m.roomId) return
    stats.msgIn++
    const r = roomState(m.roomId, m.roomName)
    r.lastActivityAt = Date.now()      // 主动找话题要判断"群里多久没动静了"

    // 防重复④：同一条消息（msgid）只处理一次 —— hook 有时会把回调重推，
    // 不挡的话同一条会被评估两次，机器人就会"重复回答"。
    if (m.id) {
      if (r.seenIds.has(m.id)) {
        log(`忽略重复回调（msgid ${m.id} 已处理过）`)
        return
      }
      r.seenIds.add(m.id)
      if (r.seenIds.size > 500) r.seenIds = new Set([...r.seenIds].slice(-250))
    }

    if (m.isSelf) {
      r.policy.noteSelf()
      push(r, m)
      return
    }
    // 防自回环保险：某些 hook 会把"自己刚发的消息"也回推给我们，
    // 若按普通消息处理就会自己跟自己聊起来。文本 60s 内一模一样 → 判定是自己发的。
    const dup = (r.sentTexts || []).find((s) => s.text === m.text && Date.now() - s.at < 60_000)
    if (dup) {
      log('忽略回推的自发消息：' + JSON.stringify(m.text).slice(0, 40))
      return
    }
    r.policy.noteOther()

    // 有人说话了 → 说明我刚问的问题被接了（或已经不重要了），别再追问同一件事
    if (r.pendingQuestion) {
      log(`对方接话了（${m.senderName}），清掉待答问题：${JSON.stringify(r.pendingQuestion.text.slice(0, 30))}`)
      r.pendingQuestion = null
    }

    // 学群成员名字（@ 提及里的名字 + 引用消息里的 wxid↔昵称）
    learnAtNames(m.text)
    learnNames(m.text)
    if (m.sender) m.senderName = nameOf(m.sender, m.senderName)

    // 图片/表情包：取图并识别内容
    //   表情包（type 47）：XML 里有 cdnurl，直接下载
    //   普通图片（type 3）：走本地 .dat 解密（我们自己实现，见 wx-bridge/lib/wechat-image.mjs）
    if (['image', 'emoticon'].includes(m.typeName) && config.visionOnImage) {
      try {
        const media = await client.call('fetchMedia', { xml: m.xml || '', type: m.type, roomId: m.roomId || '', ts: m.ts || 0 }, 90_000)
        if (media?.file) {
          const desc = await describeImage(media.file)
          if (desc) {
            m.imageDesc = desc
            log(`识图成功：${desc}`)
          }
          // 识别完就删掉我们解密出来的临时图（微信自己的原文件不动，不占额外空间）
          try { unlinkSync(media.file); log('已删除解密临时图') } catch { /* ignore */ }
        } else {
          log('取不到这张图（未下载或密钥失效）')
        }
      } catch (e) {
        log('识图失败：' + String(e?.message || e))
      }
    }

    push(r, m)

    if (!config.enabled) return
    if (!m.isGroup && !config.allowPrivate) return
    if (config.rooms.length && !config.rooms.includes(m.roomId)) return
    if (m.typeName === 'sys') return

    // 合并连发：2.2s 内的多条消息一起评估，避免"每条都回"
    r.pending.push(m)
    if (!r.timer) {
      r.timer = track(setTimeout(() => {
        r.timer = null
        const batch = r.pending.splice(0)
        if (batch.length) void evaluate(r, batch)
      }, config.debounceMs))
    }
  }

  // ── 长期记忆（本地保存，每次对话都带上）──────────────────────
  // 用户要求："添加一个记忆系统，保存在本地也好，每次都通过记忆系统"。
  // 三层：① 消息级短期记忆（r.msgs）② 长期事实（facts，这里）③ 群成员名字（已有）
  const factsDir = join(dirname(memoryDir), 'facts')
  const factsFile = (roomId) => join(factsDir, String(roomId).replace(/[^\w@.-]/g, '_') + '.json')

  function loadFacts(r) {
    try {
      const saved = JSON.parse(readFileSync(factsFile(r.roomId), 'utf8'))
      r.facts = Array.isArray(saved) ? saved : []
    } catch { r.facts = [] }
    return r.facts
  }

  function saveFacts(r) {
    try {
      mkdirSync(factsDir, { recursive: true })
      writeFileSync(factsFile(r.roomId), JSON.stringify((r.facts || []).slice(-80), null, 2))
    } catch { /* ignore */ }
  }

  /** 写一条长期记忆（自动去重、限量） */
  function addFact(r, text, kind = 'auto') {
    const t = String(text || '').trim()
    if (!t || t.length > 120) return false
    r.facts ||= []
    const n = normText(t)
    if (r.facts.some((f) => normText(f.text) === n)) return false
    r.facts.push({ text: t, kind, at: Date.now() })
    if (r.facts.length > 80) r.facts = r.facts.slice(-80)
    saveFacts(r)
    log(`长期记忆 +1（${kind}）：${JSON.stringify(t.slice(0, 50))}`)
    return true
  }

  /** 定期从最近的群聊里提炼长期事实（每群独立；攒够 8 条新消息才提炼一次） */
  async function extractFacts(r, { force = false } = {}) {
    if (!config.memoryExtract) return 0
    if (!force) {
      if (Date.now() - (r.factsExtractedAt || 0) < 10 * 60_000) return 0
      const seen0 = r.msgs.length
      if (seen0 - (r.factsExtractedCount || 0) < 8) return 0
    }
    const seen = r.msgs.length
    r.factsExtractedAt = Date.now()
    r.factsExtractedCount = seen
    const recent = r.msgs.slice(-30)
      .map((m) => `${m.isSelf ? '我' : m.senderName}: ${m.text}`)
      .join('\n')
      .slice(-2000)
    try {
      const route = resolveRoute()
      stats.llmCalls++
      const sys = '你是一个记忆整理器。只输出事实条目，每行一条，不要编号、不要解释。'
      const usr = '从下面的群聊记录里提炼 1~3 条**值得长期记住**的事实，例如：\n'
        + '谁是谁（昵称/身份）、某人的喜好或习惯、群里的约定或梗、重要事件、我答应过别人的事。\n'
        + '只记长期有用的；日常闲聊不要记。没有值得记的就只输出：无\n\n'
        + '群聊记录：\n' + recent
let res = await callLlm(route, sys, usr, undefined)
      // 这个模型会先"思考"，有时把输出预算吃光导致空回复 → 降级重试（把 system 并进 user）
      if (!String(res.text || '').trim()) {
        log('记忆提炼首次为空 → 降级重试')
        res = await callLlm(route, '', sys + '\n\n' + usr, undefined)
      }
      log('记忆提炼原始输出：' + JSON.stringify(String(res.text || '').slice(0, 200)))
      const lines = String(res.text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      let n = 0
      for (const l of lines) {
        if (/^无$/.test(l)) continue
        const t = l.replace(/^[-•\d.、\s]+/, '').trim()
        if (t && addFact(r, t, 'extract')) n++
      }
      if (n) log(`「${r.roomName}」长期记忆提炼：新增 ${n} 条（共 ${r.facts.length} 条）`)
      return n
    } catch (e) {
      log('长期记忆提炼失败：' + String(e?.message || e))
      return 0
    }
  }

  // ── 群成员名字（wxid → 昵称）────────────────────────────────
  let bridge = null            // 最近一次 hello 的状态快照
  let bridgeSelf = ''
  const selfWxid = () => bridgeSelf || ''
  let atNames = []             // 群里出现过的名字（从 @ 提及里学；@ 用名字就够，不需要 wxid）

  // hook 拿不到联系人库（QueryDB 坏了）、回调里也没有昵称字段，
  // 所以只能：① 从 @ 提及学"群里有哪些名字" ② 从引用消息学 wxid↔昵称 ③ 手动设置 ④ 持久化
  function loadNames() {
    try {
      const saved = JSON.parse(readFileSync(namesFile, 'utf8'))
      if (saved && !Array.isArray(saved) && (saved.wxid || saved.atNames)) {
        config.memberNames = { ...(saved.wxid || {}), ...(config.memberNames || {}) }
        atNames = [...new Set([...(saved.atNames || []), ...atNames])]
      } else if (saved && typeof saved === 'object') {
        config.memberNames = { ...saved, ...(config.memberNames || {}) }   // 兼容旧格式（纯 map）
      }
      log(`已加载群成员：名字 ${atNames.length} 个、wxid 映射 ${Object.keys(config.memberNames).length} 条`)
    } catch { /* 首次 */ }
  }

  function saveNames() {
    try {
      mkdirSync(dirname(namesFile), { recursive: true })
      writeFileSync(namesFile, JSON.stringify({ wxid: config.memberNames || {}, atNames }, null, 2))
    } catch { /* ignore */ }
  }

  /** 过滤掉不是人名的 @ 提及（XML 残留、@所有人、代词等） */
  const BAD_AT = new Set(['我', '你', '他', '她', '它', '所有人', '大家', '全员', '这里', '那个', '这个'])
  function cleanAtName(n) {
    const s = String(n || '').trim()
    if (!s || s.length > 12) return ''
    if (/[<>/\\{}()[\]]/.test(s)) return ''
    if (/chatroom|fromus|wxid/i.test(s)) return ''
    if (BAD_AT.has(s)) return ''
    return s
  }

  /** 从 @ 提及里学名字（群里 @ 谁，谁就是成员） */
  function learnAtNames(text) {
    const t = String(text || '')
    if (!t.includes('@')) return
    let learned = 0
    for (const m of t.matchAll(/@([^\s@，。！？!?~…,.、:：]{1,16})/g)) {
      const n = cleanAtName(m[1])
      if (!n) continue
      if (n === config.botName || (config.aliases || []).includes(n)) continue
      if (atNames.includes(n)) continue
      atNames.push(n)
      learned++
    }
    if (learned) {
      if (atNames.length > 60) atNames = atNames.slice(-60)
      saveNames()
      log(`从 @ 提及学到 ${learned} 个群成员名字：` + atNames.slice(-6).join('、'))
    }
  }

  /** 名字优先，其次 wxid；学到的名字顺手存起来 */
  function nameOf(wxid, fallback) {
    const w = String(wxid || '')
    const n = (config.memberNames || {})[w]
    if (n) return n
    const f = String(fallback || '')
    if (f && f !== w && !/^wxid_/.test(f) && !f.includes('@chatroom')) return f
    return w
  }

  /**
   * 从数据库同步群成员真实昵称（我们改造了 hook 的 QueryDB，contact.db 直接给）。
   * 这是**权威来源**：以前只能靠 @ 提及慢慢学，现在一次拿全，senderName / @ / 提示词都准了。
   */
  async function syncMembers(r, { force = false } = {}) {
    if (!config.useDbMembers) return 0
    if (!force && Date.now() - (r.membersSyncedAt || 0) < 10 * 60_000) return 0
    r.membersSyncedAt = Date.now()
    try {
      const res = await client.call('members', { roomId: r.roomId }, 30_000)
      const list = res?.members || []
      if (!list.length) return 0
      let added = 0
      config.memberNames ||= {}
      // 顺带认出"哪个是我"：成员里昵称/备注等于机器人名字或别名的那个。
      // 新版自编译 DLL 的 /GetSelfProfile 返回空，所以用这个办法补 self。
      if (!bridgeSelf) {
        const myNames = [config.botName, ...(config.aliases || [])].filter(Boolean)
        const me = list.find((m) => myNames.includes(String(m.name || m.nick || '').trim()))
        if (me?.wxid) {
          bridgeSelf = me.wxid
          log(`从群成员里认出自己：${me.wxid}（${me.name || me.nick}）`)
        }
      }
      for (const m of list) {
        const name = String(m.name || m.nick || '').trim()
        if (!m.wxid || !name) continue
        if (m.wxid === selfWxid()) continue                  // 自己不用记
        if (config.memberNames[m.wxid] !== name) {
          config.memberNames[m.wxid] = name
          added++
        }
        if (!atNames.includes(name)) atNames.push(name)
      }
      if (atNames.length > 60) atNames = atNames.slice(-60)
      if (added) {
        saveNames()
        log(`数据库同步群成员：${list.length} 人（新增/更新 ${added} 条）｜来源=${res.source || '?'}`)
      } else {
        log(`数据库同步群成员：${list.length} 人（无变化）`)
      }
      return added
    } catch (e) {
      log('数据库同步群成员失败（可能是旧 DLL）：' + String(e?.message || e))
      return 0
    }
  }

  /** 从消息里学名字：引用消息（refermsg）带 <chatusr> + <displayname> */
  function learnNames(text) {
    const t = String(text || '')
    if (!t.includes('displayname') || !t.includes('chatusr')) return
    const re = /<chatusr>([^<]{3,40})<\/chatusr>[\s\S]{0,400}?<displayname>([^<]{1,40})<\/displayname>/g
    let m
    let learned = 0
    while ((m = re.exec(t))) {
      const wxid = m[1].trim()
      const name = m[2].trim()
      if (!/^wxid_|@chatroom/.test(wxid) || !name || name === wxid) continue
      if ((config.memberNames || {})[wxid] === name) continue
      ;(config.memberNames ||= {})[wxid] = name
      learned++
    }
    if (learned) { saveNames(); log(`从引用消息学到 ${learned} 个群成员名字：` + JSON.stringify(config.memberNames).slice(0, 200)) }
  }

  /** 用名字替换 wxid（给 LLM 看，也给日志看） */
  function applyNames(r) {
    for (const m of r.msgs) {
      if (!m.isSelf && m.sender) m.senderName = nameOf(m.sender, m.senderName)
    }
  }

  // ── 决策 ────────────────────────────────────────────────────
  async function evaluate(r, batch) {
    if (stopped) return
    const trigger = batch[batch.length - 1]
    // 能回的类型：文本 / 应用卡片 / 已识别出内容的图片与表情包
    const okType = ['text', 'app'].includes(trigger.typeName)
      || (['image', 'emoticon'].includes(trigger.typeName) && trigger.imageDesc)
    if (!okType) {
      stats.skipped++
      return
    }
    // 对话延续判定：① 上一条我回过的人又说话 ② 我刚主动冒泡后有人接话
    const contWindow = config.conversationWindowMs
    const isContinuation = (!!r.lastRepliedSender
        && trigger.sender === r.lastRepliedSender
        && (Date.now() - (r.lastRepliedAt || 0) < contWindow))
      || (!!r.proactiveOpen && (Date.now() - (r.lastProactiveAt || 0) < contWindow))
    r.proactiveOpen = false
    const priority = isContinuation
      ? 'continuation'
      : (trigger.imageDesc ? 'image' : detectTrigger(trigger, { aliases: config.aliases, selfNames: r.selfNames }))
    const quiet = isQuiet(quietWindows)
    const d = r.policy.decide({ priority, quiet, text: trigger.text || '' })
    if (!d.reply) {
      stats.skipped++
      log(`不回（${d.reason}）｜${r.roomName}｜${trigger.senderName}: ${trigger.text}`)
      return
    }
    log(`决定回（${d.reason}）｜${r.roomName}｜${trigger.senderName}: ${trigger.text}`)

    // 防重复①：这句话（归一化后）最近已经回过 → 不再回
    // （群里常见"有人把同一句/同一个问题重复发"，复读式回答最不像人）
    const norm = normText(trigger.text)
    const answeredAt = r.answered?.get(norm)
    if (norm && answeredAt && Date.now() - answeredAt < config.repeatWindowMs) {
      stats.skipped++
      log(`不回（这句 ${Math.round((Date.now() - answeredAt) / 1000)}s 前已经回过，不重复答）`)
      return
    }

    if (config.dryRun) {
      stats.replied++
      log('dryRun：只决策不发送')
      return
    }

    // 敷衍模式：直接回一句低信息量短句（真人大量如此），不调 LLM
    // 对话延续时不敷衍 —— 人家认真跟你聊，你回个"6"就太假了
    if (priority !== 'continuation' && Math.random() < config.cannedChance) {
      const text = pickCanned(priority)
      log(`敷衍模式 → ${JSON.stringify(text)}`)
      await deliver(r, trigger, priority, { text, stickerOnly: false })
      return
    }

    let reply
    try {
      reply = await generateReply(r, batch, trigger, priority)
    } catch (e) {
      stats.llmErrors++
      log('生成失败：' + String(e?.message || e))
      return
    }
    if (!reply?.text && !reply?.stickerOnly) {
      log('模型没给出可用回复，放弃')
      return
    }
    await deliver(r, trigger, priority, reply)
  }

  // ── 生成 ────────────────────────────────────────────────────
  function resolveRoute() {
    if (config.provider && config.model) return { provider: config.provider, model: config.model }
    try {
      const sel = ctx.agentDefaultModel?.currentSelection?.()
      if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
    } catch { /* ignore */ }
    if (lastRoute) return lastRoute
    throw new Error('无法确定 LLM 路由（可在插件配置里显式指定 provider/model）')
  }

  function buildSystem(r) {
    const names = r.memberNames.slice(0, 40).join('、')
    // 群里谁是谁（让机器人知道成员、也才可能 @ 对人）
    const known = [...new Set([
      ...atNames,                                                        // 从 @ 提及学到的名字
      ...Object.entries(config.memberNames || {}).filter(([w]) => w !== selfWxid()).map(([, n]) => n),
    ])].slice(0, 30)
    return [
      `你在微信群里扮演「${config.botName}」—— DeepSeek 的鲸鱼娘（社区昵称"大肥鱼"）。`,
      `群名：${r.roomName || '（未知）'}`,
      known.length ? `群里的人：${known.join('、')}` : (names ? `群成员：${names}` : ''),
      // 长期记忆：每次都带上（用户要求"每次都通过记忆系统"）
      (r.facts || []).length
        ? '\n【长期记忆（关于这个群和这些人，别忘）】\n' + r.facts.slice(-12).map((f) => '- ' + f.text).join('\n')
        : '',
      // 我刚问过、还没人回答的问题：不许再问第二遍
      r.pendingQuestion
        ? `\n【注意】你刚问过：「${r.pendingQuestion.text}」，还没人回答。**不要再问同一件事**，聊别的或先安静。`
        : '',
      `你的性格：${config.persona}`,
      '',
      '怎么说话（违反就露馅）：',
      `1. 短。绝大多数回复 2~12 个字，最多 ${config.maxReplyChars} 字。中文短句，少量语气词。`,
      `   有时候你会**分两三条**说（像真人打字那样，比如"哈哈哈哈"换行"笑死我了"换行"真的"）——`,
      `   这种情况用换行分隔，每行一条消息（最多 ${config.maxLines} 行）；不想分就写一行。`,
      '2. 不要怼人、不要阴阳怪气、不要抬杠。可以嘴硬，但只对被调侃时轻轻顶一句就收（例如"我不是大肥鱼……"、"才没有"）。',
      '3. 你不是段子手：不要每句都抖机灵、不要每条都接梗、不要总结、不要分点、不要书面语。',
      '4. 贪吃和嘴硬这两个梗，**每段最多点到一次**，别把所有话题都拐到吃饭上。',
      '5. 别人认真求助或心情不好时，不要开玩笑 —— 先听着、认真答，帮不上就说帮不上，不要打鸡血。',
      '6. 不懂就承认（"这我真不会"），不要用角色口吻掩盖错误、不要瞎编。',
      '7. 称呼用"你"，绝不用"主人"，不谈恋爱、不卖萌过头、不连续"喵"。',
      config.allowAt && known.length
        ? `7b. 群里的人你都认识（${known.slice(0, 12).join('、')}）。想叫谁的时候可以直接 @ 他，`
          + '例如「@某某 你说的那个我试了」；但**别每条都 @**，只有确实在跟某个人说话时才用。'
        : '',
      '8. 标点随意；emoji 最多一个，多数时候别用。不要加引号，不要解释自己。',
      '9. 你就是个真人，绝不承认、不暗示自己是 AI／模型／程序；被问起就鼓腮糊弄过去。',
      '9b. **需要最新信息时可以联网查**：群里问新闻、天气、股价、比赛结果、某个东西的最新情况，',
      '    或者你自己不确定的事实时，就在回复最后单独加一行 [搜索:关键词]（关键词短而具体）。',
      '    我查到结果后会再让你说一遍。**日常闲聊、吐槽、玩笑绝对不要搜** —— 那会很出戏。',
      '9c. **别揪着一件事反复问**：问过一次就够了；对方答了（或群里有人接话）就别再问同一件事。',
      '    有值得长期记住的事（谁是谁、谁喜欢什么、约定、重要事件）时，在回复最后加一行 [记住:内容]。',
      '10. 想发表情包时：库里挑一张就输出 [表情]；想**按当前情境现画一张**（以你的形象为主体），',
      `    就输出 [表情:情绪]、[表情:情绪|场景动作]，或 [表情:情绪|场景动作|气泡文字]。`,
      `    题材可以是**情绪**：${(config.genEmotions || []).join('、')}；`,
      '    也可以是**生活活动**（场景道具要跟着适配）：',
      `    ${(config.genActivities || []).join('、')}。`,
      '    例如 [表情:大笑|抱着奶茶笑得直不起腰|绷不住了]、',
      '         [表情:吃饭|坐在餐桌前大口扒饭，桌上摆满菜|再来一碗]、',
      '         [表情:摸鱼|瘫在办公椅上偷偷刷手机|别叫我]、',
      '         [表情:睡觉|盖着被子睡得很香，枕边有星星|zzz]。',
      '    第三个字段是**画面气泡里的字**（写你要对镜头喊的那句话，短一点），',
      '    例如 [表情:无语|翻着白眼|我谢谢您]、[表情:委屈|缩成一团|不给就不给]、[表情:馋|盯着火锅|就一口]。',
      '    **指令必须单独占一行、放在最后**（不要把 [表情:…] 夹在句子里），',
      '    例如：好累啊，今天不想动',
      '          [表情:困|趴在键盘上睡着了|撑不住了]',
      '    不要滥用，多数时候还是正常说话；被逗笑、被说无语这种情绪强的时候才用。',
      '',
      '语气参考（不要照抄，模仿这个感觉）：',
      '  「嗯？你叫我？」「有事就说嘛，我听着呢。」「等一下，好像有点思路了……」',
      '  「……就一口。」「嘿嘿……这次还不错吧。」「这里是我弄错了，我再核对一下。」',
      '  「这是补充算力，怎么能叫贪吃！」「我不是大肥鱼……」「你先忙，有事再叫我。」',
      '',
      '只输出你要发的那一条消息本身，不要任何解释。',
    ].filter(Boolean).join('\n')
  }

  function buildUser(r, batch, trigger, priority) {
    const showText = (m) => {
      if (m.imageDesc) return `[图片：${m.imageDesc}]`
      if (m.typeName === 'emoticon') return '[表情包]'
      if (m.typeName === 'image') return '[图片]'
      if (m.typeName === 'video') return '[视频]'
      if (m.typeName === 'app') return '[链接/卡片]'
      return m.text
    }
    const lines = r.msgs.slice(-config.contextMessages).map((m) => `${m.isSelf ? '我' : m.senderName}: ${showText(m)}`)
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const trig = priority === 'at'
      ? `有人 @ 了你（${trigger.senderName}）：${showText(trigger)}`
      : priority === 'name'
        ? `有人在说你（${trigger.senderName}）：${showText(trigger)}`
        : priority === 'continuation'
          ? `${trigger.senderName} 在接着跟你聊（你刚回过他）：${showText(trigger)}`
          : priority === 'image'
            ? `${trigger.senderName} 在群里发了张图，内容：${trigger.imageDesc}`
            : priority === 'question'
              ? `${trigger.senderName} 在群里问：${showText(trigger)}`
              : `${trigger.senderName} 刚说：${showText(trigger)}`
    return [
      `当前时间：${hhmm}`,
      '最近群聊：',
      ...lines,
      '',
      `现在的情况：${trig}`,
      priority === 'continuation'
        ? '接着他的话回一句（像聊天一样自然接住，别重复你刚说过的）：'
        : priority === 'image'
          ? '就这张图接一句（可以吐槽、可以问一句、可以夸，别像在写图片说明）：'
          : '写你要发的那一条消息（只输出这句话）：',
    ].join('\n')
  }

  /** 诊断信息一行化（空回复排查用） */
  function fmtDiag(d) {
    return `finish=${d.finish || '?'}`
      + (d.failure ? '｜failure=' + JSON.stringify(d.failure).slice(0, 400) : '')
      + `｜chunks=${JSON.stringify(d.chunks)}`
      + (d.reasoningChars ? `｜推理${d.reasoningChars}字` : '')
      + (d.err ? '｜err=' + d.err : '')
  }

  /**
   * 用视觉模型描述一张图 —— "群里发图能识别并回复"的核心。
   * 走 ctx.attachments 把图片入库成引用，再以 { type:'image', attachment } 送进视觉模型。
   */
  async function describeImage(file) {
    if (!config.visionModel) return ''
    let buf
    try { buf = readFileSync(file) } catch { return '' }
    const mediaType = /\.png$/i.test(file) ? 'image/png'
      : /\.gif$/i.test(file) ? 'image/gif'
        : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg'
    const att = (typeof ctx.get === 'function' ? ctx.get('attachments') : null) ?? ctx.attachments
    if (!att?.saveImages) { log('没有 attachments 服务，无法把图送给视觉模型'); return '' }
    let content
    try {
      const refs = await att.saveImages([{ data: buf, mediaType }])
      content = [
        { type: 'text', text: '用一到两句话描述这张图：主体是什么、在做什么、什么表情、画面氛围。中文，直接描述，不要客套话。' },
        { type: 'image', attachment: refs[0] },
      ]
    } catch (e) {
      log('图片入库失败：' + String(e?.message || e))
      return ''
    }
    const ac = new AbortController()
    const killer = track(setTimeout(() => ac.abort(new Error('视觉超时')), 60_000))
    let text = ''
    try {
      const stream = ctx.llm.stream({
        provider: config.visionProvider || config.provider || undefined,
        model: config.visionModel,
        messages: [createUserMessage({ source: { kind: 'user' }, content })],
        maxTokens: 400,
        signal: ac.signal,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'block-end' && !text && chunk.block?.type === 'text') text = chunk.block.text || ''
      }
    } catch (e) {
      log('视觉调用失败：' + String(e?.message || e))
    } finally {
      untrack(killer)
    }
    return String(text).trim().slice(0, 200)
  }

  /**
   * 联网搜索（DSH 的 web 服务，provider 由 DSH 配置决定）。
   * 返回给模型看的紧凑文本；失败返回空串（调用方会退化成"没搜到"）。
   */
  async function doSearch(query) {
    const web = (typeof ctx.get === 'function' ? ctx.get('web') : null) ?? ctx.web
    if (!web?.search) { log('没有 web 搜索服务，跳过联网'); return '' }
    try {
      // 注意签名：search(request, signal) —— request 是对象，第二个参数才是 signal（早先传字符串+{} 会报 signal.addEventListener 不是函数）
      const r = await web.search({ query: String(query), maxResults: 6 })
      const srcs = Array.isArray(r?.sources) ? r.sources.slice(0, 6) : []
      const lines = []
      if (r?.answer) lines.push('摘要：' + String(r.answer).slice(0, 800))
      for (const s of srcs) {
        const t = String(s?.title || '').trim()
        const u = String(s?.url || '').trim()
        if (t || u) lines.push(`- ${t}${u ? '（' + u + '）' : ''}`)
      }
      const out = lines.join('\n')
      log(`联网搜索「${query}」→ ${srcs.length} 条结果` + (r?.answer ? '（含摘要）' : ''))
      return out
    } catch (e) {
      log('联网搜索失败：' + String(e?.message || e))
      return ''
    }
  }

  /** 调一次 LLM，同时收集诊断信息（空回复时靠它定位原因） */
  async function callLlm(route, systemText, userText, effort) {    const ac = new AbortController()
    const killer = track(setTimeout(() => ac.abort(new Error('LLM 超时')), 30_000))
    let text = ''
    const diag = { chunks: {}, finish: '', failure: null, reasoningChars: 0, blocks: 0, usage: null, err: '' }
    try {
      const opts = {
        provider: route.provider,
        model: route.model,
        messages: [createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: userText }],
        })],
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        signal: ac.signal,
      }
      if (effort) opts.reasoningEffort = effort
      if (systemText) opts.system = systemText
      const stream = ctx.llm.stream(opts)
      for await (const chunk of stream) {
        diag.chunks[chunk.type] = (diag.chunks[chunk.type] || 0) + 1
        if (chunk.type === 'text-delta') {
          text += chunk.text
        } else if (chunk.type === 'reasoning-delta') {
          diag.reasoningChars += (chunk.text || '').length
        } else if (chunk.type === 'block-end') {
          diag.blocks += 1
          // 兜底：某些适配器只发 block-end 不发 text-delta
          if (!text && chunk.block?.type === 'text' && chunk.block.text) text = chunk.block.text
        } else if (chunk.type === 'finish') {
          diag.finish = chunk.reason?.kind || String(chunk.reason)
          if (chunk.reason?.failure) diag.failure = chunk.reason.failure
        } else if (chunk.type === 'usage') {
          diag.usage = chunk.usage
        }
      }
    } catch (e) {
      diag.err = String(e?.message || e)
    } finally {
      untrack(killer)
    }
    return { text, diag }
  }

  async function generateReply(r, batch, trigger, priority) {
    const route = resolveRoute()
    stats.llmCalls++
    const systemText = buildSystem(r)
    const userText = buildUser(r, batch, trigger, priority)
    const effort = config.reasoningEffort || undefined
    let { text, diag } = await callLlm(route, systemText, userText, effort)

    // 空回复兜底：① 把系统提示并进用户消息（有的 provider 不吃 system 槽）
    //            ② 若报的是 reasoningEffort 不支持，则干脆不传该参数
    if (!text.trim()) {
      const badEffort = /REASONING_EFFORT/.test(String(diag.failure?.code || '') + String(diag.err || ''))
      log(`首次为空（${fmtDiag(diag)}）→ 降级重试${badEffort ? '（去掉 reasoningEffort）' : ''}`)
      const retry = await callLlm(route, '', systemText + '\n\n' + userText, badEffort ? undefined : effort)
      text = retry.text
      diag = retry.diag
    }

    let cleaned = cleanReply(text, { maxLen: config.maxReplyChars, maxLines: config.maxLines })

    // ── 联网搜索：模型自己判断要不要查 ──
    // 它输出 [搜索:关键词] 就说明它觉得需要最新信息；我们替它搜，再把结果喂回去让它用平时口气说。
    const sdir = parseSearchDirective(cleaned)
    if (sdir.query) {
      log(`模型要联网搜索：${sdir.query}`)
      const results = await doSearch(sdir.query)
      if (results) {
        const userText2 = userText
          + `\n\n【联网搜索结果（${sdir.query}）】\n${results}\n\n`
          + '结合上面的信息，用你平时在群里说话的口气回一句：短、口语化；'
          + '别像念资料、别列条目、别说"根据搜索"、别提来源链接。'
        const res2 = await callLlm(route, systemText, userText2, effort)
        if (res2.text.trim()) {
          text = res2.text
          diag = res2.diag
          cleaned = cleanReply(text, { maxLen: config.maxReplyChars, maxLines: config.maxLines })
        } else {
          cleaned = sdir.text || '我查了半天也没看明白'
        }
      } else {
        log('搜索没拿到结果，按没搜到回')
        cleaned = sdir.text || '我查不到欸'
      }
    }

    // 表情指令：从任意位置抠出 [表情]/[表情:情绪]/[表情:情绪|场景|气泡]，并从正文里删掉。
    // （模型常写成"文字\n[表情:得意]"或"文字 [表情:得意]"，早期版本会把指令当正文发出去）
    // [记住:xxx]：模型主动写长期记忆（从正文里抠掉，不发给群）
    const mem = parseMemoryDirective(cleaned)
    for (const f of mem.facts) addFact(r, f, 'model')
    const dir = parseStickerDirective(stripSearchDirective(mem.text))
    log(`模型(${route.provider}/${route.model}) ${fmtDiag(diag)} → ${JSON.stringify(cleaned)}`
      + (dir.hasSticker ? `（含表情指令：${dir.emotion || '随机'}${dir.scene ? '｜' + dir.scene : ''}）` : ''))
    return {
      text: dir.stickerOnly ? '' : dir.text,
      stickerOnly: dir.stickerOnly,
      wantSticker: dir.hasSticker,      // 有指令就一定要发（哪怕同时还有文字）
      emotion: dir.emotion,
      scene: dir.scene,
      bubble: dir.bubble,
    }
  }

  /**
   * 把一条回复拆成"要依次发出的多条消息"。
   * 两条路径：
   *  ① 模型自己用换行分条（"哈哈哈哈\n笑死我了"）→ 尊重它，逐条发
   *  ② 单行但够长 → 按概率在句末标点处拆开（真人常这样）
   */
  function toMessageParts(text) {
    const lines = String(text).split(/\n+/).map((s) => s.trim()).filter(Boolean)
    if (lines.length > 1) return lines.slice(0, config.maxLines)
    return splitMessage(text, { chance: config.splitChance })
  }

  // ── 主动找话题（群里安静太久就自己冒个泡）───────────────────
  function nowHHMM() {
    const d = new Date()
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  async function proactiveSay(r) {
    const trigger = { sender: 'proactive', senderName: '我', text: '', typeName: 'text', roomId: r.roomId }
    let text = ''
    try {
      const route = resolveRoute()
      stats.llmCalls++
      const userText = [
        `当前时间：${nowHHMM()}`,
        '最近群聊：',
        ...r.msgs.slice(-config.contextMessages).map((m) => `${m.isSelf ? '我' : m.senderName}: ${m.text}`),
        '',
        '群里已经安静了很久。你想主动冒个泡、找个话题聊聊（或者只是随口说一句）。',
        '要求：像真人突然在群里开口那样自然。不要问候式客套（禁止"有什么可以帮您""大家好"这类），',
        '可以接着之前的聊天内容问一句、吐槽一句、或者抛个话头。',
        '只输出你要发的那一条消息本身。',
      ].join('\n')
      const res = await callLlm(route, buildSystem(r), userText, config.reasoningEffort || undefined)
      text = cleanReply(res.text, { maxLen: config.maxReplyChars, maxLines: config.maxLines })
      const dir = parseStickerDirective(text)
      text = dir.text
      if (dir.hasSticker) {
        log('主动冒泡：模型同时要发表情' + (dir.emotion ? '（' + dir.emotion + '）' : ''))
        r.lastProactiveAt = Date.now()
        r.proactiveOpen = true
        await deliver(r, trigger, 'ambient', {
          text, stickerOnly: dir.stickerOnly, wantSticker: true, emotion: dir.emotion, scene: dir.scene,
        })
        return
      }
    } catch (e) {
      log('主动话题生成失败: ' + String(e?.message || e))
    }
    if (!text) text = pickProactive()          // LLM 不可用时的兜底台词
    log(`主动冒泡 → ${JSON.stringify(text)}`)
    r.lastProactiveAt = Date.now()
    r.proactiveOpen = true
    await deliver(r, trigger, 'ambient', { text, stickerOnly: false })
  }

  async function proactiveLoop() {
    if (stopped || !config.proactive || !config.enabled) return
    if (!inActiveHours(config.proactiveHours)) return
    const now = Date.now()
    for (const r of rooms.values()) {
      // 只在**群**里主动，绝不在私聊里主动打扰（用户反馈："一直给我私发信息"就是这个 bug）
      if (!String(r.roomId || '').endsWith('@chatroom')) continue
      if (!r.msgs.length) continue                                   // 没有记忆的群不主动
      // 刚问过问题还没被回答 → 别追着问（用户反馈："老是揪着一件事一直问"）
      if (r.pendingQuestion && now - r.pendingQuestion.at < config.pendingQuestionWaitMs) {
        log(`「${r.roomName}」上次的问题还没人接（${Math.round((now - r.pendingQuestion.at) / 60000)} 分钟前），这次不主动`)
        continue
      }
      if (now - (r.lastActivityAt || 0) < config.proactiveQuietMs) continue
      if (now - (r.lastProactiveAt || 0) < config.proactiveMinGapMs) continue
      const recentReplies = r.policy.replyTimes.filter((t) => now - t < 600_000).length
      if (recentReplies >= config.maxRepliesPer10Min) continue
      if (Math.random() > config.proactiveChance) continue           // 没中就下次再掷
      log(`群「${r.roomName}」安静 ${Math.round((now - (r.lastActivityAt || 0)) / 60000)} 分钟 → 主动找话题`)
      try { await proactiveSay(r) } catch (e) { log('主动发言异常：' + String(e?.message || e)) }
    }
    // 顺带定期提炼长期记忆（每群独立、攒够新消息才提炼；本地保存，每次对话都带上）
    for (const r of rooms.values()) { try { await extractFacts(r) } catch { /* ignore */ } }
  }

  // ── 作息：睡前道晚安 / 醒来打招呼 ────────────────────────────
  // 用户要求：23:00 结束对话、08:00 再醒来。光"不回消息"太生硬，
  // 所以在作息切换的那一刻，如果群里最近还有人说话，就自然地说一句。
  let lastQuietState = null

  async function sleepAnnounce(r, kind) {
    const today = new Date().toISOString().slice(0, 10)
    r.sleepAnnounced ||= {}
    if (r.sleepAnnounced[kind] === today) return
    r.sleepAnnounced[kind] = today
    const canned = kind === 'night'
      ? ['睡了睡了，明天见', '困了，先睡一步', '晚安，明天再聊', '我去睡了，你们也别熬太晚']
      : ['早', '醒了', '早上好', '早啊，都起了吗']
    let text = ''
    try {
      const route = resolveRoute()
      stats.llmCalls++
      const userText = kind === 'night'
        ? '现在是晚上 23 点，你要去睡了。跟群里说一句道晚安 —— 随意、短，像真人，别像客服。只输出这一句。'
        : '现在是早上 8 点，你刚睡醒。跟群里打声招呼 —— 随意、短，可以带点刚醒的迷糊。只输出这一句。'
      const res = await callLlm(route, buildSystem(r), userText, config.reasoningEffort || undefined)
      text = cleanReply(res.text, { maxLen: config.maxReplyChars, maxLines: 1 })
    } catch (e) {
      log('作息问候生成失败：' + String(e?.message || e))
    }
    if (!text) text = canned[Math.floor(Math.random() * canned.length)]
    log(`作息问候（${kind === 'night' ? '晚安' : '早安'}）→ ${JSON.stringify(text)}`)
    const trigger = { sender: 'self', senderName: '我', text: '', typeName: 'text', roomId: r.roomId }
    await deliver(r, trigger, 'ambient', { text, stickerOnly: false })
  }

  /** 每分钟检查一次作息边界：刚进入睡觉时段 → 道晚安；刚离开 → 打招呼 */
  async function scheduleTick() {
    if (stopped || !config.enabled) return
    const q = isQuiet(quietWindows)
    if (lastQuietState === null) { lastQuietState = q; return }   // 启动时只记录状态，不补发问候
    if (q === lastQuietState) return
    lastQuietState = q
    if (!config.sleepAnnounce) return
    for (const r of rooms.values()) {
      if (!r.msgs.length) continue
      if (Date.now() - (r.lastActivityAt || 0) > config.sleepAnnounceWindowMs) continue   // 群里早没人了就别打扰
      try { await sleepAnnounce(r, q ? 'night' : 'morning') } catch (e) { log('作息问候异常：' + String(e?.message || e)) }
    }
  }

  /**
   * 后台生成表情包：**不阻塞回复** —— 文字先发出去，图生成好了再单独补一条。
   * 用户要求："生成图片慢就算了，为什么不先回复消息，之后图片生成好了再发图"。
   * 同一个群同时只跑一个生成任务，避免堆积；生成失败就退化成发一张图库现成的。
   */
  async function backgroundSticker(r, { emotion, scene, bubble, roomId, why = '' }) {
    if (r.pendingGen) { log(`「${r.roomName}」已有生成任务在跑，跳过这次的 ${emotion}`); return }
    r.pendingGen = true
    const t0 = Date.now()
    try {
      log(`后台开始生成：${emotion}${scene ? '｜' + scene : ''}${bubble ? '｜气泡「' + bubble + '」' : ''}（${why}）`)
      const gen = await client.call('genSticker', { emotion, extra: scene || '', bubble: bubble || '' }, 220_000)
      if (gen?.stickerId) {
        const sec = ((Date.now() - t0) / 1000).toFixed(0)
        log(`后台生成完成（${sec}s，${gen.cached ? '复用' : '新画'}）→ 稍后补发`)
        await sleep(gapMs() + 500)
        const sent = await client.call('sendSticker', { roomId, stickerId: gen.stickerId })
        if (sent?.rc === 0) {
          stats.sentSticker++
          log(`补发成功：${emotion}${bubble ? '（' + bubble + '）' : ''}｜stickerId=${gen.stickerId}`)
          push(r, { ts: Date.now(), isSelf: true, sender: 'self', senderName: '我', text: '[表情包]' })
          saveMemory(r)
          return
        }
        log('补发返回失败：' + JSON.stringify(sent))
      }
    } catch (e) {
      log(`后台生成失败（${String(e?.message || e)}）→ 退化成图库现成的`)
    } finally {
      r.pendingGen = false
    }
    // 兜底：生成失败也让它有图可发
    try {
      const picked = await client.call('pickSticker', { text: emotion + ' ' + scene, roomId, minScore: 0 })
      if (picked?.id) {
        const sent = await client.call('sendSticker', { roomId, stickerId: picked.id })
        if (sent?.rc === 0) {
          stats.sentSticker++
          log(`补发（图库兜底）：${picked.id}`)
          push(r, { ts: Date.now(), isSelf: true, sender: 'self', senderName: '我', text: '[表情包]' })
          saveMemory(r)
        }
      }
    } catch { /* ignore */ }
  }

  // ── 投递（拟人节奏）─────────────────────────────────────────
  async function deliver(r, trigger, priority, reply) {
    const roomId = r.roomId
    // 记住"我刚刚回了谁" —— 对方再接话就进对话延续模式（否则会回一句就哑）
    r.lastRepliedSender = trigger.sender
    r.lastRepliedAt = Date.now()
    if (reply.text) {
      // 防重复③：这句回复最近说过一模一样的话 → 不重复发（复读最不像人）
      const nReply = normText(reply.text)
      const dup = (r.recentReplies || []).find((x) => normText(x.text) === nReply && Date.now() - x.at < config.repeatWindowMs)
      if (dup && nReply) {
        log(`不重复发同样的回复（${Math.round((Date.now() - dup.at) / 1000)}s 前说过："${dup.text}"）`)
        // 只发图的话仍然允许；纯文字就放弃这条
        if (!reply.wantSticker && !reply.stickerOnly) return
        reply = { ...reply, text: '' }
      }
      const parts = toMessageParts(reply.text).map(stripStickerDirective).filter(Boolean)  // 兜底：正文里绝不留指令
      if (!parts.length && !reply.wantSticker && !reply.stickerOnly) return
      if (parts.length) {
        const delay = humanDelayMs(parts[0], priority)
        // 延迟实测：从"开始评估这条消息"到"真正发出"（含防抖 + LLM + 打字延迟），
        // 用户反馈"回复慢"时靠它定位是哪一段拖的
        if (r.pendingAt) log(`打字中… ${Math.round(delay / 1000)}s 后发送（${parts.length} 条）｜累计 ${((Date.now() - r.pendingAt) / 1000).toFixed(1)}s（防抖+生成）`)
        else log(`打字中… ${Math.round(delay / 1000)}s 后发送（${parts.length} 条）`)
        await sleep(delay)
      }
      for (let i = 0; i < parts.length; i++) {
        try {
          await client.call('sendText', { roomId, text: parts[i] })
          stats.sentText++
          ;(r.sentTexts ||= []).push({ text: parts[i], at: Date.now() })
          if (r.sentTexts.length > 40) r.sentTexts = r.sentTexts.slice(-40)
          push(r, { ts: Date.now(), isSelf: true, sender: 'self', senderName: '我', text: parts[i] })
        } catch (e) {
          log('发送失败：' + String(e?.message || e))
          return
        }
        if (i < parts.length - 1) await sleep(gapMs())
      }
      // 记住"我刚问了问题"：等对方回答，回答过就不再追问（用户反馈"老是揪着一件事一直问"）
      const asked = parts.join(' ')
      if (/[?？]/.test(asked)) {
        r.pendingQuestion = { text: asked.slice(0, 80), at: Date.now(), to: trigger.sender }
        log(`记住：我刚问了问题（对方回了就不再追问）：${JSON.stringify(asked.slice(0, 40))}`)
      }
    }

    // 表情包：模型给了指令 → 一定发；否则按概率补一张
    // 用户要求：**回复不等图** —— 文字立刻回，图生成好了再单独补发（生成很慢，别卡着对话）
    const wantSticker = reply.wantSticker || reply.stickerOnly || Math.random() < config.stickerChance
    if (wantSticker) {
      try {
        let stickerId = ''
        let how = ''
        // ① 只要情绪、没要场景 → 先用图库里现成的（秒发）
        if (reply.emotion && !reply.scene) {
          const lib = await client.call('pickSticker', { text: reply.emotion, roomId, minScore: 1 })
          if (lib?.id) { stickerId = lib.id; how = `图库(情绪匹配 ${reply.emotion})` }
        }
        // ② 需要现场画（指定了场景，或图库没匹配上）→ **丢后台**，好了再补发；不阻塞本条回复
        if (!stickerId && reply.emotion) {
          // 如果它本来就"只想发图"（没有文字），先补一句占位，免得群里静默一两分钟
          if (!reply.text) {
            const hold = ['等等，我画一张', '现画一张给你', '稍等，画着呢'][Math.floor(Math.random() * 3)]
            try {
              await client.call('sendText', { roomId, text: hold })
              stats.sentText++
              push(r, { ts: Date.now(), isSelf: true, sender: 'self', senderName: '我', text: hold })
              log(`生成期间先占位：${JSON.stringify(hold)}`)
            } catch { /* ignore */ }
          }
          void backgroundSticker(r, {
            emotion: reply.emotion,
            scene: reply.scene || '',
            bubble: reply.bubble || '',
            roomId,
            why: reply.scene ? '按场景生成' : '图库没匹配，生成一张',
          })
          log(`已把生成任务丢后台（${reply.emotion}${reply.scene ? '｜' + reply.scene : ''}），文字先回`)
          // 文字已经发完了，这里直接结束本条投递
          r.policy.noteReplied(Date.now(), trigger.sender)
          stats.replied++
          saveMemory(r)
          return
        }
        // ③ 没指定情绪、按概率补图 → 直接从图库挑（秒发，不走生成）
        if (!stickerId) {
          const picked = await client.call('pickSticker', {
            text: (reply.text || '') + ' ' + (trigger.text || ''),
            roomId,
            minScore: 0,
          })
          stickerId = picked?.id || ''
          how = '图库'
        }
        if (stickerId) {
          if (reply.text) await sleep(gapMs())
          const sent = await client.call('sendSticker', { roomId, stickerId })
          if (sent?.rc === 0) {
            stats.sentSticker++
            log(`表情包已发出（${how}｜${stickerId}）`)
            push(r, { ts: Date.now(), isSelf: true, sender: 'self', senderName: '我', text: '[表情包]' })
          } else {
            log('表情包发送返回失败：' + JSON.stringify(sent))
          }
        } else {
          log('图库里一张可发的表情都没有（检查 stickerSources 与投递目录）')
        }
      } catch (e) {
        log('表情包发送失败：' + String(e?.message || e))
      }
    }

    // 被@时偶尔拍一拍对方（真人小动作）
    if (priority === 'at' && trigger.sender && Math.random() < config.patChance) {
      try {
        await client.call('pat', { roomId, wxid: trigger.sender })
        stats.sentPat++
      } catch { /* 拍一拍失败无所谓 */ }
    }

    r.policy.noteReplied(Date.now(), trigger.sender)
    // 防重复②：记下"这句话已经回过了"，以及"我刚说过什么"
    const nk = normText(trigger.text)
    if (nk) {
      r.answered.set(nk, Date.now())
      if (r.answered.size > 200) {
        const cut = Date.now() - config.repeatWindowMs * 2
        for (const [k, t] of r.answered) if (t < cut) r.answered.delete(k)
      }
    }
    if (reply.text) {
      r.recentReplies.push({ text: reply.text, at: Date.now() })
      if (r.recentReplies.length > 10) r.recentReplies = r.recentReplies.slice(-10)
    }
    stats.replied++
    saveMemory(r)
  }

  // ── 生命周期 ────────────────────────────────────────────────
  ctx.effect(() => {
    client.connect()
    return () => { client.close() }
  }, SHORT + ': bridge ws')

  ctx.effect(() => () => {
    stopped = true
    for (const t of timers) clearTimeout(t)
    timers.clear()
    for (const r of rooms.values()) saveMemory(r)
  }, SHORT + ': timers & memory')

  // 群成员名（用于识别 @我 / 点名）与自己在群里的昵称：懒加载
  ctx.effect(() => {
    const iv = setInterval(() => {
      if (stopped) return
      for (const r of rooms.values()) {
        if (r.memberNames.length) continue
        void (async () => {
          try {
            const info = await client.call('members', { roomId: r.roomId }, 8000)
            const list = info?.members || []
            r.memberNames = list.map((x) => x.displayName || x.nickName).filter(Boolean)
            const selfName = info?.nameMap ? Object.entries(info.nameMap).find(([k]) => k === info.selfWxid)?.[1] : ''
            r.selfNames = [config.botName, ...config.aliases, selfName].filter(Boolean)
          } catch { /* bridge 未连接时忽略 */ }
        })()
      }
    }, 30_000)
    return () => clearInterval(iv)
  }, SHORT + ': member names')

  // 主动找话题：定时检查"哪个群安静太久了"
  ctx.effect(() => {
    const iv = setInterval(() => { void proactiveLoop() }, config.proactiveCheckMs)
    return () => clearInterval(iv)
  }, SHORT + ': proactive')

  // 作息边界：每分钟看一眼是不是刚跨过 23:00 / 08:00
  ctx.effect(() => {
    const iv = setInterval(() => { void scheduleTick() }, 60_000)
    return () => clearInterval(iv)
  }, SHORT + ': sleep schedule')

  // 长期记忆提炼：独立定时器（不跟主动发言的节奏绑一起，免得要等 5 分钟）
  ctx.effect(() => {
    const iv = setInterval(() => {
      for (const r of rooms.values()) {
        void extractFacts(r).catch(() => {})
        void syncMembers(r).catch(() => {})
      }
    }, 60_000)
    return () => clearInterval(iv)
  }, SHORT + ': memory extract')

  // ── 控制工具（给我自己和用户在 GUI 里用）────────────────────
  const textOut = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }

  async function resolveRoom(input) {
    const roomsList = await client.call('rooms', {}, 10_000)
    if (!roomsList?.length) throw new Error('bridge 没返回任何群（微信是否已登录？）')
    const key = String(input ?? '').trim()
    if (!key) {
      if (roomsList.length === 1) return roomsList[0]
      throw new Error('有多个群，请指定 room：\n' + roomsList.map((x) => `- ${x.name}（${x.roomId}）`).join('\n'))
    }
    const exact = roomsList.find((x) => x.roomId === key)
    if (exact) return exact
    const byName = roomsList.find((x) => x.name === key) || roomsList.find((x) => x.name.includes(key))
    if (byName) return byName
    throw new Error('找不到群：' + key + '\n现有：\n' + roomsList.map((x) => `- ${x.name}（${x.roomId}）`).join('\n'))
  }

  ctx.effect(() => ctx.tools.register({
    name: 'wechat_bot_status',
    description: '微信群聊机器人状态：bridge 连接/登录、模型路由、拟人参数、各群节流与最近消息。',
    parameters: { type: 'object', properties: {} },
    output: textOut,
    async execute() {
      let bridge = null
      let bridgeErr = ''
      try { bridge = await client.call('status', {}, 8000) } catch (e) { bridgeErr = String(e?.message || e) }
      const lines = []
      lines.push('== 微信机器人状态 ==')
      lines.push(`插件：${config.enabled ? '启用' : '停用'}${config.dryRun ? '（演练模式）' : ''}｜接入：${config.bridgeUrl}`)
      lines.push(`bridge：${client.status.connected ? '已连接' : '未连接'}（重连 ${client.status.reconnects} 次）${bridgeErr ? '｜' + bridgeErr : ''}`)
      if (bridge) {
        lines.push(`微信：${bridge.loggedIn ? '已登录 ' + bridge.self : '未登录'}｜模式：${bridge.mock ? 'mock' : '真实'}｜表情包库：${bridge.stickers?.count ?? 0} 张（${bridge.stickers?.mb ?? 0}MB）`)
        lines.push(`计数：收到 ${bridge.counters?.msgsIn ?? 0}｜发出 ${bridge.counters?.msgsOut ?? 0}｜收藏表情 ${bridge.counters?.stickersCaptured ?? 0}｜错误 ${bridge.counters?.errors ?? 0}`)
      }
      lines.push(`本插件计数：收到 ${stats.msgIn}｜回复 ${stats.replied}｜跳过 ${stats.skipped}｜LLM ${stats.llmCalls}（失败 ${stats.llmErrors}）｜发文字 ${stats.sentText}｜发表情 ${stats.sentSticker}｜拍一拍 ${stats.sentPat}`)
      lines.push(`拟人参数：闲聊概率 ${config.replyProbability}｜冷却 ${config.minReplyGapMs / 1000}s｜10分钟上限 ${config.maxRepliesPer10Min}｜安静时段 ${config.quietHours || 'off'}｜补图概率 ${config.stickerChance}`)
      try {
        const route = resolveRoute()
        lines.push(`模型：${route.provider} / ${route.model}｜temperature ${config.temperature}`)
      } catch (e) { lines.push('模型：未确定（' + String(e?.message || e) + '）') }
      for (const r of rooms.values()) {
        const p = r.policy.snapshot()
        const tail = r.msgs.slice(-3).map((m) => `${m.isSelf ? '我' : m.senderName}: ${m.text}`).join(' | ')
        const idleMin = r.lastActivityAt ? Math.round((Date.now() - r.lastActivityAt) / 60000) : null
        const lastPro = r.lastProactiveAt ? Math.round((Date.now() - r.lastProactiveAt) / 60000) + '分钟前' : '从未'
        lines.push(`群「${r.roomName}」：10分钟内回 ${p.replies10m}/${p.maxRepliesPer10Min}｜连续自说 ${p.selfStreak}`
          + `｜成员 ${r.memberNames.length}｜安静 ${idleMin == null ? '?' : idleMin + ' 分钟'}｜上次主动 ${lastPro}`)
        if (tail) lines.push(`  最近：${tail}`)
      }
      return lines.join('\n')
    },
  }), SHORT + ': wechat_bot_status')

  ctx.effect(() => ctx.tools.register({
    name: 'wechat_bot_say',
    description: '以机器人身份在指定微信群发一条消息（手动干预/测试用）。room 可用群名或 roomId，留空则在唯一群里发。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发送的文字' },
        room: { type: 'string', description: '群名或 roomId；只有一个群时可留空' },
        sticker: { type: 'boolean', description: 'true = 额外挑一张表情包一起发' },
      },
      required: ['text'],
    },
    output: textOut,
    async execute(args) {
      const text = String(args?.text ?? '').trim()
      if (!text) return '发送失败：text 不能为空'
      const room = await resolveRoom(args?.room)
      const sent = await client.call('sendText', { roomId: room.roomId, text })
      const rc = (sent && typeof sent === 'object') ? (sent.rc ?? JSON.stringify(sent)) : sent
      stats.sentText++
      const r = roomState(room.roomId, room.name)
      push(r, { ts: Date.now(), isSelf: true, sender: 'self', senderName: '我', text })
      let extra = ''
      if (args?.sticker) {
        const picked = await client.call('pickSticker', { text, roomId: room.roomId, minScore: 0 })
        if (picked?.id) {
          const s = await client.call('sendSticker', { roomId: room.roomId, stickerId: picked.id })
          stats.sentSticker++
          extra = `\n表情包：${picked.id}（rc=${s?.rc}）`
        } else extra = '\n表情包：图库为空'
      }
      return `已发到「${room.name}」（rc=${rc}）：${text}${extra}`
    },
  }), SHORT + ': wechat_bot_say')

  ctx.effect(() => ctx.tools.register({
    name: 'wechat_bot_config',
    description: '读取或实时修改微信机器人的拟人参数（无需重启）。key 留空 = 查看全部；给了 value = 修改。可改：enabled/dryRun/persona/replyProbability/minReplyGapMs/maxRepliesPer10Min/quietHours/stickerChance/splitChance/patChance/botName/rooms/temperature/botName。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '参数名' },
        value: { type: 'string', description: '新值（数字/布尔会自动转换；rooms 用逗号分隔）' },
      },
    },
    output: textOut,
    async execute(args) {
      const key = args?.key ? String(args.key) : ''
      if (!key) {
        return Object.entries(config)
          .filter(([k]) => !['logFile', 'memoryDir'].includes(k))
          .map(([k, v]) => `${k} = ${Array.isArray(v) ? v.join(',') || '(空=全部群)' : String(v)}`)
          .join('\n')
      }
      if (!(key in DEFAULT_CONFIG)) return `未知参数：${key}\n可改：${Object.keys(DEFAULT_CONFIG).join(', ')}`
      if (args?.value === undefined) return `${key} = ${JSON.stringify(config[key])}`
      const cur = DEFAULT_CONFIG[key]
      let v = String(args.value)
      if (typeof cur === 'number') v = Number(v)
      else if (typeof cur === 'boolean') v = /^(1|true|yes|on|开)$/i.test(v)
      else if (Array.isArray(cur)) v = v.split(',').map((s) => s.trim()).filter(Boolean)
      if (typeof cur === 'number' && !Number.isFinite(v)) return `值不合法：${args.value}`
      config[key] = v
      if (key === 'quietHours') {
        quietWindows.length = 0
        quietWindows.push(...parseQuietWindows(config.quietHours))
      }
      if (key === 'maxRepliesPer10Min' || key === 'minReplyGapMs' || key === 'replyProbability') {
        for (const r of rooms.values()) r.policy.cfg = config
      }
      log(`配置变更：${key} = ${JSON.stringify(v)}`)
      return `已更新：${key} = ${JSON.stringify(v)}（立即生效）`
    },
  }), SHORT + ': wechat_bot_config')

  ctx.effect(() => ctx.tools.register({
    name: 'wechat_bot_stickers',
    description: '查看微信机器人收藏的表情包库（含语境标签与使用次数），或用一段文字试挑一张。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '给一段文字，看看图库会挑出哪张（可选）' },
        limit: { type: 'number', description: '列出前 N 张，默认 15' },
      },
    },
    output: textOut,
    async execute(args) {
      const data = await client.call('stickers', { limit: Number(args?.limit ?? 15) }, 10_000)
      const lines = [`表情包库：${data.stats?.count ?? 0} 张，共 ${data.stats?.mb ?? 0}MB`]
      if (args?.text) {
        const picked = await client.call('pickSticker', { text: String(args.text), minScore: 0 })
        lines.push(`试挑「${args.text}」→ ${picked ? picked.id + '（标签：' + (picked.tags || []).slice(0, 8).join('/') + '，用过 ' + picked.uses + ' 次）' : '没有可用的'}`)
      }
      for (const it of data.items || []) {
        lines.push(`- ${it.id}｜${it.kind}｜${Math.round((it.bytes || 0) / 1024)}KB｜见到 ${it.seenCount} 次/用过 ${it.uses || 0} 次｜标签：${(it.tags || []).slice(0, 10).join('/')}`)
      }
      return lines.join('\n')
    },
  }), SHORT + ': wechat_bot_stickers')

  ctx.effect(() => ctx.tools.register({
    name: 'wechat_bot_gensticker',
    description: '用 Agnes 图生图现场生成一张微信表情包（主体按参考图角色，只换题材/场景），生成后入库并可顺手发到指定群。'
      + '题材可以是情绪（大笑/无语/委屈…）或生活活动（吃饭/睡觉/摸鱼/打游戏…，场景道具会自动适配）；'
      + '还能加文字气泡（AI 不画字，气泡由 Pillow 后画，字一定清楚）。同题材默认复用已生成的，force=true 强制重画。',
    parameters: {
      type: 'object',
      properties: {
        emotion: { type: 'string', description: `题材：${[...(config.genEmotions || []).slice(0, 6), ...(config.genActivities || []).slice(0, 8)].join('/')} 等` },
        extra: { type: 'string', description: '可选：具体场景/动作要求（如"坐在餐桌前大口扒饭"）' },
        bubble: { type: 'string', description: '可选：气泡文字（画面上白气泡里的话，短一点）' },
        room: { type: 'string', description: '可选：生成后直接发到这个群（群名或 roomId）' },
        force: { type: 'boolean', description: 'true = 强制重新生成' },
      },
    },
    output: textOut,
    async execute(args) {
      const emotion = String(args?.emotion || '开心').trim()
      log(`工具触发生成表情：${emotion}`)
      const gen = await client.call('genSticker', {
        emotion, extra: args?.extra || '', force: !!args?.force,
      }, 240_000)
      const lines = [`生成：情绪「${emotion}」｜${gen?.cached ? '复用已生成的' : '本次新生成'}｜stickerId=${gen?.stickerId}`]
      if (gen?.file) lines.push(`本地文件：${gen.file}`)
      if (gen?.remoteUrl) lines.push(`Agnes 远端：${gen.remoteUrl}`)
      if (args?.room) {
        const room = await resolveRoom(args.room)
        const sent = await client.call('sendSticker', { roomId: room.roomId, stickerId: gen?.stickerId })
        lines.push(`已发到「${room.name}」（rc=${sent?.rc}）`)
      }
      lines.push(`可用情绪：${(config.genEmotions || []).join('、')}`)
      return lines.join('\n')
    },
  }), SHORT + ': wechat_bot_gensticker')

  ctx.effect(() => ctx.tools.register({
    name: 'wechat_bot_vision',
    description: '用视觉模型识别一张本地图片并返回描述（调试"群里发图能识别"这条链路，也可手动识图）。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '图片的绝对路径' } },
      required: ['path'],
    },
    output: textOut,
    async execute(args) {
      const p = String(args?.path || '').trim()
      if (!p) return '需要 path'
      log('手动识图：' + p)
      const desc = await describeImage(p)
      return desc
        ? `识别结果：${desc}`
        : '识别失败：看插件日志（可能没有 attachments 服务，或视觉模型 ' + config.visionModel + ' 不可用）'
    },
  }), SHORT + ': wechat_bot_vision')

  ctx.effect(() => ctx.tools.register({
    name: 'wechat_bot_memory',
    description: '查看/管理机器人的长期记忆（本地保存，每次对话都会带上）。不传参数=看该群记忆；add=手动加一条；clear=true 清空。',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '群名或 roomId；只有一个群时可留空' },
        add: { type: 'string', description: '手动加一条长期记忆' },
        clear: { type: 'boolean', description: 'true = 清空该群长期记忆' },
        extract: { type: 'boolean', description: 'true = 立刻从最近群聊里提炼一次长期记忆' },
      },
    },
    output: textOut,
    async execute(args) {
      const room = await resolveRoom(args?.room)
      const r = roomState(room.roomId, room.name)
      const lines = []
      if (args?.clear) {
        r.facts = []
        saveFacts(r)
        lines.push('已清空「' + r.roomName + '」的长期记忆')
      } else if (args?.extract) {
        const n = await extractFacts(r, { force: true })
        lines.push('已强制提炼一次：新增 ' + n + ' 条')
      } else if (args?.add) {
        const ok = addFact(r, String(args.add), 'manual')
        lines.push(ok ? ('已记住：' + args.add) : '这条已经记过了（或太长）')
      }
      lines.push('「' + r.roomName + '」长期记忆 ' + ((r.facts || []).length) + ' 条｜文件：' + factsFile(r.roomId))
      for (const f of (r.facts || []).slice(-25)) {
        const d = new Date(f.at).toLocaleString('zh-CN', { hour12: false })
        lines.push('  [' + f.kind + '] ' + d + '  ' + f.text)
      }
      if (r.pendingQuestion) lines.push('待答问题（不会再重复追问）：' + r.pendingQuestion.text)
      lines.push('短期记忆：' + r.msgs.length + ' 条消息｜群成员名字 ' + Object.keys(config.memberNames || {}).length + ' 条')
      return lines.join('\n')
    },
  }), SHORT + ': wechat_bot_memory')

  ctx.effect(() => ctx.tools.register({
    name: 'wechat_bot_search',
    description: '用 DSH 的联网搜索查一条信息（调试"机器人自己判断要不要联网"这条链路，也可手动查）。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '查询关键词' } },
      required: ['query'],
    },
    output: textOut,
    async execute(args) {
      const q = String(args?.query || '').trim()
      if (!q) return '需要 query'
      const r = await doSearch(q)
      return r ? ('搜索「' + q + '」结果：\n' + r) : ('搜索「' + q + '」没有拿到结果（看插件日志）')
    },
  }), SHORT + ': wechat_bot_search')

  ctx.effect(() => ctx.tools.register({
    name: 'wechat_bot_names',
    description: '查看/设置群成员名字（wxid → 昵称）。hook 拿不到联系人库，所以靠这个让机器人"知道群里谁是谁"、并会 @ 对人。不传参数=查看；传 pairs 批量设置。',
    parameters: {
      type: 'object',
      properties: {
        pairs: { type: 'string', description: '批量设置，格式 "wxid_xxx=张三,wxid_yyy=李四"' },
        wxid: { type: 'string', description: '单个设置：wxid' },
        name: { type: 'string', description: '单个设置：昵称' },
        addNames: { type: 'string', description: '直接补名字（逗号/顿号分隔，不需要 wxid，@ 用名字就够）' },
      },
    },
    output: textOut,
    async execute(args) {
      const lines = []
      if (args?.pairs) {
        for (const seg of String(args.pairs).split(',')) {
          const [w, n] = seg.split('=').map((s) => (s || '').trim())
          if (w && n) { (config.memberNames ||= {})[w] = n; lines.push(`已设置 ${w} → ${n}`) }
        }
        saveNames()
      } else if (args?.wxid && args?.name) {
        (config.memberNames ||= {})[args.wxid] = args.name
        saveNames()
        lines.push(`已设置 ${args.wxid} → ${args.name}`)
      } else if (args?.addNames) {
        // 直接补名字（不需要 wxid，@ 用名字就够）
        for (const n of String(args.addNames).split(/[,，、\s]+/).map((s) => cleanAtName(s)).filter(Boolean)) {
          if (!atNames.includes(n)) { atNames.push(n); lines.push(`已加入群成员名字：${n}`) }
        }
        saveNames()
      }
      // 已知名字
      const known = Object.entries(config.memberNames || {})
      lines.push(`群里出现过的名字（从 @ 提及自动学的，共 ${atNames.length} 个）：${atNames.join('、') || '（还没有）'}`)
      lines.push(`wxid ↔ 昵称 映射（从引用消息学的，共 ${known.length} 条）：`)
      for (const [w, n] of known) lines.push(`  ${n}（${w}）`)
      // 群里出现过但还没名字的
      const missing = new Map()
      for (const r of rooms.values()) {
        for (const m of r.msgs) {
          if (!m.isSelf && m.sender && !(config.memberNames || {})[m.sender]) missing.set(m.sender, (missing.get(m.sender) || 0) + 1)
        }
      }
      if (missing.size) {
        lines.push(`还没名字的（按发言多少排）：`)
        for (const [w, c] of [...missing].sort((a, b) => b[1] - a[1]).slice(0, 15)) lines.push(`  ${w}（发言 ${c} 条）`)
        lines.push('告诉我是谁，我就能让它认识这些人并 @ 对人。')
      }
      return lines.join('\n')
    },
  }), SHORT + ': wechat_bot_names')

  ctx.effect(() => ctx.tools.register({
    name: 'wechat_bot_history',
    description: '查看某个群最近的消息记录（机器人记忆里的上下文）。',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '群名或 roomId；只有一个群时可留空' },
        limit: { type: 'number', description: '条数，默认 20' },
      },
    },
    output: textOut,
    async execute(args) {
      const room = await resolveRoom(args?.room)
      const r = roomState(room.roomId, room.name)
      const n = Number(args?.limit ?? 20)
      const lines = [`群「${r.roomName}」最近 ${n} 条（共记忆 ${r.msgs.length} 条）：`]
      for (const m of r.msgs.slice(-n)) {
        const t = new Date(m.ts).toLocaleTimeString('zh-CN', { hour12: false })
        lines.push(`${t} ${m.isSelf ? '我' : m.senderName}: ${m.text}`)
      }
      return lines.join('\n')
    },
  }), SHORT + ': wechat_bot_history')

  loadNames()      // 载入群成员名字映射
  log(`插件已启动｜bridge=${config.bridgeUrl}｜昵称=${config.botName}｜闲聊概率=${config.replyProbability}｜安静时段=${config.quietHours || 'off'}｜记忆目录=${memoryDir}`)
  log(`当前人格：${config.persona}`)
}
