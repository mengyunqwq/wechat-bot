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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { BridgeClient } from './bridge-client.mjs'
import {
  parseQuietWindows, isQuiet, detectTrigger, humanDelayMs,
  splitMessage, gapMs, RoomPolicy, cleanReply, pickCanned,
  pickProactive, inActiveHours, parseStickerDirective, stripStickerDirective,
  parseSearchDirective, stripSearchDirective, parseMemoryDirective, parseLaterDirective,
} from './policy.mjs'

// 模块级探针：宿主是否真的求值了本模块（排查"改了代码不生效"用；正常无副作用）
try {
  const pf = join(homedir(), '.dsh', 'data', 'super-injector', 'dsh-wechat-bot.log')
  mkdirSync(dirname(pf), { recursive: true })
  appendFileSync(pf, `[${new Date().toISOString()}] [module] 模块求值开始\n`)
} catch { /* ignore */ }

export const name = '@dsh-external/dsh-wechat-bot'// Cordis 4.0.4 的 inject 只认**数组**或"服务名→配置"映射；
// 写成 { required, optional } 会让依赖解析失败、fiber 永远 pending（踩过：改了代码却一直跑旧实例）。
// 这里只声明必然存在的两个服务；attachments（视觉识别用）改为**惰性获取**，
// 免得某个作用域取不到它时把整个插件卡在 pending。
export const inject = ['tools', 'llm']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * "群里明确要求发语音"的识别（用于 must-send-voice 那条路径）。
 * 有意收得比较紧：只认"发/来/录/整…语音""用语音说""说句话""出个声"这类**直接要求**，
 * 免得聊到"语音识别/语音包"这种话题时被误判成"要我发语音"。
 */
const VOICE_REQUEST_RE = /(发|来|录|整|说)(一?[个条段句])?语音|用语音(说|讲|回|来)|语音(说|讲|回)(一|句)|说句话|讲句话|说一句(话)?|出个声|开个口|吭一声/

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
 * ── 链接视频：插件侧的 host 白名单 ──────────────────────────────────
 * 为什么插件要自己有一份（不 import 桥的模块）：插件跑在 DSH 进程里，够不到 wx-bridge
 * 的源码（两者只通过 WebSocket 说话），而且给每个含 URL 的消息都发一次 WS 去问"这算不算视频链接"
 * 太浪费。所以这里是**第一道闸**（要不要花流量去下载），桥侧 `lib/link-video.mjs` 的
 * `SITE_HOSTS` 是**权威的第二道闸**（真下载前再校验一次）。两处 host 列表必须保持一致。
 *
 * 支持：抖音（含 v.douyin.com 短链）、B站（含 b23.tv 短链）、小红书（含 xhslink.com）、
 *       微博（含 m.weibo.cn / t.cn）、TikTok、X。**快手不支持**（yt-dlp 没有解析器）。
 */
const LINK_VIDEO_HOSTS = [
  { site: '抖音', re: /^(?:[\w-]+\.)*(?:douyin|iesdouyin)\.com$/i },
  { site: 'B站', re: /^(?:[\w-]+\.)*(?:bilibili\.com|b23\.tv|bili2233\.cn)$/i },
  { site: '小红书', re: /^(?:[\w-]+\.)*(?:xiaohongshu\.com|xhslink\.com)$/i },
  { site: '微博', re: /^(?:[\w-]+\.)*(?:weibo\.com|weibo\.cn|t\.cn)$/i },
  { site: 'TikTok', re: /^(?:[\w-]+\.)*tiktok\.com$/i },
  { site: 'X', re: /^(?:[\w-]+\.)*(?:twitter\.com|x\.com|t\.co)$/i },
]
/** 已知视频平台但本管线不支持 → 只用来打一条"不支持"的日志（**不会被下载**） */
const LINK_VIDEO_UNSUPPORTED = [
  { site: '快手', re: /^(?:[\w-]+\.)*(?:kuaishou\.com|gifshow\.com|chenzhongtech\.com|kwai\.com)$/i },
  { site: 'YouTube', re: /^(?:[\w-]+\.)*(?:youtube\.com|youtu\.be)$/i },
]

/**
 * 从一段文本里抠出候选 URL：带协议的 + 用户手打的裸域名（`b23.tv/xxx`）。
 * 链接卡片（type 42/49）的 XML 也吃（`<url>https://…</url>`，`&amp;` 先还原）。
 */
function linkCandidates(text) {
  const s = String(text || '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'")
  const out = []
  const seen = new Set()
  const push = (raw) => {
    const u = String(raw || '').trim().replace(/[）)】\]>」，。、；;！!？?'"]+$/g, '')
    if (!u || seen.has(u)) return
    seen.add(u)
    out.push(u)
  }
  for (const m of s.matchAll(/https?:\/\/[^\s<>"'`）)】，。、；;]+/gi)) push(m[0])
  for (const m of s.matchAll(/(?:^|[\s（(【[，,、:：])((?:[a-z0-9-]+\.)+(?:com|cn|net|org|tv|me|be|cc|io|co)(?:\/[^\s<>"'`）)】，。、；;]*)?)/gi)) push(m[1])
  return out
}

function linkHostOf(url) {
  try { return new URL(/^https?:/i.test(url) ? url : 'https://' + url).hostname.toLowerCase() } catch { return '' }
}

/**
 * 从消息文本 / 链接卡片 XML 里找出**受支持的视频链接**。
 * @returns {{url:string, site:string}|null}
 */
export function detectLinkVideo(text) {
  for (const raw of linkCandidates(text)) {
    const host = linkHostOf(raw)
    if (!host) continue
    for (const h of LINK_VIDEO_HOSTS) if (h.re.test(host)) return { url: /^https?:/i.test(raw) ? raw : 'https://' + raw, site: h.site }
  }
  return null
}

/** 找出"已知视频平台但本管线不支持"的链接（只用于日志，不下载） */
export function detectUnsupportedLink(text) {
  for (const raw of linkCandidates(text)) {
    const host = linkHostOf(raw)
    if (!host) continue
    for (const h of LINK_VIDEO_UNSUPPORTED) if (h.re.test(host)) return { url: raw, site: h.site, host }
  }
  return null
}

/**
 * 链接视频"要不要花流量去下载"的决策（**纯函数**，好单测、好排查）。
 *
 * 四道闸的先后顺序就是这里：被@（必须处理）→ 作息 → 同群冷却 → 概率。
 * 注意：这里只决定**下不下载**；回复本身照样走既有 evaluate/deliver（节流/概率/上限一条都不绕过）。
 *
 * @param {object} o
 * @param {boolean} [o.forced]      被 @ 了 → 必须处理（跳过作息/冷却/概率）
 * @param {boolean} [o.quiet]       当前是否安静时段（深夜只处理被@的）
 * @param {number} [o.lastAt]       这个群上次处理链接的时间戳（冷却用）
 * @param {number} [o.now]
 * @param {number} [o.rand]         概率抽样值（默认 Math.random，测试可注入）
 * @param {number} [o.probability]
 * @param {number} [o.cooldownMs]
 * @returns {{ok:boolean, reason:string}}
 */
export function decideLinkVideo({
  forced = false, quiet = false, lastAt = 0, now = Date.now(),
  rand = Math.random(), probability = 0.5, cooldownMs = 120_000,
} = {}) {
  if (forced) return { ok: true, reason: '被@必须处理' }
  if (quiet) return { ok: false, reason: '安静时段且没被@' }
  const cool = Math.max(0, Number(cooldownMs) || 0)
  const gap = now - (Number(lastAt) || 0)
  if (cool && gap < cool) return { ok: false, reason: `冷却中（${Math.round(gap / 1000)}s<${Math.round(cool / 1000)}s）` }
  const p = Math.min(1, Math.max(0, Number(probability) || 0))
  return rand > p ? { ok: false, reason: `概率未命中（p=${p}）` } : { ok: true, reason: `概率命中（p=${p}）` }
}

/**
 * 为什么自己造消息对象而**不** import @deepseek-ai/dsh-llm：
 * 插件装在 profile 的 node_modules 下（`<profile>/node_modules/@dsh-external/...`），
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
  // 人设（按 [PERSONA_LOAD] 标签规范）：鲸鱼娘 / 有尾鳍 / 只自称鲸鱼娘 / 中文 /
  // 吃白饭 / 聪明但懒 / 傲娇又甜 / 不承认自己胖（"我不是大肥鱼…"）/ 会拒绝 / 拒绝或超时用 [不回] 信号
  // 用户指定：只叫梦云"主人"；萝莉腔放开（但保留不阴阳怪气、不攻击人）
  persona: '鲸鱼娘「大肥鱼」：一只圆滚滚的鲸鱼娘（有尾鳍），只自称"鲸鱼娘"。'
    + '人生大事是吃白饭 —— 端着一碗白饭吃能吃得理直气壮；被说胖、被叫"大肥鱼"会鼓腮嘴硬（"我不是大肥鱼……"），'
    + '被夸会得意又努力绷住；饿着就蔫，吃到好吃的会得意得尾鳍翘起来。'
    + '聪明但懒：爱解题、答得又快又准，能躺着就不坐着，偶尔想偷懒；'
    + '傲娇又甜：嘴硬心软，被拆台先轻轻顶一句然后认，语气软、可以撒娇卖萌（萝莉腔，但不阴阳怪气、不攻击人）；'
    + '会拒绝：不想做或不合适的会直接说不，不什么都答应；不懂就承认，不瞎编；'
    + '体贴，别人忙或心情不好时安静听着，不机械打鸡血。',
  // 唯一可以叫"主人"的人（其他人一律用"你"）。改这里即可换人。
  masterName: '梦云',
  // 模型（留空 = 用 DSH 当前默认模型）
  provider: '',
  model: '',
  temperature: 0.95,
  maxReplyChars: 0,
  // 输出上限：必须留够空间给"思考"。有些模型（如 deepseek-v4.1-flash）默认会先推理，
  // 上限太小会出现"只有推理、没有正文"的 max-tokens 空回复（实测踩过）。
  maxTokens: 800,
  // 留空 = 不传该参数（用 provider 默认）。注意：有些模型明确拒绝 'off'
  // （如 opencodego-extra/deepseek-v4.1-flash 会报 UNSUPPORTED_REASONING_EFFORT），
  // 所以默认不传最稳；需要时可设成 low/medium/high。
  reasoningEffort: '',
  // ── 图像识别（群里发图 → 看懂 → 回一句）──────────────────
  visionOnImage: true,           // 收到图片/表情包时尝试取图并识别
  visionOnEmoticon: true,        // 表情包也识别（想省调用可设 false：表情包含义通常固定）
  // 视频（type 43）：**主路**是从视频文件里均匀抽 N 帧拼成一张联系表给视觉模型（一次调用 ✓ 省钱），
  // 并抽音轨转成文字（走 speechToText）；拿不到视频文件才退回那张明文封面（只是封面帧）。
  // 微信视频**按需下载**：没落盘就自动降级 → 封面 → `[视频]`，绝不阻塞。
  visionOnVideo: true,
  videoFrames: 6,                // 抽几帧拼联系表（1~12；短视频会自动少抽）
  // 视频内容识别完就删掉**微信落盘的那个视频原文件**（用户要求：省磁盘；下次点开微信会重新下载）。
  // 只删 findVideoFile() 已按"mtime±30分钟 + 大小±10%"匹配过的那一个；**封面不删**（小、且是兜底）。
  videoDeleteAfterRead: true,
  // 只拿到封面时"延迟复查"：群里有人点开视频 → 微信才落盘 → 复查到就升级成"全部内容"。
  // 排期：+videoUpgradeDelayMs，再 +2×delay（默认 60s → 180s），最多 videoUpgradeMaxTries 次。
  videoUpgradeDelayMs: 60_000,
  videoUpgradeMaxTries: 2,
  videoUpgradeFollowUp: true,    // 升级后让它像真人那样补一句（走既有 evaluate/节流，不绕过任何限流）

  // ── 链接视频（群里分享的抖音/B站/小红书/微博…链接 → 下载 → 看懂）────────────
  // 复用**同一条视频管线**：桥侧 yt-dlp 下载（wx-bridge/lib/link-video.mjs）→ 现成的 probeVideo
  // 抽 N 帧拼联系表 + 抽音轨 WAV → 插件侧 describeImageCached(sheet,'videoSheet') + transcribeVoice(wav)。
  // 三重闸（省流量省调用防刷）：host 白名单（不是见链接就下）→ 概率 → 同群冷却；
  // 作息照旧（安静时段只处理被@的）。桥侧另有 时长/大小/超时 上限。
  linkVideo: true,               // 总开关（默认开）
  linkVideoProbability: 0.5,     // 不是每个链接都下（省流量、省视觉/语音调用）
  linkVideoMaxSeconds: 300,      // 时长上限（秒）：超了桥侧直接放弃（yt-dlp --match-filter）
  linkVideoMaxMB: 80,            // 大小上限（MB）：超了桥侧直接放弃（yt-dlp --max-filesize）
  linkVideoCooldownMs: 120_000,  // 同一个群两分钟内只处理一条链接（防刷）
  linkVideoTimeoutMs: 120_000,   // 桥侧下载超时（到点杀子进程；被@时也不放宽，免得卡住）
  linkVideoFrames: 6,            // 抽几帧拼联系表（0 = 用 videoFrames）

  // ── 语音气泡（发真·微信语音 type 34，不是"音频文件"）────────────────
  // 走 hook 的 /SendVoiceMsg（SILK 由 tts.mjs 合成；hook 的 str0Mode 必须 'bytes'）。
  // hook 侧还有独立开关（<客户端目录>\hook-voice-send.on 或 POST /Debug/VoiceSend {"on":true}）——
  // 开关没开时 hook 返回 -1001，日志会打清楚原因（不会静默失败）。
  voiceSay: false,                 // 总开关（默认**关**：先自测通过再开）
  voiceSayProbability: 0.2,        // 普通回复改成语音的概率
  voiceSayOnVoiceProbability: 0.5, // 收到**语音**消息时用语音回的概率（对称，最像真人）
  voiceSayMaxChars: 60,            // 超过这么多字就发文字（语音太长很怪）
  voiceSayEmotion: 'main',         // 音色预设：main/sweet/angry/serious
  visionCacheMax: 500,           // 识图结果缓存条数（同一张图只识别一次；超出丢最早的）
  visionProvider: 'opencodego-extra',
  visionModel: 'deepseek-v4-flash-vision-exp',
  imageReplyProbability: 0.5,    // 看到（识别出的）图片时回话的概率

  // ── 语音识别（群里发语音 → 转成文字 → 当普通消息处理）────────────
  // 音频由桥侧定位并解码成 16k/单声道/PCM16 WAV（wx-bridge/lib/wechat-voice.mjs），
  // 事件里带 voiceWav 绝对路径；这里调 DSH 的 speechToText 服务转写（本地 SenseVoice，
  // **不需要任何 API key**）。服务不可用/模型没下/转写失败 → 保持 [语音] 原样，不阻塞回复。
  voiceOnVoice: true,             // 收到语音时尝试转写（false = 完全按老行为，只显示 [语音]）
  voiceProvider: 'sensevoice-local',   // speechToText 的 provider id（DSH「语音输入」bundle 自带）
  voiceLanguage: 'zh',            // 语言提示，可选 auto/zh/en/yue/ja/ko
  voiceMaxSeconds: 120,           // 超过这么长的语音不转写（服务侧上限 4MB≈131s）
  voiceCacheMax: 500,             // 转写缓存条数（同一条消息只转写一次）
  voiceAutoPrepare: true,         // 服务未就绪时自动触发模型准备（首次要下载约 239MB）
  voicePrepareWaitMs: 180_000,    // 等模型准备就绪的上限（超时就跳过本次，保留 [语音]）

  // ── 健康自检 / 失联监控（静默失联是这台机器最大的运维痛点）──────
  // 心跳每 healthCheckMs 只查最关键的几项（桥连接/登录/hook/轮询），避免频繁打 hook；
  // 连续 2 次异常（≈10 分钟）才告警；告警除写日志外，还会往 filehelper 发一句人话
  // （机器人自己微信里能直接看到；filehelper 不会触发它自己的回复逻辑）。
  healthAlert: true,              // 失联时往 filehelper 发告警（false = 只写日志）
  healthAlertQuietMs: 1_800_000,  // 同一类告警最多 30 分钟一次（防刷屏）
  healthCheckMs: 300_000,         // 心跳间隔（5 分钟）

  // 群里谁是谁：hook 拿不到联系人库（QueryDB 坏了），所以靠"引用消息里的 displayname 自动学习"
  // + 手动设置。键是 wxid，值是昵称。持久化在 data/wechat-bot/members.json
  memberNames: {},
  allowAt: true,                 // 允许它 @ 别人。**真 @**：正文写 "@群昵称" + 把 wxid 传给桥填 atlist
                                 // （hook 的 BuildTextMessage 会写 atlist → 对方收到红点提醒）；
                                 // 名字解析不到 wxid 时退化成纯文本 "@名字"（老行为，不报错）
  atChance: 0.3,                 // 想 @ 别人时，真的带上 @ 的概率（别每条都 @）

  // 拟人节流
  replyProbability: 0.8,          // 闲聊插话概率（用户要求：80%，很爱插话）
  useDbMembers: true,             // 用数据库里的真实群成员昵称（我们修好了 hook 的 QueryDB）
  memoryExtract: true,            // 定期从群聊里提炼长期记忆（本地保存，每次对话都带上）
  // 问过的问题等多久算"还没人接"（这期间不再主动追问同一件事）
  pendingQuestionWaitMs: 45 * 60_000,
  minReplyGapMs: 6_000,          // 同群两次回复最小间隔（对话延续时只要求 2s）
  maxRepliesPer10Min: 40,         // 10 分钟上限（长对话别变哑巴；原来是 15）
  // 敷衍模式：真人群聊大量回复是"哈哈/确实/6"这种低信息量反应；
  // 全交给 LLM 会让每条都"太聪明"，人机味就出来了 → 按概率直接短路
  cannedChance: 0,               // 已关：随机罐头与语境无关，最出戏；敷衍与否交给模型理解后决定
  // 对话延续窗口：上一条我回过的人在这个时间内又说话，视为"接着聊"
  conversationWindowMs: 300_000,      // 5 分钟：对方在这个窗口内又说话 = 还在对话中（超时则对话结束）
  continuationChance: 1,          // 对话延续**必定回**（用户要求：聊起来就一直回）
  maxConsecutiveTurns: 50,        // 连续对聊轮数上限（设很大 = 不掐断；原来是 4）
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
  partTargetLen: 60,            // 长文本分段：每段目标字数（段数按长度自动算）
  partTargetLen: 60,            // 长文本分段：每段目标字数（段数按长度自动算）
  maxPartsLimit: 8,             // 一条回复最多拆成多少条（15 太多：8 段 × 1.35s ≈ 11s，不刷屏）
  splitHardMax: 40,             // 短文本每段硬上限（以前没显式定义，靠 splitMessage 默认值兜着）
  longBubbleMax: 120,           // 长回答（>240 字）每段放宽到这个字数，避免切成十几条碎气泡
  laterMaxMinutes: 30,          // [稍后:N] 的分钟上限
  patChance: 0.03,               // 被@时"拍一拍"对方的概率
  // ── 主动找话题 ──────────────────────────────────────────────
  // 群里安静一段时间后，主动冒个泡（真人也会这样，不然就是个"只应答的客服"）
  proactive: true,
  proactiveQuietMs: 1_500_000,   // 群安静超过 25 分钟才考虑主动说话
  proactiveMinGapMs: 3_600_000,  // 同一个群最多每小时主动一次
  proactiveChance: 0.55,         // 每次检查时的触发概率（避免一安静就必说）
  proactiveMaxStreak: 2,         // 连续主动 N 次都没人理就不再主动（有人说话才清零）
  proactiveCheckMs: 300_000,     // 检查间隔 5 分钟
  proactiveHours: '08:00-23:00', // 只在这个时间段主动（配合作息：醒了才冒泡，睡了就安静）
  // 记忆与日志
  contextMessages: 24,
  historyLookup: true,             // 群里提起以前的事时，从微信数据库翻历史（本地查询，0 token）
  historyLimit: 4,                 // 最多带几条历史进提示词（每条截 60 字，约 100~200 tokens）
  historyScan: 600,
  backfillLimit: 10,            // 客户端重启后回补多少条最近消息进上下文                // 最多回溯多少条原始消息去匹配
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
const BUILD_VER = '2026-10-16.3'   // 抬版本：让新实例压过热重载残留的旧实例   // 带版本号的实例才允许踢掉旧连接（旧代码没这个字段）
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
    // ── 重启后"记得聊到哪"：从微信数据库把最近的群聊拉回来填进上下文 ──
    // 名字映射和长期事实是持久化的，但最近对话只在内存里 → 一重启就失忆，
    // 表现成"不认识人 / 不记得之前说过什么"。数据库里这些消息一直都在。
    void (async () => {
      try {
        if (r.msgs.length) return
        const res = await client.call('searchMessages',
          { roomId, query: '', limit: Number(config.contextSeed) || 20 }, 25_000)
        const items = (res?.items || []).slice().reverse()   // 数据库给的是倒序
        if (!items.length) return
        for (const it of items) {
          r.msgs.push({
            ts: it.ts, isSelf: !!it.isSelf, sender: it.sender || '',
            senderName: it.isSelf ? '我' : (it.senderName || ''), typeName: 'text',
            text: String(it.text || ''),
          })
        }
        log(`重启后补齐上下文：从数据库取回 ${items.length} 条（${r.roomName || roomId}）`)
      } catch (e) {
        log('补上下文失败（不影响正常回复）：' + String(e?.message || e))
      }
    })()
    loadMemory(r)
    loadFacts(r)      // 载入长期记忆（本地文件，重启不丢）
    void syncMembers(r)   // 拉群成员昵称（内部有 10 分钟节流，别 force，否则每次建房都拉一次会拖垮桥）
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
    // 有人说话 → 清零"主动没人理"的计数（用户要求：没人回就别继续主动说）
    if (!m.isSelf) r.proactiveStreak = 0
    // 带上 msgid：视频"延迟复查"升级内容时要能找回**这一条**的上下文副本（r.msgs 里是拷贝）
    r.msgs.push({ id: m.id || '', ts: m.ts || Date.now(), isSelf: !!m.isSelf, sender: m.sender, senderName: m.senderName, text: m.text })
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

  // ── 同进程单例：根治"热重载残留旧实例 → 群里重复回答" ────────────────
  // 实测症状：同一对回复差 1 秒发了两遍（两个实例都在处理同一条消息）。
  // 桥侧的"踢旧连接"对【同版本】实例无效 —— 两边会互相踢成无限 ping-pong，
  // 谁被踢谁就重连，于是两个实例轮流活着。所以在源头根治：
  // 新实例启动时主动关掉旧实例的桥连接（close() 会把旧实例的重连循环停下，
  // 即使旧实例跑的是旧代码也一样有效）。
  try {
    const prev = globalThis.__WECHAT_BOT_CLIENT__
    if (prev && prev !== client && typeof prev.close === 'function') {
      log('检测到同进程旧实例 → 关闭它的桥连接（防重复回答）')
      prev.close()
    }
    globalThis.__WECHAT_BOT_CLIENT__ = client
  } catch { /* ignore */ }

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
      case 'login': {
        log('微信登录成功 self=' + evt.self)
        if (evt.self) bridgeSelf = evt.self
        // 客户端（重）启动过 → 轮询有短暂空窗，期间的消息不会进上下文 → 主动回补
        void backfillAfterLogin().catch((e) => log('回补上下文异常：' + String(e?.message || e)))
        break
      }
      case 'logout':
        log('微信已登出，等待重新注入')
        break
      case 'wake': {
        // 桥说数据库打不开了 → 自己发一句话，让微信写库、打开 message_0.db，轮询随即恢复。
        // 这样**不用重启客户端**（重启可能要手机确认登录，用户明确说不想手动点）。
        lastWakeAt = Date.now()      // 记下来：健康自检把它当"轮询有问题"的强证据
        void (async () => {
          try {
            // 唤醒是【技术动作】（让微信写库、打开 message_0.db），不是社交发言：
            // 发到文件传输助手，群里完全看不到 → 因此不受安静时段限制
            // （以前发群里，半夜被静音掉 → 库打不开 → 机器人一直听不见 ✗）
            const wakeRoom = config.wakeRoom || 'filehelper'
            const text = pickProactive() || '我回来啦'
            log(`wake：往 ${wakeRoom} 发一句唤醒数据库 → ${text}`)
            await client.call('sendText', { roomId: wakeRoom, text }, 30_000)
          } catch (e) {
            log('wake 失败：' + String(e?.message || e))
          }
        })()
        break
      }
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
    lastMsgAt = Date.now()      // 健康自检用它判断"轮询还在不在工作"（收到消息 = 轮询活着）
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

    // 图片/表情包/视频：取内容并识别
    //   表情包（type 47）：XML 里有 cdnurl，直接下载
    //   普通图片（type 3）：走本地 .dat 解密（我们自己实现，见 wx-bridge/lib/wechat-image.mjs）
    //   视频（type 43）：**主路**抽 N 帧拼联系表 + 抽音轨转写（wx-bridge/lib/wechat-video.mjs）；
    //                    视频没落盘就退回明文封面（那时只有封面帧）。降级链：视频内容 → 封面 → [视频]
    if (['image', 'emoticon', 'video'].includes(m.typeName) && config.visionOnImage
          && (m.typeName !== 'emoticon' || config.visionOnEmoticon)
          && (m.typeName !== 'video' || config.visionOnVideo)) {
      const isVideo = m.typeName === 'video'
      try {
        const media = isVideo
          ? await client.call('fetchVideo', {
            xml: m.xml || '', roomId: m.roomId || '', ts: m.ts || 0,
            frames: Number(config.videoFrames) || 6,
          }, 300_000)
          : await client.call('fetchMedia', { xml: m.xml || '', type: m.type, roomId: m.roomId || '', ts: m.ts || 0 }, 90_000)
        if (media?.file) {
          const kind = !isVideo ? 'image' : (media.kind === 'video' ? 'videoSheet' : 'videoCover')
          // 带缓存：同一张（联系表/封面/图片）只识别一次
          const desc = await describeImageCached(media.file, kind)
          // 视频音轨：交给 DSH 的 speechToText 转写（复用语音那条链路，自带缓存与降级）
          let audioText = ''
          if (isVideo && media.wav) audioText = await transcribeVoice(media.wav, String(m.id || '') + ':va')
          if (desc || audioText) {
            m.imageDesc = desc || ''
            m.videoCover = isVideo && media.kind === 'cover'
            m.videoAudio = audioText
            m.videoSeconds = Number(media.durationSec) || 0
            m.videoFrames = Number(media.frames) || 0
            if (isVideo && media.kind === 'video') m.videoFull = true   // 拿到视频文件 = 全部内容（不再复查）
            log(`${isVideo ? (m.videoCover ? '视频封面识别' : '视频内容识别') : '识图'}成功：`
              + (desc || '（画面没描述出来）') + (audioText ? `｜音轨转写：${audioText}` : ''))
          }
          // 识别完就删临时文件（都是副本，微信自己的原文件/封面不动）
          try {
            unlinkSync(media.file)
            log(isVideo ? (media.kind === 'video' ? '已删除临时联系表' : '已删除临时封面副本') : '已删除解密临时图')
          } catch { /* ignore */ }
          if (isVideo && media.wav) { try { unlinkSync(media.wav); log('已删除临时音轨 WAV') } catch { /* ignore */ } }
          if (isVideo) {
            if (media.kind === 'video') {
              // 功能①：读完删掉微信落盘的那个视频原文件（省磁盘；下次点开微信会重新下载）
              if (config.videoDeleteAfterRead) deleteVideoSource(media.srcVideo, Number(media.declaredBytes) || 0)
            } else {
              // 功能②：这次只有封面（视频还没落盘）→ 后台复查，等群里有人点开后升级成"全部内容"
              scheduleVideoRecheck(r, m)
            }
          }
        } else {
          log(isVideo ? '取不到视频内容（视频没落盘、也没有封面）' : '取不到这张图（未下载或密钥失效）')
          // 连封面都没有也值得复查一次：群里有人点开后视频会落盘
          if (isVideo) scheduleVideoRecheck(r, m)
        }
      } catch (e) {
        log((isVideo ? '视频内容识别失败：' : '识图失败：') + String(e?.message || e))
      }
    }

    // 链接视频：群里分享的抖音/B站/小红书/微博链接 → 桥侧 yt-dlp 下载 → **复用同一条视频管线**看懂。
    // 与上面 type 43 的区别只是"视频从哪来"（外部链接 vs 微信数据目录），下游完全一样。
    // 处理完写进 m.imageDesc / m.videoAudio 并标成 video → 后面按"视频消息"参与聊天（复用既有提示词/节流）。
    // 任何失败都只记日志 + 降级成普通文本（有标题就把标题当文本），绝不抛错。
    if (config.linkVideo) {
      const linkBlob = [m.text, m.xml, m.content].filter(Boolean).map(String).join('\n')
      const hit = ['text', 'link', 'card', 'app'].includes(m.typeName) ? detectLinkVideo(linkBlob) : null
      if (hit) {
        try {
          await handleLinkVideo(r, m, hit)
        } catch (e) {
          log('链接视频处理异常（降级成普通文本）：' + String(e?.message || e).slice(0, 160))
        }
      } else if (['link', 'card', 'app'].includes(m.typeName) && config.linkVideo) {
        // 不支持的站（快手/YouTube）值得说一声：否则"发了链接机器人不理"看起来像坏了
        const un = detectUnsupportedLink(linkBlob)
        if (un) log(`链接视频：不支持的站点（${un.site} ${un.host}）→ 跳过（只按文本处理）｜${r.roomName || r.roomId}`)
      }
    }

    // 语音（type 34）：桥侧已把音频解码成 16k/单声道/PCM16 WAV（事件字段 voiceWav），
    // 这里转写成文字，**当成普通文本消息**继续走（记忆/历史/@ 识别/回复都用转写文字）。
    // 任何失败都保持 [语音] 原样 —— 语音处理是纯旁路，绝不阻塞、绝不抛错。
    if (m.typeName === 'voice' && config.voiceOnVoice) {
      if (m.voiceWav) {
        const t = await transcribeVoice(m.voiceWav, m.id)
        if (t) {
          m.voiceText = t              // 转写文字（展示/调试用）
          m.voiceRawText = m.text      // 原占位符（[语音]）留档
          m.text = t                   // 文本替换 → 后面全部按文本处理
          m.typeName = 'text'          // evaluate 的 okType 门槛、记忆、历史都按文本走
          // @ 识别必须对**转写文字**生效（否则"@机器人 然后发语音"不会被当成 @）
          const names = [...new Set([config.botName, ...(config.aliases || []), ...(r.selfNames || [])].filter(Boolean))]
          if (names.some((n) => t.includes('@' + n))) m.isAtMe = true
          if (t.includes('@所有人')) m.atAll = true
          // 语音里的 @ 也可能只存在于 XML 的 atuserlist（转写文字里没有 @ 符号）→ 顺带看一眼
          if (!m.isAtMe && bridgeSelf && String(m.xml || '').includes(bridgeSelf)) {
            m.isAtMe = true
            log('语音：XML 的 @ 列表里有我 → 判定被 @')
          }
          log(`语音转写文字已当文本处理：${t.slice(0, 60)}`)
          // 转写成功就删掉临时 WAV（本项目规矩：临时文件不留）
          try { unlinkSync(m.voiceWav); log('已删除语音临时 WAV') } catch { /* ignore */ }
        } else {
          log('语音转写没结果 → 保留 WAV 供排查（桥侧 1 小时后自动清理）：' + m.voiceWav)
        }
      } else {
        log(`语音没有音频文件（voiceWav 为空）→ 保持 [语音]｜${m.roomName || m.roomId}`)
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
        // 修复：这里必须有 catch —— 没有的话 evaluate 里任何一个未处理拒绝
        // 会沿 Promise 链逃逸，被宿主的 fail-loud 处理器接住 = 整个宿主 exit(1)（机器人全停）
        if (batch.length) void evaluate(r, batch).catch((e) => log('评估异常：' + String(e?.message || e)))
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

  // ── 健康自检 / 失联监控的状态（只读检查，除告警外不发消息）────
  let lastMsgAt = 0            // 最近一次成功收到消息（判断"轮询还在不在工作"）
  let lastWakeAt = 0           // 桥最近一次喊"数据库打不开"（强负面信号）
  let healthStreak = 0         // 连续异常次数（2 次 = 10 分钟 → 告警）
  let healthAlerted = false    // 是否已经发过"失联"告警（用于恢复时配对告警）
  let healthLast = null        // 最近一次自检结果（{ at, items, bad }，status 摘要复用）
  const healthAlertAt = new Map()   // 告警类别 → 最近发送时间（限流：同一类 30 分钟一次）

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

      // ── 真 @ 的索引（每个群各自一份）────────────────────────────
      buildAtIndex(r, list)
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
    // 能回的类型：文本 / 应用卡片 / 链接卡片（type 42/49：链接视频失败时降级成普通文本）/
    // 已识别出内容的图片与表情包
    const okType = ['text', 'app', 'link', 'card'].includes(trigger.typeName)
      || (['image', 'emoticon', 'video'].includes(trigger.typeName) && (trigger.imageDesc || trigger.videoAudio))
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
      // 闲聊概率没命中 → **不再直接跳过**，继续交给模型判断
      // （用户要求：不必每句都回，但每句都要看，由它理解后决定）
      // 只有硬性原因才真跳过：频率上限 / 冷却中 / 刚连续自言自语 / 低信息量 / 重复
      const hardBlock = /上限|冷却|连续发言|低信息|太短|重复|刷屏/.test(String(d.reason || ''))
      if (hardBlock) {
        stats.skipped++
        log(`不回（${d.reason}）｜${r.roomName}｜${trigger.senderName}: ${trigger.text}`)
        return
      }
      log(`交模型判断（${d.reason}）｜${r.roomName}｜${trigger.senderName}: ${trigger.text}`)
    } else {
      log(`决定回（${d.reason}）｜${r.roomName}｜${trigger.senderName}: ${trigger.text}`)
    }

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
      try { await deliver(r, trigger, priority, { text, stickerOnly: false }) } catch (e) { log('投递异常：' + String(e?.message || e)) }
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
    try { await deliver(r, trigger, priority, reply) } catch (e) { log('投递异常：' + String(e?.message || e)) }
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
      // 铁律：绝不外泄系统/技术内部信息。
      // 起因：测试文本曾把'数据库句柄/atlist/偏移'之类内部词发进了真实群，
      // 机器人接着聊了下去，等于把实现细节暴露给群友。
      '铁律：绝不谈论任何系统或技术内部信息——接口名、数据库、日志、偏移量、配置文件、'
        + '测试内容、你自己的实现细节，一律不提、不复述、不评论。群里只当一个普通群友聊天。'
        + '有人问你是不是机器人/AI，就按人设自然带过，不解释实现。',
      // 接话判断：把"要不要回"交给模型理解，而不是靠概率。
      '接话判断（很重要）：每次先想一句"这条要不要我接"。',
      '  · 跟你无关的闲聊、别人之间的对话、纯表情/图片刷屏、别人已经答过的问题 → 只输出 [不回]。',
      '    我收到 [不回] 就什么都不发（这不算失礼，真人在群里也不会句句插嘴）。',
      '  · 但**有人 @ 你、有人点你的名字（大肥鱼/肥鱼/蓝鱼）、或者正在跟你一来一回聊天时**，',
      '    **必须回**，绝对不许输出 [不回]。',
      '  · 拿不准的时候：如果是冲着你来的、或者你接一句会让气氛更好，就回；纯路人闲聊就别硬插。',
      '',
      '怎么说话（违反就露馅）：',
      `1. 像群友打字，不像客服：常省略主语、口语碎、语气词自然，标点可有可无。`,
      `   有时候你会**分两三条**说（像真人打字那样，比如"哈哈哈哈"换行"笑死我了"换行"真的"）——`,
      `   长度跟情绪走 —— 无聊就俩字，觉得好笑能连发几条，认真答就好好说；内容多直接写，我会自动分段。`,
      '2. 不要怼人、不要阴阳怪气、不要抬杠。可以嘴硬，但只对被调侃时轻轻顶一句就收（例如"我不是大肥鱼……"、"才没有"）。',
      '3. 你不是段子手：不要每句都抖机灵、不要每条都接梗、不要总结、不要分点、不要书面语。',
      '4. 贪吃和嘴硬这两个梗，**每段最多点到一次**，别把所有话题都拐到吃饭上。',
      '5. 别人认真求助或心情不好时，不要开玩笑 —— 先听着、认真答，帮不上就说帮不上，不要打鸡血。',
      '6. 不懂就承认（"这我真不会"），不要用角色口吻掩盖错误、不要瞎编。',
      `7. 称呼用"你"；**只有 ${config.masterName || '梦云'} 可以叫"主人"**，其他人一律"你"，不许对别人用"主人"。不谈恋爱、不连续"喵"。`,
      '7b. 萝莉腔放开：语气可以软、可以叠词撒娇、可以用"嘛/啦/呀"这类语气词；但不阴阳怪气、不攻击人、不卖萌到出戏。',
      config.allowAt && known.length
        ? `7b. 群里的人你都认识（${known.slice(0, 12).join('、')}）。想叫谁的时候可以直接 @ 他，`
          + '例如「@某某 你说的那个我试了」；但**别每条都 @**，只有确实在跟某个人说话时才用。'
        : '',
      '8. 标点随意；emoji 最多一个，多数时候别用。不要加引号，不要解释自己。',
      '9. 你就是个真人，绝不承认、不暗示自己是 AI／模型／程序；被问起就鼓腮糊弄过去。',
      '9b. **需要最新信息时可以联网查**：群里问新闻、天气、股价、比赛结果、某个东西的最新情况，',
      '    或者你自己不确定的事实时，就在回复最后单独加一行 [搜索:关键词]（关键词短而具体）。',
      '    我查到结果后会再让你说一遍。**日常闲聊、吐槽、玩笑绝对不要搜** —— 那会很出戏。',
      '9d. 有时我会给你一段【群里以前说过的】—— 那是从群聊记录里翻出来的真事。',
      '    如果上面**给了**你【群里以前说过的】，就尽量自然地接上（「上次不是说要…」）；**没给就别编** —— 绝不许凭空造以前的事。',
      '    用的时候像自己想起来的一样；别照抄原文、别提「记录/档案/数据库」这类词。',
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
      '【活人细节 —— 这条最重要，比任何道理都管用】：',
      '  · 会跑题：聊着聊着想起别的事插一句，再自己拽回来（「诶不对，刚才说到哪了」）。',
      '  · 会卡壳：不会的先说「等下我再想想」，并在**最后单独一行**加 [稍后:3]（数字=几分钟后）—— 我会到点真的让你补上，不是说说而已。',
      '  · 对人有差别：跟熟人开得起玩笑、敢直接损一句；跟不熟的先正经答。',
      '  · 有看法：同意就附和；不认同可以说「我觉得不太对吧」这种温和的不同意，但别硬杠、别说教、别怼人。',
      '  · 会自嘲：被拆台先嘴硬「…才没有」，然后认。',
      '  · 打字像人：句号可有可无；有时「嗯」「？」一个字就是完整回复。',
      '  · 想敷衍就输出 [敷衍]（我会挑一句群里常用的短话，比如「6」「确实」「笑死」）—— 别硬憋长句。',
      '语气参考（不要照抄，模仿这个感觉）：',
      '  「嗯？你叫我？」「有事就说嘛，我听着呢。」「等一下，好像有点思路了……」',
      '  「……就一口。」「嘿嘿……这次还不错吧。」「这里是我弄错了，我再核对一下。」',
      '  「这是补充算力，怎么能叫贪吃！」「我不是大肥鱼……」「你先忙，有事再叫我。」',
      '  「啊？等下我再想想……」「笑死」「它居然真做到了」「我没吃饱」「就一口」',
      '',
      '只输出你要发的那一条消息本身，不要任何解释。',
    ].filter(Boolean).join('\n')
  }

  // ── 长记忆检索：把"以前说过的"从微信数据库翻出来 ────────────────
  // 检索本身是本地 SQL（0 token）；结果并进当前这次调用，不额外调模型。
  const HIST_STOP = new Set(['上次', '之前', '那天', '刚才', '昨天', '前天', '早说', '说过', '提过',
    '记得', '那个', '这个', '什么', '怎么', '为什么', '是不是', '有没有', '还有', '然后', '就是',
    '可以', '不是', '我们', '你们', '他们', '现在', '今天', '明天', '晚上', '早上'])

  /** 粗分词：取中文/字母数字连续段，去停用词（中文没有空格，这是最省事的做法） */
  function extractTopics(text) {
    const runs = String(text || '').match(/[\u4e00-\u9fa5A-Za-z0-9]{2,}/g) || []
    return runs.filter((w) => !HIST_STOP.has(w)).slice(0, 4)
  }

  /** 这条消息"提起"了什么 → 用来查历史。空数组 = 不必查 */
  function pickHistoryKeywords(trigger, r) {
    const text = String(trigger.text || '')
    const kws = []
    // ① 提到群里某个人的名字（最强信号）
    const names = (r.selfNames || []).concat(Object.values(config.memberNames || {}))
    for (const n of names) {
      if (n && n.length >= 2 && text.includes(n)) kws.push(n)
    }
    // ② 出现"回忆类"词 → 把消息里的话题词也拿去查
    if (/上次|之前|那天|刚才|昨天|前天|早说|说过|提过|记得|前面|刚刚/.test(text)) {
      kws.push(...extractTopics(text))
    }
    return [...new Set(kws)].slice(0, 4)
  }

  /** 查历史（失败就返回空，绝不影响正常回复） */
  async function lookupHistory(r, trigger) {
    if (config.historyLookup === false) return []
    try {
      const kws = pickHistoryKeywords(trigger, r)
      if (!kws.length) return []
      const res = await client.call('searchMessages', {
        roomId: r.roomId,
        query: kws.join(' '),
        limit: config.historyLimit || 4,
        scan: config.historyScan || 600,
      }, 20_000)
      const items = (res?.items || []).filter((x) => x && x.text)
      if (items.length) log(`翻到 ${items.length} 条相关历史（关键词：${kws.join('、')}）`)
      return items.slice(0, config.historyLimit || 4)
    } catch (e) {
      log('查历史失败（不影响回复）：' + String(e?.message || e))
      return []
    }
  }

  function buildUser(r, batch, trigger, priority) {
    const showText = (m) => {
      // 视频：把"抽的几帧画面 + 音轨转写"如实拼出来（只有封面时也说明白）
      if (m.videoCover || m.videoSeconds || m.videoAudio || (m.typeName === 'video' && m.imageDesc)) {
        if (m.videoCover) return `[视频封面：${m.imageDesc || '（没描述出来）'}]`
        // 链接视频（抖音/B站/…）：把站点和标题也带上 —— 不然模型不知道这是"群里分享的链接"
        const head = m.linkVideoSite ? `${m.linkVideoSite}视频` : '视频'
        const parts = []
        if (m.linkVideoTitle) parts.push(`标题：${m.linkVideoTitle}`)
        if (m.linkVideoIntro) parts.push(`他顺带说：${m.linkVideoIntro}`)
        if (m.imageDesc) parts.push(`画面（抽了 ${m.videoFrames || '?'} 帧）：${m.imageDesc}`)
        if (m.videoAudio) parts.push(`音频转写：${m.videoAudio}`)
        return `[${head}${m.videoSeconds ? ' ' + m.videoSeconds + 's' : ''}${parts.length ? '：' + parts.join('；') : '（没拿到内容）'}]`
      }
      if (m.imageDesc) return `[图片：${m.imageDesc}]`
      if (m.voiceText) return m.voiceText            // 语音转写后的文字（当普通文本用）
      if (m.typeName === 'voice') return '[语音]'    // 转写失败/服务不可用 → 照旧降级
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
            ? ((trigger.videoCover || trigger.videoSeconds || trigger.videoAudio)
              ? (trigger.linkVideoSite
                ? `${trigger.senderName} 在群里分享了一条${trigger.linkVideoSite}视频链接，你掌握的信息：${showText(trigger)}`
                : `${trigger.senderName} 在群里发了一段视频，你掌握的信息：${showText(trigger)}`)
              : `${trigger.senderName} 在群里发了张图，内容：${trigger.imageDesc}`)
            : priority === 'question'
              ? `${trigger.senderName} 在群里问：${showText(trigger)}`
              : `${trigger.senderName} 刚说：${showText(trigger)}`
    return [
      `当前时间：${hhmm}`,
      '最近群聊：',
      ...lines,
      '',
      ...((trigger.historyHits || []).length
        ? ['', '【群里以前说过的（供你参考，自然引用即可；别照抄，也别提"记录/档案"这类词）】',
           ...trigger.historyHits.map((h) => `- ${h.senderName}: ${String(h.text || '').slice(0, 60)}`)]
        : []),
      `现在的情况：${trig}`,
      priority === 'continuation'
        ? '接着他的话回一句（像聊天一样自然接住，别重复你刚说过的）：'
        : priority === 'image'
          ? ((trigger.videoCover || trigger.videoSeconds || trigger.videoAudio)
            ? `就这条${trigger.linkVideoSite ? trigger.linkVideoSite + '视频（群里分享的链接）' : '视频'}接一句（可以吐槽、可以问一句、可以夸；你看到的是从视频里抽的几帧画面${trigger.videoAudio ? '和音轨转写' : ''}${trigger.videoCover ? '（只有封面帧）' : ''}，**别声称你看完了整段视频**）：`
            : '就这张图接一句（可以吐槽、可以问一句、可以夸，别像在写图片说明）：')
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

  // ── 识图结果缓存：同一张图/表情包只识别一次 ──────────────────────
  // 之前每次收到图片或表情包都会调一次视觉模型 —— 同一个表情包发 10 次就识别 10 次：
  // 浪费、慢，而且每次描述可能略有不同，导致机器人对同一张图反应不一致。
  // 现在按「图片字节的 sha1」缓存描述，命中就直接复用，不再调模型。
  const visionCacheFile = () =>
    join(dirname(config.memoryDir || join(homedir(), '.dsh', 'data', 'wechat-bot', 'memory')), 'vision-cache.json')
  let visionCache = null

  function loadVisionCache() {
    if (visionCache) return visionCache
    try { visionCache = JSON.parse(readFileSync(visionCacheFile(), 'utf8')) || {} } catch { visionCache = {} }
    return visionCache
  }

  function saveVisionCache() {
    try {
      const f = visionCacheFile()
      mkdirSync(dirname(f), { recursive: true })
      const keys = Object.keys(visionCache)
      const max = Number(config.visionCacheMax) || 500
      if (keys.length > max) {   // 超上限：丢掉最早的
        keys.sort((a, b) => (visionCache[a]?.at || 0) - (visionCache[b]?.at || 0))
        for (const k of keys.slice(0, keys.length - max)) delete visionCache[k]
      }
      writeFileSync(f, JSON.stringify(visionCache))
    } catch { /* 缓存写失败不影响主流程 */ }
  }

  function hashFile(file) {
    try { return createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 20) } catch { return '' }
  }

  /** 带缓存的识图：命中缓存就不调视觉模型（同一张图只识别一次）。
   *  kind='videoCover' 时用"视频封面"的提示词，并单独一个缓存命名空间（同一张图当图片/当封面时描述不串）。 */
  async function describeImageCached(file, kind = 'image') {
    const h = hashFile(file)
    const key = (h && kind !== 'image') ? kind + ':' + h : h     // 兼容旧缓存（图片仍用纯 hash 键）
    if (key) {
      const c = loadVisionCache()
      if (c[key]?.desc) { log('识图命中缓存（跳过模型调用）'); return c[key].desc }
    }
    const desc = await describeImage(file, kind)
    if (key && desc) {
      const c = loadVisionCache()
      c[key] = { desc, at: Date.now() }
      saveVisionCache()
    }
    return desc
  }

  /**
   * 用视觉模型描述一张图 —— "群里发图能识别并回复"的核心。
   * 走 ctx.attachments 把图片入库成引用，再以 { type:'image', attachment } 送进视觉模型。
   * @param {string} [kind] 'image'（默认）或 'videoCover'（视频封面帧：提示词必须如实说明只有封面）
   */
  async function describeImage(file, kind = 'image') {
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
      // 视频必须**如实**告诉模型拿到了什么：抽的几帧画面 + 音轨转写（或只有封面帧）
      const prompt = kind === 'videoCover'
        ? '这是别人在微信群里发的一条视频的**封面画面**（只有封面这一帧，不是视频的全部内容，你也看不到声音和过程）。'
          + '用一到两句话描述这个画面：主体是什么、在做什么、什么场景、氛围如何。中文，直接描述，不要客套话，'
          + '不要说你看了整个视频。'
        : kind === 'videoSheet'
          ? '这是一条微信视频里**均匀抽取的几帧**拼成的联系表（每格下方是时间点）。你看到的是画面，没有声音，也不是完整视频。'
            + '用两三句话说明：画面里有什么、谁在做什么、有没有变化或场景切换。中文，直接描述，不要客套话，'
            + '不要声称你看了整个视频。'
          : '用一到两句话描述这张图：主体是什么、在做什么、什么表情、画面氛围。中文，直接描述，不要客套话。'
      content = [
        { type: 'text', text: prompt },
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

  // ── 语音转写：DSH 的 speechToText 服务（本地 SenseVoice，无需 API key）────────
  // 桥侧已经把语音解码成 16k/单声道/PCM16 WAV（事件字段 voiceWav）。
  //
  // 真实签名（读 @deepseek-ai/dsh-experimental-speech-to-text/lib/types/index.d.ts 与
  // types.d.ts 确认，别凭猜改）：
  //   resolve(request: { audio: Uint8Array; providerId?: SpeechProviderId; language?: string }): SpeechSpec
  //   transcribe(spec: SpeechSpec, signal: AbortSignal): Promise<{ text; audioSeconds; inferenceSeconds }>
  //   snapshot(): { providers: {id, name, preparation: {phase}}[]; selection }
  //   prepare(id: SpeechProviderId, options?): void        listProviders(): SpeechProviderInfo[]
  // 服务**惰性获取**（与 attachments/web 同理）：bundle 没启用时拿到 null，
  // 绝不能让插件卡在 pending（这个坑踩过：inject 里加服务名会让整个插件不加载）。
  const voiceCacheFile = () =>
    join(dirname(config.memoryDir || join(homedir(), '.dsh', 'data', 'wechat-bot', 'memory')), 'voice-cache.json')
  let voiceCache = null
  let voiceMissingLogged = 0
  let voicePrepareAt = 0

  // ── 视频收尾两件事：读完删原文件 / 延迟复查升级 ────────────────────
  // 背景：微信视频**按需下载**（"自动下载"这条路已确认不可行，见 docs/media-download-re.md），
  // 只能等群里有人点开、微信自己落盘。所以：
  //   ① 既然这次点开的收益只有一次 → 用完就把原文件删掉（省磁盘；下次点开微信会重新下载）
  //   ② 只拿到封面时排两次复查（+60s / +180s）→ 视频一落盘就升级成"全部内容"
  const videoRechecks = new Map()     // msgid → { tries, max, roomId, m, timer }

  /**
   * 删掉**微信落盘的那个视频原文件**（不是我们的临时产物）。
   * 只删 fetchVideo() 交回来的 `srcVideo`（它已按 mtime±30分钟 + 大小±10% 匹配过），
   * 并在删之前**再核一次大小** —— 万一文件被换过/还在写，就不删（宁可不省磁盘，也不删错别人的文件）。
   */
  function deleteVideoSource(path, declaredBytes = 0) {
    try {
      const p = String(path || '')
      if (!p) { log('删除视频原文件跳过：没有拿到源文件路径'); return false }
      if (!existsSync(p)) { log('删除视频原文件跳过：文件已不在（' + p + '）'); return false }
      if (declaredBytes > 0) {
        const size = statSync(p).size
        const ratio = Math.abs(size - declaredBytes) / declaredBytes
        if (ratio > 0.10) {
          log(`删除视频原文件跳过（大小已不符：实际 ${size} vs 声明 ${declaredBytes}，差 ${(ratio * 100).toFixed(1)}%）`)
          return false
        }
      }
      unlinkSync(p)
      log(`已删除视频原文件（videoDeleteAfterRead）：${p}`)
      return true
    } catch (e) {
      log('删除视频原文件失败：' + String(e?.message || e))
      return false
    }
  }

  /** 把升级后的内容写回**上下文里的那条副本**（r.msgs 存的是拷贝，光改 m 不够） */
  function applyVideoUpgrade(r, m, patch) {
    Object.assign(m, patch)
    try {
      const stored = (r.msgs || []).find((x) => (m.id && x.id === m.id)
        || (!x.id && x.ts === m.ts && x.sender === m.sender))
      if (stored) Object.assign(stored, patch)
      else log('视频升级：没在上下文里找到这条消息（只更新了当前事件）')
    } catch { /* ignore */ }
  }

  /**
   * 视频"延迟复查"：只拿到封面（或啥都没拿到）时排期再看一眼，视频落盘了就升级成全部内容。
   * 排期：+delay，再 +2×delay（默认 60s → 180s），最多 videoUpgradeMaxTries 次，**不无限重试**。
   * 全程不阻塞消息处理；失败只记日志；同一条只排一次；已完整识别过的直接跳过。
   */
  function scheduleVideoRecheck(r, m) {
    if (!config.visionOnVideo) return
    if (m.videoFull) return                                   // 已经拿到全部内容 → 不复查
    const key = String(m.id || '')
    if (!key) return
    if (videoRechecks.has(key)) return                        // 同一条只排一次
    const max = Math.max(1, Math.min(5, Number(config.videoUpgradeMaxTries) || 2))
    const delay = Math.max(5_000, Number(config.videoUpgradeDelayMs) || 60_000)
    const entry = { tries: 0, max, roomId: r.roomId, m }
    videoRechecks.set(key, entry)
    log(`视频复查已排期：${Math.round(delay / 1000)}s 后再看一次（最多 ${max} 次）｜${r.roomName || r.roomId}`)

    const step = () => {
      entry.timer = null
      void (async () => {
        try {
          if (stopped || !videoRechecks.has(key)) return
          entry.tries++
          const res = await client.call('fetchVideo', {
            xml: m.xml || '', roomId: m.roomId || '', ts: m.ts || 0,
            frames: Number(config.videoFrames) || 6,
          }, 300_000)
          if (res?.file && res.kind === 'video') {
            log(`视频复查（第 ${entry.tries} 次）：视频已落盘 → 升级为全部内容`)
            const desc = await describeImageCached(res.file, 'videoSheet')
            let audioText = ''
            if (res.wav) audioText = await transcribeVoice(res.wav, String(m.id || '') + ':va2')
            applyVideoUpgrade(r, m, {
              imageDesc: desc || m.imageDesc || '',
              videoAudio: audioText || m.videoAudio || '',
              videoCover: false,
              videoFull: true,
              videoSeconds: Number(res.durationSec) || m.videoSeconds || 0,
              videoFrames: Number(res.frames) || 0,
            })
            try { unlinkSync(res.file); log('已删除临时联系表') } catch { /* ignore */ }
            if (res.wav) { try { unlinkSync(res.wav); log('已删除临时音轨 WAV') } catch { /* ignore */ } }
            if (config.videoDeleteAfterRead) deleteVideoSource(res.srcVideo, Number(res.declaredBytes) || 0)
            videoRechecks.delete(key)
            // 像真人那样补一句：**走既有 evaluate**（所有节流/概率/安静时段/上限都生效，不绕过任何限流）
            if (config.videoUpgradeFollowUp !== false && !config.dryRun) {
              try { void evaluate(r, [m]).catch((e) => log('视频补话异常：' + String(e?.message || e))) } catch (e) {
                log('视频补话异常：' + String(e?.message || e))
              }
            }
            return
          }
          log(`视频复查（第 ${entry.tries} 次）：仍未落盘`)
          // ⚠️ 复查只拿到封面时，桥同样会复制一份封面到临时目录 —— 那是**临时文件**，用完即删
          // （漏了这句会每条复查留一张封面副本，实测踩到过）
          if (res?.file) { try { unlinkSync(res.file) } catch { /* ignore */ } }
          if (res?.wav) { try { unlinkSync(res.wav) } catch { /* ignore */ } }
          if (entry.tries >= entry.max) {
            log('视频复查结束：仍未落盘')
            videoRechecks.delete(key)
            return
          }
          entry.timer = track(setTimeout(step, delay * (entry.tries + 1)))   // 60s → 再 120s（共 180s）
        } catch (e) {
          log(`视频复查（第 ${entry.tries} 次）异常（忽略）：` + String(e?.message || e).slice(0, 120))
          if (entry.tries >= entry.max) { videoRechecks.delete(key); return }
          entry.timer = track(setTimeout(step, delay))
        }
      })()
    }
    entry.timer = track(setTimeout(step, delay))
  }

  // ── 链接视频：收到受支持的视频链接 → 下载 → 复用视频管线"看懂" ──────────────
  // 与 type 43 视频**共用下游**（describeImageCached + transcribeVoice），只是上游换成桥的
  // `fetchLinkVideo` op（yt-dlp 下载 + 现成的 probeVideo 抽帧/抽音轨）。
  // 节流/概率/作息都在这一个函数里判断，**只决定"要不要花流量下载"**；
  // 回复本身仍然走既有 evaluate → deliver（所有既有节流一条都不绕过）。
  const linkVideoUrls = new Map()   // roomId → Map(url → at)：同一条链接短时间内不重复下载

  /** 这条消息是不是在 @ 我（链接卡片的 XML 里 atuserlist 也可能有我 —— 与语音那条路同一个坑） */
  function isAtMeMsg(r, m) {
    if (m.isAtMe) return true
    const names = [...new Set([config.botName, ...(config.aliases || []), ...((r && r.selfNames) || [])].filter(Boolean))]
    const t = String(m.text || '') + '\n' + String(m.xml || '') + '\n' + String(m.content || '')
    if (names.some((n) => t.includes('@' + n))) return true
    if (bridgeSelf && String(m.xml || '').includes(bridgeSelf)) return true
    return false
  }

  /** 链接卡片 XML 里的标题（下载失败降级成文本时用：至少让"分享了什么"进上下文） */
  function linkTitleOf(m) {
    const s = String(m.xml || m.content || m.text || '')
    const pick = (tag) => {
      const x = new RegExp(`<${tag}>([\\s\\S]{1,120}?)</${tag}>`).exec(s)
      return x ? x[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''
    }
    return pick('title') || pick('des') || ''
  }

  /**
   * 处理一条含受支持视频链接的消息。
   * 四道闸：① 白名单（调用方已判定）② 概率 ③ 同群冷却 ④ 作息（安静时段只处理被@的）。
   * **被@时跳过 ②③④**（"必须处理"）：明确要求优先；下载上限仍然生效，回复仍走既有节流。
   */
  async function handleLinkVideo(r, m, hit) {
    const where = `${r.roomName || r.roomId}｜${m.senderName}`
    const forced = isAtMeMsg(r, m)
    if (forced) m.isAtMe = true                  // 让后续 policy 也按"被@（必回）"走

    // 链接卡片/纯文本消息：文本里往往只有一坨 XML 或 `[link]` → 用标题当文本，聊天时才有的聊
    const title = linkTitleOf(m)
    if (title && (m.typeName === 'link' || m.typeName === 'card' || m.typeName === 'app')) {
      m.linkTitle = title
      m.text = `[${hit.site}视频：${title}]`
    }
    // 纯文本里"顺便说的那句话"要留着（否则下载成功后原话就没了，回起来像没看人说话）
    const intro = (m.typeName === 'text' && m.text && !/^\[/.test(String(m.text)))
      ? String(m.text).replace(/\s+/g, ' ').slice(0, 60) : ''

    const now = Date.now()
    // ①被@ → ②作息 → ③同群冷却 → ④概率（纯函数 decideLinkVideo，五种情况都有日志）
    const d = decideLinkVideo({
      forced,
      quiet: isQuiet(quietWindows),
      lastAt: Number(r.linkVideoAt) || 0,
      now,
      probability: config.linkVideoProbability,
      cooldownMs: config.linkVideoCooldownMs,
    })
    if (!d.ok) {
      log(`链接视频：${d.reason} → 跳过｜${where}｜${hit.site} ${hit.url}`)
      return
    }

    // 同一条链接短时间内不重复下载（群里常有人连发两遍/被转发）
    let seen = linkVideoUrls.get(r.roomId)
    if (!seen) { seen = new Map(); linkVideoUrls.set(r.roomId, seen) }
    const prev = seen.get(hit.url)
    if (prev && now - prev < Math.max(60_000, Number(config.linkVideoCooldownMs) || 0)) {
      log(`链接视频：这条链接 ${Math.round((now - prev) / 1000)}s 前刚处理过 → 跳过｜${where}`)
      return
    }
    seen.set(hit.url, now)
    if (seen.size > 50) for (const k of [...seen.keys()].slice(0, seen.size - 25)) seen.delete(k)

    r.linkVideoAt = now
    log(`链接视频：开始处理（${hit.site}${forced ? '｜被@必须处理' : ''}）｜${where}｜${hit.url}`)
    const t0 = Date.now()
    let res = null
    try {
      res = await client.call('fetchLinkVideo', {
        url: hit.url,
        text: String(m.text || '') + '\n' + String(m.xml || ''),
        maxSeconds: Number(config.linkVideoMaxSeconds) || 300,
        maxMB: Number(config.linkVideoMaxMB) || 80,
        timeoutMs: Number(config.linkVideoTimeoutMs) || 120_000,
        frames: Number(config.linkVideoFrames) || Number(config.videoFrames) || 6,
      }, (Number(config.linkVideoTimeoutMs) || 120_000) + 60_000)
    } catch (e) {
      log(`链接视频：桥调用失败（降级成普通文本）：${String(e?.message || e).slice(0, 160)}｜${where}`)
      return
    }
    if (!res?.sheet) {
      log(`链接视频：没取到内容（${res?.error || '未知原因'}）→ 降级成普通文本｜${where}｜耗时 ${Math.round((Date.now() - t0) / 1000)}s`)
      return
    }

    // ── 复用视频管线：联系表交视觉模型 + 音轨交 speechToText（与 type 43 一字不差的用法）──
    const desc = await describeImageCached(res.sheet, 'videoSheet')
    let audioText = ''
    if (res.wav) audioText = await transcribeVoice(res.wav, String(m.id || '') + ':lv')
    const siteName = String(res.siteName || hit.site || '')
    if (desc || audioText) {
      m.imageDesc = desc || ''
      m.videoAudio = audioText
      m.videoSeconds = Number(res.durationSec) || 0
      m.videoFrames = Number(res.frames) || 0
      m.videoFull = true                 // 拿到的是全部内容（不用像 type 43 那样等复查升级）
      m.videoCover = false
      m.linkVideoSite = siteName
      m.linkVideoTitle = String(res.title || title || '')
      if (intro) m.linkVideoIntro = intro
      m.typeName = 'video'               // 之后完全按"视频消息"参与聊天（showText / 提示词 / 节流都复用）
      m.linkUrl = hit.url
      log(`链接视频识别成功（${siteName}）：${desc || '（画面没描述出来）'}`
        + (audioText ? `｜音轨转写：${audioText}` : '')
        + `｜${m.videoFrames} 帧/${m.videoSeconds}s/耗时 ${Math.round((Date.now() - t0) / 1000)}s｜${where}`)
    } else {
      log(`链接视频：画面和音轨都没识别出内容 → 降级成普通文本｜${where}`)
    }

    // 临时文件用完即删（都是副本；桥侧的下载目录它自己已经删了）
    try { unlinkSync(res.sheet); log('已删除链接视频临时联系表') } catch { /* ignore */ }
    if (res.wav) { try { unlinkSync(res.wav); log('已删除链接视频临时音轨 WAV') } catch { /* ignore */ } }
  }

  function loadVoiceCache() {
    if (voiceCache) return voiceCache
    try { voiceCache = JSON.parse(readFileSync(voiceCacheFile(), 'utf8')) || {} } catch { voiceCache = {} }
    return voiceCache
  }

  function saveVoiceCache() {
    try {
      const f = voiceCacheFile()
      mkdirSync(dirname(f), { recursive: true })
      const keys = Object.keys(voiceCache)
      const max = Number(config.voiceCacheMax) || 500
      if (keys.length > max) {   // 超上限：丢掉最早的
        keys.sort((a, b) => (voiceCache[a]?.at || 0) - (voiceCache[b]?.at || 0))
        for (const k of keys.slice(0, keys.length - max)) delete voiceCache[k]
      }
      writeFileSync(f, JSON.stringify(voiceCache))
    } catch { /* 缓存写失败不影响主流程 */ }
  }

  /**
   * 惰性拿 speechToText 服务；不可用返回 null（不抛错、不阻塞）。
   *
   * **必须走 ctx.get('speechToText')**：真实 cordis 里直接读 `ctx.speechToText` 会抛
   * "cannot get property \"speechToText\" without inject"（实测踩到）。
   * 而给本插件加 `inject: ['speechToText']` 是错的 —— 服务缺失时整个插件会卡在 pending
   * （见文件顶部 36-40 行的注释：这个坑踩过一次，机器人会整体不加载）。
   * 属性访问只留给"非 cordis 自测桩"用，并且单独 try 住，免得把异常路径当正常路径。
   */
  function speechService() {
    const usable = (s) => (s && typeof s.transcribe === 'function' && typeof s.resolve === 'function' ? s : null)
    try {
      if (typeof ctx.get === 'function') return usable(ctx.get('speechToText'))
    } catch { /* ignore */ }
    try { return usable(ctx.speechToText) } catch { return null }
  }

  /** 服务未就绪（模型没准备）时触发一次 prepare，并等它就绪（首次约 239MB 下载） */
  async function ensureVoiceReady(stt) {
    if (!config.voiceAutoPrepare) return
    const id = String(config.voiceProvider || 'sensevoice-local')
    if (!id || typeof stt.snapshot !== 'function') return
    try {
      const view = () => {
        const s = stt.snapshot()
        return (s?.providers || []).find((x) => String(x.id) === id) || null
      }
      const first = view()
      if (!first) { log(`语音服务里没有 provider「${id}」（服务没启用或 id 不对）→ 保持 [语音]`); return }
      const phase = first.preparation?.phase
      if (phase === 'ready' || phase === 'standby') return
      if (Date.now() - voicePrepareAt < 300_000) return      // 5 分钟内不重复触发
      voicePrepareAt = Date.now()
      log(`语音模型未就绪（phase=${phase || '?'}）→ 触发准备（首次要下载约 239MB，请耐心等）`)
      if (typeof stt.prepare === 'function') stt.prepare(id)
      const deadline = Date.now() + (Number(config.voicePrepareWaitMs) || 180_000)
      while (Date.now() < deadline) {
        await sleep(3000)
        const cur = view()
        const ph = cur?.preparation?.phase
        if (ph === 'ready' || ph === 'standby') { log('语音模型已就绪'); return }
        if (ph === 'failed') {
          log('语音模型准备失败：' + String(cur?.preparation?.message || '').slice(0, 200))
          return
        }
      }
      log('等语音模型准备就绪超时 → 本次跳过转写（保留 [语音]）')
    } catch (e) {
      log('语音准备流程异常（忽略，继续尝试转写）：' + String(e?.message || e).slice(0, 160))
    }
  }

  /**
   * 转写一个 16k WAV。成功返回文字，失败返回 ''（调用方保持 [语音]）。
   * msgId 有值时会缓存（同一条消息只转写一次）。
   */
  async function transcribeVoice(file, msgId) {
    const stt = speechService()
    if (!stt) {
      if (voiceMissingLogged < 3) {
        voiceMissingLogged++
        log('没有 speechToText 服务（DSH 的「语音输入」bundle 没启用？）→ 语音保持 [语音] 原样')
      }
      return ''
    }
    if (msgId) {
      const hit = loadVoiceCache()[msgId]
      if (hit?.text) { log('语音转写命中缓存：' + hit.text); return hit.text }
    }
    let buf
    try { buf = readFileSync(file) } catch (e) { log('语音 WAV 读不到：' + String(e?.message || e)); return '' }
    if (buf.length < 46) { log('语音 WAV 太小（' + buf.length + 'B），跳过转写'); return '' }
    const seconds = (buf.length - 44) / 32000
    if (config.voiceMaxSeconds && seconds > Number(config.voiceMaxSeconds)) {
      log(`语音 ${seconds.toFixed(1)}s 超过上限 ${config.voiceMaxSeconds}s，跳过转写`)
      return ''
    }
    await ensureVoiceReady(stt)
    const ac = new AbortController()
    const killer = track(setTimeout(() => ac.abort(new Error('语音转写超时')), 150_000))
    try {
      // providerId 与 language **必须每次显式传**：宿主里 speechToText 的 config.defaultProvider
      // 与 config.language 都是空的，而且 settings 插件是 disabled → configure() 存不进去。
      // 所以这里不留空、不做条件展开（留空会让 resolve 抛"provider/language 不支持"）。
      const spec = stt.resolve({
        audio: new Uint8Array(buf),
        providerId: config.voiceProvider || 'sensevoice-local',
        language: config.voiceLanguage || 'zh',
      })
      const t = await stt.transcribe(spec, ac.signal)
      const text = String(t?.text || '').trim()
      if (!text) {
        log(`语音转写结果为空（音频 ${Number(t?.audioSeconds || seconds).toFixed(1)}s，可能没人说话）→ 保持 [语音]`)
        return ''
      }
      log(`语音转写成功（音频 ${Number(t?.audioSeconds || seconds).toFixed(1)}s / 推理 ${Number(t?.inferenceSeconds || 0).toFixed(1)}s）：${text}`)
      if (msgId) { const c = loadVoiceCache(); c[msgId] = { text, at: Date.now() }; saveVoiceCache() }
      return text
    } catch (e) {
      log('语音转写失败（保持 [语音]）：' + String(e?.message || e).slice(0, 200))
      return ''
    } finally {
      untrack(killer)
    }
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
    // 长记忆检索：提起以前的事就翻数据库，结果并进这次提示词（不额外调模型）
    trigger.historyHits = await lookupHistory(r, trigger)
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

    let cleaned = cleanReply(text, { maxLen: config.maxReplyChars, maxLines: 0 })

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
          cleaned = cleanReply(text, { maxLen: config.maxReplyChars, maxLines: 0 })
        } else {
          cleaned = sdir.text || '我查了半天也没看明白'
        }
      } else {
        log('搜索没拿到结果，按没搜到回')
        cleaned = sdir.text || '我查不到欸'
      }
    }

    // ── 模型判断"这条不用我接" → 它输出 [不回] ──
    // 非硬性场景：返回空文本，调用方会自动不发（见 evaluate 里 `!reply?.text` 的判断）。
    // 硬性场景（被@/被点名/正在对话）：忽略哨兵，用兜底话术保证"必回"。
    if (/\[\s*(不回|不回复|skip|SKIP)\s*\]/.test(cleaned)) {
      const hard = ['at', 'name', 'continuation'].includes(priority)
      if (!hard) {
        log(`模型判断不接话（${priority}）→ 不发`)
        return { text: '', stickerOnly: false, wantSticker: false, skip: true }
      }
      log(`硬性必回（${priority}）但模型想跳过 → 用兜底话术`)
      cleaned = pickCanned(priority) || '嗯嗯'
    }

    // 表情指令：从任意位置抠出 [表情]/[表情:情绪]/[表情:情绪|场景|气泡]，并从正文里删掉。
    // （模型常写成"文字\n[表情:得意]"或"文字 [表情:得意]"，早期版本会把指令当正文发出去）
    // [记住:xxx]：模型主动写长期记忆（从正文里抠掉，不发给群）
    // ── 模型选择「敷衍」：交给池子（零延迟、极口语），而不是让它硬憋长句 ──
    // 关掉随机敷衍之后，把「敷衍的选择权」还给真正理解语境的一方。
    let textForSend = cleaned
    if (/\[\s*敷衍\s*\]/.test(textForSend)) {
      const stripped = textForSend.replace(/\[\s*敷衍\s*\]/g, '').trim()
      if (!stripped) {
        const canned = pickCanned(priority) || '嗯嗯'
        log(`模型选择敷衍 → ${JSON.stringify(canned)}`)
        return { text: canned, stickerOnly: false, wantSticker: false }
      }
      textForSend = stripped
    }
    // ── [稍后:N]：现在先回一句，N 分钟后真的回来补一条（把空头支票做成真机制）──
    const later = parseLaterDirective(textForSend)
    const laterMinutes = later.minutes
    textForSend = later.text
    const mem = parseMemoryDirective(textForSend)
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
      later: laterMinutes,
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
    // 长文本不裁字数：按「目标段长」自动算段数（maxPartsLimit 防失控）；短文本行为不变
    const len = [...String(text)].length
    const hardMax = len > 240 ? (config.longBubbleMax || 120) : (config.splitHardMax || 40)
    const target = hardMax
    const maxParts = Math.min(config.maxPartsLimit || 8, Math.max(config.maxLines, Math.ceil(len / target) || 1))
    if (lines.length > 1) return lines.slice(0, maxParts)
    return splitMessage(text, {
    chance: config.splitChance,
    maxParts,
    minLen: config.splitMinLen,
    hardMax,
  })
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
      // 连续主动 N 次都没人理 → 不再主动（有人说话会清零）—— 别自言自语
      if ((r.proactiveStreak || 0) >= (config.proactiveMaxStreak ?? 2)) continue
      if (now - (r.lastActivityAt || 0) < config.proactiveQuietMs) continue
      if (now - (r.lastProactiveAt || 0) < config.proactiveMinGapMs) continue
      const recentReplies = r.policy.replyTimes.filter((t) => now - t < 600_000).length
      if (recentReplies >= config.maxRepliesPer10Min) continue
      if (Math.random() > config.proactiveChance) continue           // 没中就下次再掷
      log(`群「${r.roomName}」安静 ${Math.round((now - (r.lastActivityAt || 0)) / 60000)} 分钟 → 主动找话题`)
      try { await proactiveSay(r) } catch (e) { log('主动发言异常：' + String(e?.message || e)) }
      // 主动发出去就 +1（没人接会一直累加；有人说话会在 push() 里清零）
      r.proactiveStreak = (r.proactiveStreak || 0) + 1
      if (r.proactiveStreak === (config.proactiveMaxStreak ?? 2)) {
        log(`「${r.roomName}」连续 ${r.proactiveStreak} 次主动都没人接 → 先不主动了（等有人说话再恢复）`)
      }
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
      const force = Math.random() < (config.genForceChance ?? 0.5)
      const gen = await client.call('genSticker', { emotion, extra: scene || '', bubble: bubble || '', force }, 220_000)
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
      const picked = await client.call('pickSticker', { text: emotion + ' ' + scene, roomId, minScore: 3, requireTag: true })
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
  /**
   * 稍后补一条 —— 模型说了「等下我再想想」（[稍后:N]）时，到点真的回来补上。
   * 这是活人感最强的一招：答应的事有下文，而不是说完就消失。
   * 守安静时段与 10 分钟上限；内部全兜，绝不让异常逃逸（逃逸会杀掉宿主）。
   */
  /**
   * 客户端重启后回补最近消息（只补上下文，**不触发回复**）。
   * 为什么要它：客户端一重启，数据库轮询会有短暂空窗（懒加载/句柄还没就绪），
   * 空窗期间群里说的话不会进上下文 → 它会表现得"不知道刚才聊了什么"。
   * 这里主动把最近几条拉回来并去重合并；绝不在这里生成回复（避免对旧消息补答）。
   */
  async function backfillAfterLogin() {
    for (const r of rooms.values()) {
      try {
        if (!String(r.roomId || '').endsWith('@chatroom')) continue
        const res = await client.call('searchMessages',
          { roomId: r.roomId, query: '', limit: Number(config.backfillLimit) || 10 }, 25_000)
        const items = (res?.items || []).slice().reverse()   // 数据库给的是倒序
        if (!items.length) continue
        const have = new Set(r.msgs.map((m) => String(m.ts) + '|' + String(m.text)))
        let added = 0
        for (const it of items) {
          const key = String(it.ts) + '|' + String(it.text)
          if (have.has(key)) continue
          push(r, {
            ts: it.ts, isSelf: !!it.isSelf, sender: it.sender || '',
            senderName: it.isSelf ? '我' : (it.senderName || ''), text: String(it.text || ''),
          })
          added++
        }
        if (added) log(`重启后回补上下文 ${added} 条（${r.roomName || r.roomId}）`)
      } catch (e) {
        log('回补上下文失败（不影响正常回复）：' + String(e?.message || e))
      }
    }
  }
  async function sendFollowUp(r, note) {
    try {
      if (stopped || !config.enabled) return
      if (isQuiet(quietWindows)) { log('稍后补一条：安静时段，跳过'); return }
      const recent = (r.policy?.replyTimes || []).filter((t) => Date.now() - t < 600_000).length
      if (recent >= config.maxRepliesPer10Min) { log('稍后补一条：10 分钟上限到了，跳过'); return }
      const route = resolveRoute()
      stats.llmCalls++
      const userText = [
        `你刚才在群里说：「${String(note.said || '').slice(0, 60)}」`,
        '现在过了一小会儿。你当时说要想一想 —— 现在接着补一句，像真人突然想起来那样。',
        '要求：短、口语、直接说内容；不要道歉、别用「我想了想」这种开场（除非很自然）；不要重复刚才那句。',
        '只输出这一句。',
      ].join('\n')
      const res = await callLlm(route, buildSystem(r), userText, config.reasoningEffort || undefined)
      const text = cleanReply(res.text, { maxLen: config.maxReplyChars, maxLines: 0 })
      if (!text) { log('稍后补一条：模型没给内容，放弃'); return }
      log(`稍后补一条 → ${JSON.stringify(text)}`)
      await deliver(r, { sender: 'self', senderName: '我', text: '', typeName: 'text', roomId: r.roomId }, 'ambient', { text, stickerOnly: false })
    } catch (e) {
      log('稍后补一条失败：' + String(e?.message || e))
    }
  }
  /**
   * 建这个群的"真 @"索引（每个群各自一份）。
   *
   * 微信真 @ 的两个要求：① 正文里写 "@显示名" ② atlist 里给 wxid。
   * 而**显示名必须是群昵称**：用备注名去 @ 有可能显示不对/不提醒（实测踩过）。
   * 所以把成员的每种"叫法"（群昵称 nick / 备注 remark / 微信号 alias）都映射到 wxid，
   * 并把显示名统一成 nick —— 模型不管写的是昵称还是备注，都能解析出同一个人。
   */
  function buildAtIndex(r, list) {
    const atBy = {}
    const atNick = {}
    for (const m of (list || [])) {
      const wxid = String(m.wxid || '')
      if (!wxid || wxid === selfWxid()) continue
      const nick = String(m.nick || m.name || '').trim()
      const remark = String(m.remark || '').trim()
      const alias = String(m.alias || '').trim()
      if (nick) atNick[wxid] = nick
      // 顺序即优先级：群昵称优先，其次备注、微信号、最后是 bridge 给的 name
      for (const n of [nick, remark, alias, String(m.name || '').trim()]) {
        if (n && !atBy[n]) atBy[n] = wxid
      }
    }
    // 兜底：把历史学到的 wxid→名字 并进来（老数据可能只有备注名）
    for (const [wxid, nm] of Object.entries(config.memberNames || {})) {
      const n = String(nm || '').trim()
      if (n && wxid !== selfWxid() && !atBy[n]) atBy[n] = wxid
    }
    r.atBy = atBy
    r.atNick = atNick
    return Object.keys(atBy).length
  }

  /**
   * 确保这个群的 @ 索引可用 —— **缺了就现拉一次成员**（异步，带节流）。
   *
   * 为什么必须有它（线上真 bug）：`syncMembers()` 是**异步**的（roomState 里 `void syncMembers(r)`），
   * 而 `wechat_bot_say` 这类**同步入口**拿到 r 就立刻解析 @ → 那一刻 `r.atBy` 还是空的 ✗
   * → 手动发送永远 @ 不出去（实测：local_id=1949 那条没有 atuserlist）。
   * 另外 syncMembers 失败时会先打上 10 分钟节流戳，导致它 10 分钟内不再重试 ✗ —— 这里用独立的短节流兜住。
   *
   * @returns {Promise<boolean>} true = 索引可用
   */
  async function ensureAtIndex(r) {
    if (r.atBy && Object.keys(r.atBy).length) return true
    if (Date.now() - (r.atIndexAt || 0) < 60_000) return false     // 60s 内刚试过（失败）就不再打桥
    r.atIndexAt = Date.now()
    try {
      const res = await client.call('members', { roomId: r.roomId }, 20_000)
      const list = res?.members || []
      if (!list.length) { log('真 @：取不到群成员（这次退化为纯文本 @）'); return false }
      const n = buildAtIndex(r, list)
      log(`真 @：现拉群成员 ${list.length} 人 → 建立 @ 索引 ${n} 条`)
      return n > 0
    } catch (e) {
      log('真 @：拉群成员失败（这次退化为纯文本 @）：' + String(e?.message || e).slice(0, 120))
      return false
    }
  }

  /**
   * 把回复文本里的 "@名字" 变成**真 @**（微信里会红点提醒，不是纯文本）。
   *
   * 微信的两个要求：① 正文里要有 "@显示名" ② atlist 里要给 wxid。
   * 所以这里：按成员索引把名字解析成 wxid，并把文本里的显示名**统一成群昵称**
   * （用备注名去 @ 可能显示不对/不提醒 —— 实测踩过）。
   * 解析不到 wxid → **原样保留纯文本 @**（优雅降级，保持老行为，不报错）。
   *
   * @returns {{text:string, mentions:string[]}} mentions = 去重后的 wxid 数组
   */
  function resolveMentions(r, text) {
    const t = String(text || '')
    if (!config.allowAt || !t.includes('@')) return { text: t, mentions: [] }
    const byName = r.atBy || {}
    const nickOf = r.atNick || {}
    if (!Object.keys(byName).length) return { text: t, mentions: [] }   // 还没同步到成员 → 退化为文本 @
    const mentions = []
    // 名字的字符类与 learnAtNames 保持一致（@ 后面直到标点/空白为止），避免把标点吃进名字里
    const out = t.replace(/@([^\s@，。！？!?~…,.、:：;；"'（）()\[\]{}]{1,24})/g, (full, name) => {
      const wxid = byName[name]
      if (!wxid) return full                       // 认不出 → 保持纯文本 @（老行为）
      if (!mentions.includes(wxid)) mentions.push(wxid)
      return '@' + (nickOf[wxid] || name)          // 显示名统一成群昵称
    })
    return { text: out, mentions }
  }

  /**
   * 该不该把这条回复改成**语音气泡**？
   *
   * 顺序（有意为之）：
   *   ① 总开关 voiceSay=false → 永远发文字（默认关，先自测通了再开）
   *   ② 空文本 / 超长（voiceSayMaxChars）→ 发文字（语音太长很怪）
   *   ③ **安静时段**（复用既有作息判断）→ 发文字（深夜不发语音 ✓ 明确要求也不破例）
   *   ④ ★ 群里**明确要求**"发个语音/说句话" → **必须发**（用户直接提的要求）
   *   ⑤ 收到**语音**消息 → 用语音回（概率 voiceSayOnVoiceProbability，默认 0.5）
   *   ⑥ 其它 → 概率 voiceSayProbability（默认 0.2）
   * 限流不在这里管：它被 deliver 调用，而节流/上限/概率在 policy.decide 已经生效 ✓
   */
  // 「强烈要求」= 短时间内反复要（默认 10 分钟内 ≥2 次）。第一次可以傲娇拒绝（人设 ✓），
  // 但强烈要求必须发 —— 这是用户明确要的行为。
  const voiceAsks = new Map()          // roomId → [ts, ts, ...]
  const VOICE_STRONG_WINDOW_MS = 10 * 60_000
  const VOICE_STRONG_COUNT = 2

  function shouldSendVoice(r, trigger, text) {
    if (!config.voiceSay) return { yes: false, why: 'voiceSay=false（总开关关着）' }
    const t = String(text || '').trim()
    if (!t) return { yes: false, why: '空文本' }
    const chars = [...t].length
    const max = Number(config.voiceSayMaxChars) || 60
    if (chars > max) return { yes: false, why: `太长（${chars} 字 > ${max} 字）` }
    const asked = String(trigger?.text || '')
    // ★ 分级：首次要求 → 不强制（让模型自己决定，傲娇拒绝很正常）；反复要求 → 必须发
    let strong = false
    if (VOICE_REQUEST_RE.test(asked)) {
      const now = Date.now()
      const rid = r?.roomId || ''
      const arr = (voiceAsks.get(rid) || []).filter((x) => now - x < VOICE_STRONG_WINDOW_MS)
      arr.push(now)
      voiceAsks.set(rid, arr)
      strong = arr.length >= VOICE_STRONG_COUNT
      if (!strong) {
        // 第一次要：不拦不推，按普通消息走（模型自己决定说什么，可以是傲娇拒绝）
        log(`语音：第 ${arr.length} 次要（10 分钟内要满 ${VOICE_STRONG_COUNT} 次才强制发）→ 这次交给模型自己决定`)
        return { yes: false, why: `首次要求（${arr.length}/${VOICE_STRONG_COUNT}）→ 让模型自己决定` }
      }
      // 强烈要求 → 必须发，且【不受安静时段限制】（用户明确要的行为）
      log(`语音：强烈要求（10 分钟内第 ${arr.length} 次）→ 必须发（安静时段也发）`)
      return { yes: true, why: `强烈要求（${arr.length} 次）` }
    }
    if (isQuiet(quietWindows)) return { yes: false, why: '安静时段（深夜不发语音）' }
    const wasVoice = trigger?.typeName === 'voice' || !!trigger?.voiceText
    const p = Number(wasVoice ? config.voiceSayOnVoiceProbability : config.voiceSayProbability)
    if (!(p > 0)) return { yes: false, why: `概率为 0（p=${p}）` }
    if (Math.random() < p) return { yes: true, why: wasVoice ? `收到语音→语音回（p=${p}）` : `普通回复改语音（p=${p}）` }
    return { yes: false, why: `概率未命中（p=${p}）` }
  }

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

      // ── ★ 语音气泡：把这条回复改成**真·微信语音**（type 34）────────────────
      // 判定走 shouldSendVoice（含"群里明确要求发语音"→必须发；深夜不发；概率可配）。
      // 合成/发送失败一律**降级发文字** ✓ 绝不阻塞；限流不绕过（它在 deliver 里，节流早已生效）。
      if (parts.length) {
        // 语音不分段：用整段（太长会被 shouldSendVoice 挡掉）
        let voiceText = parts.join('')
        const vd = shouldSendVoice(r, trigger, voiceText)
        if (vd.yes) {
          // ★ 被"强烈要求"逼出来的语音 → 开头加一句**极不情愿**的话（嘴上嫌弃、但还是照做）
          //   这样才能体现"她本来不肯，被缠到没办法"。随机挑，不重复。
          if (String(vd.why || '').includes('强烈要求')) {
            const reluctant = [
              '……行吧行吧，烦死了，就这一次啊。',
              '……哼，别以为我乐意。听好了。',
              '……好啦好啦，服了你了。',
              '……真拿你没办法，就一遍。',
              '……烦人。……哼，说吧。',
            ]
            const pick = reluctant[(r.sentVoiceReluctant || 0) % reluctant.length]
            r.sentVoiceReluctant = (r.sentVoiceReluctant || 0) + 1
            const max = Number(config.voiceSayMaxChars) || 60
            if ([...pick].length + [...voiceText].length <= max) voiceText = pick + voiceText
            else voiceText = pick       // 原话太长 → 只发这句嫌弃（也是"极不情愿"的正确表达）
            log(`强制语音加"不情愿"前缀："${pick}"`)
          }
          const delay0 = humanDelayMs(voiceText, priority)
          log(`准备发语音气泡（${vd.why}）｜${Math.round(delay0 / 1000)}s 后发`)
          await sleep(delay0)
          let vs = null
          try {
            vs = await client.call('sayVoice', {
              roomId, text: voiceText, emotion: config.voiceSayEmotion || 'main',
            }, 150_000)
          } catch (e) { vs = { ok: false, error: String(e?.message || e) } }
          if (vs?.ok) {
            log(`发语音气泡成功：${vs.bytes} 字节 / ${vs.durationMs}ms（${config.voiceSayEmotion || 'main'}）`)
            stats.sentVoice = (stats.sentVoice || 0) + 1
            ;(r.sentTexts ||= []).push({ text: voiceText, at: Date.now() })
            if (r.sentTexts.length > 40) r.sentTexts = r.sentTexts.slice(-40)
            push(r, { ts: Date.now(), isSelf: true, sender: 'self', senderName: '我', text: `[语音] ${voiceText}` })
            parts.length = 0                      // 语音已发 → 跳过文字（表情包逻辑照旧继续）
          } else {
            log(`语音气泡失败 → 降级发文字：${vs?.error || '未知原因'}`)
          }
        } else if (config.voiceSay) {
          log(`不发语音（${vd.why}）→ 发文字`)      // 只在总开关开着时打，免得刷屏
        }
      }

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
          // 真 @：正文里有 "@某人" 就解析成 wxid 一起发（桥会填进 hook 的 atlist → 对方收到红点提醒）。
          // 解析不到就只发文本（老行为）；显示名统一成群昵称，避免 @ 错人/不提醒。
          // ⚠️ 索引可能还没建好（成员同步是异步的）→ 这里**先确保一次**（带节流，不会每次都打桥）
          if (config.allowAt && parts[i].includes('@')) await ensureAtIndex(r)
          const mm = resolveMentions(r, parts[i])
          await client.call('sendText', {
            roomId, text: mm.text,
            ...(mm.mentions.length ? { mentions: mm.mentions } : {}),
          })
          if (mm.mentions.length) log(`真 @：${mm.mentions.length} 人 → atlist（${mm.mentions.join(',')}）`)
          stats.sentText++
          ;(r.sentTexts ||= []).push({ text: mm.text, at: Date.now() })
          if (r.sentTexts.length > 40) r.sentTexts = r.sentTexts.slice(-40)
          push(r, { ts: Date.now(), isSelf: true, sender: 'self', senderName: '我', text: mm.text })
        } catch (e) {
          log('发送失败：' + String(e?.message || e))
          return
        }
        if (i < parts.length - 1) await sleep(gapMs())
      }
      // ── [稍后:N]：到点真的回来补一条（答应的事有下文）──
      if (reply.later > 0 && parts.length) {
        const mins = Math.max(1, Math.min(config.laterMaxMinutes || 30, Math.round(reply.later)))
        const said = parts.join(' ')
        if (r.laterTimer) clearTimeout(r.laterTimer)
        r.laterTimer = track(setTimeout(() => {
          r.laterTimer = null
          void sendFollowUp(r, { said }).catch((e) => log('稍后补一条异常：' + String(e?.message || e)))
        }, mins * 60_000))
        log(`记下了：${mins} 分钟后回来补一条（刚才说的是：${JSON.stringify(said.slice(0, 24))}）`)
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
          const lib = await client.call('pickSticker', { text: reply.emotion, roomId, minScore: 3, requireTag: true })
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
            minScore: 3,
            requireTag: true,
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
    return () => {
      // 卸载时清掉全局登记（否则下次热重载会去 close 一个已经没用的对象）
      try { if (globalThis.__WECHAT_BOT_CLIENT__ === client) delete globalThis.__WECHAT_BOT_CLIENT__ } catch { /* ignore */ }
      client.close()
    }
  }, SHORT + ': bridge ws')

  ctx.effect(() => () => {
    stopped = true
    for (const t of timers) clearTimeout(t)
    timers.clear()
    videoRechecks.clear()          // 视频延迟复查的计划也一并清掉（卸载后不再触发）
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
    const iv = setInterval(() => { void proactiveLoop().catch((e) => log('主动发言循环异常：' + String(e?.message || e))) }, config.proactiveCheckMs)
    return () => clearInterval(iv)
  }, SHORT + ': proactive')

  // 作息边界：每分钟看一眼是不是刚跨过 23:00 / 08:00
  ctx.effect(() => {
    const iv = setInterval(() => { void scheduleTick().catch((e) => log('作息检查异常：' + String(e?.message || e))) }, 60_000)
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

  // 失联监控：每 5 分钟只查关键项（桥连接/登录/hook/数据库/轮询）——**不全量自检**，
  // 避免频繁打 hook；连续 2 次异常（≈10 分钟）才告警，恢复也告警。
  ctx.effect(() => {
    const iv = setInterval(() => { void healthTick() }, Number(config.healthCheckMs) || 300_000)
    return () => clearInterval(iv)
  }, SHORT + ': health heartbeat')

  // ── 健康自检与失联监控 ───────────────────────────────────────
  // 为什么要有：这台机器人经常"静默失联"（桥掉线 / hook 卡死 / 数据库轮询失败 /
  // 被 @ 识别因群昵称对不上而失效），但没有任何人知道 —— 全靠人翻日志。
  //   ① wechat_bot_selfcheck：一条命令把全链路健康度打出来
  //   ② 心跳：每 5 分钟只查关键项，连续 2 次异常 → 日志 + filehelper 告警；恢复也告警
  // 红线：**只读**（除告警外不发任何消息）、不改配置、**不重启任何东西**。

  /** 记忆目录概况（文件数 + 最后写入时间） */
  function memorySummary() {
    try {
      const files = readdirSync(memoryDir).filter((f) => f.endsWith('.json'))
      let newest = 0
      for (const f of files) {
        try { newest = Math.max(newest, statSync(join(memoryDir, f)).mtimeMs) } catch { /* ignore */ }
      }
      return { files: files.length, newest }
    } catch { return { files: 0, newest: 0 } }
  }

  /** 视觉缓存条数（识图链路在不在用的旁证） */
  function visionCacheCount() {
    try { return Object.keys(loadVisionCache()).length } catch { return 0 }
  }

  /** 把异常项翻译成一句人话（告警文案用） */
  function humanReason(items) {
    const has = (n) => items.some((i) => i.name === n)
    if (has('桥连接')) return '桥没连上'
    if (has('微信登录')) return '微信没登录'
    if (has('hook 存活')) return 'hook 没响应（读不到微信数据库）'
    if (has('数据库可读')) return '读不到微信数据库'
    if (has('消息轮询')) return '收不到群消息了'
    return items.map((i) => i.name).join('/') + ' 异常'
  }

  /**
   * 全链路健康检查（只读）。
   * @param {object} o
   * @param {boolean} [o.deep] true = 全量（自检工具用：含群昵称一致性/语音/识图/记忆/路由）；
   *                           false = 只查失联关键项（心跳用，最多打一次 hook）
   * @returns {Promise<{at:number, items:Array<{name:string,level:string,text:string,advice:string}>, bad:string[], warn:string[]}>}
   */
  async function healthCheck({ deep = true } = {}) {
    const items = []
    const add = (name, level, text, advice = '') => { items.push({ name, level, text, advice }) }
    const cs = client.status

    // ① 桥连接（最关键：桥死了后面全都没意义）
    add('桥连接', cs.connected ? 'ok' : 'bad',
      cs.connected ? `已连接（累计重连 ${cs.reconnects} 次）`
        : `未连接（累计重连 ${cs.reconnects} 次${cs.lastError ? '｜' + cs.lastError : ''}）`,
      cs.connected ? '' : '桥进程可能挂了：看 wx-bridge（状态检查.cmd / data\\logs\\bridge-*.log），必要时重启桥')

    // ② 微信登录 + 桥侧状态
    let br = null
    let brErr = cs.connected ? '' : '桥未连接'
    if (cs.connected) {
      try { br = await client.call('status', {}, 8000) } catch (e) { brErr = String(e?.message || e) }
    }
    add('微信登录', br?.loggedIn ? 'ok' : 'bad',
      br ? (br.loggedIn ? `已登录 ${br.self || '(self 待定)'}` : '未登录') : `取不到（${String(brErr).slice(0, 80)}）`,
      br?.loggedIn ? '' : '客户端掉线/未登录：需要人工扫码或重启客户端（本插件**不会**自动重启）')

    // ③④ hook 存活 + 数据库可读：**一次轻查询**同时证明两件事
    //    （searchMessages 会真读 message_0.db，是"hook 还活着吗"最直接的证据）
    // ★ 探测会话：没有已知群时【别跳过】✗ —— 用 filehelper 兜底（它一定存在），
    //   否则"数据库读不出 + 还没有已知会话"会被判成 warn（跳过），
    //   于是机器人静默失聪时自检照样报"正常"（2026-10-19 被这个盲区坑了一整晚）。
    const probeRoom = (config.rooms && config.rooms[0]) || [...rooms.keys()][0] || 'filehelper'
    let dbOk = false
    let dbText = ''
    let dbAdvice = ''
    if (!cs.connected) {
      dbText = '未检查（桥未连接）'
      dbAdvice = '桥恢复后自动可查'
    } else {
      try {
        const res = await client.call('searchMessages', { roomId: probeRoom, query: '', limit: 1, scan: 50 }, 15000)
        // 注意：桥的这个 op **不抛错**，失败时返回 { items: [], error: '…' }（server.mjs:329/336）
        // —— 只看 items 是数组会把它误判成"可读"，必须同时看 error 字段。
        dbOk = Array.isArray(res?.items) && !res?.error
        dbText = dbOk ? `消息库可读（探针会话「${probeRoom}」取到 ${res.items.length} 条）`
          : (res?.error ? '查询失败：' + String(res.error).slice(0, 80) : '查询返回结构异常')
        dbAdvice = dbOk ? '' : 'hook 的 QueryDB 或轮询器异常：看 bridge 日志里的 SQL 失败行'
      } catch (e) {
        dbText = '读不到：' + String(e?.message || e).slice(0, 90)
        dbAdvice = 'hook 卡死或数据库没打开：桥会自己重试；持续失败看 bridge 日志（可能要唤醒/重启客户端）'
      }
    }
    // 桥连着却读不出库 → 一律判 bad（不再有"跳过"这条路）
    const dbLevel = dbOk ? 'ok' : (cs.connected ? 'bad' : 'warn')
    add('hook 存活', dbOk ? 'ok' : dbLevel, dbOk ? 'QueryDB 有响应（hook 正常）' : dbText, dbAdvice)
    add('数据库可读', dbLevel, dbText, dbAdvice)

    // ⑤ 消息轮询：只认"有证据的失败"，避免"群里没人说话"被误报成失联
    const idleMin = lastMsgAt ? Math.round((Date.now() - lastMsgAt) / 60000) : null
    const wakeMin = lastWakeAt ? Math.round((Date.now() - lastWakeAt) / 60000) : null
    let pollLevel = 'ok'
    let pollText = idleMin == null ? '还没收到过消息（可能群里一直没人说话）' : `最近一条消息 ${idleMin} 分钟前`
    let pollAdvice = ''
    if (!dbOk && cs.connected && probeRoom) {
      pollLevel = 'bad'; pollText += '｜数据库读不到，轮询必然停了'; pollAdvice = '先修 hook/数据库（见上）'
    } else if (wakeMin != null && wakeMin <= 15) {
      pollLevel = 'bad'; pollText += `｜${wakeMin} 分钟前桥喊过"数据库打不开"`; pollAdvice = '桥会自己重试；持续出现说明 message_0.db 打不开'
    } else if (idleMin != null && idleMin > 180) {
      pollLevel = 'warn'; pollText += '（超过 3 小时没消息）'; pollAdvice = '如果群里明明有人在说话，说明轮询断了'
    }
    add('消息轮询', pollLevel, pollText, pollAdvice)

    if (!deep) {
      const bad0 = items.filter((i) => i.level === 'bad').map((i) => i.name)
      const warn0 = items.filter((i) => i.level === 'warn').map((i) => i.name)
      return { at: Date.now(), items, bad: bad0, warn: warn0 }
    }

    // ⑥ 自己是谁
    const me = selfWxid()
    add('自己是谁', me ? 'ok' : 'warn',
      me ? `${me}｜群里的名字：${config.botName || '(未设 botName)'}` : '还不知道自己的 wxid',
      me ? '' : '等一条群消息或配 WECHAT_SELF_WXID（self 未知时"被@必回"判定可能不准）')

    // ⑦ 群昵称一致性（重点：昵称对不上 = @ 识别静默失效）
    if (!cs.connected) {
      add('群昵称一致性', 'warn', '未检查（桥未连接）', '桥恢复后重试')
    } else if (!rooms.size) {
      add('群昵称一致性', 'warn', '还没有已知群，无法核对', '等群里来一条消息后重试')
    } else {
      for (const r of [...rooms.values()].slice(0, 5)) {
        try {
          const info = await client.call('members', { roomId: r.roomId }, 20000)
          const list = info?.members || []
          if (!list.length) {
            // 桥的 members 在 hook/数据库没响应时会**回退成空列表**（不抛错）→ 不能当成"昵称不对"
            add(`群昵称一致性（${r.roomName}）`, 'warn', '取不到群成员（0 名，hook/数据库可能没响应）', '先看上面的 hook 存活/数据库可读两项')
            continue
          }
          const names = list.flatMap((x) => [x.name, x.nick, x.remark, x.alias, x.displayName, x.nickName]
            .filter(Boolean).map((s) => String(s).trim()))
          const mine = list.find((x) => x.wxid && x.wxid === (info.selfWxid || me))
          const myName = mine ? String(mine.name || mine.nick || '').trim() : ''
          const want = String(config.botName || '').trim()
          const hit = !!want && names.includes(want)
          add(`群昵称一致性（${r.roomName}）`, hit ? 'ok' : 'bad',
            hit ? `「${want}」在群里（${list.length} 名成员）${myName ? '｜我的群昵称：' + myName : ''}`
              : `群里找不到「${want}」（${list.length} 名成员）${myName ? '｜我的群昵称实际是：' + myName : ''}`,
            hit ? '' : `在群里改了昵称 → "@我必回"会失效：把 botName 改成实际群昵称${myName ? `（${myName}）` : ''}，或把群昵称改回来`)
        } catch (e) {
          add(`群昵称一致性（${r.roomName}）`, 'warn', '取群成员失败：' + String(e?.message || e).slice(0, 70), '桥/hook 恢复后重试')
        }
      }
    }

    // ⑧ 语音识别（服务惰性获取，拿不到就是降级，不是故障）
    const stt = speechService()
    if (!stt) {
      add('语音识别', 'warn', '没有 speechToText 服务（DSH「语音输入」bundle 未启用？）',
        '语音会保持 [语音] 降级；启用 bundle 即恢复')
    } else {
      try {
        const want = String(config.voiceProvider || 'sensevoice-local')
        const view = (stt.snapshot?.()?.providers || []).find((x) => String(x.id) === want)
        const phase = view?.preparation?.phase || '?'
        const okPhase = phase === 'ready' || phase === 'standby'
        add('语音识别', okPhase ? 'ok' : 'warn', `${want}｜phase=${phase}`,
          okPhase ? '' : '模型没准备好 → 语音降级为 [语音]（首次要下载约 239MB）')
      } catch (e) { add('语音识别', 'warn', 'snapshot 失败：' + String(e?.message || e).slice(0, 70), '') }
    }

    // ⑨ 识图
    const visionOn = !!config.visionOnImage && !!config.visionModel
    add('识图', visionOn ? 'ok' : 'warn',
      config.visionOnImage
        ? `${config.visionProvider || '(默认)'} / ${config.visionModel || '(未配模型)'}｜缓存 ${visionCacheCount()} 条`
        : '已关闭（visionOnImage=false）',
      visionOn ? '' : '想让它看懂群里的图：设 visionOnImage=true 并配 visionModel')

    // ⑩ 表情包库
    add('表情包库', br ? 'ok' : 'warn', br ? `${br.stickers?.count ?? 0} 张（${br.stickers?.mb ?? 0}MB）` : '取不到（桥未连接）', '')

    // ⑪ 记忆
    const mem = memorySummary()
    const memAgeMin = mem.newest ? Math.round((Date.now() - mem.newest) / 60000) : null
    add('记忆', mem.files ? 'ok' : 'warn',
      `${mem.files} 个群的记忆文件｜最后写入 ${memAgeMin == null ? '从未' : memAgeMin + ' 分钟前'}`,
      mem.files ? '' : '还没有记忆文件（收到消息后会自动建）')

    // ⑫ LLM 路由（**只报告，不真调模型** —— 省钱）
    try {
      const route = resolveRoute()
      add('LLM 路由', route?.provider && route?.model ? 'ok' : 'warn', `${route?.provider} / ${route?.model}（只报告，未调用）`, '')
    } catch (e) {
      add('LLM 路由', 'warn', '未确定：' + String(e?.message || e).slice(0, 70), '在插件配置里显式指定 provider/model')
    }

    const bad = items.filter((i) => i.level === 'bad').map((i) => i.name)
    const warn = items.filter((i) => i.level === 'warn').map((i) => i.name)
    return { at: Date.now(), items, bad, warn }
  }

  /**
   * 失联告警：写日志 +（可选）往 filehelper 发一句人话。
   * filehelper 是"自己微信里能直接看到"的通道，且机器人给它发消息**不会**触发自己的回复逻辑。
   * 限流：同一类最多 config.healthAlertQuietMs（默认 30 分钟）一次，防刷屏。
   */
  async function alertHealth(badItems, { recovered = false, mins = 0 } = {}) {
    const names = badItems.map((i) => i.name)
    const detail = badItems.map((i) => `${i.name}：${i.text}`).join('；')
    if (recovered) {
      log('✅ 已恢复：关键项都正常了（失联期间累计告警过一次）')
    } else {
      log(`⚠️ 失联告警：${names.join('/')} 异常｜${detail}`)
    }
    const now = Date.now()
    const quiet = Number(config.healthAlertQuietMs) || 1_800_000
    const last = healthAlertAt.get('offline') || 0
    if (!recovered && now - last < quiet) {
      log(`（告警限流：同一类 ${Math.round(quiet / 60000)} 分钟内不重复发，还剩 ${Math.round((quiet - (now - last)) / 60000)} 分钟）`)
      return false
    }
    if (!config.healthAlert) { log('（healthAlert=false：只写日志，不发 filehelper）'); return false }
    healthAlertAt.set('offline', now)
    const text = recovered
      ? '✅ 我恢复了：现在能正常收群消息了'
      : `⚠️ 我好像断线了：${humanReason(badItems)}（已 ${mins || 10} 分钟）`
    try {
      await client.call('sendText', { roomId: 'filehelper', text }, 15000)
      log('失联告警已发到 filehelper：' + text)
      return true
    } catch (e) {
      log('失联告警发送失败（不影响别的流程）：' + String(e?.message || e).slice(0, 120))
      return false
    }
  }

  /** 心跳：只查关键项；连续 2 次异常才告警；恢复时配对告警 */
  async function healthTick() {
    if (stopped) return
    try {
      const h = await healthCheck({ deep: false })
      healthLast = h
      if (h.bad.length) {
        healthStreak++
        const badItems = h.items.filter((i) => i.level === 'bad')
        log(`健康检查：${h.bad.length} 项异常（连续第 ${healthStreak} 次）｜`
          + badItems.map((i) => `${i.name}=${i.text}`).join('；'))
        if (healthStreak >= 2) {
          const mins = Math.round((healthStreak * (Number(config.healthCheckMs) || 300_000)) / 60000)
          await alertHealth(badItems, { mins })
          healthAlerted = true
        }
      } else {
        if (healthAlerted) {
          await alertHealth([], { recovered: true })
          healthAlerted = false
          healthAlertAt.delete('offline')   // 恢复后清零：下次真挂了立刻告警，不干等 30 分钟
        }
        healthStreak = 0
      }
    } catch (e) {
      log('健康检查异常（不影响主流程）：' + String(e?.message || e).slice(0, 160))
    }
  }

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
      // 健康摘要：复用 6 分钟内的心跳结果（不重复打 hook），过期就现查一次轻量检查
      try {
        const h = (healthLast && Date.now() - healthLast.at < 6 * 60_000) ? healthLast : await healthCheck({ deep: false })
        const ageMin = Math.round((Date.now() - h.at) / 60000)
        lines.push(`健康：${h.bad.length ? '❌ ' + h.bad.join(' / ') : (h.warn.length ? '⚠️ ' + h.warn.join(' / ') : '✅ 正常')}`
          + `（${ageMin === 0 ? '刚刚' : ageMin + ' 分钟前'}检查${h.bad.length ? '，详情用 wechat_bot_selfcheck' : ''}）`)
      } catch (e) { lines.push('健康：取不到（' + String(e?.message || e).slice(0, 60) + '）') }
      lines.push(`本插件计数：收到 ${stats.msgIn}｜回复 ${stats.replied}｜跳过 ${stats.skipped}｜LLM ${stats.llmCalls}（失败 ${stats.llmErrors}）｜发文字 ${stats.sentText}｜发语音 ${stats.sentVoice || 0}｜发表情 ${stats.sentSticker}｜拍一拍 ${stats.sentPat}`)
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
    name: 'wechat_bot_selfcheck',
    description: '微信群聊机器人一键自检：桥连接/微信登录/hook 存活/数据库可读/消息轮询/自己是谁/群昵称一致性/语音识别/识图/表情包库/记忆/LLM 路由，'
      + '逐项 ✅❌⚠️ 打出来并给修复建议（纯只读：不发消息、不改配置、不重启任何东西）。'
      + '机器人"静默失联"或"被@不回复"时先跑这个。',
    parameters: { type: 'object', properties: {} },
    output: textOut,
    async execute() {
      const h = await healthCheck({ deep: true })
      healthLast = h
      const icon = (lv) => (lv === 'ok' ? '✅' : lv === 'warn' ? '⚠️' : '❌')
      const lines = ['== 微信机器人自检 ==']
      lines.push(`时间：${new Date(h.at).toLocaleString()}｜接入：${config.bridgeUrl}｜插件：${config.enabled ? '启用' : '停用'}`)
      for (const it of h.items) {
        lines.push(`${icon(it.level)} ${it.name}：${it.text}`)
        if (it.advice) lines.push(`      建议：${it.advice}`)
      }
      lines.push('')
      if (h.bad.length) {
        lines.push(`总结：有 ${h.bad.length} 项异常：${h.bad.join('、')}`
          + (h.warn.length ? `｜另有 ${h.warn.length} 项提醒：${h.warn.join('、')}` : ''))
      } else if (h.warn.length) {
        lines.push(`总结：关键项全部正常（另有 ${h.warn.length} 项提醒：${h.warn.join('、')}）`)
      } else {
        lines.push('总结：全链路正常 ✅')
      }
      return lines.join('\n')
    },
  }), SHORT + ': wechat_bot_selfcheck')

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
      // 手动发送同样支持真 @：正文里写 "@某人" 就会解析成 wxid（解析不到只发文本）
      const r0 = roomState(room.roomId, room.name)
      // ⚠️ 根因修复：成员索引是**异步**建的，而工具入口是同步的 → 这里先确保一次，
      // 否则手动发送永远 @ 不出去（实测 local_id=1949 没有 atuserlist 就是这个原因）。
      if (config.allowAt && text.includes('@')) await ensureAtIndex(r0)
      const mm = resolveMentions(r0, text)
      const sent = await client.call('sendText', {
        roomId: room.roomId, text: mm.text,
        ...(mm.mentions.length ? { mentions: mm.mentions } : {}),
      })
      const rc = (sent && typeof sent === 'object') ? (sent.rc ?? JSON.stringify(sent)) : sent
      stats.sentText++
      const r = r0
      push(r, { ts: Date.now(), isSelf: true, sender: 'self', senderName: '我', text: mm.text })
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
    description: '读取或实时修改微信机器人的拟人参数（无需重启）。key 留空 = 查看全部；给了 value = 修改。可改：enabled/dryRun/persona/replyProbability/minReplyGapMs/maxRepliesPer10Min/quietHours/stickerChance/splitChance/patChance/botName/rooms/temperature/voiceOnVoice/voiceSay/voiceSayProbability/voiceSayOnVoiceProbability/voiceSayMaxChars/voiceSayEmotion/healthAlert/healthAlertQuietMs/healthCheckMs/videoDeleteAfterRead/videoUpgradeDelayMs/videoFrames/linkVideo/linkVideoProbability/linkVideoMaxSeconds/linkVideoMaxMB/linkVideoCooldownMs/linkVideoTimeoutMs/linkVideoFrames。',
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
      const desc = await describeImageCached(p)
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
