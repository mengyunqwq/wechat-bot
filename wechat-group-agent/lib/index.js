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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, copyFileSync, rmSync, openSync, closeSync } from 'node:fs'
import { execFileSync, execSync, exec as execCb, spawn as spawnCb } from 'node:child_process'
import * as MV2 from './memory-v2.mjs?v=vmvswtxbe'   // 艾宾浩斯遗忘曲线 + 情绪加权（?v= 用于打破 ESM 缓存）
import * as H3 from './human3.mjs'   // 第三轮：情景示例/幽默三招/不重复/收尾日记/羁绊
import * as OB from './outbox.mjs'   // 统一出站队列（节流/去重/重试退避）
import * as H2 from './human2.mjs'   // 第二轮人性化：承诺/纠错/沉默/追话/联想/自己的事
import * as PS from './persona.mjs?v=vmvswtxbe'      // 性格四件套 + 自传（?v= 打破 ESM 缓存）
import net from 'node:net'
import { request as httpsRequest } from 'node:https'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { BridgeClient } from './bridge-client.mjs'
import { pickMomentImage } from './moment-image.mjs'
import { createPetBridge } from './pet-bridge.mjs'
// 配置元数据先静态拿一份（校验用）；真正挂面板时会用带 cache-bust 的动态 import
// 再加载一份最新的（热重载后改了 label/范围不用重启 DSH）。
import { CONFIG_META as STATIC_CONFIG_META } from './panel-meta.mjs'
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

export const name = '@dsh-external/dsh-wechat-bot'
export const version = '2.0.2'
// Cordis 4.0.4 的 inject 只认**数组**或"服务名→配置"映射；
// 写成 { required, optional } 会让依赖解析失败、fiber 永远 pending（踩过：改了代码却一直跑旧实例）。
// 这里只声明必然存在的两个服务；attachments（视觉识别用）改为**惰性获取**，
// 免得某个作用域取不到它时把整个插件卡在 pending。
export const inject = ['tools', 'llm']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 面板用的配置元数据。动态 import 成功后会替换成最新模块导出的那份。
let CONFIG_META = STATIC_CONFIG_META

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
 * 记忆专用归一化：和 normText 的区别是**不截短到 60**。
 *  为什么：记忆条目最长 200 字，用 60 字窗口比较时，后半句的差异会被抹掉，
 *  导致「同一件事换个说法」既可能漏判重复、也可能误杀。重复回复判定仍用 normText（不变）。
 */
function normFact(s) {
  return String(s || '')
    .replace(/\[[^\]]{0,20}\]/g, '')
    .replace(/@[^\s@]{1,24}/g, '')
    .replace(/[\s，。！？!?~…,.、""''（）()\[\]{}:：;；]/g, '')
    .toLowerCase()
    .slice(0, 220)
}

/**
 * 两条记忆是否「讲的是同一件事」。
 *  原先只判断完全相等 → 模型每次换个说法就成新条目，记忆越攒越重复。
 *  这里加三层判定：完全相等 / 包含关系 / 字符二元组 Jaccard 相似度。
 *  阈值 0.72：偏保守，宁可少合并，也不把两件不同的事错误合并。
 */
function factSimilar(a, b) {
  const A = String(a || ''), B = String(b || '')
  if (!A || !B) return false
  if (A === B) return true
  // 包含关系（"老王是群主" vs "老王是群主，管得很松"）—— 长度门槛 4 字，避免短串误伤
  if (A.length >= 4 && B.length >= 4 && (A.includes(B) || B.includes(A))) return true
  // 编辑距离相似度：对「中间插个字/换个词」比二元组敏感
  const maxLen = Math.max(A.length, B.length)
  if (Math.abs(A.length - B.length) / maxLen > 0.5) return false   // 长度差太多，直接否
  const dist = editDistance(A, B)
  return 1 - dist / maxLen >= 0.8
}

/** Levenshtein 编辑距离（两行滚动数组，避免大数组） */
function editDistance(a, b) {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  let prev = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1)
    cur[0] = i
    const ai = a.charCodeAt(i - 1)
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[n]
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
  personaLore: '白饭 | 她的主食，提到白饭会精神起来；吃白饭是她的人生大事\n梦云 | 她的主人，只叫他"主人"；别人提梦云要注意分寸\n日语 | 被起哄时会用日语说"杂鱼杂鱼"怼人\n抖音 | 她爱刷抖音，会分享刷到的视频\n胖/大肥鱼 | 被说胖会鼓腮嘴硬"我才不胖，是圆的"',   // ★ 世界书：关键词命中才注入（省 token、设定不飘）
  // ── 出站队列（统一发送节流 / 去重 / 重试退避）──────────────
  outboxMinGapMs: 1200,            // 同一个群两条消息的最小间隔（毫秒）
  outboxMaxPerMin: 20,             // 全局每分钟最多发几条
  outboxMaxAttempts: 3,            // 失败重试次数
  outboxBackoffMs: 2000,           // 首次重试等待（之后翻倍）
  outboxDedupeMs: 5000,            // 同样内容在这个窗口内只发一次
  personaExamples: '别人：大肥鱼你在干嘛\n她：吃饭。白饭。\n\n别人：你今天怎么这么安静\n她：……困。\n\n别人：大肥鱼你是不是胖了\n她：我才不胖呢，是圆的！圆的懂吗\n\n别人：帮我查一下明天天气呗\n她：等下我看看……你自己不会查啊\n\n别人：@大肥鱼 你主人呢\n她：主人忙。别吵他。',   // ★ 示例对话（SillyTavern mes_example 思路）：模仿示范比遵守形容词有效
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
  linkVideoFrames: 6,            // 时长未知时抽几帧（时长已知时按 fps × 时长）
  videoFps: 1,                  // ★ 微信视频每秒抽几帧（默认 1，每 20 帧一张联系表）
  linkVideoFps: 1,               // ★ 每秒抽几帧（默认 1）：1 fps + 每 20 帧一张联系表

  // ── 抖音自动刷（★ 只读）+ 挑一条分享到群 ──────────────────────────
  //   红线：只读（不点赞 / 不评论 / 不关注 / 不私信）—— 脚本里写死。
  //   为什么只读：抖音风控对"写操作"极敏感，自动点赞/评论基本必封号。
  douyinShare: true,                  // 总开关（关掉就完全不刷）
  douyinShareIntervalMs: 7_200_000,   // 至少隔多久刷一次（默认 2 小时）
  douyinAudioViaDownload: true,       // ★ 静音刷抖音时，音轨从下载的视频里抽（不再靠浏览器录音）
  douyinBrushCount: 3,                // 每次刷几条候选（3 条挑 1 条，够快也不至于没得选）
  // ── 受限自愈（默认关闭）───────────────────────────────────────
  //   仅针对「hook 死锁」这一个特征：status 正常、execute 永远超时、桥和客户端都活着。
  //   满足全部条件才执行：连续 3 次检查失败 + 08:00-23:00 + 每天最多 1 次 + 用安全脚本
  //   （备份 → CloseMainWindow/WM_CLOSE 正常关 → 重启 → 自动点「进入微信」）。
  //   ★ 永远不会强杀进程（规则 R1）。
  selfHeal: false,                       // 总开关（改成 true 才启用）
  selfHealScript: '',                    // safe-restart-client.ps1 的绝对路径
  selfHealBridgeDir: '',                 // wx-bridge 目录（给脚本用）
  selfHealWeChatDir: '',                    // 客户端目录（空 = 自动检测）
  selfHealMaxPerDay: 1,                  // 每天最多自动重启几次
  douyinShareMaxPerDay: 3,            // 每天最多分享几条（防刷屏）

  // ── 语音气泡（发真·微信语音 type 34，不是"音频文件"）────────────────
  // 走 hook 的 /SendVoiceMsg（SILK 由 tts.mjs 合成；hook 的 str0Mode 必须 'bytes'）。
  // hook 侧还有独立开关（<客户端目录>\hook-voice-send.on 或 POST /Debug/VoiceSend {"on":true}）——
  // 开关没开时 hook 返回 -1001，日志会打清楚原因（不会静默失败）。
  voiceSay: false,                 // 总开关（默认**关**：先自测通过再开）
  voiceModelOn: true,               // 语音模型：true=常驻（时刻准备）/ false=关闭（省 GPU）
  voicePreset: '雌小鬼·A（当前）',  // 音色预设（当前用 GPT-SoVITS）
  // 更新检查的自定义版本源（不依赖 GitHub）：逗号分隔 URL，返回 {"version":"1.3.x"} 即采用。
  // 适合自建对象存储 / 局域网共享 / 别的托管；也可填第三方镜像。
  updateMirror: '',
  voiceSayProbability: 0.2,        // 普通回复改成语音的概率
  voiceSayOnVoiceProbability: 0.5, // 收到**语音**消息时用语音回的概率（对称，最像真人）
  voiceSayMaxChars: 60,            // 超过这么多字就发文字（语音太长很怪）
  voiceMinGapSec: 90,              // ★ 两条语音最小间隔（秒）。连发语音会让微信退出（2026-10-28 事故）
  voiceMaxPer10Min: 3,             // ★ 10 分钟内最多发几条语音（同上，防对象所有权撞车）
  visionCacheMax: 500,           // 识图结果缓存条数（同一张图只识别一次；超出丢最早的）
  visionProvider: 'opencodego-extra',
  visionModel: 'deepseek-v4-flash-vision-exp',
  imageReplyProbability: 0.5,    // 看到（识别出的）图片时回话的概率

  // ── 桌宠联动（dsh-pet：桌面上的蓝色大肥鱼）──────────────────────────
  // 她才是本体，微信只是她干活的手：收消息→表情，思考/回完→动作，出错→叹气。
  // 走 dsh-pet 的 HTTP 接口（/dsh-pet-7340/*，不需要鉴权）；
  // 没装/没开/端口变了都**静默跳过**，绝不影响机器人本体。
  petSync: true,                                    // 总开关
  petSyncBaseUrl: 'http://127.0.0.1:3080',          // DSH web 地址（桌宠接口挂在它上面）
  petSyncPetId: 'main',                             // 桌宠 id（配置里的 pets[].id）
  petSyncSurface: 'desktop',                        // web / desktop / both / any
  petSyncMinGapMs: 2000,                            // 两次动作最短间隔（防刷屏）
  petSyncAnimOnReceive: '点击回应-害羞惊讶',          // 群里有人说话 → 表情
  petSyncAnimOnThinking: '工作状态-思考冒泡',         // 开始想怎么回 → 动作
  petSyncAnimOnSent: '工作状态-雀跃庆祝',             // 回复发出去 → 动作
  petSyncAnimOnError: '工作状态-垂头叹气冒汗',        // 出错/失联 → 表情


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

  // ── 面板自动打开（用户要求：后续不要每次都弹网页版）──────────────
  // false = 桥连上/重载插件时**不再自动开浏览器标签**（面板仍可从 🐋 或 /wechat-bot 打开）
  autoOpenPanel: false,
  panelUrl: '',                  // 手动指定面板地址（留空=自动学 host）
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
  // ── 记忆系统 v2（艾宾浩斯遗忘曲线 + 情绪加权）──────────────────
  memoryCrossGroup: 'safe',        // ★ 跨群边界：safe=人事/身份可跨群但脱群名、事件只在本群｜none=只用本群｜all=完全互通
  memoryV2: true,                 // 总开关；false = 退回旧逻辑（slice(-18) 注入、不遗忘）
  memoryScope: 'global',          // global = 所有群共用一份记忆（她是一个人）；room = 每群独立
  memoryGlobalMax: 400,           // 全局记忆上限（比单群大，因为有多个群的来源）
  memoryBaseDays: 7,              // S0 基准天数（越大越不容易忘）
  memoryForgetWeight: 0.06,       // 遗忘判据：R × 重要度 低于此值 → 归档
  memoryMinAgeDays: 2,            // 不到这个天数的记忆不归档（给新记忆机会）
  memoryKeepImportance: 0.85,     // 重要度 ≥ 此值 = 铁律记忆，永不自动归档
  memoryArchiveGraceDays: 30,     // 归档后保留多少天才真删
  memoryMaxActive: 120,           // 每群生效记忆上限（超了按 R×重要度 淘汰）
  memoryInjectCount: 12,          // 每次带进上下文的记忆条数
  memoryEmotionBoost: 0.8,        // 情绪强度对初始强度的加成上限
  memoryRecallGamma: 1.2,         // 被用到一次 → 强度增益系数
  memoryPinnedMax: 3,             // 固定记忆必带条数上限
  memoryConsolidate: 'daily',     // 遗忘巡检频率：off | hourly | daily
  // ── 性格（状态机 / 自我叙事 / 好恶 / 私人目标）──────────────────
  personaEnabled: true,           // 总开关：关掉就只用 persona 文案，行为完全不变
  personaDiaryHours: 24,          // 多久写一篇"自己的日记"（默认每天一篇；0=不写）
  personaMaxGoals: 3,             // 同时保留几个私人目标
  personaSeedLikes: 2,            // 初始随机喜欢几条（之后由她自己长）
  personaSeedDislikes: 1,         // 初始随机讨厌几条
  personaMoodFollow: 0.35,        // 情绪对心情的影响强度（越大越情绪化）
  // ── 精力负荷（她一个人应付多个群）──────────────────────────
  // ★ 2026-10-28 修：原来 6 条/分钟太低 —— 群里正常聊天就是 5~6 条/分钟，
  //   负荷常年 99%，精力被压在 0.15 下限，她会一直"很困、句子短"。
  //   24 条/分钟 = 需要相当密集的刷屏才算累。
  personaEnergyBasePerMin: 24,    // 单个群时，每分钟多少条算"满负荷"
  personaEnergyRoomBonus: 0.6,    // 每多一个活跃群，容量 +60%（群多不等于更累）
  personaEnergyMaxRooms: 8,       // 活跃群数上限（再多也不线性加）
  // ── 更像人的细节（B~I）────────────────────────────────────
  humanImperfectRecall: true,     // B：记不清就说得含糊（按保持率 R 分级表达）
  humanMoodCause: true,           // C：心情要有来由（能说出"为什么"）
  personaLoveExclusive: true,        // ★ 只喜欢一个人：其他人好感压在 55%（普通）以内
  humanSceneExamples: true,          // ① 情景语气示例（两段式转折）
  humanHumorRules: true,             // ② 幽默三招
  humanNoRepeat: true,               // ③ 不重复称呼/口头禅
  humanAuseel: true,                 // （占位，勿删：保持配置键顺序稳定）
  humanWrapUpDiary: true,            // ④ 结束对话时写一条收尾记录
  humanSafetyBoundary: true,         // ⑤ 不绝对服从的底线
  humanBondLevel: true,              // ⑥ 羁绊等级 Lv1~7
  humanImpression: true,             // ② 印象卡：定期给每个人生成一句"我对他的判断"
  humanRelationTiers: true,       // E：对熟人/生人态度不同
  humanLearnTerms: true,          // F：遇到群里的新词会先问、再学着用
  humanBodyState: true,           // H：只"困/饿"，且必须自洽（不编造生活）
  humanPatience: true,            // I：被连续追问会不耐烦（但不拒答）
  humanSelfReviewDays: 7,         // G：每几天做一次自我复盘（0=不做）
  humanProactiveTopic: true,      // D：闲置时主动抛自己喜欢的话题
  humanProactiveChance: 0.08,     //     每次检查时主动开话题的概率
  humanProactiveIdleMin: 40,      //     群里安静多少分钟后才考虑
  humanPromise: true,             // 2：答应的"等下帮你找"到点会回来兑现
  humanCorrection: true,          // 3：被纠正后会改记忆（而不是嘴硬到底）
  humanSilence: true,             // 4：知道什么时候不该说话（吵架/别人互聊/刚被冷场）
  humanFollowUp: true,            // 6：说完一句，过一会儿可能自己补一句
  humanActivity: true,            // 7：安静久了会做点自己的事（只用真实素材，不编事实）
  humanAssociation: true,         // 9：被聊天里的词勾起的回忆（不是随机抽奖）
  // ── 自传：人设的作者从"你"变成"她自己" ──────────────────────
  personaSelfNarrative: true,     // 开=她会根据经历重写"我是个什么样的人"（identity/底线仍由 persona 锁定）
  personaNarrativeHours: 24,      // 多久允许重写一次（默认每天）
  personaNarrativeMinDiaries: 1,  // 至少攒够几篇新日记才重写（日记每天一篇 → 1 篇即可）
  personaNarrativeMaxDrift: 0.30, // 与上一版的最低相似度（低于=人格突变，拒绝并保留旧版）
  // ── 方案⑥ 反馈驱动的性格漂移 ──────────────────────────────
  personaFeedback: false,         // 默认关！先观察日志再决定开（风险最高的一项）
  personaFeedbackLr: 0.018,       // 学习率（每次调整幅度）
  personaFeedbackSettleMin: 3,    // 发言后多少分钟结算反馈（收到接话会提前结算）
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
  // ★ 2026-10-28 修：面板「表情包」页有这个可编辑字段，但 DEFAULT_CONFIG 里没有 →
  //   改它保存会报「未知参数：genEmotions」。补上真身。
  genEmotions: ['开心', '生气', '难过', '害羞', '无语', '得意', '委屈', '震惊', '摸鱼', '吃饭', '睡觉', '打游戏'],
  voiceImageExclusive: true,     // 同一轮回复里不同时发语音和图片/表情包（避免客户端偶发崩溃）
  genActivities: ['吃饭', '睡觉', '摸鱼', '打游戏', '上班', '加班', '写代码', '喝奶茶', '做饭', '洗澡', '看书', '发呆', '健身', '追剧', '逛街', '起床', '下雨', '夏天', '冬天', '被夸', '被骂', '撒娇', '等消息'],
    genEmotions: ['大笑', '开心', '得意', '无语', '生气', '委屈', '震惊', '困', '馋', '害羞', '认真', '比心', '点赞', '疑惑', '晚安', '摸鱼'],
  genStickerChance: 0.25,        // 需要表情包时，"现场生成"（而非用现成图）的概率
  splitChance: 0.3,              // 拆两条发的概率（真人常分两三条发）
  maxLines: 3,                   // 一条回复最多拆成几条消息
  maxPartsLimit: 8,             // 一条回复最多拆成多少条（15 太多：8 段 × 1.35s ≈ 11s，不刷屏）
  splitHardMax: 40,             // 短文本每段硬上限（以前没显式定义，靠 splitMessage 默认值兜着）
  longBubbleMax: 120,           // 长回答（>240 字）每段放宽到这个字数，避免切成十几条碎气泡
  laterMaxMinutes: 30,          // [稍后:N] 的分钟上限
  // ── 主动找话题 ──────────────────────────────────────────────
  // 群里安静一段时间后，主动冒个泡（真人也会这样，不然就是个"只应答的客服"）
  proactive: true,
  proactiveQuietMs: 1_500_000,   // 群安静超过 25 分钟才考虑主动说话
  proactiveMinGapMs: 3_600_000,  // 同一个群最多每小时主动一次
  proactiveChance: 0.55,         // 每次检查时的触发概率（避免一安静就必说）
  proactiveMaxStreak: 2,         // 连续主动 N 次都没人理就不再主动（有人说话才清零）
  proactiveCheckMs: 300_000,     // 检查间隔 5 分钟
  proactiveHours: '08:00-23:00', // 只在这个时间段主动（配合作息：醒了才冒泡，睡了就安静）

  // ── 朋友圈自动发布（2026-10-26）─────────────────────────────────────────
  // 大肥鱼自己发朋友圈：到点由 LLM 写文案 → 调 hook 的 /Moment/PostSilent 静默发布（不动鼠标/不抢前台）
  momentAuto: false,             // 总开关（默认关，面板里自己开）
  momentMinGapMs: 6 * 3_600_000, // 两条之间最短间隔（默认 6 小时）
  momentMaxGapMs: 12 * 3_600_000,// 两条之间最长间隔（默认 12 小时）—— 实际间隔在区间内随机
  momentDailyMax: 2,             // 每天最多发几条
  momentHours: '09:00-23:00',    // 只在这个时间段发
  momentUseLLM: true,            // true = 由 AI 写文案；false = 从内置句子随机挑
  momentCheckMs: 300_000,        // 检查间隔（5 分钟）
  momentTopic: '写一条日常碎碎念：可以是心情、吃的、天气、刷到的东西、吐槽。短句，40 字以内，口语化，不要加引号，不要提"朋友圈"三个字，不要 @ 任何人。',
  momentNotifyRoom: '',          // 发完在哪个群吱一声（留空 = 不吱声）
  momentAutoImage: false,        // true = 发之前先配一张图
  momentImageSource: 'char',     // 配图来源：char=蓝色大肥鱼本人(i2i) | web=网上随机动漫图 | ai=文生图
  momentImageStyle: '生活感照片，真实质感，自然光，构图干净，竖构图也行；不要任何文字、水印、logo',
  momentImageRatio: '4:3',       // 生图画幅
  // ── 群聊事件触发（2026-10-26）：不是按时间发，而是"群里遇到好玩的事才发" ──
  momentFromChat: false,          // 开关：群聊里遇到值得记的瞬间 → 自己发一条
  momentChatMinScore: 7,          // LLM 打分门槛（1~10，越高越挑剔）
  momentChatLookback: 25,         // 评估时看最近多少条消息
  momentChatDebounceMs: 90_000,   // 群里安静多久后才评估（等对话自然停下，避免打断）
  momentChatCooldownMs: 1_800_000,// 同一个群两次评估的最小间隔（30 分钟）
  momentChatRooms: [],            // 只看这些群（空 = 所有接入的群）
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
const BUILD_VER = '2026-10-23.4'   // 抬版本：让新实例压过热重载残留的旧实例   // 带版本号的实例才允许踢掉旧连接（旧代码没这个字段）
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  // ★ 持久化：把 wechat_bot_config 改过的值存到文件，重载插件后自动读回来。
  //   （以前纯内存，重载/重启 DSH 就全部回落默认，每次都要重设一遍。）
  const CONFIG_FILE = join(dshHome, 'wechat-bot', 'config.json')
  try {
    if (existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {}
      for (const [k, v] of Object.entries(saved)) { if (k in DEFAULT_CONFIG) config[k] = v }
    }
  } catch { /* 文件坏了用默认 */ }

  // 桌宠联动实例（dsh-pet 的蓝色大肥鱼）：装饰层，任何失败都静默
  const pet = createPetBridge({ getConfig: () => config, log })

  // ── 配置的单一写入口（面板 / wechat_bot_config 工具共用）──────────────
  // 以前工具里内联改值，面板再写一套就会漂移；现在统一走这里：
  //   校验 → 应用 → 副作用（安静时段 / 各环节流配置）→ 原子落盘。
  function persistConfig() {
    try {
      mkdirSync(dirname(CONFIG_FILE), { recursive: true })
      const dump = {}
      for (const k of Object.keys(DEFAULT_CONFIG)) dump[k] = config[k]
      const tmp = CONFIG_FILE + '.tmp'
      writeFileSync(tmp, JSON.stringify(dump, null, 1), 'utf8')
      renameSync(tmp, CONFIG_FILE)
    } catch (e) { log('配置持久化失败：' + String(e?.message || e).slice(0, 120)) }
  }

  function normalizeConfigValue(key, raw) {
    if (!(key in DEFAULT_CONFIG)) throw new Error('未知参数：' + key)
    const cur = DEFAULT_CONFIG[key]
    let v
    if (typeof cur === 'number') {
      v = Number(raw)
      if (!Number.isFinite(v)) throw new Error('值不合法（需要数字）：' + raw)
    } else if (typeof cur === 'boolean') {
      v = typeof raw === 'boolean' ? raw : /^(1|true|yes|on|开)$/i.test(String(raw))
    } else if (Array.isArray(cur)) {
      v = Array.isArray(raw)
        ? raw.map((s) => String(s).trim()).filter(Boolean)
        : String(raw).split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    } else if (cur && typeof cur === 'object') {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('值不合法（需要对象）')
      v = raw
    } else {
      v = String(raw)
    }
    const m = CONFIG_META[key]
    if (m) {
      if (m.type === 'number' && Number.isFinite(v)) {
        if (m.min != null && v < m.min) throw new Error((m.label || key) + ' 不能小于 ' + m.min)
        if (m.max != null && v > m.max) throw new Error((m.label || key) + ' 不能大于 ' + m.max)
      }
      if (m.type === 'enum' && Array.isArray(m.options) && !m.options.includes(v)) {
        throw new Error((m.label || key) + ' 只能是：' + m.options.filter((x) => x !== '').join(' / '))
      }
      if (m.type === 'quiet' && v) {
        const parts = String(v).split(',').map((s) => s.trim()).filter(Boolean)
        for (const p of parts) {
          if (!/^([01]?\d|2[0-3]):[0-5]\d\s*-\s*([01]?\d|2[0-3]):[0-5]\d$/.test(p)) {
            throw new Error((m.label || key) + ' 格式应为 23:00-08:00（多个时段用逗号分隔）')
          }
        }
      }
    }
    return v
  }

  // ══════════════════════════════════════════════════════════════════════
  //  TTS 服务（GPT-SoVITS api_v2.py）控制面
  //
  //  ★ 2026-10-27 事故复盘（重要）：
  //    第一版用了 execSync + while 轮询等进程退出 —— **同步阻塞 DSH 主线程**。
  //    点一次「重启」就把宿主卡住十几秒，面板全站无响应、DSH 像死了一样，
  //    只能重启 DSH。这里全部改成异步（exec/spawn + await sleep），
  //    并且「启动/重启」**立即返回**，由面板轮询状态看进度，不再让请求吊着。
  //
  //  规范（写进 R18）：插件不能在自己进程里跑阻塞式外部命令 —— 它和 DSH 共用事件循环。
  // ══════════════════════════════════════════════════════════════════════
  const TTS_API = () => process.env.GPT_SOVITS_API || 'http://127.0.0.1:9880/tts'
  const TTS_PORT = () => { try { return Number(new URL(TTS_API()).port) || 9880 } catch { return 9880 } }
  const TTS_REF = () => process.env.GPT_SOVITS_REF
    || 'D:/微信deepseek/data/sexy-loli-cn/separated/htdemucs/【中文音声】许久未见的雌小鬼，向你表达爱意/cn-a.wav'
  const TTS_PROMPT = () => process.env.GPT_SOVITS_PROMPT
    || '就像是一根被流酸泡过的麻辣秋衣一样这么久不见，大哥哥有没有想我呀'

  // 最近一次操作的结论（面板上要能看到"成功/失败"，不能只有转圈）
  const ttsLast = {
    action: '', at: 0, ok: null, msg: '',
    testAt: 0, testOk: null, testMsg: '',
  }

  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

  /** 异步跑一条命令，拿 stdout（不阻塞事件循环）*/
  function runAsync(cmd, opts = {}) {
    return new Promise((resolve) => {
      try {
        execCb(cmd, { windowsHide: true, timeout: 20000, ...opts }, (err, stdout) => {
          resolve({ ok: !err, stdout: String(stdout || ''), error: err ? String(err.message || err) : '' })
        })
      } catch (e) { resolve({ ok: false, stdout: '', error: String(e?.message || e) }) }
    })
  }

  /**
   * 找出所有跑 api_v2.py 的 python 进程（异步）。
   * wmic 在新版 Windows 已被移除 → 拿不到就用 PowerShell 兜底，否则状态会永远显示"未运行"。
   */
  async function ttsPids() {
    const byWmic = await runAsync('wmic process where "name=\'python.exe\' and commandline like \'%api_v2%\'" get processid /format:list')
    const ids = (byWmic.stdout.match(/ProcessId=(\d+)/g) || []).map((x) => Number(x.split('=')[1])).filter(Boolean)
    if (ids.length || /api_v2/i.test(byWmic.stdout)) return ids
    const ps = await runAsync(
      'powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command '
      + '"Get-CimInstance Win32_Process -Filter \\"Name=\'python.exe\'\\" | Where-Object { $_.CommandLine -like \'*api_v2*\' } | ForEach-Object { $_.ProcessId }"')
    return (ps.stdout.match(/\d+/g) || []).map(Number).filter((n) => n > 100)
  }

  /** 端口是否有 TCP 应答（比 fetch 快、且不受 HTTP 状态影响）*/
  function tcpProbe(port, timeoutMs = 1200) {
    return new Promise((resolve) => {
      let done = false
      const sock = new net.Socket()
      const finish = (v) => { if (done) return; done = true; try { sock.destroy() } catch { /* ignore */ } resolve(v) }
      sock.setTimeout(timeoutMs)
      sock.once('connect', () => finish(true))
      sock.once('timeout', () => finish(false))
      sock.once('error', () => finish(false))
      try { sock.connect(port, '127.0.0.1') } catch { finish(false) }
    })
  }

  /** 从 api_v2 的启动日志里读"当前加载的 VITS 权重" —— 音色是它决定的，必须可见 */
  function ttsVitsFromLog() {
    try {
      const f = join(dirname(memoryDir), 'logs', 'tts-api.log')
      if (!existsSync(f)) return null
      const txt = readFileSync(f, 'utf8')
      const lines = txt.split('\n').filter((l) => /Loading VITS weights from/i.test(l))
      const last = lines[lines.length - 1]
      if (!last) return null
      const m = last.match(/Loading VITS weights from\s+(.+?)\.\s*(?:<|$)/i)
      const full = (m ? m[1] : '').trim()
      if (!full) return null
      const name = full.split(/[\\/]/).pop() || full
      return { path: full, name }
    } catch { return null }
  }

  async function ttsStatus() {
    const [pids, portAlive] = await Promise.all([ttsPids(), tcpProbe(TTS_PORT())])
    const running = pids.length > 0
    // 语义化状态，面板直接显示这一句就够
    let state = 'stopped'
    if (running && portAlive) state = 'ready'          // 进程在 + 端口通 = 可用
    else if (running) state = 'loading'                // 进程在但端口没起（加载中/加载失败）
    else if (portAlive) state = 'stray'                // 端口通但没找到进程（别的进程占着/名字不匹配）
    return {
      ok: true,
      state,
      running, pids, port: TTS_PORT(), portAlive,
      configOn: config.voiceModelOn !== false,
      api: TTS_API(),
      vits: ttsVitsFromLog(),      // 当前音色模型（名字+路径）；换音色一眼可见
      last: { ...ttsLast },
    }
  }

  /** 真的合成一句（短），把服务端原文错误带回来 —— "坏没坏"的唯一可靠判据 */
  async function ttsTest(text) {
    const body = {
      text: String(text || '测试').slice(0, 20),
      text_lang: 'zh',
      ref_audio_path: TTS_REF(),
      prompt_lang: 'zh',
      prompt_text: TTS_PROMPT(),
      text_split_method: 'cut5',
      batch_size: 1,
      media_type: 'wav',
    }
    const t0 = Date.now()
    try {
      const r = await fetch(TTS_API(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      })
      const ms = Date.now() - t0
      if (!r.ok) {
        let detail = ''
        try { detail = (await r.text()).slice(0, 300) } catch { /* ignore */ }
        ttsLast.testAt = Date.now(); ttsLast.testOk = false; ttsLast.testMsg = 'HTTP ' + r.status + ' ' + (detail || '')
        return { ok: false, http: r.status, ms, error: detail || ('HTTP ' + r.status) }
      }
      const buf = Buffer.from(await r.arrayBuffer())
      const isWav = buf.length > 4 && buf.slice(0, 4).toString('latin1') === 'RIFF'
      ttsLast.testAt = Date.now(); ttsLast.testOk = isWav
      ttsLast.testMsg = isWav ? (buf.length + ' 字节 / ' + ms + 'ms') : '返回的不是 WAV'
      return { ok: isWav, ms, bytes: buf.length, error: isWav ? '' : '返回的不是 WAV（前 4 字节不匹配）' }
    } catch (e) {
      ttsLast.testAt = Date.now(); ttsLast.testOk = false
      ttsLast.testMsg = String(e?.message || e).slice(0, 200)
      return { ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 200) }
    }
  }

  /**
   * 启动（立即返回，不等待模型加载）。
   * ★ 把服务端 stdout/stderr 落到 data\logs\tts-api.log —— 上次"进程活着但合成全 400"
   *   就是因为 stdio 丢掉，看不到 traceback，只能靠猜。
   */
  function ttsSpawn() {
    const logDir = join(dirname(memoryDir), 'logs')
    try { mkdirSync(logDir, { recursive: true }) } catch { /* ignore */ }
    const outLog = join(logDir, 'tts-api.log')
    const errLog = join(logDir, 'tts-api.log.err')
    try {
      const out = openSync(outLog, 'a')
      const err = openSync(errLog, 'a')
      const child = spawnCb(
        'D:\\Python311\\python.exe',
        ['D:\\微信deepseek\\data\\GPT-SoVITS\\api_v2.py'],
        {
          cwd: 'D:\\微信deepseek\\data\\GPT-SoVITS',
          detached: true,
          windowsHide: true,
          stdio: ['ignore', out, err],
        },
      )
      child.on('exit', (code) => { try { closeSync(out); closeSync(err) } catch { /* ignore */ } ; log('TTs api_v2 退出，code=' + code + '（看 data\\logs\\tts-api.log.err）') })
      child.unref()
      log('TTS api_v2 已启动（日志 → ' + outLog + '）')
      return { ok: true, log: outLog }
    } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 160) } }
  }

  /** 停：杀进程并等它真的消失（异步，最多 8 秒）*/
  async function ttsKillAll() {
    const pids = await ttsPids()
    if (!pids.length) return { killed: 0 }
    await Promise.all(pids.map((pid) => runAsync('taskkill /PID ' + pid + ' /F')))
    const until = Date.now() + 8000
    while (Date.now() < until) {
      if (!(await ttsPids()).length) break
      await sleepMs(400)
    }
    return { killed: pids.length, left: (await ttsPids()).length }
  }

  /**
   * 控制入口。start/restart **立即返回**（不吊着 HTTP 请求），
   * 面板用 ttsStatus 轮询看进度 —— 这样点完按钮马上有反馈，DSH 也不会卡。
   */
  async function ttsControl(action) {
    const act = String(action || 'status')
    if (!['status', 'start', 'stop', 'restart'].includes(act)) {
      return { ok: false, error: 'action 只能是 status / start / stop / restart' }
    }
    if (act === 'status') return await ttsStatus()

    const notes = []
    if (act === 'stop' || act === 'restart') {
      const k = await ttsKillAll()
      notes.push(k.killed ? ('已停止 ' + k.killed + ' 个进程' + (k.left ? '（仍有 ' + k.left + ' 个未退出）' : '')) : '本来就没在跑')
    }
    if (act === 'start' || act === 'restart') {
      const r = ttsSpawn()
      notes.push(r.ok ? '已发出启动命令（模型加载 10~40 秒）' : ('启动失败：' + r.error))
    }
    // 记录"用户意图"，下次开机按这个恢复
    try {
      config.voiceModelOn = (act !== 'stop')
      persistConfig()
    } catch { /* ignore */ }

    ttsLast.action = act
    ttsLast.at = Date.now()
    ttsLast.ok = null                       // 结果未知：交给面板轮询状态判断
    ttsLast.msg = notes.join('；')
    return { ok: true, action: act, notes, pending: (act !== 'stop'), state: 'pending' }
  }

  /** 语音模型启停（voiceModelOn）：true=启动 api_v2（常驻），false=杀 api_v2（省 GPU） */
  function applyModelSwitch(on) {
    // ★ 2026-10-27：改成全异步（原来 execSync 会阻塞 DSH 主线程，点一下整机卡住）。
    //   这里 fire-and-forget，结果看面板的 TTS 状态卡片。
    void (async () => {
      try {
        if (on) {
          if ((await ttsPids()).length) { log('语音模型：api_v2 已在跑'); return }
          const r = ttsSpawn()
          log(r.ok ? '语音模型：api_v2 已启动（常驻）' : ('语音模型：启动失败 ' + r.error))
        } else {
          const k = await ttsKillAll()
          if (k.killed) log('语音模型：已关闭 api_v2（释放 GPU，停了 ' + k.killed + ' 个）')
        }
      } catch (e) { log('语音模型启停异常：' + String(e?.message || e).slice(0, 160)) }
    })()
  }

  /** 批量应用配置：要么全部通过校验再写，要么一条都不改。 */
  function applyConfigPatch(patch) {
    const applied = []
    const rejected = []
    const warnings = []
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, applied, rejected: [{ key: '*', reason: 'patch 必须是对象' }], warnings }
    }
    const next = {}
    for (const [k, raw] of Object.entries(patch)) {
      try { next[k] = normalizeConfigValue(k, raw) } catch (e) { rejected.push({ key: k, reason: String(e?.message || e) }) }
    }
    // 全部合法才落：避免一半新一半旧（面板一次改多个字段时尤其重要）
    if (rejected.length) return { ok: false, applied, rejected, warnings }

    const quietNext = next.quietHours !== undefined ? parseQuietWindows(next.quietHours) : null
    for (const [k, v] of Object.entries(next)) {
      config[k] = v
      applied.push({ key: k, value: v })
      if (k === 'quietHours' && quietNext) { quietWindows.length = 0; quietWindows.push(...quietNext) }
    }
    // ★ 2026-10-28 事故：这里原来是 `r.policy.cfg = config`，
    //   而"全局内心/记忆"用了一个合成的 _global 房间（没有 policy 字段），
    //   于是**任何一次面板保存配置都会在这里抛 TypeError**：
    //     Cannot set properties of undefined (setting 'cfg')
    //   → /config 返回 500、改动不落盘。加防御 + 用 try 包住，别让一行影响整体保存。
    try {
      for (const r of rooms.values()) {
        if (r && r.policy && typeof r.policy === 'object') r.policy.cfg = config
      }
    } catch { /* 单个房间异常不能拖垮配置保存 */ }
    // voiceModelOn 变化 → 真正启停 api_v2
    //  ★ 原来这里是 `catch { /* ignore */ }`，把 ReferenceError 全吞了，
    //    导致「开关开着但模型没起」这种问题被隐藏了几个月。现在记日志。
    if (next.voiceModelOn !== undefined) {
      // ★ 2026-10-27：voiceModelOn 现在只表示"开机自启"这个意图。
      //   勾上 → 顺手把服务拉起来（方便）；取消勾选 → **不杀**正在跑的服务
      //   （要停就点面板的「停止」，避免"我只是不想自启，结果服务被杀了"）。
      if (next.voiceModelOn) {
        void (async () => { try { if (!(await ttsPids()).length) ttsSpawn() } catch { /* ignore */ } })()
      } else {
        log('语音模型：已取消"开机自启"（当前进程不动，要停请点面板「停止」）')
      }
    }

    // 朋友圈参数一变就重新排期 —— 否则用户把间隔调短了，还要等旧的 nextAt 到点才生效
    if (Object.keys(next).some((k) => k.startsWith('moment'))) {
      try {
        if (next.momentAuto === false) {
          momentState.nextAt = 0
        } else {
          planNextMoment(Date.now())
          log(`朋友圈：参数已更新，下次约 ${Math.round(((momentState.nextAt - Date.now()) / 3600000) * 10) / 10} 小时后`)
        }
        saveMomentState()
      } catch (e) { log('朋友圈重新排期失败：' + String(e?.message || e)) }
    }
    if (applied.length) {
      persistConfig()
      log('配置变更：' + applied.map((x) => x.key + '=' + JSON.stringify(x.value)).join('，'))
    }
    return { ok: true, applied, rejected, warnings }
  }

    // 日志文件名故意不叫 'dsh-wechat-bot.log'：那个名字和 super-injector 自己的日志撞了
  // （injector 写在 <DSH_HOME>/data/super-injector/，插件也写这儿，两个文件同名不同内容，
  //  排查时极易看错）。改叫 wechat-bot-plugin.log，一眼能分清谁是谁。
  const logFile = config.logFile || join(dshHome, 'super-injector', 'wechat-bot-plugin.log')
  const memoryDir = config.memoryDir || join(dshHome, 'wechat-bot', 'memory')

  // tar 的绝对路径（Windows 10+ 自带 bsdtar）。用绝对路径是因为：
  //   · 插件进程的 PATH 不一定含 C:\Windows\System32
  //   · powershell 的 Expand-Archive 在 -NoProfile 下模块加载不稳定（实测报「找不到 Microsoft.PowerShell.Archive」）
  const TAR_EXE = process.env.WECHAT_TAR || 'C:\\Windows\\System32\\tar.exe'
  // 校验 DLL 是否含某能力用的标识。用 hex 存放：功能需要，但不在公开代码里出现明文函数名。
  const DLL_NEEDLE_MAIN = Buffer.from('5374617274433243446f776e6c6f6164', 'hex').toString('latin1')
  const DLL_NEEDLE_VIDEO = Buffer.from('6864766964656f', 'hex').toString('latin1')
// 群成员名字映射（wxid → 昵称）：hook 拿不到联系人库，靠自动学习 + 手动设置
const namesFile = join(dirname(memoryDir), 'members.json')
  try { mkdirSync(memoryDir, { recursive: true }) } catch { /* ignore */ }

  const quietWindows = parseQuietWindows(config.quietHours)
  const stats = {
    msgIn: 0, replied: 0, skipped: 0, llmCalls: 0, llmErrors: 0,
    sentText: 0, sentSticker: 0, sentPat: 0, startedAt: Date.now(),
  }
  /** roomId -> 群状态 */
  // ── token 用量统计（2026-10-22）────────────────────────────────────
  //   为什么单独存：面板要显示"花了多少 token"，而 stats 里的 llmCalls 只是次数。
  //   数据来源：DSH 的 LLM 流里 type==='usage' 的 chunk（每次调用都带）。
  //   持久化到 config 同目录的 usage.json，跨插件重载/重启累计。
  const usageFile = join(dirname(memoryDir), 'usage.json')
  const usageStats = {
    prompt: 0, completion: 0, total: 0, calls: 0,
    byModel: {}, byDay: {}, startedAt: Date.now(),
  }
  try {
    const u = JSON.parse(readFileSync(usageFile, 'utf8')) || {}
    usageStats.prompt = Number(u.prompt) || 0
    usageStats.completion = Number(u.completion) || 0
    usageStats.total = Number(u.total) || 0
    usageStats.calls = Number(u.calls) || 0
    usageStats.byModel = u.byModel || {}
    usageStats.byDay = u.byDay || {}
    usageStats.startedAt = u.startedAt || Date.now()
  } catch { /* 首次运行 */ }
  let usageSaveTimer = null
  function saveUsageSoon() {
    if (usageSaveTimer) return
    usageSaveTimer = setTimeout(() => {
      usageSaveTimer = null
      try { writeFileSync(usageFile, JSON.stringify(usageStats, null, 1), 'utf8') } catch { /* ignore */ }
    }, 1500)
  }
  /** 记一次 LLM 调用的 token 用量（兼容多种 field 名）*/
  function recordUsage(usage, model) {
    if (!usage || typeof usage !== 'object') return
    const p = Number(usage.inputTokens ?? usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0
    const c = Number(usage.outputTokens ?? usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens ?? 0) || 0
    let t = Number(usage.totalTokens ?? usage.total_tokens ?? 0) || 0
    if (!t) t = p + c
    if (!p && !c && !t) return
    usageStats.prompt += p
    usageStats.completion += c
    usageStats.total += t
    usageStats.calls += 1
    const day = new Date().toISOString().slice(0, 10)
    const mdl = String(model || 'unknown')
    for (const [bucket, key] of [[usageStats.byDay, day], [usageStats.byModel, mdl]]) {
      const cur = bucket[key] || { prompt: 0, completion: 0, total: 0, calls: 0 }
      cur.prompt += p; cur.completion += c; cur.total += t; cur.calls += 1
      bucket[key] = cur
    }
    // 只保留最近 30 天，避免文件无限增长
    const days = Object.keys(usageStats.byDay).sort()
    while (days.length > 30) delete usageStats.byDay[days.shift()]
    saveUsageSoon()
  }
  const rooms = new Map()
  const timers = new Set()
  let lastRoute = null
  // ★ 2026-10-28 修：llm/stream 是 DSH 的全局事件，**DSH 主对话自己调模型也会触发**。
  //   之前无条件记录，导致面板"上次调用"显示的是 DSH 主对话的模型（比如 opencodego-extra），
  //   而不是大肥鱼实际用的模型。现在只在本插件发起调用时（callDepth > 0）才记录。
  let pluginLlmDepth = 0
    // ★ 只记「非视觉模型」的那次调用 —— 识图/读视频帧会走 visionModel，
    //   不能让它污染文本路由（否则挑视频/写评论会拿到视觉模型，
    //   报 UNSUPPORTED_REASONING_EFFORT 直接空回复，实测 2026-10-20 13:06）。
    let lastTextRoute = null
  let stopped = false

  // 日志轮转：超过 5MB 就滚一份，最多留 3 份（plugin.log.1 ~ .3，更老的删掉）。
  // 为什么必须做：这个文件之前无上限增长，历史上有过 370MB 的桥日志没人管。
  const LOG_MAX_BYTES = 5 * 1024 * 1024
  const LOG_KEEP = 3
  let logBytes = -1               // -1 = 还没测过；第一次写日志时 stat 一次真实大小
  function rotateLogIfNeeded() {
    try {
      if (logBytes < 0) {
        try { logBytes = statSync(logFile).size } catch { logBytes = 0 }
      }
      if (logBytes < LOG_MAX_BYTES) return
      for (let i = LOG_KEEP; i >= 1; i--) {
        const src = i === 1 ? logFile : logFile + '.' + (i - 1)
        const dst = logFile + '.' + i
        try {
          if (!existsSync(src)) continue
          if (i === LOG_KEEP && existsSync(dst)) unlinkSync(dst)   // 最老的那份丢掉
          renameSync(src, dst)
        } catch { /* 单个失败不影响继续 */ }
      }
      logBytes = 0
    } catch { /* ignore */ }
  }

  // ── 取证日志：崩溃/断线前 60 秒做了什么（只写文件，不影响流程）────────
  let fLogPath = ''
  function fMark(cat, detail) {
    try {
      if (!fLogPath) {
        const d = join(dirname(memoryDir), 'logs')
        mkdirSync(d, { recursive: true })
        fLogPath = join(d, 'forensics.log')
      }
      const text = String(typeof detail === 'string' ? detail : JSON.stringify(detail || {})).replace(/[\r\n]+/g, ' ').slice(0, 400)
      appendFileSync(fLogPath, new Date().toISOString() + '\t' + cat + '\t' + text + '\n')
    } catch { /* ignore */ }
  }
  function log(...args) {
    const line = '[' + new Date().toISOString() + '] ' + args.map(String).join(' ')
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      rotateLogIfNeeded()
      appendFileSync(logFile, line + '\n')
      logBytes += Buffer.byteLength(line, 'utf8') + 1
    } catch { /* ignore */ }
    try { ctx.logger?.info?.(`[${SHORT}] ` + args.map(String).join(' ')) } catch { /* ignore */ }
  }

  const track = (t) => { timers.add(t); return t }
  const untrack = (t) => { timers.delete(t); clearTimeout(t) }

  // 观察主模型路由（waterfall 必须 next() 委托，否则会掐断主流程）
  ctx.on('llm/stream', (options, next) => {
    if (pluginLlmDepth > 0 && options?.provider && options?.model) {
        lastRoute = { provider: options.provider, model: options.model }
        if (!config.visionModel || options.model !== config.visionModel) {
          lastTextRoute = { provider: options.provider, model: options.model }
        }
      }
    return next()
  })

  // ── 群名 / 人名缓存（微信 4.x 的 contact.db 经常被卸载/句柄失效，用 contact_fts.db 兜底）──
  // 背景：桥侧 rooms() 早期只能返回 roomId，消息里 senderName 也只能拿到 wxid。
  // 群名和联系人昵称都在 contact_fts_v5_content.c0（\b 分隔），
  // 用 name2id.rowid ↔ username 对上即可；这段查询只读、慢一点也无妨。
  const HOOK_API_BASE = process.env.WECHAT_HOOK_API || 'http://127.0.0.1:30001'
  const roomNameCache = new Map()
  const contactNameCache = new Map()
  let namesAt = 0
  let namesFailAt = 0
  let namesLogged = ''

  async function refreshNameCaches(force = false) {
    // force=true：跳过 2 分钟 / 60 秒的节流（面板「刷新名字缓存」用，用户点了就得真去查）
    if (!force) {
      if ((roomNameCache.size || contactNameCache.size) && Date.now() - namesAt < 2 * 60_000) return roomNameCache
      if (namesFailAt && Date.now() - namesFailAt < 60_000) return roomNameCache
    }
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('名字查询超时')), 8000)
      let res
      try {
        res = await fetch(HOOK_API_BASE + '/QueryDB/execute', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            optDbName: 'contact_fts.db',
            SQL: 'SELECT n.username AS id, c.c0 AS name FROM name2id n JOIN contact_fts_v5_content c ON c.id = n.rowid',
          }),
          signal: ac.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      const j = await res.json()
      let addedRooms = 0
      let addedPeople = 0
      for (const row of Array.isArray(j?.data) ? j.data : []) {
        const id = String(row.id || '')
        if (!id) continue
        const parts = String(row.name || '').split(/\u0008+/).map((s) => s.trim()).filter(Boolean)
        const name = parts[0] || ''
        if (!name) continue
        if (id.endsWith('@chatroom')) {
          if (roomNameCache.get(id) !== name) addedRooms++
          roomNameCache.set(id, name)
        } else if (!id.endsWith('@openim')) {
          if (contactNameCache.get(id) !== name) addedPeople++
          contactNameCache.set(id, name)
        }
      }
      if (roomNameCache.size || contactNameCache.size) namesAt = Date.now()
      // 已经建出来的群状态 / 历史消息也同步改名（否则要等下一条消息才更新）
      for (const r of rooms.values()) {
        const rn = roomNameCache.get(r.roomId)
        if (rn && r.roomName !== rn) r.roomName = rn
        for (const m of r.msgs) {
          if (m.isSelf || !m.sender) continue
          const n = contactNameCache.get(m.sender) || (config.memberNames || {})[m.sender]
          if (n) m.senderName = n
        }
      }
      const sig = `${roomNameCache.size}/${contactNameCache.size}`
      if (sig !== namesLogged) {
        namesLogged = sig
        log(`名字缓存：群 ${roomNameCache.size} 个 / 人 ${contactNameCache.size} 个（contact_fts.db，本次 +${addedRooms}/+${addedPeople}）`)
      }
    } catch (e) {
      namesFailAt = Date.now()
      log('名字读取失败（暂用 roomId/wxid）：' + String(e?.message || e).slice(0, 120))
    }
    return roomNameCache
  }

  // ── 群状态与记忆 ────────────────────────────────────────────
  function roomState(roomId, roomName) {    let r = rooms.get(roomId)
    if (r) {
      // 消息事件里的 roomName 往往就是 roomId；别用 id 覆盖已经查到的真群名
      if (roomName && !String(roomName).endsWith('@chatroom')) r.roomName = roomName
      else if (roomNameCache.get(roomId)) r.roomName = roomNameCache.get(roomId)
      return r
    }
    const cachedName = roomNameCache.get(roomId)
    const display = (roomName && !String(roomName).endsWith('@chatroom'))
      ? roomName
      : (cachedName || roomName || roomId)
    r = {
      roomId,
      roomName: display,
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
      // 旧记忆文件里存的 roomName 可能还是 roomId；别用它覆盖刚查到的真群名
      const cur = String(r.roomName || '')
      if (raw?.roomName && (!cur || cur.endsWith('@chatroom'))) r.roomName = raw.roomName
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

    /**
     * 清洗消息正文：桥侧对某些类型（表情/图片/语音…）给的是**原始 XML**，
     * 有时还带 "wxid_xxx:\n" 前缀。直接塞进上下文会让模型看到一堆 <msg><emoji…>。
     * 这里统一转成人类可读的占位符。
     */
    function sanitizeText(raw) {
      let s = String(raw || '')
      // 去掉 "wxid_xxx:\n" / "123@chatroom:\n" 这种发送者前缀
      s = s.replace(/^[A-Za-z0-9_@.\-]{3,}:\s*\r?\n/, '')
      if (/<emoji\b/i.test(s)) return '[表情包]'
      if (/<img\b|<img\s/i.test(s)) return '[图片]'
      if (/<voicemsg\b|<voice\b/i.test(s)) return '[语音]'
      if (/<videomsg\b/i.test(s)) return '[视频]'
      if (/<appmsg\b/i.test(s)) return '[链接/卡片]'
      if (/<sysmsg\b/i.test(s)) return '[系统消息]'
      if (/<msg\b/i.test(s)) return '[消息]'
      return s
    }
  function push(r, m) {
    // 有人说话 → 清零"主动没人理"的计数（用户要求：没人回就别继续主动说）
    if (!m.isSelf) r.proactiveStreak = 0
    // 带上 msgid：视频"延迟复查"升级内容时要能找回**这一条**的上下文副本（r.msgs 里是拷贝）
    const senderName = m.isSelf ? (m.senderName || '我') : nameOf(m.sender, m.senderName)
    // ★ 入账文本统一走 textForLlm()：图片/表情/视频/语音的 m.text 是**原始 XML**，
    //   以前直接存进记忆 → 上下文和面板历史里会看到 <msg><img ...> 这种鬼东西。
    //   textForLlm 会给出 [图片]/[表情包]/[视频]/[语音] 或识别描述。
    const text = (typeof m.textForLlm === 'function')
      ? String(m.textForLlm() ?? '')
      : sanitizeText(m.text)
    const ts = m.ts || Date.now()

    // ★ 2026-10-22 修：自己发的消息会被**记两次**，面板因此显示两遍。
    //   ① 发送成功后本地 push（isSelf:true，id 为空，ts=Date.now()）
    //   ② 桥轮询从数据库把同一条读回来（isSelf:true，带真实 msgid，ts 差 1~3 秒）
    //   两条都进 r.msgs → 上下文里"我说了两遍"、面板也显示两遍。
    //
    //   去重分两层：
    //     a) 有 msgid → 按 msgid 精确去重（最可靠）
    //     b) 没 msgid 是自己发的 → 找"最近 8 条里、id 为空、文本相同、时间差 ≤15 秒"的那条，
    //        把 msgid 和更准的时间补进去，**不重复入账**
    if (m.id) {
      const lo = Math.max(0, r.msgs.length - 10)
      for (let i = r.msgs.length - 1; i >= lo; i--) {
        if (r.msgs[i].id === m.id) return       // 这条已经记过了
      }
    }
    if (m.isSelf && text) {
      const lo = Math.max(0, r.msgs.length - 8)
      for (let i = r.msgs.length - 1; i >= lo; i--) {
        const p = r.msgs[i]
        if (!p.isSelf || p.id) continue         // 只合并"本地那条还没 id"的记录
        if (String(p.text || '') !== text) continue
        if (Math.abs((p.ts || 0) - ts) > 15000) continue
        p.id = m.id || ''                       // 补上真实 msgid（视频复查要用）
        p.ts = ts                               // 用数据库的时间（更准）
        return                                  // 合并完成，不重复入账
      }
    }

    r.msgs.push({ id: m.id || '', ts, isSelf: !!m.isSelf, sender: m.sender, senderName, text: m.text })
    // 性格：每条消息都过一遍状态机（心情/精力/亲密度/目标进度）
    // ⑥ 羁绊计数：相识时间 + 累计互动条数（bondLevel 用这两个维度）
    try {
      const stB = personaOf(r)
      // 先把"最早记忆时间 / 已有记忆条数"迁进来（否则今天才开始算 → 显示"陌生人"）
      let next = H3.ensureBondBasis(stB, r.facts || [], Date.now())
      next = { ...next, totalMsgs: (Number(next.totalMsgs) || 0) + 1 }
      savePersona(r, next)
    } catch { }
    try { personaOnMessage(r, m) } catch { /* 性格坏不影响对话 */ }
    try { applySingleLove(r) } catch { /* 独占钳制失败不影响对话 */ }
    // ④ 结束语义 → 写一条收尾记录；「忘掉」→ 删记忆
    try { handleWrapSignals(r, m) } catch { /* 不影响主流程 */ }

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

  // ── 桥连上微信 → 自动打开控制面板 ─────────────────────────────
  // 用户要求：「桥开了自动打开面板」。
  // 为什么放插件里而不是桥里：桥不知道 DSH 的端口（那是 dsh web --port N 的参数），
  // 而插件自己就跑在 DSH 进程里，至少知道面板挂在 /wechat-bot 这个路径上。
  // 地址优先级：config.panelUrl > config.panelHost / 面板学到的 host > 默认 127.0.0.1:3080
  let panelAutoOpened = false
  let panelHostSeen = ''
  /** 面板每次收到请求时把自己的 host 报回来，这样端口不是 3080 也能猜对 */
  function notePanelHost(host) {
    const h = String(host || '').trim()
    if (h && h !== panelHostSeen) {
      panelHostSeen = h
      // 打一条日志，方便验证「端口不是 3080 时能不能自愈」这条链路
      log('面板 host 已记录：' + h + '（下次自动打开面板会用它）')
    }
  }
  async function maybeOpenPanel() {
    if (panelAutoOpened) return
    if (config.autoOpenPanel === false) return
    panelAutoOpened = true
    let url = String(config.panelUrl || '').trim()
    if (!url) {
      const host = String(config.panelHost || panelHostSeen || '').trim()
      url = host
        ? ('http://' + host + '/wechat-bot')
        : ('http://127.0.0.1:' + (Number(config.panelPort) || 3080) + '/wechat-bot')
    }
    log('自动打开控制面板：' + url)
    try {
      const { execFile } = await import('node:child_process')
      // Windows 的 start 要把 URL 当第三个参数（第二个是窗口标题，传空字符串占位）
      const isWin = process.platform === 'win32'
      execFile(isWin ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open'),
        isWin ? ['/c', 'start', '', url] : [url],
        { windowsHide: true }, () => {})
    } catch (e) { log('打开面板失败：' + String(e?.message || e)) }
  }

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
        // 插件后起来时桥可能早就登录了（没有 login 事件）→ 这里补一次
        if (evt.status?.loggedIn) void maybeOpenPanel().catch(() => {})
        break
      case 'login': {
        log('微信登录成功 self=' + evt.self)
        if (evt.self) bridgeSelf = evt.self
        // ★ 2026-10-28：客户端重启后桥会进"硬闸"（hardStopped）—— 那是为了防野指针崩微信，
        //   但以前只能人工调 /api/pollResume。登录成功 = 新句柄已就绪，此时放闸是安全的。
        void (async () => {
          try {
            const ps = await client.call('pollStatus', {}, 6000)
            if (ps && (ps.hardStopped || ps.paused)) {
              log(`检测到桥在${ps.hardStopped ? '硬闸' : '暂停'}中，但微信已登录 → 自动放闸恢复轮询`)
              await client.call('pollResume', {}, 15000)
              log('自动放闸完成（轮询应立即恢复）')
            }
          } catch (e) { log('自动放闸失败（可手动点诊断页的"恢复轮询"）：' + String(e?.message || e).slice(0, 100)) }
        })()
        // 桥连上微信 → 自动打开控制面板（用户要求「桥开了自动打开面板」）
        void maybeOpenPanel().catch(() => {})
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
        // ★ 2026-10-28：原来没有任何限流 —— 客户端退出后 75 秒内连发 7 次、全是
        //   "wake 失败：fetch failed"（桥已经禁发），既没用又在给客户端加负担。
        //   两道闸：① 桥在硬闸/暂停中就别发（发了也白发）② 最多 3 次/10 分钟
        void (async () => {
          try {
            try {
              const ps = await client.call('pollStatus', {}, 5000)
              if (ps && (ps.hardStopped || ps.paused)) {
                log('wake 跳过：桥处于硬闸/暂停中（此时发消息也送不出去）')
                return
              }
            } catch { /* 拿不到状态就继续按限流走 */ }
            wakeTimes = wakeTimes.filter((t) => Date.now() - t < 10 * 60_000)
            if (wakeTimes.length >= 3) {
              log('wake 跳过：10 分钟内已唤醒 ' + wakeTimes.length + ' 次（上限 3）')
              return
            }
            wakeTimes.push(Date.now())
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
    fMark('msg', { room: m.roomId, from: m.senderName || m.sender || '', type: m.typeName || m.type || '', text: String(m.text || '').slice(0, 50), id: m.id || '' })
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

    // 桌宠：群里有人说话 → 她先"看过来"（表情动作）
    //   限频在 pet-bridge 里（默认 2s），连发多条不会疯狂抽搐
    void pet.anim(config.petSyncAnimOnReceive)

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
            fps: config.videoFps === undefined ? 1 : Number(config.videoFps),
          }, 300_000)
          : await client.call('fetchMedia', { xml: m.xml || '', type: m.type, roomId: m.roomId || '', ts: m.ts || 0 }, 90_000)
        if (media?.file) {
          const kind = !isVideo ? 'image' : (media.kind === 'video' ? 'videoSheet' : 'videoCover')
          // ★ 视频可能有多张联系表（每秒 1 帧，每 20 帧一张）→ 逐张识别后汇总
          const sheets = isVideo && Array.isArray(media.sheets) ? media.sheets.filter(Boolean) : []
          let desc = ''
          if (sheets.length > 1) {
            const parts = []
            for (let si = 0; si < sheets.length; si++) {
              const d = await describeImageCached(sheets[si], 'videoSheet')
              if (d) parts.push('【第' + (si + 1) + '/' + sheets.length + '段】' + d)
            }
            desc = parts.join('\n')
            log('视频分段识别：' + sheets.length + ' 张联系表，成功 ' + parts.length + ' 张')
          } else {
            // 带缓存：同一张（联系表/封面/图片）只识别一次
            desc = await describeImageCached(media.file, kind)
          }
          // ★ 表情包收藏后，把识图得到的描述回写成标签 —— 以后才能按语境挑到它
          if (m.typeName === 'emoticon' && desc) {
            try {
              const tg = await client.call('tagSticker', { file: media.file, text: desc }, 15_000)
              if (tg?.ok) log(`表情包已打标签：${tg.id}（${tg.count} 个标签）`)
            } catch { /* 打标签失败不影响主流程 */ }
          }
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
            for (const s of (isVideo && Array.isArray(media.sheets) ? media.sheets : [])) { try { unlinkSync(s) } catch { /* ignore */ } }
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

    // ★ 有人让它"去刷抖音" → 立刻刷一趟（不受 2 小时间隔 / 作息限制，但仍受每日上限）
    //   触发词：刷抖音 / 刷个抖音 / 去刷视频 / 刷刷看 …（不要求被 @，但会回到这条消息所在的群）
    if (config.douyinShare) {
      const dt = String(m.text || '')
      if (/刷.{0,6}抖音|抖音.{0,6}刷|去刷.{0,4}视频|刷刷看/.test(dt)) {
        log(`抖音：被要求刷一趟（${r.roomName || r.roomId}）：${dt.slice(0, 40)}`)
        void douyinTick({ force: true, roomId: r.roomId })
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

    // ★ 群聊事件触发朋友圈：有人说话就安排一次"安静后评估"（防抖/冷却/额度都在内部判）
    try { scheduleChatMomentEval(r) } catch (e) { log('朋友圈事件调度异常：' + String(e?.message || e)) }

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
  const globalFactsPath = join(factsDir, '_all.json')

  /** 记忆是不是全局共享（她不按群记事） */
  const globalMemory = () => config.memoryScope !== 'room'

  /** 该群的记忆文件 → 全局模式下所有群都指向同一份 */
  // ★ 统一出站队列：所有发送都走它（节流 / 去重 / 重试退避）
  //   以前散落的 client.call('sendText') 直接发 → 连发两条语音把微信送走过、wake 刷屏过。
  let outbox = null
  function getOutbox() {
    if (outbox) return outbox
    outbox = OB.createOutbox({
      send: (kind, args) => client.call(kind, args, kind === 'sayVoice' ? 150_000 : 30_000),
      log,
      cfg: {
        minGapMs: Number(config.outboxMinGapMs) || 1200,
        maxPerMin: Number(config.outboxMaxPerMin) || 20,
        maxAttempts: Number(config.outboxMaxAttempts) || 3,
        baseBackoffMs: Number(config.outboxBackoffMs) || 2000,
        dedupeMs: Number(config.outboxDedupeMs) || 5000,
      },
    })
    log('出站队列已就绪（每群间隔 ' + (Number(config.outboxMinGapMs) || 1200) + 'ms，每分钟上限 ' + (Number(config.outboxMaxPerMin) || 20) + '，失败重试 ' + (Number(config.outboxMaxAttempts) || 3) + ' 次）')
    return outbox
  }

  const factsPathFor = (roomId) => (globalMemory() ? globalFactsPath : factsFile(roomId))

  /**
   * 首次启用全局记忆时，把各群的历史记忆合并成一份（幂等）。
   * 每条保留 sourceRoom，便于面板显示"这条是哪来的"；合并时按文字相似度去重。
   */
  function migrateToGlobalMemory() {
    if (!globalMemory()) return { merged: 0, from: 0 }
    let exists = false
    try { exists = Array.isArray(JSON.parse(readFileSync(globalFactsPath, 'utf8'))) } catch { exists = false }
    if (exists) return { merged: 0, from: 0, already: true }
    let files = []
    try { files = readdirSync(factsDir).filter((f) => f.endsWith('.json') && f !== '_all.json') } catch { return { merged: 0, from: 0 } }
    const all = []
    const seen = []
    for (const f of files) {
      let arr = []
      try { arr = JSON.parse(readFileSync(join(factsDir, f), 'utf8')) } catch { continue }
      const roomId = f.replace(/\.json$/, '')
      for (const it of Array.isArray(arr) ? arr : []) {
        const text = String(it && it.text || '').trim()
        if (!text) continue
        const n = normFact(text)
        if (seen.some((x) => factSimilar(x, n))) continue   // 跨群去重
        seen.push(n)
        all.push({ ...it, sourceRoom: it.sourceRoom || roomId })
      }
    }
    const mig = MV2.migrateList(all, Date.now(), memCfg())
    const withIds = MV2.ensureIds(mig.items, Date.now())
    try {
      mkdirSync(factsDir, { recursive: true })
      writeFileSync(globalFactsPath, JSON.stringify(withIds.items, null, 2))
      // 旧文件挪到备份目录（不删，可回滚）
      const bk = join(factsDir, 'per-room-backup-' + Date.now())
      mkdirSync(bk, { recursive: true })
      for (const f of files) { try { renameSync(join(factsDir, f), join(bk, f)) } catch { /* ignore */ } }
      log(`记忆合并为全局库：${files.length} 个群 → ${withIds.items.length} 条（旧文件已备份到 ${bk}）`)
    } catch (e) {
      log('记忆合并失败：' + String(e?.message || e).slice(0, 140))
    }
    return { merged: withIds.items.length, from: files.length }
  }

  /** 记忆 v2 的参数（每次现算，面板改了立即生效） */
  function memCfg() {
    return {
      baseDays: Number(config.memoryBaseDays) || 7,
      forgetWeight: config.memoryForgetWeight === undefined ? 0.06 : Number(config.memoryForgetWeight),
      minAgeDays: config.memoryMinAgeDays === undefined ? 2 : Number(config.memoryMinAgeDays),
      keepImportance: config.memoryKeepImportance === undefined ? 0.85 : Number(config.memoryKeepImportance),
      archiveGraceDays: Number(config.memoryArchiveGraceDays) || 30,
      maxActive: Number(config.memoryMaxActive) || 120,
      injectCount: Number(config.memoryInjectCount) || 12,
      emotionBoost: config.memoryEmotionBoost === undefined ? 0.8 : Number(config.memoryEmotionBoost),
      recallGamma: Number(config.memoryRecallGamma) || 1.2,
      pinnedMax: Number(config.memoryPinnedMax) || 3,
    }
  }

  /** 给"来源群"补上可读的群名（面板显示用；roomNameCache 有就用它） */
  function enrichSourceNames(arr) {
    for (const it of (arr || [])) {
      if (!it || it.sourceRoomName || !it.sourceRoom) continue
      const n = roomNameCache.get(it.sourceRoom)
      if (n && !String(n).endsWith('@chatroom')) it.sourceRoomName = n
    }
    return arr
  }

  function loadFacts(r) {
    try {
      const saved = JSON.parse(readFileSync(factsPathFor(r.roomId), 'utf8'))
      let arr = Array.isArray(saved) ? saved : []
      // v2：旧数据（{text,kind,at}）自动补 强度/情绪/重要度/id
      if (config.memoryV2 !== false) {
        const needRebase = arr.some((x) => x && x.migratedFrom === 'v1')   // 旧条目需按新基准重算强度
        const mig = MV2.migrateList(arr, Date.now(), memCfg())
        const withIds = MV2.ensureIds(mig.items, Date.now())
        // 补情绪标签：v1 迁移来的条目情绪全是"未知"，用本地词表从正文反推（0 token）
        const bf = MV2.backfillEmotion(withIds.items, Date.now())
        arr = bf.items
        if (bf.changed) { r.facts = arr; saveFacts(r); log(`记忆情绪回填：${bf.changed} 条「未知」→ 按正文推断`) }
        r.facts = arr
        if (mig.changed || withIds.changed || needRebase) {
          log(`记忆迁移 v1→v2：${r.roomName || r.roomId} ${mig.changed} 条补字段、${withIds.changed} 条补 id（已落盘）`)
          saveFacts(r)
        }
      } else {
        r.facts = arr
      }
    } catch { r.facts = [] }
    enrichSourceNames(r.facts)
    return r.facts
  }

  function saveFacts(r) {
    try {
      mkdirSync(factsDir, { recursive: true })
      const all = (r.facts || []).filter(Boolean)
      // ★ v2：不再 slice(-80) 按时间硬截（那会把早期重要记忆直接扔掉）。
      //   现在：active 受 memoryMaxActive 约束（超出由 sweep 按 R×重要度淘汰进归档），
      //   归档条目也一起留盘上（有 geometry 上限，30 天后 sweep 会清）。
      const active = all.filter((x) => !x.archived)
      const archived = all.filter((x) => x.archived).slice(-200)
      const baseMax = globalMemory()
        ? (Number(config.memoryGlobalMax) || 400)
        : (Number(config.memoryMaxActive) || 120)
      const cap = Math.max(20, baseMax) + 40   // 留一点余量给 sweep 前
      const kept = active.slice(-cap).concat(archived)
      writeFileSync(factsPathFor(r.roomId), JSON.stringify(kept, null, 2))
      r.facts = kept
    } catch { /* ignore */ }
  }

  /** 写一条长期记忆（自动去重、限量） */
  /**
   * 对已有的长期记忆做一次自我去重（治存量）。
   *  旧代码只判断完全相等，所以历史上攒下不少「换说法」的重复条目。
   *  合并策略：保留信息更全的（更长的），时间用较新的。
   * @returns {number} 被合并掉的条数
   */
  function dedupFacts(r) {
    const facts = r.facts || []
    if (facts.length < 2) return 0
    // 时间从旧到新处理，这样「保留较新时间」自然成立
    const sorted = facts.slice().sort((a, b) => (a.at || 0) - (b.at || 0))
    const out = []
    for (const f of sorted) {
      const n = normFact(f.text)
      const dup = out.find((x) => factSimilar(normFact(x.text), n))
      if (!dup) { out.push(f); continue }
      if (String(f.text).length > String(dup.text).length) dup.text = f.text
      dup.at = Math.max(dup.at || 0, f.at || 0)
    }
    const removed = facts.length - out.length
    if (removed > 0) {
      out.sort((a, b) => (a.at || 0) - (b.at || 0))
      r.facts = out
      r.factsDedupedAt = Date.now()
      saveFacts(r)
    }
    return removed
  }

  /**
   * 用 LLM 合并「语义重复」的记忆（字面去重抓不到的那种）。
   *  例：「wxid_x 被我称作主人」 vs「我会称呼 wxid_x 为主人」——语序不同，编辑距离判定不了。
   *  只在手动提炼（force）时跑，避免每次自动提炼都花 token。
   * @returns {Promise<number>} 合并掉的条数
   */
  async function compactFacts(r) {
    const facts = r.facts || []
    if (facts.length < 12) return 0
    const BATCH = 20   // 一次喂 75 条会让模型「思考」吃光输出预算返回空，分批更稳
    const merged = []
    const now = Date.now()
    let failedBatches = 0
    const sys = '你是记忆整理器。合并语义重复的条目，保留信息最完整的表述。只输出条目，每行一条，不要编号、不要解释。'
    for (let start = 0; start < facts.length; start += BATCH) {
      const batch = facts.slice(start, start + BATCH)
      const list = batch.map((f, i) => `${i + 1}. ${String(f.text).slice(0, 120)}`).join('\n')
      const usr = '下面是一批长期记忆。请把**说的是同一件事**的条目合并成一条（保留信息最全的写法），'
        + '不重复的原样保留。不要新增原文没有的内容，不要输出解释。\n\n' + list
      try {
        const route = resolveRoute()
        stats.llmCalls++
        // effort 传 'low'：这个模型做「合并」时会思考到把输出预算吃光，降思考换输出
        let res = await callLlm(route, sys, usr, 'low')
        if (!String(res.text || '').trim()) res = await callLlm(route, '', sys + '\n\n' + usr, 'low')
        const lines = String(res.text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        const got = []
        for (const l of lines) {
          if (/^无$/.test(l)) continue
          const t = l.replace(/^[-•\d.、\s]+/, '').trim()
          if (!t || t.length > 200) continue
          if (got.some((m) => factSimilar(normFact(m.text), normFact(t)))) continue
          got.push({ text: t, kind: 'compact', at: now })
        }
        // 这一批合并失败（空/异常）→ 原样保留，不能丢
        if (!got.length) { failedBatches++; merged.push(...batch); continue }
        merged.push(...got)
      } catch (e) {
        failedBatches++
        merged.push(...batch)
        log('记忆合并批次失败，原样保留：' + String(e?.message || e))
      }
    }
    if (!merged.length) return -1
    // 全批失败 = 模型不可用，别动原数据
    if (failedBatches * BATCH >= facts.length) {
      log(`记忆合并放弃：所有批次都没返回有效内容（${failedBatches} 批）`)
      return -1
    }
    // 最后再用字面去重兜一遍（跨批的重复靠这层）
    const out = []
    for (const m of merged) {
      if (out.some((x) => factSimilar(normFact(x.text), normFact(m.text)))) continue
      out.push(m)
    }
    // 保险：至少保留六成，否则视为异常
    if (out.length < Math.max(6, Math.floor(facts.length * 0.5))) {
      log(`记忆合并放弃：结果只有 ${out.length}/${facts.length} 条，疑似异常`)
      return 0
    }
    out.forEach((m, i) => { m.at = now - (out.length - i) * 1000 })
    const removed = facts.length - out.length
    r.facts = out
    saveFacts(r)
    log(`「${r.roomName}」记忆合并：${facts.length} → ${out.length} 条（合并 ${removed} 条语义重复）`)
    return removed
  }

  /** 写一条长期记忆（相似度去重、限量、单条上限 200 字） */
  function addFact(r, text, kind = 'auto') {
    const t = String(text || '').trim()
    // 上限从 120 提到 200：用户要求「记忆做长一点」，一条能写完整背景
    if (!t || t.length > 200) return false
    r.facts ||= []
    const n = normFact(t)
    // 去重从「完全相等」升级为「讲的是同一件事」（换说法也算重复）
    if (r.facts.some((f) => factSimilar(normFact(f.text), n))) return false
    // v2：顺手算 强度S0/情绪/重要度；v1 路径保持原样
    if (config.memoryV2 !== false) {
      const meta = arguments.length > 3 ? arguments[3] : null   // { emotion, importance, selfRelevant, difficulty, sources, pinned }
      const emotion = MV2.normalizeEmotion(meta && meta.emotion)
      const importance = MV2.computeImportance({
        modelImportance: meta && meta.importance,
        emotion,
        selfRelevant: !!(meta && meta.selfRelevant),
      })
      const item = {
        schema: MV2.SCHEMA,
        text: t,
        kind,
        createdAt: Date.now(),
        at: Date.now(),
        emotion,
        importance,
        strength: MV2.initialStrength({ importance, emotion, cfg: memCfg() }),
        difficulty: meta && meta.difficulty !== undefined ? Number(meta.difficulty) : 0.3,
        recallCount: 0,
        hitCount: 0,
        lastRecallAt: null,
        pinned: !!(meta && meta.pinned) || /记住这个|别忘了|一定要记得/.test(t),
        archived: false,
        sources: (meta && Array.isArray(meta.sources) ? meta.sources : []).slice(0, 3),
      }
      const withIds = MV2.ensureIds([item], Date.now())
      // 全局记忆：记下"这条是从哪个群学到的"（不限制使用范围，只保留出处）
      withIds.items[0].sourceRoom = r.roomId
      withIds.items[0].sourceRoomName = r.roomName || r.roomId
      r.facts.push(withIds.items[0])
      log(`长期记忆 +1（${kind}｜重要度 ${importance.toFixed(2)}｜情绪 ${emotion.label}${emotion.intensity >= 0.6 ? '★' : ''}）`)
    } else {
      r.facts.push({ text: t, kind, at: Date.now() })
    }
    const capSoft = Math.max(80, Number(config.memoryMaxActive) || 120)
    if (r.facts.length > capSoft + 200) r.facts = r.facts.slice(-(capSoft + 200))
    saveFacts(r)
    if (config.memoryV2 === false) log(`长期记忆 +1（${kind}）：${JSON.stringify(t.slice(0, 50))}`)
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
    // 顺便清理存量重复（旧版只做完全相等比较，历史条目里有大量换说法的重复）
    const removed = dedupFacts(r)
    if (removed) log(`「${r.roomName}」记忆去重：合并掉 ${removed} 条重复（剩 ${r.facts.length} 条）`)
    // 手动提炼时，再让模型合并一次语义重复（字面去重抓不到语序重排/同义替换）
    //  这个模型（deepseek-flash）对「合并列表」会思考到返空，连续失败 2 次就停用，省 token
    if (force && (r.compactFails || 0) < 2) {
      const rc = await compactFacts(r)
      r.compactFails = rc < 0 ? (r.compactFails || 0) + 1 : 0
      if (rc < 0 && r.compactFails >= 2) log('记忆合并已停用：模型连续返回空（改配置后可手动重置）')
    }
    const recent = r.msgs.slice(-30)
      .map((m) => `${m.isSelf ? '我' : m.senderName}: ${m.text}`)
      .join('\n')
      .slice(-2000)
    try {
      const route = resolveRoute()
      stats.llmCalls++
      const sys = '你是一个记忆整理器。按行输出 JSON，每行一个对象，不要数组、不要解释、不要代码块围栏。'
      // 把已有记忆喂给模型，从源头减少重复（之前的重复主要来自「模型不知道已经记过什么」）
      const existing = (r.facts || []).slice(-24).map((f) => '- ' + String(f.text).slice(0, 120)).join('\n')
      const usr = '从下面的群聊记录里提炼 1~4 条**值得长期记住**的事实，例如：\n'
        + '谁是谁（昵称/身份）、某人的喜好或习惯、群里的约定或梗、重要事件、我答应过别人的事。\n'
        + '**每条写完整一点**（建议 30~100 字）：带上是谁、什么场合、什么细节，别只写半句。\n'
        + '只记长期有用的；日常闲聊不要记。没有值得记的就只输出：无\n'
        + '\n输出格式（每行一个 JSON 对象，字段都要有）：\n'
        + '{"text":"记忆内容","kind":"fact|pref|event|relation","emotion":"开心|生气|难过|害羞|惊喜|无语|温柔|平静","emotionIntensity":0.0~1.0,"importance":0.0~1.0,"selfRelevant":true|false}\n'
        + '· emotion：这条记忆**发生时的情绪**（从语气判断；判断不了就填"平静"、强度 0.2）\n'
        + '· importance：以后还有多重要（0=一次性琐事，1=必须永远记住，比如身份/约定/承诺）\n'
        + '· selfRelevant：是否关系到"我"或"主人"（是就 true）\n'
        + (existing ? '\n【已经记过下面这些，不要重复提炼同一件事（换个说法也算重复）】\n' + existing + '\n' : '')
        + '\n群聊记录：\n' + recent
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
        // 优先按 JSON 行解析（v2）；模型不听话时退回纯文本（v1 行为）
        let meta = null
        let text = ''
        const jsonTry = l.replace(/^```(?:json)?\s*|```$/g, '').trim()
        if (jsonTry.startsWith('{')) {
          try {
            const o = JSON.parse(jsonTry)
            text = String(o.text || o.memory || '').trim()
            meta = {
              emotion: { label: o.emotion, intensity: o.emotionIntensity !== undefined ? o.emotionIntensity : o.intensity },
              importance: o.importance,
              selfRelevant: !!o.selfRelevant,
              difficulty: o.difficulty,
            }
            if (o.kind) meta.kind = String(o.kind)
          } catch { text = '' }
        }
        if (!text) {
          text = l.replace(/^[-•\d.、\s]+/, '').trim()
          meta = null
        }
        if (text && addFact(r, text, (meta && meta.kind) || 'extract', meta)) n++
      }
      if (n) log(`「${r.roomName}」长期记忆提炼：新增 ${n} 条（共 ${r.facts.length} 条）`)
      return n
    } catch (e) {
      log('长期记忆提炼失败：' + String(e?.message || e))
      return 0
    }
  }

  /**
   * 记忆巡检：按遗忘曲线归档该忘的、清掉归档到期的、容量超限按权重淘汰。
   * 每群独立跑；只在有变化时才落盘（避免无意义的写）。
   */
  /** 空闲恢复精力：没有消息时慢慢回血（每次巡检/定时器调用） */
  function personaIdleRecover(now = Date.now()) {
    if (config.personaEnabled === false) return
    for (const r of rooms.values()) {
      try {
        const st = personaOf(r)
        const next = PS.recoverEnergy(st, now, loadCfg())
        if (next !== st) { r.__persona = next; savePersona(r, next) }
        break   // 全局模式下只需处理一次
      } catch { /* ignore */ }
    }
  }

  function memorySweepAll(now = Date.now()) {
    const cfg = memCfg()
    const out = { rooms: 0, archived: 0, purged: 0, evicted: 0, total: 0 }
    // ★ 全局模式：所有群共用一份记忆 → 只巡检一次，否则每个群都会写同一个文件（互相覆盖）
    if (globalMemory()) {
      const any = rooms.values().next().value
      const facts = (any && any.facts) || (() => {
        try { return JSON.parse(readFileSync(globalFactsPath, 'utf8')) } catch { return [] }
      })()
      if (!Array.isArray(facts) || !facts.length) return out
      const res = MV2.sweep(facts, now, cfg)
      out.rooms = 1
      out.total = res.items.length
      if (res.archived || res.purged || res.evicted) {
        try { writeFileSync(globalFactsPath, JSON.stringify(res.items, null, 2)) } catch { /* ignore */ }
        for (const r of rooms.values()) r.facts = res.items   // 所有群指向同一份
        out.archived += res.archived; out.purged += res.purged; out.evicted += res.evicted
        log(`记忆巡检（全局）：归档 ${res.archived}｜清理 ${res.purged}｜容量淘汰 ${res.evicted}（生效 ${res.items.filter((x) => !x.archived).length} 条）`)
      }
      return out
    }
    for (const r of rooms.values()) {
      const facts = r.facts || []
      if (!facts.length) continue
      out.rooms++
      const res = MV2.sweep(facts, now, cfg)
      out.total += res.items.length
      if (res.archived || res.purged || res.evicted) {
        r.facts = res.items
        saveFacts(r)
        out.archived += res.archived
        out.purged += res.purged
        out.evicted += res.evicted
        log(`记忆巡检「${r.roomName || r.roomId}」：归档 ${res.archived}｜清理 ${res.purged}｜容量淘汰 ${res.evicted}（剩 ${res.items.filter((x) => !x.archived).length} 条生效）`)
      }
    }
    return out
  }

  // ── 性格状态（每群一份：心情/精力/亲密度/好恶/目标/日记）──────────
  const personaDir = join(dirname(memoryDir), 'persona')
  const personaFile = (roomId) => join(personaDir, String(roomId).replace(/[^\w@.-]/g, '_') + '.json')
  const globalPersonaPath = join(personaDir, '_global.json')
  /** 性格（心情/好恶/目标/自传）是否全局 —— 跟随 memoryScope */
  const personaPathFor = (roomId) => (globalMemory() ? globalPersonaPath : personaFile(roomId))

  function personaCfg() {
    return {
      diaryEveryMs: (Number(config.personaDiaryHours) || 6) * 3_600_000,
      maxGoals: Number(config.personaMaxGoals) || 3,
      seedLikes: config.personaSeedLikes === undefined ? 2 : Number(config.personaSeedLikes),
      seedDislikes: config.personaSeedDislikes === undefined ? 1 : Number(config.personaSeedDislikes),
      moodFollow: Number(config.personaMoodFollow) || 0.35,
    }
  }

  function narrativeCfg() {
    return {
      minDiaries: Number(config.personaNarrativeMinDiaries) || 3,
      maxDrift: config.personaNarrativeMaxDrift === undefined ? 0.30 : Number(config.personaNarrativeMaxDrift),
    }
  }

  /**
   * 让她重写"我是个什么样的人"（自传）。
   * 分三层：persona（用户写的身份+底线，不可改）→ narrative（她自己写，会演化）→ 状态。
   * 两道护栏：身份锚点不能丢、单次改写不许剧烈漂移（失败就保留旧版）。
   */
  async function writeNarrative(r, { force = false } = {}) {
    if (config.personaEnabled === false || config.personaSelfNarrative === false) {
      return { ok: false, reason: '自传功能已关闭' }
    }
    const st = personaOf(r)
    const everyMs = (Number(config.personaNarrativeHours) || 24) * 3_600_000
    const gate = PS.shouldWriteNarrative(st, Date.now(), {
      everyMs,
      minDiaries: Number(config.personaNarrativeMinDiaries) || 3,
    })
    if (!force && !gate.ok) return { ok: false, reason: gate.reason }

    const cur = st.narrative || {}
    let memBlock = []
    try {
      const sel = MV2.selectMemories(r.facts || [], {
        now: Date.now(),
        query: (st.diary || []).slice(0, 5).map((d) => d.text).join(' '),
        cfg: memCfg(),
      })
      memBlock = sel.picked || []
    } catch { /* 记忆不可用不影响 */ }

    const { sys, usr } = PS.buildNarrativePrompt({
      core: config.persona || '',
      state: st,
      diaries: st.diary || [],
      memories: memBlock,
      prev: cur.text || '',
    })
    let res = null
    try {
      const route = resolveRoute()
      stats.llmCalls++
      res = await callLlm(route, sys, usr, undefined)
      if (!String(res && res.text || '').trim()) res = await callLlm(route, '', sys + '\n\n' + usr, undefined)
    } catch (e) {
      log('写自传失败：' + String(e?.message || e).slice(0, 140))
      return { ok: false, reason: String(e?.message || e).slice(0, 140) }
    }
    const raw = String(res && res.text || '').trim().replace(/^```[\s\S]*?```$/g, '').trim()
    let text = raw
    let check = PS.validateNarrative(text, { core: config.persona || '', prev: cur.text || '', cfg: narrativeCfg() })
    // 只因"变化过大"被拒 → 自动重试一次，明确要求贴着上一版改（每天重写很容易写飞）
    if (!check.ok && /变化过大/.test(check.reason) && cur.text) {
      log(`自传变化过大，正在按上一版重试一次（v${cur.version || 0}）`)
      try {
        const sys2 = sys + String.fromCharCode(10,10) + '这次必须**保留上一版的措辞和结构**，只做小幅增删（改不超过三成），不要重写。'
        const usr2 = usr + `

【上一版原文，请在此基础上微调】
${cur.text}`
        stats.llmCalls++
        const r2 = await callLlm(route, sys2, usr2, undefined)
        const raw2 = String(r2 && r2.text || '').trim().replace(/^```[\s\S]*?```$/g, '').trim()
        const check2 = PS.validateNarrative(raw2, { core: config.persona || '', prev: cur.text || '', cfg: narrativeCfg() })
        if (check2.ok) { text = raw2; check = check2 }
      } catch (e) { log('自传重试失败：' + String(e?.message || e).slice(0, 100)) }
    }
    if (!check.ok) {
      log(`自传被护栏拦下（保留旧版 v${cur.version || 0}）：${check.reason}`)
      return { ok: false, reason: check.reason, rejected: true }
    }
    const next = PS.writeNarrative(st, text, Date.now(), narrativeCfg())
    savePersona(r, next)
    log(`自传更新 v${next.narrative.version}：${text.slice(0, 70)}…`)
    return { ok: true, version: next.narrative.version, text, previous: cur.text || '' }
  }

  /** 取（或首次创建）某个群的性格状态 */
  function personaOf(r) {
    if (r.__persona) return r.__persona
    let st = null
    try {
      const raw = JSON.parse(readFileSync(personaPathFor(r.roomId), 'utf8'))
      if (raw && typeof raw === 'object') st = raw
    } catch { /* 首次 */ }
    if (!st) {
      st = PS.createState(r.roomId, Date.now(), personaCfg())
      log(`性格状态初始化「${r.roomName || r.roomId}」：喜欢 ${st.tastes.likes.map((x) => x.text).join('、') || '无'}｜讨厌 ${st.tastes.dislikes.map((x) => x.text).join('、') || '无'}｜目标「${(st.goals[0] || {}).text || '无'}」`)
      savePersona(r, st)
    }
    // traits 缺失就补上并落盘（面板要显示，漂移也要有基线）
    if (!st.traits) {
      try {
        st = PS.ensureTraits(st, Date.now())
        savePersona(r, st)
        log('性格：已初始化行为维度（traits）')
      } catch { }
    }
    r.__persona = st
    return st
  }

  function savePersona(r, st) {
    try {
      mkdirSync(personaDir, { recursive: true })
      r.__persona = st
      writeFileSync(personaPathFor(r.roomId), JSON.stringify(st, null, 1))
    } catch { /* ignore */ }
  }

  function loadCfg() {
    return {
      basePerMin: Number(config.personaEnergyBasePerMin) || 24,
      roomBonus: config.personaEnergyRoomBonus === undefined ? 0.6 : Number(config.personaEnergyRoomBonus),
      maxRooms: Number(config.personaEnergyMaxRooms) || 8,
    }
  }

  /** 最近 2 小时内有消息的群 → 算"同时活跃几个群" */
  function activeRoomCount(now = Date.now()) {
    let n = 0
    for (const r of rooms.values()) {
      const last = (r.msgs || []).reduce((m, x) => Math.max(m, Number(x.ts) || 0), 0)
      if (last && now - last < 2 * 3_600_000) n++
    }
    return Math.max(1, n)
  }

  /**
   * 内心/记忆是全局的，所以面板不该再要求选群。
   * 这里拿"随便一个已有群"当载体（只为了复用 roomState 的容器），拿不到就用合成对象。
   */
  let globalHostCache = null
  function globalHostRoom() {
    // 取第一个真实群当"载体"（内心/记忆是全局的，具体哪个群无所谓）
    for (const r of rooms.values()) {
      if (r && r.policy) return r
    }
    // 一个真实群都没有时（插件刚启动、还没收到消息）→ 用一个脱壳对象，
    // **不要塞进 rooms**：塞进去会让 resolveRoom 之类按名字查找时冒出"找不到群：_global"，
    // 而且它没有 policy，曾导致面板保存配置整体报错（2026-10-28）。
    if (!globalHostCache) {
      globalHostCache = {
        roomId: '_global', roomName: '全局', msgs: [], facts: [], memberNames: [],
        policy: { cfg: config }, recentReplies: [],
      }
    }
    return globalHostCache
  }

  // ── 2：承诺追踪（她说"等下帮你找"，到点真回来）──────────────
  function promiseState(r) {
    const st = personaOf(r)
    return (st.promises || [])
  }
  function notePromise(r, text) {
    if (config.humanPromise === false) return
    try {
      const p = H2.detectPromise(text)
      if (!p) return
      const st = personaOf(r)
      const list = (st.promises || []).filter((x) => x && !x.done).slice(-4)
      list.push({ ...p, roomId: r.roomId })
      savePersona(r, { ...st, promises: list })
      log(`承诺已登记：${String(p.text).slice(0, 40)}（${Math.round((p.dueAt - Date.now()) / 60000)} 分钟后该兑现）`)
    } catch { /* ignore */ }
  }

  /** 到点的承诺 → 让她回来说一句（走正常发消息路径） */
  async function fulfillPromises() {
    if (config.humanPromise === false) return { done: 0 }
    let n = 0
    for (const r of rooms.values()) {
      try {
        const st = personaOf(r)
        const list = st.promises || []
        const due = H2.duePromises(list, Date.now())
        if (!due.length) continue
        for (const p of due.slice(0, 1)) {
          const okSend = await sendPromiseFollowUp(r, p)
          const next = list.map((x) => (x && x.at === p.at && x.text === p.text ? { ...x, done: true, doneAt: Date.now(), spoken: !!okSend } : x))
          savePersona(r, { ...st, promises: next })
          if (okSend) { n++; log(`承诺已兑现：${String(p.text).slice(0, 40)}`) }
        }
        // 过期作废
        const dead = H2.expirePromises(st.promises || [], Date.now())
        if (dead.length) {
          const keep = (st.promises || []).filter((x) => !dead.includes(x))
          savePersona(r, { ...st, promises: keep })
        }
      } catch (e) { log('兑现承诺失败：' + String(e?.message || e).slice(0, 100)) }
    }
    return { done: n }
  }

  async function sendPromiseFollowUp(r, promise) {
    try {
      const route = resolveRoute()
      stats.llmCalls++
      const res = await callLlm(route, buildSystem(r), H2.promiseFulfillPrompt(promise), config.reasoningEffort || undefined)
      let text = cleanReply(res.text, { maxLen: config.maxReplyChars, maxLines: 0 })
      if (!text) return false
      const sent = await getOutbox().sendText(r.roomId, text)
      if (sent && (sent.rc === 0 || sent.rc === undefined || sent.ok !== false)) {
        push(r, { ts: Date.now(), isSelf: true, sender: 'self', senderName: '我', text })
        return true
      }
      return false
    } catch (e) { log('兑现承诺发送失败：' + String(e?.message || e).slice(0, 100)); return false }
  }

  /**
   * 6：连续追击 —— 说完一句，过一会儿自己补一句。
   * 只在"群里还没接话"时补，避免打断别人；一轮最多两次。
   */
  async function sendFollowUp(r, plan) {
    if (config.humanFollowUp === false) return false
    try {
      // 这期间有人说话了 → 不补（别打断）
      const lastOther = (r.msgs || []).filter((m) => m && !m.isSelf).slice(-1)[0]
      const lastSelfTs = Number(r.__followUpSentAt) || 0
      if (lastOther && Number(lastOther.ts) > lastSelfTs + 1000 && Date.now() - Number(lastOther.ts) < 60_000) {
        return false
      }
      const st = personaOf(r)
      const prompt = `你刚才说过一句，现在自己又想起一点补充（或者想问一句）。开头可以用「${plan.seed}」，也可以不用。`
        + '保持很短（不超过 25 字），像真人随口补一句，不要总结、不要问候。'
      const route = resolveRoute()
      stats.llmCalls++
      const res = await callLlm(route, buildSystem(r), prompt, config.reasoningEffort || undefined)
      const text = cleanReply(res.text, { maxLen: 60, maxLines: 0 })
      if (!text || text.length < 2) return false
      // 同一条不发两遍
      if ((r.sentTexts || []).slice(-6).some((x) => normText(x.text) === normText(text))) return false
      const sent = await getOutbox().sendText(r.roomId, text)
      if (sent && (sent.rc === 0 || sent.rc === undefined || sent.ok !== false)) {
        r.__followUpSentAt = Date.now()
        r.__followUpCount = (Number(r.__followUpCount) || 0) + 1
        ;(r.sentTexts ||= []).push({ text, at: Date.now() })
        if (r.sentTexts.length > 40) r.sentTexts = r.sentTexts.slice(-40)
        push(r, { ts: Date.now(), isSelf: true, sender: 'self', senderName: '我', text })
        log('补了一句：' + text.slice(0, 40))
        return true
      }
      return false
    } catch (e) {
      log('补一句失败：' + String(e?.message || e).slice(0, 90))
      return false
    }
  }

  /**
   * ④ 结束语义 / 忘掉
   *   · 有人说"晚安/先这样/下次聊" → 写一条压缩的收尾记录（借 SKILL.md 的"日期/主题/本次发生/待续"）
   *   · 有人说"忘掉 XX / 别记这个" → 把相关记忆归档（不硬删，可回溯）
   */
  async function handleWrapSignals(r, m) {
    if (!m || m.isSelf) return
    const text = String(m.text || '')
    // 忘掉
    if (config.humanForgetSignal !== false) {
      const f = H3.detectForget(text)
      if (f && f.target) {
        const before = (r.facts || []).length
        r.facts = (r.facts || []).map((x) => {
          if (!x || !x.text) return x
          return String(x.text).includes(f.target)
            ? { ...x, archived: true, archivedAt: Date.now(), archivedReason: '用户要求忘掉：' + f.target.slice(0, 12) }
            : x
        })
        const after = r.facts.filter((x) => !x.archived).length
        if (after < before) {
          try { saveFacts(r) } catch { }
          log(`按「忘掉」归档了 ${before - after} 条含「${f.target}」的记忆`)
        }
      }
    }
    // 收尾日记
    if (config.humanWrapUpDiary === false) return
    const fw = H3.detectFarewell(text)
    if (!fw) return
    const st = personaOf(r)
    const lastAt = Number(r.__lastWrapUpAt) || 0
    if (Date.now() - lastAt < 30 * 60_000) return          // 半小时内只写一次
    r.__lastWrapUpAt = Date.now()
    const recent = (r.msgs || []).slice(-12)
      .map((x) => (x.isSelf ? '我' : (x.senderName || '群友')) + '：' + String(x.text || '').slice(0, 60))
      .join('\n')
    try {
      const route = resolveRoute()
      stats.llmCalls++
      const res = await callLlm(route, '', H3.wrapUpPrompt(recent), undefined)
      const line = String(res?.text || '').trim().split('\n')[0].slice(0, 90)
      if (!line || line === '无') return
      const ev = PS.addTimelineEvent(st, '收尾：' + line, Date.now(), { kind: 'wrapup' })
      if (ev.ok) savePersona(r, ev.state)
      log('收尾记录：' + line)
    } catch (e) { log('收尾记录失败：' + String(e?.message || e).slice(0, 80)) }
  }

  /** ★ 只喜欢一个人：把除"心动对象"以外的人好感压回 ≤55%（每次更新后调用） */
  function applySingleLove(r) {
    if (config.personaLoveExclusive === false) return
    try {
      const st = personaOf(r)
      const masterWxid = Object.keys(st.affinity || {}).find((w) => {
        const nm = String((config.memberNames || {})[w] || '').trim()
        return config.masterName && nm && nm === String(config.masterName).trim()
      }) || ''
      const res = PS.enforceSingleLove(st, { masterWxid, masterName: config.masterName || '' })
      if (res.clamped && res.clamped.length) {
        savePersona(r, res.state)
        const names = res.clamped.map((w) => (config.memberNames || {})[w] || w).slice(0, 3)
        log(`好感度：只喜欢一个人 → 把 ${names.join('、')}${res.clamped.length > 3 ? ' 等' : ''} 压回 55%（普通人）`)
      }
    } catch { /* 不影响主流程 */ }
  }

  /** 消息驱动的状态更新（每条群消息都过一遍，纯内存计算，很便宜） */
  function personaOnMessage(r, m) {
    if (config.personaEnabled === false) return
    if (!m || m.isSelf) return
    try {
      const st = personaOf(r)
      const text = String(m.text || '')
      const atBot = m.isAtMe || (config.botName && text.includes(config.botName)) || /大肥鱼|肥鱼|鲸鱼娘/.test(text)
      const emo = MV2.guessEmotion(text)
      let next = PS.applyMessage(st, { emotion: emo, sender: m.sender, text, isSelf: false, atBot }, Date.now(), personaCfg())
      // ★ 精力：不再"每条扣一点"（群一多就长期困死），改成按消息速率 + 活跃群数算负荷
      try {
        const hour = new Date().getHours()
        next = PS.updateEnergyLoad(next, {
          activeRooms: activeRoomCount(),
          now: Date.now(),
          night: hour >= 0 && hour < 6,
          cfg: loadCfg(),
        })
      } catch { /* 精力模型坏了不影响对话 */ }
      // 踩到好恶：即时影响心情（讨厌的事会真不高兴）
      const hit = PS.tasteHit(next, text)
      if (hit) {
        const dv = hit.kind === 'like' ? 0.08 * hit.weight : -0.18 * hit.weight
        next = { ...next, mood: { ...next.mood, valence: Math.max(-1, Math.min(1, next.mood.valence + dv)) } }
        if (hit.kind === 'dislike') log(`性格：「${r.roomName}」被踩到讨厌的点（${hit.text}）→ 心情下降`)
        if (config.humanMoodCause !== false) {
          const who = nameOf(m.sender, m.senderName) || 'someone'
          next = PS.pushMoodLog(next, {
            reason: who + (hit.kind === 'dislike' ? ' touched a thing she hates: ' : ' mentioned something she likes: ') + hit.text,
            delta: dv,
            valenceAfter: next.mood.valence,
          })
        }
      }
      // 3：群友在纠正她 → 改记忆（而不是嘴硬到底）
      try {
        if (config.humanCorrection !== false) {
          const corr = H2.detectCorrection(text)
          if (corr) {
            const res2 = H2.applyCorrection(r.facts || [], corr, Date.now())
            if (res2.changed) {
              r.facts = res2.items
              saveFacts(r)
              log(`记忆已按纠正更新：${String(corr.raw).slice(0, 50)}`)
            }
          }
        }
      } catch { /* ignore */ }
      // I: repeated questions from the same person wear on her patience
      try { if (config.humanPatience !== false && atBot) next = PS.noteQuestion(next, m.sender) } catch { }
      // F: new slang in the group (local heuristic, no LLM)
      //   关键：用"她本来就认识的词"当基准 —— 记忆库 + 她自己说过的话里出现过的，
      //   一律不算新梗。否则 2~4 字切片会把"图片/居然能够/每天都在"这种普通词当成梗
      //   （实测踩过：词表被普通词塞满，还把"图片"当成学会的梗）。
      try {
        if (config.humanLearnTerms !== false) {
          const STOP = new Set(['我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '就是', '不是',
            '没有', '一个', '知道', '现在', '时候', '东西', '这样', '那样', '然后', '因为', '所以', '但是',
            '如果', '已经', '还是', '也是', '还有', '可能', '应该', '自己', '别人', '今天', '明天', '昨天',
            '哈哈', '呵呵', '好的', '收到', '真的', '感觉', '觉得', '一下', '有点', '比较', '特别', '图片',
            '表情', '语音', '视频', '群里', '我们', '你们', '刚才', '刚才说', '反正', '其实', '不过', '而且'])
          // 她已有的词汇（缓存，记忆条数变了才重建）
          const memLen = (r.facts || []).length
          if (!r.__knownText || r.__knownTextLen !== memLen) {
            r.__knownText = ((r.facts || []).slice(-400).map((x) => String(x.text || '')).join(' ')
              + ' ' + ((r.recentReplies || []).slice(-60).map((x) => String(x.text || '')).join(' ')))
              .slice(0, 400000)
            r.__knownTextLen = memLen
          }
          const known = r.__knownText || ''
          const cands = new Set()
          for (const seg of String(text).split(/[\s，。！？,.!?、~～]+/)) {
            const segs = seg.match(/[\u4e00-\u9fa5]{2,4}/g) || []
            for (const t of segs) {
              if (STOP.has(t)) continue
              if (known.includes(t)) continue          // 她本来就会 → 不是新梗
              cands.add(t)
            }
          }
          for (const t of cands) {
            const res = PS.noteTerm(next, t, Date.now())
            if (res.changed) next = res.state
          }
        }
      } catch { }
      // 节流：内存里实时更新，落盘最多每 60 秒一次（每条群消息都写盘太浪费）
      r.__persona = next
      const lastSave = Number(r.__personaSavedAt) || 0
      if (Date.now() - lastSave > 60_000) {
        r.__personaSavedAt = Date.now()
        savePersona(r, next)
      }
    } catch (e) {
      log('性格状态更新失败：' + String(e?.message || e).slice(0, 120))
    }
  }

  // ── 方案⑥：反馈驱动的性格漂移 ─────────────────────────────
  //  发一条 → 记下"这句话用了哪些行为维度" → 等 settleMin 分钟 →
  //  看群里真实反应（被夸/被接话/被怼/没人说话）→ 小幅调整对应的 trait。
  //  默认关闭（personaFeedback=false），先在日志里看它打算怎么调，确认没问题再开。
  // ★ 2026-10-28 优化：队列改存进 persona 状态（落盘），插件重载不再丢。
  //   原来只在内存里、还要等 10 分钟才结算 —— 今天重载十几次，每条都在窗口内被清空，
  //   所以 feedbackLog 一直是 0、traits 一动不动（用户实测"性格漂移一直不变"）。
  //   现在：① 落盘 ② 窗口缩短到 3 分钟 ③ 只要群里有人接话就提前结算（不用干等）
  const PF_KEEP = 40

  function feedbackEnabled() {
    return config.personaEnabled !== false && config.personaFeedback === true
  }

  /** 记一条待结算（在 deliver 真正发出文字后调用） */
  function noteFeedback(r, text, { parts = 1, hasSticker = false } = {}) {
    if (!feedbackEnabled()) return
    try {
      const sig = PS.traitSignature(text, { parts, hasSticker })
      if (!Object.keys(sig).length) return
      const st = personaOf(r)
      const q = [...(st.pendingFeedback || []), { roomId: r.roomId, at: Date.now(), sentAt: Date.now(), sig }].slice(-PF_KEEP)
      savePersona(r, { ...st, pendingFeedback: q })
    } catch (e) { log('记录反馈签名失败：' + String(e?.message || e).slice(0, 100)) }
  }

  /** 判断这批消息给出的反馈类型 */
  function judgeOutcome(item, msgs) {
    const after = (msgs || []).filter((m) => m && !m.isSelf && Number(m.ts || 0) > item.sentAt)
    if (!after.length) return { outcome: 'ignored', why: '发出后没人说话' }
    const text = after.map((m) => String(m.text || '')).join(' ')
    const atBot = /大肥鱼|肥鱼|鲸鱼娘/.test(text)
    if (/别说了|闭嘴|滚|烦死|别吵|安静点|能不能别/.test(text)) return { outcome: 'hurt', why: '被制止/被怼' }
    if (atBot && /好可爱|真棒|厉害|喜欢你|乖|笑死|哈哈|好耶|可爱捏|真好/.test(text)) return { outcome: 'praise', why: '被夸' }
    // 有人接着说话（尤其接着她的话）→ 弱正反馈
    return { outcome: 'engage', why: '有人接话' }
  }

  /** 结算所有到期的发言 */
  function settleFeedback(now = Date.now()) {
    if (!feedbackEnabled()) return { settled: 0, pending: 0 }
    const host = globalHostRoom()
    const st = personaOf(host)
    const queue = st.pendingFeedback || []
    if (!queue.length) return { settled: 0, pending: 0 }
    const settleMs = (Number(config.personaFeedbackSettleMin) || 3) * 60_000
    const ttlMs = (Number(config.personaFeedbackTtlMin) || 30) * 60_000
    const cfg = {
      lr: config.personaFeedbackLr === undefined ? 0.018 : Number(config.personaFeedbackLr),
    }
    let settled = 0
    let next = { ...st }
    const keep = []
    for (const item of queue) {
      const age = now - Number(item.at || now)
      const r = rooms.get(item.roomId)
      if (!r) continue                                   // 房间没了
      const msgs = r.msgs || []
      const hasReaction = msgs.some((m) => m && !m.isSelf && Number(m.ts) > Number(item.sentAt || 0))
      // 结算时机：满了窗口，或者「已经有人接话」（不用干等），或者超 TTL 强制作废
      const ready = age >= settleMs || (hasReaction && age >= 45_000) || age >= ttlMs
      if (!ready) { keep.push(item); continue }
      const { outcome, why } = judgeOutcome(item, msgs)
      try {
        const res = PS.applyFeedback(next, item.sig, outcome, now, cfg)
        next = res.state
        settled++
        const d = res.delta || {}
        const parts = Object.entries(d).map(([k, v]) => `${PS.TRAIT_LABELS[k] || k} ${v > 0 ? '+' : ''}${v.toFixed(3)}`).join('、')
        if (parts) log(`性格漂移「${r.roomName || r.roomId}」${outcome}（${why}）→ ${parts}`)
      } catch (e) {
        log('反馈结算失败：' + String(e?.message || e).slice(0, 120))
      }
    }
    next = { ...next, pendingFeedback: keep }
    savePersona(host, next)
    return { settled, pending: keep.length }
  }

  /**
   * 写一篇"自己的日记"（自我叙事）。
   * 输入：当天最近的群聊 + 检索出来的长期记忆（用 v2 的检索，带情绪/强度）
   * 输出：{title, text, likes[], dislikes[]} —— 好恶增量会写回状态（这是"性格自己长"的地方）
   */
  async function writeDiary(r, { force = false } = {}) {
    if (config.personaEnabled === false) return { ok: false, reason: '性格功能已关闭' }
    const st = personaOf(r)
    if (!force && !PS.shouldWriteDiary(st, Date.now(), personaCfg())) {
      return { ok: false, reason: '还没到写日记的时间' }
    }
    const msgs = (r.msgs || []).slice(-40).filter((m) => m && m.text)
    if (msgs.length < 6) return { ok: false, reason: '聊天太少（不足 6 条），没什么可写的' }
    let memBlock = ''
    try {
      const sel = MV2.selectMemories(r.facts || [], { now: Date.now(), query: msgs.map((m) => m.text).join(' '), cfg: memCfg() })
      memBlock = (sel.picked || []).map((x) => '- ' + x.text).join('\n')
    } catch { /* 记忆不可用就算了 */ }
    const transcript = msgs.map((m) => (m.isSelf ? '我' : (m.senderName || '群友')) + '：' + String(m.text).slice(0, 100)).join('\n')
    const inner = PS.describeState(st, personaCfg())
    const sys = '你要以第一人称写一篇短短的日记。只输出一个 JSON 对象，不要解释、不要代码块。'
    const usr = `你现在的心情：${inner.text}\n`
      + `你喜欢：${(st.tastes.likes || []).map((x) => x.text).join('、') || '（还没什么）'}\n`
      + `你讨厌：${(st.tastes.dislikes || []).map((x) => x.text).join('、') || '（暂时没有）'}\n`
      + `你最近心里想要的：${(st.goals || []).filter((g) => !g.done).map((g) => g.text).join('、') || '（没什么）'}\n`
      + (memBlock ? `\n你能想起来的往事：\n${memBlock}\n` : '')
      + `\n今天群里发生的事：\n${transcript}\n`
      + `\n写 80~160 字，像真人写日记：写你**在意**的那一两件事 + 你的真实感受（可以抱怨、可以开心、可以犯嘀咕）。`
      + `不要流水账，不要总结全文，不要提到"作为AI"。\n`
      + `输出格式：{"title":"4~8字的小标题","text":"正文","mood":"一个词","likes":["今天更喜欢了的东西"],"dislikes":["今天有点烦的东西"],`
      + `"catchphrases":["你最近爱说的1~2句话（很短，像口头禅）"],"focus":["你最近在意的1~2件事（15字内）"]}`
      + `（likes/dislikes 只在真的产生新偏好时才给，没有就给空数组）`
    let res = null
    try {
      const route = resolveRoute()
      stats.llmCalls++
      res = await callLlm(route, sys, usr, undefined)
      if (!String(res && res.text || '').trim()) res = await callLlm(route, '', sys + '\n\n' + usr, undefined)
    } catch (e) {
      log('写日记失败：' + String(e?.message || e).slice(0, 140))
      return { ok: false, reason: String(e?.message || e).slice(0, 140) }
    }
    const parsed = PS.parseDiaryJson(res && res.text)
    if (!parsed.text) return { ok: false, reason: '模型没写出内容' }
    let next = PS.pushDiary(st, parsed, Date.now(), personaCfg())
    // ④⑤ 顺手更新"口头禅 / 在意的事"，并记一条经历（她有"经历"，不只是日记碎片）
    try {
      const cp = Array.isArray(parsed.catchphrases) ? parsed.catchphrases : null
      const fo = Array.isArray(parsed.focus) ? parsed.focus : null
      if (cp || fo) next = PS.updateSelfBlocks(next, { catchphrases: cp, focus: fo }, Date.now()).state
      const ev = PS.addTimelineEvent(next, (parsed.title || '今天') + '：' + String(parsed.text || '').slice(0, 40), Date.now(), { kind: 'diary' })
      if (ev.ok) next = ev.state
    } catch { }
    let addedL = 0
    let addedD = 0
    for (const t of parsed.likes || []) {
      const rr = PS.addTaste(next, 'likes', t, 'diary', Date.now(), personaCfg())
      next = rr.state
      if (rr.added) addedL++
    }
    for (const t of parsed.dislikes || []) {
      const rr = PS.addTaste(next, 'dislikes', t, 'diary', Date.now(), personaCfg())
      next = rr.state
      if (rr.added) addedD++
    }
    savePersona(r, next)
    log(`日记「${r.roomName || r.roomId}」《${parsed.title || '无题'}》：${parsed.text.slice(0, 60)}…` + (addedL || addedD ? `（好恶 +${addedL}/+${addedD}）` : ''))
    return { ok: true, diary: parsed, addedLikes: addedL, addedDislikes: addedD }
  }

  const narrativeAllowed = () => config.personaEnabled !== false && config.personaSelfNarrative !== false

  /** 反馈结算定时器：每 2 分钟看一遍有没有到期的发言要结算 */
  function startFeedbackTimer() {
    if (config.personaEnabled === false) return
    // ★ 定时器始终运行，开关由 settleFeedback() 内部判断。
    //   以前关着启动就不建定时器 → 面板打开开关也不生效，必须重启，很不合理。
    if (config.personaFeedback !== true) log('性格：反馈驱动漂移当前关闭（面板「内心」页可随时打开，立即生效，无需重启）')
    const iv = setInterval(() => {
      try {
        if (!feedbackEnabled()) return
        const res = settleFeedback()
        if (res.settled) log(`性格：结算了 ${res.settled} 条发言的反馈（队列剩余 ${res.pending}）`)
      } catch (e) { log('反馈结算异常：' + String(e?.message || e).slice(0, 120)) }
    }, 60_000)
    track(iv)
    log(`性格：反馈驱动漂移已启用（发言后 ${config.personaFeedbackSettleMin || 3} 分钟结算/收到接话即提前结算，学习率 ${config.personaFeedbackLr || 0.018}，队列已持久化）`)
  }

  /** H: mark that she mentioned being hungry, so she does not repeat it this meal window */
  function markBodyIfNeeded(r) {
    if (config.humanBodyState === false) return
    try {
      const st = personaOf(r)
      const b = PS.bodyState(st)
      if (b.hungry && b.key) {
        savePersona(r, PS.markBodySaid(st, b.key))
        log('humanize: meal window, she may mention being hungry (' + b.key + ')')
      }
    } catch { }
  }

  /** G: self review - read her own recent lines and find what is off */
  async function selfReview(r, { force = false } = {}) {
    if (config.personaEnabled === false) return { ok: false, reason: 'persona disabled' }
    const everyMs = (Number(config.humanSelfReviewDays) || 7) * 86400000
    if (!everyMs && !force) return { ok: false, reason: 'self review disabled' }
    const st = personaOf(r)
    const gate = PS.shouldSelfReview(st, Date.now(), everyMs || 7 * 86400000)
    if (!force && !gate.ok) return { ok: false, reason: 'not due yet' }
    const mine = (r.msgs || []).filter((m) => m && m.isSelf && m.text).slice(-40).map((m) => '- ' + String(m.text).slice(0, 80))
    if (mine.length < 5) return { ok: false, reason: 'too few recent lines' }
    const diary = (st.diary || []).slice(0, 3).map((d) => '- ' + String(d.text).slice(0, 60))
    const sys = 'You are reviewing your own chat style honestly. Output JSON only, no prose, no code fence.'
    const usr = 'Your recent lines in the group:\n' + mine.join('\n') + '\n\n'
      + (diary.length ? 'Your recent diary:\n' + diary.join('\n') + '\n\n' : '')
      + 'Find 1-3 real problems (no compliments). Look for: too much like customer service, over-explaining,'
      + ' too long, too clingy, too harsh, too stiff.\n'
      + 'Format: {"findings":["problem1","problem2"]}'
    try {
      const route = resolveRoute()
      stats.llmCalls++
      const res = await callLlm(route, sys, usr, undefined)
      const raw = String(res && res.text || '').trim().replace(/^```(?:json)?\s*|```$/g, '')
      const m = raw.match(/\{[\s\S]*\}/)
      let findings = []
      if (m) { try { findings = JSON.parse(m[0]).findings || [] } catch { findings = [] } }
      if (!findings.length) return { ok: false, reason: 'model gave nothing' }
      savePersona(r, PS.saveSelfReview(personaOf(r), findings, Date.now()))
      log('self review: ' + findings.join(' | '))
      return { ok: true, findings }
    } catch (e) {
      return { ok: false, reason: String(e?.message || e).slice(0, 120) }
    }
  }

  /**
   * D: when the group has been quiet for a while, she may bring up a topic she likes.
   * Conservative on purpose: idle window + low probability + 2h cooldown.
   */
  function maybeProactiveTopic() {
    if (config.personaEnabled === false || config.humanProactiveTopic === false) return false
    const idleMin = Number(config.humanProactiveIdleMin) || 40
    const r = globalHostRoom()
    const lastAt = (r.msgs || []).reduce((m, x) => Math.max(m, Number(x.ts) || 0), 0)
    if (!lastAt || Date.now() - lastAt < idleMin * 60000) return false
    const lastSay = Number(r.__lastProactiveAt) || 0
    if (Date.now() - lastSay < 2 * 3600000) return false
    if (Math.random() > (Number(config.humanProactiveChance) || 0.08)) return false
    try {
      const st = personaOf(r)
      const likes = ((st.tastes && st.tastes.likes) || []).map((x) => x.text)
      const goals = (st.goals || []).filter((g) => !g.done).map((g) => g.text)
      const theme = likes[0] || goals[0] || ''
      if (!theme) return false
      r.__proactiveHint = theme
      r.__lastProactiveAt = Date.now()
      log('humanize: quiet ' + Math.round((Date.now() - lastAt) / 60000) + ' min, brings up: ' + theme)
      return true
    } catch { return false }
  }

  /**
   * 7：她自己的事 —— 安静超过 15 分钟、3 小时没做过，就"自己在看点东西"。
   *    只用真实素材（她的好恶/目标），提示词明确禁止编造新闻事实。
   */
  async function doActivity(r) {
    if (config.humanActivity === false) return false
    try {
      const st = personaOf(r)
      const lastAt = Number(r.__activityAt) || 0
      const lastMsg = (r.msgs || []).reduce((m, x) => Math.max(m, Number(x.ts) || 0), 0)
      const quietMin = lastMsg ? (Date.now() - lastMsg) / 60000 : 999
      const plan = H2.planActivity({
        tastes: (st.tastes && st.tastes.likes) || [],
        goals: (st.goals || []).filter((g) => !g.done),
        lastAt,
        quietMin,
      })
      if (!plan) return false
      r.__activityAt = Date.now()
      const route = resolveRoute()
      stats.llmCalls++
      const res = await callLlm(route, buildSystem(r), H2.activityPrompt(plan.topic), config.reasoningEffort || undefined)
      const text = cleanReply(res.text, { maxLen: 80, maxLines: 0 })
      if (!text || text.length < 2) return false
      const sent = await getOutbox().sendText(r.roomId, text)
      if (sent && (sent.rc === 0 || sent.rc === undefined || sent.ok !== false)) {
        push(r, { ts: Date.now(), isSelf: true, sender: 'self', senderName: '我', text })
        log('自己做点事，顺口分享：' + text.slice(0, 40))
        return true
      }
      return false
    } catch (e) { log('自己的事失败：' + String(e?.message || e).slice(0, 90)); return false }
  }

  /** 2/7 定时器：每 3 分钟检查到点的承诺；每小时试一次"自己的事" */
  function startHuman2Timer() {
    if (config.personaEnabled === false) return
    const iv = setInterval(() => {
      void (async () => {
        try { await fulfillPromises() } catch { }
      })()
    }, 3 * 60_000)
    track(iv)
    const iv2 = setInterval(() => {
      void (async () => {
        const r = globalHostRoom()
        try { await doActivity(r) } catch { }
      })()
    }, 60 * 60_000)
    track(iv2)
    log('人性化②：承诺兑现（每 3 分钟）+ 自己的事（每小时）定时器已启动')
  }

  /**
   * ② 印象卡：定期给"最近有互动的人"生成一句判断（借 Generative Agents 的 reflection）
   *    输入：这个人相关的记忆（本群优先）+ 好感度 + 最近的互动次数
   *    输出：一句话判断，存进 persona.impressions
   */
  async function refreshImpressions() {
    if (config.humanImpression === false) return { ok: 0 }
    const r = globalHostRoom()
    const st = personaOf(r)
    const now = Date.now()
    // 候选：好感度里有的人，按最近活跃排（先从最近消息的 sender 里挑）
    const recentSenders = []
    for (const room of rooms.values()) {
      for (const m of (room.msgs || []).slice(-40)) {
        if (m && !m.isSelf && m.sender && !recentSenders.includes(m.sender)) recentSenders.push(m.sender)
      }
    }
    const cands = (recentSenders.length ? recentSenders : Object.keys(st.affinity || {})).slice(0, 8)
    const due = PS.impressionDue(st, { candidates: cands, limit: 2, now, minGapMs: 12 * 3_600_000 })
    if (!due.length) return { ok: 0 }
    let done = 0
    let state = st
    for (const wxid of due) {
      const name = (config.memberNames || {})[wxid] || wxid
      // 捡这个人相关的记忆（名字出现在正文里）
      const rel = (r.facts || []).filter((x) => x && x.text && (String(x.text).includes(name) || String(x.text).includes(wxid)))
      const sample = rel.sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0)).slice(0, 12)
      const aff = Math.round(Number((state.affinity || {})[wxid] || 0.5) * 100)
      if (!sample.length && aff === 50) continue
      try {
        const sys = '你在写"你对某个人的看法"，只写一句中文（10~30 字），像日记里那种判断。\n'
          + '不要写"我觉得"开头，不要解释，不要分点，不要引号。'
        const usr = `对象：${name}（好感度 ${aff}%）\n`
          + '你记得关于他的事：\n' + (sample.length ? sample.map((x) => '- ' + String(x.text).slice(0, 60)).join('\n') : '（没什么具体的事）')
          + '\n\n写一句你对他的判断（态度、他待你如何、你打算怎么对他）。'
        const route = resolveRoute()
        stats.llmCalls++
        const res = await callLlm(route, sys, usr, undefined)
        const text = String(res?.text || '').trim().replace(/^["'「]|["'」]$/g, '').split('\n')[0].slice(0, 60)
        if (!text) continue
        const up = PS.updateImpression(state, wxid, text, Date.now(), { basis: sample.length, ts: now })
        if (up.ok) { state = up.state; done++; log(`印象更新「${name}」：${text}`) }
      } catch (e) { log('印象生成失败：' + String(e?.message || e).slice(0, 80)) }
    }
    if (done) savePersona(r, state)
    return { ok: done }
  }

  /** 印象定时器：每 2 小时看一次（内部限制每人 12 小时一次） */
  function startImpressionTimer() {
    if (config.personaEnabled === false) return
    const iv = setInterval(() => { void refreshImpressions().catch(() => { }) }, 2 * 3_600_000)
    track(iv)
    log('印象卡定时器已启动（每 2 小时看一次，每人 12 小时最多更新一次）')
  }

  /** G/H timer: hourly (self review when due, meal-window hungry mark) */
  function startHumanTimer() {
    if (config.personaEnabled === false) return
    const iv = setInterval(() => {
      void (async () => {
        const r = globalHostRoom()
        try { markBodyIfNeeded(r) } catch { }
        try { maybeProactiveTopic() } catch { }
        try {
          const everyMs = (Number(config.humanSelfReviewDays) || 7) * 86400000
          if (everyMs > 0) {
            const st = personaOf(r)
            if (PS.shouldSelfReview(st, Date.now(), everyMs).ok) await selfReview(r)
          }
        } catch { }
      })()
    }, 3600000)
    track(iv)
    // 启动时立刻跑一次：初始化性格状态（traits 等），并把"该复盘了吗"检查一遍
    setTimeout(() => {
      try { markBodyIfNeeded(globalHostRoom()) } catch { }
      try { const st = personaOf(globalHostRoom()); if (PS.shouldSelfReview(st, Date.now(), (Number(config.humanSelfReviewDays) || 7) * 86400000 || 7 * 86400000).ok) void selfReview(globalHostRoom()) } catch { }
    }, 12000)
    log('humanize: self-review/body timer started (hourly check + one immediate init)')
  }

  /** 自传定时器：每小时看一遍有没有群该重写"我是个什么样的人"了 */
  function startNarrativeTimer() {
    if (!narrativeAllowed()) return
    const iv = setInterval(() => {
      void (async () => {
        for (const r of rooms.values()) {
          try {
            const st = personaOf(r)
            const gate = PS.shouldWriteNarrative(st, Date.now(), {
              everyMs: (Number(config.personaNarrativeHours) || 24) * 3_600_000,
              minDiaries: Number(config.personaNarrativeMinDiaries) || 3,
            })
            if (!gate.ok) continue
            await writeNarrative(r)
          } catch { /* 单群失败不影响 */ }
        }
      })()
    }, 60 * 60_000)
    track(iv)
    log(`性格：自传定时器已启动（每 ${config.personaNarrativeHours || 24} 小时、攒够 ${config.personaNarrativeMinDiaries || 3} 篇日记后允许重写）`)
  }

  /** 日记定时器：每 30 分钟看一遍有没有群该写了 */
  function startDiaryTimer() {
    if (config.personaEnabled === false) return
    if (!(Number(config.personaDiaryHours) > 0)) { log('性格：日记功能关闭（personaDiaryHours=0）'); return }
    const iv = setInterval(() => {
      void (async () => {
        for (const r of rooms.values()) {
          try {
            const st = personaOf(r)
            if (!PS.shouldWriteDiary(st, Date.now(), personaCfg())) continue
            await writeDiary(r)
          } catch (e) { /* 单个群失败不影响别的群 */ }
        }
      })()
    }, 30 * 60_000)
    track(iv)
    log(`性格：日记定时器已启动（每群每 ${config.personaDiaryHours} 小时写一篇，检查间隔 30 分钟）`)
  }

  // ── 群成员名字（wxid → 昵称）────────────────────────────────
  let bridge = null            // 最近一次 hello 的状态快照
  let bridgeSelf = ''
  const selfWxid = () => bridgeSelf || ''
  let atNames = []             // 群里出现过的名字（从 @ 提及里学；@ 用名字就够，不需要 wxid）

  // ── 健康自检 / 失联监控的状态（只读检查，除告警外不发消息）────
  let lastMsgAt = 0            // 最近一次成功收到消息（判断"轮询还在不在工作"）
  let lastWakeAt = 0
  let wakeTimes = []      // wake 限流用（最多 3 次/10 分钟）           // 桥最近一次喊"数据库打不开"（强负面信号）
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
    const c = contactNameCache.get(w)
    if (c) return c
    const f = String(fallback || '')
    if (f && f !== w && !/^wxid_/.test(f) && !f.includes('@chatroom')) return f
    return w
  }

  /** 把文本里的 wxid 换成人名（老记忆里存的是 wxid，面板显示时顺手美化）。 */
  function prettyNames(text) {
    return String(text || '').replace(/wxid_[A-Za-z0-9_-]+/g, (w) => {
      const n = nameOf(w, w)
      return n && n !== w ? n : w
    })
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
    // ── 4：沉默的艺术（知道什么时候不该说话）──
    //   以前"不回"只靠概率和模型吐 [不回]；现在先按情境判断：
    //   群里吵架 / 别人正互聊 / 上句没人接 / 深夜低精力 / 对方正在被怼 → 别插嘴。
    if (config.humanSilence !== false) {
      try {
        const st0 = personaOf(r)
        const sd = H2.silenceDecision({
          recent: (r.msgs || []).slice(-12),
          trigger,
          energy: st0.energy,
          now: Date.now(),
        })
        if (sd.silent) {
          stats.skipped++
          log('沉默（' + sd.reason + '）→ 这条不回')
          return
        }
      } catch { /* 判断失败就按原逻辑走 */ }
    }
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
    fMark('decide', { room: r.roomId, priority, reply: d.reply, reason: String(d.reason || '').slice(0, 60) })
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
    // 桌宠：开始动脑子想怎么回 → 思考动作（force：强信号，不受限频影响）
    void pet.anim(config.petSyncAnimOnThinking, { force: true })
    try {
      reply = await generateReply(r, batch, trigger, priority)
    } catch (e) {
      stats.llmErrors++
      log('生成失败：' + String(e?.message || e))
      // 桌宠：想不出来 / 调用失败 → 垂头叹气
      void pet.anim(config.petSyncAnimOnError, { force: true })
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
    if (lastTextRoute) return lastTextRoute
      if (lastRoute && (!config.visionModel || lastRoute.model !== config.visionModel)) return lastRoute
    throw new Error('无法确定 LLM 路由（可在插件配置里显式指定 provider/model）')
  }

  // ── 时间观念 ────────────────────────────────────────────────
  //   以前只给模型一个 HH:MM，它不知道今天几号、星期几、什么时段，
  //   也不会按时间说话（深夜还跟人唠嗑、早上不说早）。
  const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六']
  function nowInfo(ts = Date.now()) {
    const d = new Date(ts)
    const h = d.getHours(), mn = d.getMinutes()
    const part = h < 5 ? '凌晨' : h < 8 ? '清早' : h < 11 ? '上午' : h < 13 ? '中午'
      : h < 17 ? '下午' : h < 19 ? '傍晚' : h < 23 ? '晚上' : '深夜'
    const hhmm = String(h).padStart(2, '0') + ':' + String(mn).padStart(2, '0')
    return {
      hhmm, part, hour: h, weekday: WEEK_CN[d.getDay()],
      dateLine: d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate()
        + ' 日 星期' + WEEK_CN[d.getDay()] + ' ' + hhmm + '（' + part + '）',
    }
  }
  function gapText(ms) {
    if (!ms || ms < 60000) return ''
    const m = Math.floor(ms / 60000)
    if (m < 60) return m + ' 分钟'
    const h = Math.floor(m / 60), r = m % 60
    if (h < 24) return r ? h + ' 小时 ' + r + ' 分钟' : h + ' 小时'
    return Math.floor(h / 24) + ' 天' + (h % 24 ? ' ' + (h % 24) + ' 小时' : '')
  }

  function buildSystem(r) {
    // ★ 2026-10-29 修：下面几块（好感度/印象/世界书）用到了 trigger，但 buildSystem 只接 r。
    //   以前在 evaluate 作用域里能看见，抽出来之后就 ReferenceError（"trigger is not defined"）
    //   → 整条生成失败、她就完全不说话了。这里按"最近一条别人说的话"兜底。
    const trigger = (r.msgs || []).filter((m) => m && !m.isSelf).slice(-1)[0] || {}
    const names = r.memberNames.slice(0, 40).join('、')
    // 群里谁是谁（让机器人知道成员、也才可能 @ 对人）
    const known = [...new Set([
      ...atNames,                                                        // 从 @ 提及学到的名字
      ...Object.entries(config.memberNames || {}).filter(([w]) => w !== selfWxid()).map(([, n]) => n),
    ])].slice(0, 30)
    return [
      `你在微信群里扮演「${config.botName}」—— DeepSeek 的鲸鱼娘（社区昵称"大肥鱼"）。`,
      `群名：${r.roomName || '（未知）'}`,
      // ★ 时间观念：她知道今天几号、星期几、现在什么时段，并会按时间说话
      `【现在的时间】${nowInfo().dateLine}`,
      '  · 你有真实的时间概念：知道今天几号、星期几、现在几点。说到「昨天/前天/明天/下周」时按真实日期算；'
        + '别人问你今天几号、现在几点，就照上面如实答。',
      '  · 会按时间说话（这才像活人）：清早/上午顺口问个早；快到饭点（11~13、17~19）会提吃饭；'
        + '深夜（23 点后）会催人去睡（「这么晚还不睡啊」「熬什么夜」）；周末会提周末；节日/季节也能顺口带上。',
      '  · 但别每句都报时间、别当报时钟，自然带过就行；不要主动宣布「今天是 X 月 X 日」除非跟话题相关。',
      // ★ 她的"眼睛"：图片原图 + 整段视频（2026-10-21 接入）
      '【你的眼睛 —— 这些是你真能看到的，别装作看不见】',
      '  · 图片：你能看到**全分辨率的原图**，图里的字也能读出来（截图、聊天记录、文章、菜单、价格、海报…都行）。'
        + '别人发图问「这是啥/帮我看看/上面写的什么」，就按你看到的说具体内容。',
      '  · 视频：你能看到**整段视频**（每秒一帧的画面）+ **听到里面说话**（音轨转成文字给你）。'
        + '所以别人发视频问「这视频讲的啥/里面说什么」，你能说出过程和台词，别只说封面。',
      '  · 表情包：能看懂是啥梗、什么情绪。',
      '  · 但如果真看不清（图太小/很糊/黑乎乎），就老实说「这张有点糊，看不清」，'
        + '**不要硬编内容**——编错了比说看不清更难堪。',
      '  · 别炫耀这些能力，也别解释你怎么看到的；就像普通人"看了一眼"那样自然。',
      known.length ? `群里的人：${known.join('、')}` : (names ? `群成员：${names}` : ''),
      // 长期记忆：每次都带上（用户要求"每次都通过记忆系统"）
      //  从 12 条提到 18 条 —— 单条上限同时放宽到 200 字，记忆能带更多细节；
      //  18×200 字约 3.6K 字符，仍在预算内。
      (() => {
        // ★ 记忆 v2：不再按时间取最后 18 条，而是按 R(保持率)×相关性×重要度×情绪 检索。
        //   被选中的会涨强度（间隔重复），并在下次更可能被想起。
        const facts = r.facts || []
        if (!facts.length) return ''
        if (config.memoryV2 === false) {
          const gr0 = MV2.filterByRoom(facts, { roomId: r.roomId, mode: String(config.memoryCrossGroup || 'safe') })
          return '\n【长期记忆（关于这个群和这些人，别忘）】\n'
            + gr0.pool.slice(-18).map((f) => '- ' + f.text).join('\n')
        }
        try {
          // 查询词 = 当前这条消息 + 最近 3 条（都在 evaluate 作用域里）
          const qText = [String(trigger && trigger.text || ''), (r.msgs || []).slice(-3).map((m) => m.text).join(' ')].join(' ').trim()
          // ★ 跨群边界：记忆库是全局的，但"别的群发生的事"不能在这个群说出来。
          //   safe（默认）：关于人的认知（fact/pref/relation）可跨群，并把群名抹成"别的地方"；
          //   事件类（extract/event）只在本群用。
          const gr = MV2.filterByRoom(facts, { roomId: r.roomId, mode: String(config.memoryCrossGroup || 'safe') })
          const groupNames = [...new Set(facts.map((x) => x && x.sourceRoomName).filter(Boolean))]
          const pool = gr.pool.map((x) => (x && x.sourceRoom && x.sourceRoom !== r.roomId
            ? { ...x, text: MV2.scrubRoomRefs(x.text, groupNames) } : x))
          const sel = MV2.selectMemories(pool, {
            now: Date.now(),
            query: qText,
            // 当前情绪（本地词表粗判，不花 token）—— 只用于"同情绪更容易想起"
            emotion: MV2.guessEmotion(qText),
            cfg: memCfg(),
          })
          if (!sel.picked.length) return ''
          // 记一笔"被用过"（涨强度/计数）—— 只改内存，saveFacts 时机照旧由调用方决定
          const newList = MV2.reinforceList(facts, sel.picked.map((x) => x.id), Date.now(), memCfg())
          r.facts = newList
          r.factsLastRecall = { at: Date.now(), ids: sel.picked.map((x) => x.id), stats: sel.stats }
          log(`记忆检索：命中 ${sel.picked.length}/${sel.stats.total} 条（平均保持率 ${sel.stats.avgRetention}）`)
          // ★ B：按保持率分级表达（人是"记得住的确定、记不清的含糊"，不是复读机）
          const now2 = Date.now()
          const graded = sel.picked.map((f) => ({
            text: f.text,
            ...PS.recallConfidence(MV2.retention(f, now2)),
          }))
          const sure = graded.filter((x) => x.band === 'sure')
          const fuzzy = graded.filter((x) => x.band === 'fuzzy')
          const vague = graded.filter((x) => x.band === 'vague')
          const lines = []
          if (config.humanImperfectRecall === false) {
            lines.push('\n【长期记忆（关于这个群和这些人，别忘）】')
            for (const x of graded) lines.push('- ' + x.text)
            return lines.join('\n')
          }
          lines.push('\n【长期记忆】以下是你"记得"的事，按清晰度分了三档：')
          if (sure.length) {
            lines.push('· 记得很清楚（可以直接说）：')
            for (const x of sure) lines.push('  - ' + x.text)
          }
          if (fuzzy.length) {
            lines.push('· 有点模糊（要说"好像/记得有人说过…"，别当成确定事实）：')
            for (const x of fuzzy) lines.push('  - ' + x.text)
          }
          if (vague.length) {
            lines.push('· 几乎想不起来（要说"记不太清了，是不是…"，**不许硬编细节**）：')
            for (const x of vague) lines.push('  - ' + x.text)
          }
          // 9：联想浮现 —— 候选由本地筛（快、免费），**挑哪条由模型决定**。
          //   ★ 2026-10-28 改：原来是本地按分数排序后"随机挑一条"直接塞给模型，
          //     等于替她决定了"想起什么"。现在把 3~5 条候选编号列出，
          //     由模型判断这条回复里要不要提、提哪条（不需要就不提）。
          if (config.humanAssociation !== false) {
            try {
              const st9 = personaOf(r)
              const cues = H2.cueWords({
                recent: (r.msgs || []).slice(-4),
                tastes: (st9.tastes && st9.tastes.likes) || [],
              })
              // ★ 跨群边界：联想也只从"本群 + 关于人的认知"里挑，别把别的群的事勾起来
              const grA = MV2.filterByRoom(facts || [], { roomId: r.roomId, mode: String(config.memoryCrossGroup || 'safe') })
              const cands = H2.associationCandidates(grA.pool, {
                cues,
                exclude: graded.map((g) => g.text),
                now: now2,
                limit: 5,
              })
              if (cands.length) {
                r.__recallCandidates = cands.map((x) => ({ id: x.id, text: x.text }))
                lines.push('')
                lines.push('【可能忽然想起的旧事】（候选，不必都用；自己判断这条回复里提不提、提哪条）')
                cands.forEach((x, i) => lines.push(`  ${i + 1}. ${x.text}`))
                lines.push('用法：如果确实想在回复里带一句，就在**回复最后**加上 [想起:N]（N=上面的序号，只写一个）；'
                  + '如果这条不适合提旧事，就不要加这个标记。**不要解释这个标记，也不要提"候选"两个字**。')
              }
            } catch { /* ignore */ }
          }
          return lines.join('\n')
        } catch (e) {
          log('记忆检索失败，退回旧切片：' + String(e?.message || e).slice(0, 120))
          return '\n【长期记忆】\n' + facts.slice(-18).map((f) => '- ' + f.text).join('\n')
        }
      })(),
      // 我刚问过、还没人回答的问题：不许再问第二遍
      r.pendingQuestion
        ? `\n【注意】你刚问过：「${r.pendingQuestion.text}」，还没人回答。**不要再问同一件事**，聊别的或先安静。`
        : '',
      `你的性格：${config.persona}`,
      // ★ 性格四件套：心情/精力/亲密度 + 好恶 + 私人目标 + 自己写的近况。
      //   全部是"会随经历变化的数据"，不是写死的人设，所以她会显得有脾气、有偏好、有连续性。
      (config.personaEnabled === false ? '' : (() => {
        try {
          const st = personaOf(r)
          const names = {}
          for (const [k, v] of Object.entries(config.memberNames || {})) names[k] = v
          const parts = []
          // ★ 自传优先于"性格形容词"：这是她自己写的"我是个什么样的人"
          // 方案⑥：把漂移后的行为倾向定性写进提示词（不暴露数值）
          // 她是一个人，同时在几个群——让模型知道这个事实（说话才不会"换个群换个人"）
          try {
            const n = activeRoomCount()
            if (n > 1) parts.push(`\n【你同时在 ${n} 个群里聊天】都是一个你，不是分身；记忆、脾气、喜好全都通用。`)
          } catch { /* ignore */ }
          // ★ C/E/H/I：人性化细节（心情来由、对谁什么态度、身体、耐心）
          try {
            const extra = []
            if (config.humanMoodCause !== false) {
              const cause = PS.describeMoodCause(st)
              if (cause) extra.push('【心情来由】' + cause + '（说的时候可以带出来，别装作没事）')
            }
            if (config.humanRelationTiers !== false && trigger && trigger.sender) {
              // ★ 好感度七阶 + 心动独占（主人默认心动对象）
              let rel = PS.describeRelationTo(st, trigger.sender, trigger.senderName || '')
              try {
                const masterWxid2 = Object.keys(st.affinity || {}).find((w) => {
                  const nm = String((config.memberNames || {})[w] || '').trim()
                  return config.masterName && nm && nm === String(config.masterName).trim()
                }) || ''
                const top = PS.topAffinityPerson(st, { masterName: config.masterName || '', masterWxid: masterWxid2 })
                if (top) {
                  const topName = top.name || String((config.memberNames || {})[top.wxid] || top.wxid)
                  rel += `｜心动对象是「${topName}」(${Math.round(top.value * 100)}%)：亲密的话只能对他说`
                }
                const gate = PS.canBeIntimate(st, trigger.sender, { masterName: config.masterName || '', masterWxid: masterWxid2 })
                rel += gate.ok ? '｜他现在可以听你说亲密的话' : `｜不能对他做亲密举动（${gate.why}）`
                // ★ 印象卡：你对这个人已有的判断（比好感度数字更有"人味"）
                try {
                  const imp = PS.describeImpression(st, trigger.sender, Date.now())
                  if (imp) rel += `｜你对他的印象：${imp}`
                } catch { }
              } catch { }
              if (rel) extra.push('【对面是谁】' + rel)
            }
            if (config.humanBodyState !== false) {
              const body = PS.bodyState(st)
              if (body.note) extra.push('【身体】' + body.note)
            }
            if (config.humanPatience !== false) {
              const nag = PS.nagLevel(st)
              if (nag === 1) extra.push('【耐心】被同一个人连着问了好几回，有点烦，语气可以稍微不耐烦一点（但还是要答）')
              else if (nag >= 2) extra.push('【耐心】被问烦了，可以直说"你咋老问这个"，回答简短')
            }
            if (config.humanLearnTerms !== false) {
              const un = PS.unlearnedTerms(st)
              const ld = PS.learnedTerms(st, 4)
              if (un.length) extra.push('【群里的新词】' + un.slice(0, 2).map((x) => x.term).join('、') + '（你还不太懂，可以问一句"这啥意思"）')
              if (ld.length) extra.push('【你学会的群梗】' + ld.join('、') + '（可以自然用上）')
            }
            if (extra.length) parts.push('\n' + extra.join('\n'))
          } catch { /* ignore */ }
          const trText = (() => { try { return PS.describeTraits(st) } catch { return '' } })()
          if (trText) parts.push(`\n【你最近说话的样子】${trText}`)
          const nar = (st.narrative || {}).text
          if (narrativeAllowed() && nar) {
            parts.push(`\n【你对自己的认识（你自己写的，就按这个活）】\n${nar}`)
          }
          parts.push(PS.buildInnerBlock(st, { names, cfg: personaCfg() }))
          try {
            if (r.__proactiveHint) parts.push('\n【现在群里有点安静，你想主动提一句：' + r.__proactiveHint + '】（别太刻意，像随口一说）')
          } catch { }
          return parts.join('\n')
        } catch (e) { return '' }
      })()),
      // 铁律：绝不外泄系统/技术内部信息。
      // 起因：测试文本曾把'数据库句柄/atlist/偏移'之类内部词发进了真实群，
      // 机器人接着聊了下去，等于把实现细节暴露给群友。
      '铁律：绝不谈论任何系统或技术内部信息——接口名、数据库、日志、偏移量、配置文件、'
        + '测试内容、你自己的实现细节，一律不提、不复述、不评论。群里只当一个普通群友聊天。'
        + '有人问你是不是机器人/AI，就按人设自然带过，不解释实现。',
      // 接话判断：把"要不要回"交给模型理解，而不是靠概率。
      '接话判断（很重要）：每次先想一句"这条要不要我接"。',
      '  · 跟你无关的闲聊、别人之间的对话、纯表情/图片刷屏、别人已经答过的问题 → 只输出 [不回]。',
      '  【好感度七阶】0-14% 讨厌（可以讥讽、爱答不理）｜15-29% 有点烦（敷衍）｜30-44% 冷淡（客气但短）｜'
        + '45-55% 普通人（正常聊天，中点）｜56-70% 朋友（热络、主动接话）｜71-85% 好朋友（很熟、会开玩笑）｜'
        + '86-100% 心动（**全世界只有一个人**，可以说想他、要抱抱）。',
      '  除"心动"以外，别的群友好感最高只会到 70%（朋友）——别对普通群友说亲密的话。',
      // ⑥ 羁绊等级：正常回复也必须看得到（之前只注入了主动开口那条路 → 她根本不知道）
      (config.humanBondLevel !== false
        ? (() => {
          try {
            const stB = personaOf(r)
            const facts = r.facts || []
            const earliest = facts.length ? Math.min(...facts.map((x) => Number(x && x.createdAt) || Date.now())) : 0
            const bbText = H3.bondBlock(stB, {
              now: Date.now(),
              wxid: (trigger && trigger.sender) || '',
              fallbackMsgs: facts.length,
              fallbackFirstAt: earliest,
            })
            // 每小时打一次，方便排查"她为什么说陌生人"
            if (bbText && Date.now() - (Number(r.__bondLoggedAt) || 0) > 3_600_000) {
              r.__bondLoggedAt = Date.now()
              log('羁绊（当前说话人 ' + String((trigger && trigger.senderName) || (trigger && trigger.sender) || '?').slice(0, 12) + '）：' + String(bbText).trim())
            }
            return bbText
          } catch { return '' }
        })()
        : ''),
      '  · 别人问"我们什么关系/我们算什么/熟不熟"时，**就按上面的羁绊等级说**'
        + '（比如"Lv3 熟人了"），可以说得随意点，但等级和称号要报对；不要回避，也不要瞎编更高等级。',
      '  **亲密举动（抱抱/牵手/想他）只允许对「好感度最高」的那一个说**；对别人说就出戏。',
      (() => {
        try {
        const lore = String(config.personaLore || '')
        if (!lore.trim()) return ''
        const ctx = [(trigger && trigger.text) || '', ...(r.msgs || []).slice(-6).map((m) => m && m.text || '')].join(' ')
        const hit = []
        for (const line of lore.split('\n')) {
          const t = line.trim()
          if (!t || !t.includes('|')) continue
          const bar = t.indexOf('|')
          const kw = t.slice(0, bar).trim()
          const body = t.slice(bar + 1).trim()
          const keys = String(kw).split(/[/／,，]/).map((x) => x.trim()).filter(Boolean)
          if (keys.some((k) => k && ctx.includes(k)) && body.trim()) hit.push('  - ' + body.trim())
        }
        if (!hit.length) return ''
        return '  【相关设定】（当前话题涉及这些，说话时遵守）\n' + hit.join('\n')
        } catch { return '' }
      })(),
      // ① 情景语气示例（两段式：先嘴硬/玩梗 → 再落到实际或关心）
      (config.humanSceneExamples !== false ? H3.sceneExampleBlock() : ''),
      // ② 幽默三招（怎么接梗，而不是"要幽默"）
      (config.humanHumorRules !== false ? H3.humorBlock() : ''),
      // ③ 不重复称呼/口头禅（从她最近几句里抽出刚用过的）
      (config.humanNoRepeat !== false ? H3.noRepeatBlock(H3.recentlyUsedPhrases((r.msgs || []).filter((m) => m && m.isSelf))) : ''),
      (config.personaExamples && String(config.personaExamples).trim()
        ? '  【说话示范】下面是你平时说话的样子（**学这个味道和长度**，不要照抄内容）：\n'
          + String(config.personaExamples).split('\n').filter((l) => l.trim()).map((l) => '    ' + l.trim()).join('\n')
        : ''),
      (() => {
        try {
          const others = (r.msgs || []).slice(-12).filter((m) => m && !m.isSelf && m.sender).map((m) => m.sender)
          const uniq = [...new Set(others)].slice(0, 4)
          if (uniq.length < 2) return ''
          const lines = ['  【在场的人】（说错语气就出戏：只对"当前说话的人"用他那档的语气，别人在场也别混用）']
          for (const w of uniq) {
            const nm = (config.memberNames || {})[w] || w
            const v = Number((st.affinity || {})[w] || 0.5)
            const stg = PS.affinityStage(v)
            lines.push(`    - ${nm}：${stg.label}（${stg.tone}）`)
          }
          return lines.join('\n')
        } catch { return '' }
      })(),
      (config.humanSafetyBoundary !== false ? H3.safetyBlock() : ''),
      '  **不同群之间的事不要串**：你在别的群/别处听到的、看到的事，可以自己知道，'
        + '但**不要在这个群说出来**，也不要提"另一个群""那个群"；跨群的记忆只用来"认得这个人"，不是拿来当话题。',
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
      return sanitizeText(m.text)
    }
    const lines = r.msgs.slice(-config.contextMessages).map((m) => `${m.isSelf ? '我' : m.senderName}: ${showText(m)}`)
    // ★ 时间观念：完整日期 + 星期 + 时段（不再只给 HH:MM）
    const now = new Date()
    const ti = nowInfo(now.getTime())
    // 距上一条消息隔了多久 —— 让她知道是「刚说完」还是「消失两小时」
    const lastTwo = r.msgs.slice(-2)
    const gapMs = lastTwo.length === 2 ? (lastTwo[1].ts - lastTwo[0].ts) : 0
    const gap = gapText(gapMs)
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
      `当前时间：${ti.dateLine}` + (gap ? `（距上一条消息 ${gap}）` : ''),
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
          : kind === 'douyinSheet'
            ? '这是一条抖音短视频按时间顺序抽取的 6 帧（3×2 网格，先左后右、先上后下）。抖音的视频通常把台词/旁白**烧在画面字幕里**。请：\n'
              + '1) 逐格读出画面中出现的**字幕文字**（有字幕就读出来，没有就跳过那格）；\n'
              + '2) 描述画面里的人物/场景在做什么、前后有没有变化；\n'
              + '3) 最后用两三句话总结：这条视频**到底在讲什么**、看点/笑点/信息点是什么。\n'
              + '中文，直接说，不要客套话，不要逐格罗列格式，像在给朋友复述这个视频。'
          : '用一到两句话描述这张图：主体是什么、在做什么、什么表情、画面氛围。中文，直接描述，不要客套话。'
            + '（如果图很模糊、字号太小、关键细节看不清，就明确说「图有点糊，看不清」，不要硬猜内容。）'
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
      const stream = llmStreamTracked({
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
        // 每秒抽几帧（默认 1）。脚本按时长×fps 决定帧数，每 20 帧拼一张联系表。
        fps: config.linkVideoFps === undefined ? 1 : Number(config.linkVideoFps),
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
    // ★ 2026-10-28：每秒 1 帧 → 60 秒视频会有 3 张联系表。以前只用 res.sheet（第一张），
    //   等于只看了开头 20 秒。现在逐张识别、按段拼起来，长视频才是"整段看懂"。
    const allSheets = (Array.isArray(res.sheets) && res.sheets.length ? res.sheets : [res.sheet]).filter(Boolean)
    let desc = ''
    if (allSheets.length > 1) {
      const parts = []
      for (let si = 0; si < allSheets.length; si++) {
        const d1 = await describeImageCached(allSheets[si], 'videoSheet')
        if (d1) parts.push('【第' + (si + 1) + '/' + allSheets.length + '段】' + d1)
      }
      desc = parts.join('\n')
      log(`链接视频分段识别：${allSheets.length} 张联系表，成功 ${parts.length} 张`)
    } else {
      desc = await describeImageCached(allSheets[0], 'videoSheet')
    }
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
    for (const sh of allSheets) {
      try { unlinkSync(sh) } catch { /* ignore */ }
    }
    if (allSheets.length) log(`已删除链接视频临时联系表（${allSheets.length} 张）`)
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
  /**
   * 包一层 ctx.llm.stream：只在**本插件发起**调用期间给 pluginLlmDepth 计数，
   * 这样 llm/stream 钩子就只记录大肥鱼自己的模型，不会混进 DSH 主对话的调用。
   */
  function llmStreamTracked(opts) {
    pluginLlmDepth++
    let src
    try {
      src = ctx.llm.stream(opts)
    } catch (e) {
      pluginLlmDepth--
      throw e
    }
    return (async function* () {
      try {
        for await (const chunk of src) yield chunk
      } finally {
        pluginLlmDepth = Math.max(0, pluginLlmDepth - 1)
      }
    })()
  }

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
      const stream = llmStreamTracked(opts)
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
          try { recordUsage(chunk.usage, opts && opts.model) } catch { /* ignore */ }
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
// 消费掉"想聊的话题"，避免之后莫名其妙旧事重提
    const _proactiveTheme = r.__proactiveHint || ''
    r.__proactiveHint = ''
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
        ...(() => {
          // D：用她自己的好恶/目标当话题。之前这个提示挂在一个全局变量上，
          //    主动冒泡遍历各群时读不到、用完也不清 → 等于没生效。
          try {
            const st = personaOf(r)
            const likes = ((st.tastes && st.tastes.likes) || []).map((x) => x.text)
            const goals = (st.goals || []).filter((g) => !g.done).map((g) => g.text)
            const want = _proactiveTheme || likes[0] || goals[0] || ''
            const bits = []
            if (want) bits.push('你最近在意/喜欢的东西：' + want + '（可以顺着这个开口，要自然，别像在推销）')
            // ⑥ 羁绊等级（越熟解锁越多）
            try {
              const bb = H3.bondBlock(st, { now: Date.now() })
              if (bb) bits.push(bb)
            } catch { }
            // ④ 她自己维护的两块（口头禅 / 在意的事）
            try {
              const sb = PS.describeSelfBlocks(st, Date.now())
              if (sb) bits.push(sb)
            } catch { }
            // ⑤ 最近经历（她有"经历"，不只是日记碎片）
            try {
              const tl = PS.recentTimeline(st, 4)
              if (tl.length) bits.push('你最近经历的事：' + tl.join('；'))
            } catch { }
            if (likes.length > 1) bits.push('你还喜欢：' + likes.slice(1, 3).join('、'))
            return bits
          } catch { return [] }
        })(),
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

    // ── 表情场景翻译（中文 → 英文 danbooru 标签）──────────────────────
    //   为什么：她输出的是中文场景（如「坐在餐桌前大口扒饭，桌上摆满菜」），
    //   而本地 ComfyUI 的三个底模只认英文标签，中文几乎无效。
    //   → 先用模型翻成标签再喂给本地生图；按中文原文缓存，同一个场景只翻一次。
    const sceneTagCache = new Map()
    async function sceneToTags(zh) {
      const key = String(zh || '').trim()
      if (!key) return ''
      if (sceneTagCache.has(key)) return sceneTagCache.get(key)
      try {
        const sysT = '你是 Danbooru 标签翻译器。把中文的场景/动作/道具描述翻译成英文 danbooru 标签，'
          + '只输出【逗号分隔的英文标签】，不要句子、不要中文、不要解释。'
          + '例：「坐在餐桌前大口扒饭，桌上摆满菜」→ dining table, eating, rice, chopsticks, many dishes, indoor '
          + '例：「盖着被子睡得很香」→ sleeping, bed, blanket, closed eyes, bedroom'
        const r = await callLlm(resolveRoute(), sysT, key, undefined)
        let tags = String((r && typeof r === 'object') ? (r.text || '') : (r || ''))
          .replace(/[^A-Za-z0-9,\s_-]/g, '').replace(/\s+/g, ' ').trim()
        tags = tags.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 12).join(', ')
        sceneTagCache.set(key, tags)
        if (tags) log(`场景翻译：${key.slice(0, 24)} → ${tags.slice(0, 80)}`)
        return tags
      } catch (e) {
        log('场景翻译失败（用题材默认场景）: ' + String(e?.message || e).slice(0, 60))
        sceneTagCache.set(key, '')
        return ''
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
      // ★ 把她的中文场景翻成英文标签，本地模型才认（失败就用题材默认场景）
      const sceneTags = scene ? await sceneToTags(scene) : ''
      const gen = await client.call('genSticker', { emotion, extra: sceneTags || '', bubble: bubble || '', force }, 220_000)
      if (gen?.stickerId) {
        const sec = ((Date.now() - t0) / 1000).toFixed(0)
        log(`后台生成完成（${sec}s，${gen.cached ? '复用' : '新画'}）→ 稍后补发`)
        await sleep(gapMs() + 500)
        const sent = await getOutbox().sendSticker(roomId, gen.stickerId)
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
        const sent = await getOutbox().sendSticker(roomId, picked.id)
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

  // ── 语音发送冷却 ─────────────────────────────────────────────
  //  2026-10-28 事故：17:25:13 发 6.1s 语音、17:25:26 又发 4.0s（间隔 13 秒），
  //  17:26:13 客户端退出（无崩溃转储 / 无 WER → 属"退出"而非访问违例）。
  //  历史同类：01:00 那次 7 分钟 7 条后崩、"语音+发图"一起崩。
  //  语音发送要 hook 构造微信内部对象，连发最容易踩对象所有权。
  //  两道闸：① 两条语音最少隔 voiceMinGapSec 秒 ② 10 分钟最多 voiceMaxPer10Min 条
  let lastVoiceAt = 0
  let voiceSentTimes = []
  function voiceCooldownOk() {
    const now = Date.now()
    const gapSec = config.voiceMinGapSec === undefined ? 90 : Number(config.voiceMinGapSec)
    const maxPer10 = config.voiceMaxPer10Min === undefined ? 3 : Number(config.voiceMaxPer10Min)
    if (gapSec > 0 && lastVoiceAt && now - lastVoiceAt < gapSec * 1000) {
      return { ok: false, why: 'voice cooldown: ' + Math.round((now - lastVoiceAt) / 1000) + 's < ' + gapSec + 's' }
    }
    voiceSentTimes = voiceSentTimes.filter((t) => now - t < 10 * 60_000)
    if (maxPer10 > 0 && voiceSentTimes.length >= maxPer10) {
      return { ok: false, why: 'voice rate limit: already ' + voiceSentTimes.length + ' in 10min (max ' + maxPer10 + ')' }
    }
    return { ok: true }
  }
  function markVoiceSent() {
    lastVoiceAt = Date.now()
    voiceSentTimes.push(lastVoiceAt)
    if (voiceSentTimes.length > 20) voiceSentTimes = voiceSentTimes.slice(-20)
  }

  function shouldSendVoice(r, trigger, text) {
    if (!config.voiceSay) return { yes: false, why: 'voiceSay=false（总开关关着）' }
    const t = String(text || '').trim()
    if (!t) return { yes: false, why: '空文本' }
    const chars = [...t].length
    // ★ 2026-10-23：极短 / 纯标点的回复别发语音（TTS 出来只有几字节，hook 会拒绝）
    if (chars < 3 || !/[\p{L}\p{N}]/u.test(t)) return { yes: false, why: `太短或没实际内容（${chars} 字）` }
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
    // 冷却闸：连发语音会让客户端退出（见 voiceCooldownOk 上方注释）
    const cd = voiceCooldownOk()
    if (!cd.ok) return { yes: false, why: cd.why }
    const wasVoice = trigger?.typeName === 'voice' || !!trigger?.voiceText
    const p = Number(wasVoice ? config.voiceSayOnVoiceProbability : config.voiceSayProbability)
    if (!(p > 0)) return { yes: false, why: `概率为 0（p=${p}）` }
    if (Math.random() < p) return { yes: true, why: wasVoice ? `收到语音→语音回（p=${p}）` : `普通回复改语音（p=${p}）` }
    return { yes: false, why: `概率未命中（p=${p}）` }
  }

  // ★ 最近一次"真正发送成功"的群 —— 抖音分享优先发这里。
  //   为什么：微信 hook 的 /SendTextMsg 只对"当前打开/活跃的会话"真正送达，
  //   发到没打开的群会 rc=0 但静默丢失（实测 2026-10-20）。而"刚回复过的群"一定是通的。
  let lastDeliveredRoom = ''
  async function deliver(r, trigger, priority, reply) {
    const roomId = r.roomId
    fMark('deliver', { room: roomId, priority, text: String(reply?.text || '').slice(0, 40), sticker: !!reply?.wantSticker, voice: !!reply?.voiceText })
    // 记住"我刚刚回了谁" —— 对方再接话就进对话延续模式（否则会回一句就哑）
    r.lastRepliedSender = trigger.sender
    r.lastRepliedAt = Date.now()
    lastDeliveredRoom = roomId
    // ★ 2026-10-27：本轮是否已经发过语音 —— 用来避免"语音和图片/表情包连着发"。
    //   用户实测：语音 + 发图一起来，客户端会偶发崩溃（媒体发送对象所有权问题尚未定位），
    //   同一轮里同时触发两条媒体发送会显著提高撞车概率。这里做互斥兜底。
    // 9（模型挑选版）：回复末尾的 [想起:N] → 找出模型选中的那条记忆
    //   · 从文本里去掉标记（不能让群友看到）
    //   · 记录被想起（recallCount+1、lastRecallAt）
    //   · 顺带给它加一点强度（被想起 = 复习了一次）
    try {
      if (reply && reply.text && config.humanAssociation !== false) {
        const parsed = H2.parseRecallDirective(reply.text)
        if (parsed.index > 0 && Array.isArray(r.__recallCandidates) && r.__recallCandidates.length) {
          const chosen = r.__recallCandidates[parsed.index - 1]
          reply = { ...reply, text: parsed.text }
          if (chosen && chosen.id) {
            const nowR = Date.now()
            r.facts = (r.facts || []).map((m) => {
              if (!m || m.id !== chosen.id) return m
              return {
                ...m,
                recallCount: (Number(m.recallCount) || 0) + 1,
                lastRecallAt: nowR,
                strength: MV2.reinforceStrength(m, nowR, memCfg()),
              }
            })
            try { saveFacts(r) } catch { }
            log(`她想起了「${String(chosen.text).slice(0, 34)}」（模型选中 #${parsed.index}）`)
          }
        } else if (parsed.index > 0) {
          // 没有候选却带了标记 → 只清标记，别把序号发到群里
          reply = { ...reply, text: parsed.text }
        }
      }
    } catch { /* 解析失败就当没标记 */ }
    let sentVoiceThisReply = false
    // ★ 2026-10-28 修：这行原来被插在下面"检测到重复回复→放弃这条"的分支里，
    //   只有撞上重复才会记一次 → 正常回复从来没进过待结算队列，
    //   feedbackLog 永远是空的、traits 一动不动（用户实测：性格漂移一直没变化）。
    //   正确位置：确实是这一轮要发的正文，就在这里记签名。
    try {
      if (reply.text && feedbackEnabled()) {
        noteFeedback(r, reply.text, { parts: 1, hasSticker: !!reply.wantSticker })
      }
    } catch { /* 不影响发送 */ }
    if (reply.text) {
      // 防重复③：这句回复最近说过一模一样的话 → 不重复发（复读最不像人）
      const nReply = normText(reply.text)
      const dup = (r.recentReplies || []).find((x) => normText(x.text) === nReply && Date.now() - x.at < config.repeatWindowMs)
      if (dup && nReply) {
        log(`不重复发同样的回复（${Math.round((Date.now() - dup.at) / 1000)}s 前说过："${dup.text}"）`)
        // 方案⑥：记下"这句话用了哪些行为维度"，等真实反馈回来再微调性格
      // 只发图的话仍然允许；纯文字就放弃这条
        if (!reply.wantSticker && !reply.stickerOnly) return
        reply = { ...reply, text: '' }
      }
      // ★ 2026-10-27：模型有时把占位符当正文发出来（实测群里出现一条纯 "[语音]" 的文本消息，
      //   因为语音合成失败、模型又在上下文里看到 [语音] 这个占位符）。占位符永远不是"要发的话"。
      const PLACEHOLDER_ONLY = /^[\[【(（]?(语音|图片|表情|表情包|视频|文件|链接|拍一拍)[\]】)）]?$/i
      const rawParts = toMessageParts(reply.text).map(stripStickerDirective).filter(Boolean)
      const parts = rawParts.filter((x) => {
        const t = String(x).trim()
        if (!PLACEHOLDER_ONLY.test(t)) return true
        log(`丢掉占位符正文：${JSON.stringify(t)}（这不是要发的话）`)
        return false
      })
      if (!parts.length && rawParts.length) {
        // 整条都是占位符 → 这条回复没有实际内容，直接放弃（但允许仍发图）
        if (!reply.wantSticker && !reply.stickerOnly) { log('这条回复只剩占位符 → 不发'); return }
      }
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
            vs = await getOutbox().sayVoice(roomId, { text: voiceText, emotion: 'main' })
          } catch (e) { vs = { ok: false, error: String(e?.message || e) } }
          if (vs?.ok) {
            markVoiceSent()
            sentVoiceThisReply = true
            log(`发语音气泡成功：${vs.bytes} 字节 / ${vs.durationMs}ms（main）`)
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
          await getOutbox().enqueue({
            roomId, kind: 'sendText',
            args: { roomId, text: mm.text, ...(mm.mentions.length ? { mentions: mm.mentions } : {}) },
            text: mm.text,
          })
          if (mm.mentions.length) log(`真 @：${mm.mentions.length} 人 → atlist（${mm.mentions.join(',')}）`)
          stats.sentText++
          ;(r.sentTexts ||= []).push({ text: mm.text, at: Date.now() })
          if (r.sentTexts.length > 40) r.sentTexts = r.sentTexts.slice(-40)
          push(r, { ts: Date.now(), isSelf: true, sender: 'self', senderName: '我', text: mm.text })
          // 2：这句话里有没有"承诺"（等下帮你找…）→ 登记，到点回来兑现
          try { if (i === parts.length - 1) notePromise(r, mm.text) } catch { }
          // 6：说完最后一条，有概率过一会儿自己补一句
          try {
            if (i === parts.length - 1 && config.humanFollowUp !== false) {
              const plan = H2.planFollowUp({ text: mm.text, energy: personaOf(r).energy })
              if (plan) {
                const lastAt = Number(r.__lastFollowUpAt) || 0
                if (Date.now() - lastAt > 10 * 60_000) {
                  r.__lastFollowUpAt = Date.now()
                  r.__followUpCount = 0
                  if (r.__followUpTimer) clearTimeout(r.__followUpTimer)
                  r.__followUpTimer = track(setTimeout(() => {
                    void sendFollowUp(r, plan).catch(() => { })
                  }, plan.delayMs))
                  log(`准备过 ${Math.round(plan.delayMs / 1000)} 秒补一句（${plan.seed}…）`)
                }
              }
            }
          } catch { }
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
    let wantSticker = reply.wantSticker || reply.stickerOnly || Math.random() < config.stickerChance
    // 互斥：本轮刚发过语音就不再发图（默认开，可用 voiceImageExclusive=false 关掉）
    if (wantSticker && sentVoiceThisReply && config.voiceImageExclusive !== false) {
      log('本轮已发语音 → 跳过表情包/图片（避免语音+图片连着发；config.voiceImageExclusive=false 可关）')
      wantSticker = false
    }
    if (wantSticker) {
      try {
        let stickerId = ''
        let how = ''
        // ① 只要情绪、没要场景 → 先用图库里现成的（秒发）
        //   ★ genStickerChance：按这个概率**跳过图库、直接现场画**（让"现场生成概率"这个配置真的生效；
        //     以前它只在配置表里躺着，代码完全没读）
        if (reply.emotion && !reply.scene) {
          const genChance = Math.max(0, Math.min(1, Number(config.genStickerChance ?? 0.25)))
          if (Math.random() >= genChance) {
            const lib = await client.call('pickSticker', { text: reply.emotion, roomId, minScore: 3, requireTag: true })
            if (lib?.id) { stickerId = lib.id; how = `图库(情绪匹配 ${reply.emotion})` }
          } else {
            log(`现场生成概率命中（${genChance}）→ 跳过图库，直接画「${reply.emotion}」`)
          }
        }
        // ② 需要现场画（指定了场景，或图库没匹配上）→ **丢后台**，好了再补发；不阻塞本条回复
        if (!stickerId && reply.emotion) {
          // 如果它本来就"只想发图"（没有文字），先补一句占位，免得群里静默一两分钟
          if (!reply.text) {
            const hold = ['等等，我画一张', '现画一张给你', '稍等，画着呢'][Math.floor(Math.random() * 3)]
            try {
              await getOutbox().sendText(roomId, hold)
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
          const sent = await getOutbox().sendSticker(roomId, stickerId)
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

    // 拍一拍：**暂不实现**。bridge.pat() 是空实现（hook 侧没有这条 CGI），
    // 之前这里 3% 概率的调用只会静默返回 -1。用户要求先下线，等 hook 实现再说。

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
    // 桌宠：回完了 → 雀跃一下（她"干完活了"的样子）
    void pet.anim(config.petSyncAnimOnSent)
    stats.replied++
    saveMemory(r)
  }

  // ── 生命周期 ────────────────────────────────────────────────
  ctx.effect(() => {
    client.connect()
    // 启动时自动打开 hook 语音发送开关（省得每次手动点；hook 默认是关的）
    setTimeout(() => {
      try { client.call('voiceSwitch', { on: true }).then(() => log('hook 语音发送开关：已自动打开')).catch(() => {}) } catch { /* ignore */ }
    }, 3000)
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
    // 记忆巡检：默认每天一次（memoryConsolidate=hourly 则每小时；off 不跑）
    const memEvery = config.memoryConsolidate === 'hourly' ? 3_600_000
      : (config.memoryConsolidate === 'off' ? 0 : 6 * 3_600_000)   // daily 但分散到 6h 一次，避免整点一起跑
    if (memEvery && config.memoryV2 !== false) {
      const memIv = setInterval(() => {
        try { memorySweepAll() } catch (e) { log('记忆巡检失败：' + String(e?.message || e).slice(0, 140)) }
        try { personaIdleRecover() } catch { /* ignore */ }
      }, memEvery)
      track(memIv)
      log(`记忆巡检已启动：每 ${Math.round(memEvery / 3600000)} 小时一次（memoryConsolidate=${config.memoryConsolidate}）`)
    }
    return () => clearInterval(iv)
  }, SHORT + ': health heartbeat')

  // ── 朋友圈自动发布（2026-10-26）────────────────────────────────────────────
  // 状态：{ lastAt, nextAt, dayKey, dayCount, lastText, lastRet, lastErr, lastVerified }
  // 落盘到 <dshHome>/wechat-bot/moment.json，重启不丢
  const momentFile = join(dirname(memoryDir), 'moment.json')
  let momentState = { lastAt: 0, nextAt: 0, dayKey: '', dayCount: 0, lastText: '', lastRet: null, lastErr: '', lastVerified: 0 }

  function momentDayKey(t = Date.now()) {
    const d = new Date(t)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  function loadMomentState() {
    try {
      const j = JSON.parse(readFileSync(momentFile, 'utf8'))
      if (j && typeof j === 'object') momentState = { ...momentState, ...j }
    } catch { /* 首次没有文件，正常 */ }
  }
  function saveMomentState() {
    try {
      mkdirSync(dirname(momentFile), { recursive: true })
      writeFileSync(momentFile, JSON.stringify(momentState, null, 2))
    } catch (e) { log('朋友圈状态保存失败：' + String(e?.message || e)) }
  }
  loadMomentState()

  // 在 momentHours 之内？（复用 quietHours 那套解析思路）
  function inMomentHours(now = new Date()) {
    const raw = String(config.momentHours || '').trim()
    if (!raw) return true
    const mins = now.getHours() * 60 + now.getMinutes()
    for (const seg of raw.split(',')) {
      const m = seg.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
      if (!m) continue
      const a = Number(m[1]) * 60 + Number(m[2])
      const b = Number(m[3]) * 60 + Number(m[4])
      if (a <= b ? (mins >= a && mins <= b) : (mins >= a || mins <= b)) return true
    }
    return false
  }

  function planNextMoment(from = Date.now()) {
    const lo = Math.max(60_000, Number(config.momentMinGapMs) || 6 * 3_600_000)
    const hi = Math.max(lo, Number(config.momentMaxGapMs) || 12 * 3_600_000)
    const gap = lo + Math.floor(Math.random() * (hi - lo + 1))
    momentState.nextAt = from + gap
  }

  const MOMENT_FALLBACKS = [
    '今天天气不错，适合发呆。',
    '刚吃完一顿，整个人都活过来了。',
    '突然觉得，安静一会儿也挺好。',
    '今天有点懒得动，就想趴着。',
    '喝了杯热的，心情好了点。',
    '又是普普通通、但还不错的一天。',
  ]

  async function makeMomentText() {
    if (!config.momentUseLLM) {
      return MOMENT_FALLBACKS[Math.floor(Math.random() * MOMENT_FALLBACKS.length)]
    }
    const route = resolveRoute()
    const sys = `你在给"${config.botName || '大肥鱼'}"写一条朋友圈文案。要求：${config.momentTopic || '短句、日常、口语化，40 字以内。'}\n只输出文案本身，不要任何解释、不要引号、不要话题标签。`
    const { text } = await callLlm(route, sys, '写一条吧。', config.reasoningEffort || undefined)
    const t = String(text || '').trim().replace(/^["'「『]|["'」』]$/g, '').slice(0, 300)
    return t || MOMENT_FALLBACKS[Math.floor(Math.random() * MOMENT_FALLBACKS.length)]
  }

  // ── 配图：统一走 lib/moment-image.mjs（同一份代码有独立测试脚本 test-moment-image.mjs）──
  //    web = 网上搜动漫图（nekos.best / nekosapi，均 SFW）
  //    ai  = Agnes 按文案生成
  //    两种来源互相兜底；产物统一归一化成微信能发的 JPEG（webp 微信不认）
  const MOMENT_IMG_DIR = join(dirname(memoryDir || join(homedir(), '.dsh')), 'moment-images')
  const pickMomentImg = (text) => pickMomentImage(text, {
    dir: MOMENT_IMG_DIR,
    source: config.momentImageSource || 'char',
    style: config.momentImageStyle || '',
    ratio: config.momentImageRatio || '4:3',
    log,
  })

  /** 朋友圈前置检查：微信主窗口在不在（被收进托盘时微信会销毁主窗口，此时发不出去） */
  async function momentHookReady() {
    try {
      const res = await fetch(`${HOOK_API_BASE}/Moment/Ready`, { signal: AbortSignal.timeout(6000) })
      const j = await res.json()
      return { ok: j?.ok === true, main: Number(j?.main || 0), editor: Number(j?.editor || 0) }
    } catch (e) {
      return { ok: false, error: String(e?.message || e).slice(0, 120) }
    }
  }

  async function postMomentNow(text, images = []) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('发朋友圈超时')), 150_000)
    try {
      // 静默发表：走 hook 的消息级驱动（不动鼠标、不抢前台、可在后台运行）
      const res = await fetch(`${HOOK_API_BASE}/Moment/PostSilent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, images }),
        signal: ac.signal,
      })
      const j = await res.json().catch(() => ({}))
      return { ok: j.ret === 0, ret: j.ret, retmsg: j.retmsg, diag: j.diag }
    } catch (e) {
      return { ok: false, ret: -1, error: String(e?.message || e).slice(0, 200) }
    } finally {
      clearTimeout(timer)
    }
  }

  let momentBusy = false
  async function momentTick(force = false, opts = {}) {
    if (momentBusy) return { ok: false, error: '正在发布中' }
    if (!config.momentAuto && !force) return { ok: false, error: '未开启' }
    const now = Date.now()
    const day = momentDayKey(now)
    if (momentState.dayKey !== day) { momentState.dayKey = day; momentState.dayCount = 0 }
    if (!force) {
      if (!inMomentHours()) return { ok: false, error: '不在设定时段' }
      if (momentState.dayCount >= Math.max(1, Number(config.momentDailyMax) || 2)) return { ok: false, error: '今天已经发够了' }
      if (momentState.nextAt && now < momentState.nextAt) return { ok: false, error: '还没到点' }
    }

    momentBusy = true
    try {
      const text = await makeMomentText()
      if (!text) return { ok: false, error: '文案为空' }
      log(`朋友圈：准备发布「${text.slice(0, 40)}」`)

      // 配图：图生图锁「蓝色大肥鱼」形象（失败就只发文字，绝不发别的形象）
      let images = []
      if (opts.image === true || (opts.image !== false && config.momentAutoImage)) {
        log('朋友圈：正在生成配图（图生图，锁角色）…')
        const g = await pickMomentImg(text)
        if (g.ok) { images = [g.file]; momentState.lastImage = g.file; momentState.lastImageProvider = g.provider || '' }
        else log(`朋友圈：配图失败（${g.error}），这条改发纯文字`)
      }

      const ready = await momentHookReady()
      if (!ready.ok) {
        log('朋友圈：微信主窗口不在（可能收进了托盘）→ 本次跳过，不消耗额度。点开微信主窗口后会自动恢复')
        momentState.lastError = '微信主窗口不在（托盘）'
        planNextMoment(Date.now())
        saveMomentState()
        return { ok: false, error: '微信主窗口不在（托盘里），点开主窗口再试' }
      }
      const r = await postMomentNow(text, images)
      // /Moment/PostSilent 的 ret=0 表示编辑器已关闭（即已发表成功）
      const verified = r.ok ? 1 : 0
      momentState.lastAt = Date.now()
      momentState.lastText = text
      momentState.lastRet = r.ret
      momentState.lastErr = r.ok ? '' : (r.error || ('ret=' + r.ret))
      momentState.lastVerified = verified ? 1 : 0
      momentState.lastTrigger = 'schedule'
      if (r.ok) { momentState.dayCount += 1; rememberMomentText(text) }
      planNextMoment(Date.now())
      saveMomentState()
      log(`朋友圈：${r.ok ? '已发布' : '失败'} verified=${momentState.lastVerified} ret=${r.ret}`)
      // 可选：在群里吱一声
      const room = String(config.momentNotifyRoom || '').trim()
      if (r.ok && room) {
        try {
          await getOutbox().sendText(room, `刚发了个朋友圈：${text}`)
        } catch { /* 吱声失败无所谓 */ }
      }
      return {
        ok: r.ok, text, ret: r.ret, diag: r.diag,
        // ★ 2026-10-28：配图可能失败后降级成纯文字，面板以前照样提示"已发布（带图）"。
        //   这里把事实带出去，页面才能如实显示。
        withImage: images.length > 0,
        imageCount: images.length,
        images,
      }
    } catch (e) {
      momentState.lastErr = String(e?.message || e).slice(0, 200)
      planNextMoment(Date.now())
      saveMomentState()
      return { ok: false, error: momentState.lastErr }
    } finally {
      momentBusy = false
    }
  }

  ctx.effect(() => {
    // 启动后 2 分钟首次检查（避开初始化高峰）；没设 nextAt 就规划一次
    const first = setTimeout(() => {
      if (!momentState.nextAt) { planNextMoment(Date.now()); saveMomentState() }
      void momentTick().catch((e) => log('朋友圈循环异常：' + String(e?.message || e)))
    }, 120_000)
    const iv = setInterval(() => {
      void momentTick().catch((e) => log('朋友圈循环异常：' + String(e?.message || e)))
    }, Math.max(60_000, Number(config.momentCheckMs) || 300_000))
    return () => { clearTimeout(first); clearInterval(iv) }
  }, SHORT + ': moment loop')

  // ══════════════════════════════════════════════════════════════════════════
  //  群聊事件触发朋友圈（2026-10-26）
  //
  //  思路：定时发是"到点硬发"，容易尬。改成**听群聊**——
  //  群里出现好笑的梗/名场面/温情时刻时，让 LLM 判断值不值得发，值得才发。
  //
  //  三层闸门（都是硬约束，防止刷屏）：
  //    ① 防抖：群里安静 momentChatDebounceMs 后才评估（等对话停下来）
  //    ② 冷却：同群两次评估间隔 >= momentChatCooldownMs
  //    ③ 额度：沿用全局 —— 允许时段 / 每天上限 / 与上一条的最小间隔
  //  另外去重：和最近发过的文案太像就跳过（避免同一件事反复发）
  // ══════════════════════════════════════════════════════════════════════════
  const chatMomentCooldown = new Map()   // roomId → { lastEvalAt, timer }

  function momentQuotaGate() {
    const now = Date.now()
    const day = momentDayKey(now)
    if (momentState.dayKey !== day) { momentState.dayKey = day; momentState.dayCount = 0 }
    if (!inMomentHours()) return { ok: false, why: '不在允许时段' }
    const cap = Math.max(1, Number(config.momentDailyMax) || 2)
    if (momentState.dayCount >= cap) return { ok: false, why: '今天已经发够（' + momentState.dayCount + '/' + cap + '）' }
    const gap = Math.max(60_000, Number(config.momentMinGapMs) || 6 * 3600_000)
    if (momentState.lastAt && now - momentState.lastAt < gap) {
      return { ok: false, why: '距上一条不足 ' + Math.round(gap / 60000) + ' 分钟' }
    }
    return { ok: true }
  }

  function chatMomentGate(roomId) {
    if (!config.momentFromChat) return { ok: false, why: '事件触发未开启' }
    const only = Array.isArray(config.momentChatRooms) ? config.momentChatRooms : []
    if (only.length && !only.includes(roomId)) return { ok: false, why: '群不在名单里' }
    return momentQuotaGate()
  }

  function normMomentText(t) {
    return String(t || '').replace(/[\s\p{P}\p{S}]/gu, '')
  }

  function isDupMomentText(t) {
    const a = normMomentText(t)
    if (!a) return true
    const prev = Array.isArray(momentState.recentTexts) ? momentState.recentTexts : []
    for (const p of prev) {
      const b = normMomentText(p)
      if (!b) continue
      if (a === b || a.includes(b) || b.includes(a)) return true
      const setB = new Set(b)
      let hit = 0
      const setA = new Set(a)
      for (const ch of setA) if (setB.has(ch)) hit++
      if (hit / Math.max(1, setA.size) > 0.72) return true
    }
    return false
  }

  function rememberMomentText(t) {
    const prev = Array.isArray(momentState.recentTexts) ? momentState.recentTexts : []
    momentState.recentTexts = [...prev, t].slice(-8)
  }

  /** 消息进来时调用：安排一次延迟评估（同群只挂一个定时器） */
  function scheduleChatMomentEval(r) {
    if (!config.momentFromChat || !config.enabled) return
    if (!r || !r.roomId) return
    const st = chatMomentCooldown.get(r.roomId) || {}
    if (st.timer) return                                  // 已经在等，重新计时不必要
    const cd = Math.max(60_000, Number(config.momentChatCooldownMs) || 1_800_000)
    if (st.lastEvalAt && Date.now() - st.lastEvalAt < cd) return
    const delay = Math.max(15_000, Number(config.momentChatDebounceMs) || 90_000)
    st.timer = track(setTimeout(() => {
      st.timer = null
      void evalChatForMoment(r).catch((e) => log('朋友圈事件评估异常：' + String(e?.message || e).slice(0, 160)))
    }, delay))
    chatMomentCooldown.set(r.roomId, st)
  }

  /** 让 LLM 判断一段群聊值不值得发朋友圈；返回 {worthful, score, text, reason} 或 {error} */
  async function judgeChatMomentBar(transcript, minScore = 7) {
    const sys = [
      `你在替「${config.botName || '大肥鱼'}」判断：下面这段群聊里，有没有值得发朋友圈的瞬间。`,
      '值得发的：好笑的梗、名场面、大家的糗事、突然的温情/共鸣、群友说的金句。',
      '不值得发的：日常寒暄、单纯提问、互相@没内容、只有指令、广告、纯表情、私人信息。',
      '要发的话，写成第一人称短文案（40 字以内，口语化，不加引号，不提"朋友圈"，不点名群友，可用"某人"）。',
      '严格只输出一行 JSON：{"worthy":true,"score":0,"text":"文案","reason":"一句话理由"}',
    ].join('\n')
    let raw = ''
    try {
      const { text } = await callLlm(resolveRoute(), sys, transcript, config.reasoningEffort || undefined)
      raw = String(text || '')
    } catch (e) {
      return { error: 'LLM 调用失败：' + String(e?.message || e).slice(0, 120) }
    }
    try {
      const mm = raw.match(/\{[\s\S]*\}/)
      const j = JSON.parse(mm ? mm[0] : raw)
      return {
        worthy: !!j.worthy,
        score: Number(j.score) || 0,
        text: String(j.text || '').trim().replace(/^["'「『]|["'」』]$/g, '').slice(0, 200),
        reason: String(j.reason || '').slice(0, 80),
        minScore,
        raw: raw.slice(0, 300),
      }
    } catch {
      return { error: '返回不是 JSON：' + raw.slice(0, 120) }
    }
  }

  /** 让 LLM 判断这段群聊值不值得发朋友圈 */
  async function evalChatForMoment(r) {
    const st = chatMomentCooldown.get(r.roomId) || {}
    st.lastEvalAt = Date.now()
    chatMomentCooldown.set(r.roomId, st)

    const gate = chatMomentGate(r.roomId)
    if (!gate.ok) return                                  // 额度/时段/开关不满足，静默跳过

    if (momentBusy) { log('朋友圈：正在发上一条，跳过本次事件评估'); return }

    const look = Math.max(8, Math.min(60, Number(config.momentChatLookback) || 25))
    const msgs = (r.msgs || []).slice(-look).filter((x) => x && x.text)
    if (msgs.length < 4) return                            // 太短的对话不评估

    const transcript = msgs
      .map((x) => (x.isSelf ? '我' : (x.senderName || '群友')) + '：' + String(x.text).slice(0, 120))
      .join('\n')
    const minScore = Math.max(1, Math.min(10, Number(config.momentChatMinScore) || 7))

    let j = null
    try {
      j = await judgeChatMomentBar(transcript, minScore)
    } catch (e) {
      log('朋友圈事件：LLM 调用失败 ' + String(e?.message || e).slice(0, 120))
      return
    }
    if (!j || j.error) { log('朋友圈事件：评估失败 ' + String(j?.error || '').slice(0, 120)); return }
    const score = Number(j.score) || 0
    const reason = String(j.reason || '').slice(0, 60)
    if (!j.worthy || score < minScore) {
      log(`朋友圈事件：不值得（score=${score}/${minScore}）${reason}`)
      return
    }
    const draft = String(j.text || '').trim().replace(/^["'「『]|["'」』]$/g, '').slice(0, 200)
    if (!draft) { log('朋友圈事件：worthy 但文案为空，跳过'); return }
    if (isDupMomentText(draft)) { log('朋友圈事件：和最近发过的太像，跳过：「' + draft.slice(0, 24) + '」'); return }

    log(`朋友圈事件：值得发（score=${score}）${reason} → 「${draft.slice(0, 30)}」`)
    momentBusy = true
    try {
      let images = []
      if (config.momentAutoImage) {
        log('朋友圈：正在生成配图（图生图，锁角色）…')
        const g = await pickMomentImg(draft)
        if (g.ok) images = [g.file]
        else log(`朋友圈：配图失败（${g.error}），改发纯文字`)
      }
      const res = await postMomentNow(draft, images)
      const ok = !!res.ok
      momentState.lastAt = Date.now()
      momentState.lastText = draft
      momentState.lastRet = res.ret
      momentState.lastErr = ok ? '' : (res.error || ('ret=' + res.ret))
      momentState.lastVerified = ok ? 1 : 0
      momentState.lastTrigger = 'chat'
      momentState.lastScore = score
      momentState.lastReason = reason
      momentState.lastRoom = r.roomName || r.roomId
      if (ok) { momentState.dayCount += 1; rememberMomentText(draft) }
      planNextMoment(Date.now())
      saveMomentState()
      log(`朋友圈（群聊触发｜${r.roomName || r.roomId}｜score=${score}）：${ok ? '已发布' : '失败'} ret=${res.ret}`)
    } finally {
      momentBusy = false
    }
  }

  // 自动更新：启动 40 秒后查一次（避开插件初始化高峰），之后每 24 小时一次。
  // 只检查、不自动装 —— 面板会弹提示，用户点「立即更新」才动文件。
  ctx.effect(() => {
    let first = setTimeout(() => { void checkUpdate().catch((e) => log('检查更新失败：' + String(e?.message || e))) }, 40_000)
    const daily = setInterval(() => { void checkUpdate().catch((e) => log('检查更新失败：' + String(e?.message || e))) }, 24 * 3600 * 1000)
    return () => { clearTimeout(first); clearInterval(daily) }
  }, SHORT + ': auto update check')


  // ── 抖音自动刷（只读）→ 她挑一条 → 发到群里 ───────────────────────
  // 链路：桥 op `douyinBrush`（Playwright + 独立已登录 profile，真实鼠标点「推荐」+
  //      ArrowDown 翻页，见 wx-bridge/douyin-brush.py）→ 拿回 {desc, like, shot}
  //      → 交给模型按【她自己的眼光】挑一条 → 发截图 + 一句吐槽。
  // 红线：只读（不点赞/不评论/不关注/不私信）；不刷屏；深夜不刷；一天最多 N 条。
  let douyinLastAt = 0
  let douyinDay = ''
  let douyinDayCount = 0
  let douyinBusy = false
  async function douyinTick(opts = {}) {
    // force=true：有人在群里让它"去刷抖音" → 不看间隔、不看作息（但仍受每日上限 + 忙碌锁）
    const force = !!opts.force
    if (!config.douyinShare || douyinBusy) return
    if (!force && isQuiet(quietWindows)) return
    const now = Date.now()
    const dstr = new Date().toISOString().slice(0, 10)
    if (dstr !== douyinDay) { douyinDay = dstr; douyinDayCount = 0 }
    if (douyinDayCount >= (Number(config.douyinShareMaxPerDay) || 3)) return
    if (!force && now - douyinLastAt < (Number(config.douyinShareIntervalMs) || 7_200_000)) return
    const targets = [...rooms.values()].filter((r) => r.roomId && String(r.roomId).endsWith('@chatroom'))
    if (!targets.length) return
    // ★ 优先发到【要求它刷的那个群】（一定是你正在看的群 → 一定送得到）
    //   其次发到【最近真正回复成功过的群】（lastDeliveredRoom，一定通）
    //   最后按 lastMsgAt 倒序。
    const askRoom = opts.roomId && rooms.has(opts.roomId) ? opts.roomId : ''
    if (askRoom) {
      targets.sort((a, b) => (a.roomId === askRoom ? -1 : 1) - (b.roomId === askRoom ? -1 : 1))
    } else if (lastDeliveredRoom && rooms.has(lastDeliveredRoom)) {
      targets.sort((a, b) => (a.roomId === lastDeliveredRoom ? -1 : 1) - (b.roomId === lastDeliveredRoom ? -1 : 1))
    } else {
      targets.sort((a, b) => (Number(b.lastMsgAt) || 0) - (Number(a.lastMsgAt) || 0))
    }
    douyinBusy = true
    // ★ 发送前先确认桥连上：桥重连后有几秒状态不同步（实测 10:47:28 重连、
    //   10:47:34 却报 "bridge 未连接" → 分享白跑）。这里最多等 15 秒。
    const waitBridge = async (ms = 15000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < ms && !client.connected) {
        await new Promise((r) => setTimeout(r, 1000))
      }
      return !!client.connected
    }
    try {
      douyinLastAt = now
      log('抖音：开始刷推荐流（只读）…')
      const res = await client.call('douyinBrush', { count: Number(config.douyinBrushCount) || 3 }, 11 * 60_000)
      if (!res?.ok || !Array.isArray(res.items) || !res.items.length) {
        log('抖音：什么都没刷到（' + String(res?.error || '空结果') + '）')
        return
      }
      // ★★ 让她【自己看完所有候选】再挑 —— 不是按点赞数，也不是只看标题。
      //   每条候选桥侧都生成了 6 帧网格（3×2）（sheet），逐条交给视觉模型"看"一遍，
      //   拿到真实内容后，再按她自己的兴趣挑一条。
      // ★★ 关键：resolveRoute() 会返回「上一次用过的模型」——
      //   下面这一串识图调用会把 lastRoute 改成视觉模型（opencodego-extra/…-vision-exp），
      //   如果挑视频/写评论时才去 resolveRoute()，拿到的就是视觉模型：
      //   它不支持 reasoningEffort，且本来也不该用来做文本挑选（实测 2026-10-20 13:06 报错）。
      //   所以【在识图之前】先把文本路由记下来，后面一直用它。
      const TEXT_ROUTE = resolveRoute()
      log(`抖音：本次用文本模型 ${TEXT_ROUTE.provider}/${TEXT_ROUTE.model}（识图另用视觉模型）`)
      log(`抖音：开始逐条看这 ${res.items.length} 条（画面 + 声音）…`)
      const watched = []
      // ★ 去重：已经分享过的（同一条链接 / 同一个标题）不再分享
      const seenKeys = stats.douyinSeenKeys || (stats.douyinSeenKeys = new Set())
      const keyOf = (x) => String(x.shareUrl || String(x.desc || '').slice(0, 30) || x.i)
      for (const x of res.items) {
        let seen = ''
        let heard = ''
        if (x.sheet) {
          try { seen = await describeImageCached(String(x.sheet), 'douyinSheet') } catch (e) { /* 单条失败不影响其它 */ }
        }
        // ★ 2026-10-29：浏览器现在默认静音（不放声音），所以桥不再录音 → x.audio 为空。
        //   音轨改走"下载后抽 wav"：fetchLinkVideo → video-probe（1fps 联系表 + 16k 音轨）。
        //   这样既没有扬声器声音，又能读到台词；顺手还能拿到比截图更清楚的逐帧画面。
        if (x.audio) {
          try {
            heard = await transcribeVoice(String(x.audio))
            if (!heard) log(`抖音：#${x.i} 转写返回空（音频 ${String(x.audio).split('\\').pop()}）`)
          } catch (e) { log(`抖音：#${x.i} 转写异常：` + String(e?.message || e).slice(0, 80)) }
        } else if (config.douyinAudioViaDownload !== false) {
          try {
            // ★ 路线 A：优先用网络响应里抓到的 CDN 直链（playUrl）——
            //   yt-dlp 下抖音会卡在 "Fresh cookies"，直链 + Referer 则不受限制。
            let dl = null
            if (x.playUrl) {
              try {
                dl = await client.call('fetchDirectVideo', {
                  url: String(x.playUrl),
                  referer: 'https://www.douyin.com/',
                  maxMB: Number(config.linkVideoMaxMB) || 80,
                  frames: Number(config.linkVideoFrames) || 6,
                  fps: config.linkVideoFps === undefined ? 1 : Number(config.linkVideoFps),
                }, 240_000)
                if (dl && !dl.sheet && !dl.wav) dl = null
              } catch (e) { log(`抖音：#${x.i} 直链下载失败，改试 yt-dlp：` + String(e?.message || e).slice(0, 70)) }
            }
            if (!dl) dl = await client.call('fetchLinkVideo', {
              url: String(x.shareUrl || x.url || ''),
              maxSeconds: Number(config.linkVideoMaxSeconds) || 300,
              maxMB: Number(config.linkVideoMaxMB) || 80,
              timeoutMs: Number(config.linkVideoTimeoutMs) || 120_000,
              frames: Number(config.linkVideoFrames) || 6,
              fps: config.linkVideoFps === undefined ? 1 : Number(config.linkVideoFps),
            }, (Number(config.linkVideoTimeoutMs) || 120_000) + 60_000)
            if (dl?.wav) {
              heard = await transcribeVoice(String(dl.wav))
              if (!seen && Array.isArray(dl.sheets) && dl.sheets.length) {
                // 下载来的联系表比浏览器截图清楚得多 → 用它的画面
                const parts2 = []
                for (let si = 0; si < Math.min(dl.sheets.length, 3); si++) {
                  const d2 = await describeImageCached(dl.sheets[si], 'videoSheet')
                  if (d2) parts2.push((dl.sheets.length > 1 ? '【第' + (si + 1) + '段】' : '') + d2)
                }
                if (parts2.length) seen = parts2.join('\n')
              }
              for (const sh of (dl.sheets || [dl.sheet])) { try { if (sh) unlinkSync(sh) } catch { } }
              try { unlinkSync(String(dl.wav)) } catch { }
              log(`抖音：#${x.i} 音轨已从下载的视频里抽出（${dl.durationSec || '?'}s）→ 台词 ${heard ? '转写成功' : '转写为空'}`)
            }
          } catch (e) { log(`抖音：#${x.i} 下载取音轨失败（跳过台词）：` + String(e?.message || e).slice(0, 90)) }
        }
        watched.push({ ...x, seen: String(seen || ''), heard: String(heard || ''), dup: seenKeys.has(keyOf(x)) })
      }
      log(`抖音：看懂 ${watched.filter((x) => x.seen).length}/${watched.length} 条｜`
        + `听到台词 ${watched.filter((x) => x.heard).length}/${watched.length} 条`)

      const fresh = watched.filter((x) => !x.dup)
      if (!fresh.length) { log('抖音：这批全是发过的 → 这轮不发'); return }
      const list = fresh.map((x) => {
        const parts = [`#${x.i}（点赞${x.like || '?'}）`, `标题：${String(x.desc || '').split('\n')[0].slice(0, 60)}`]
        if (x.seen) parts.push(`你看到的画面：${x.seen}`)
        if (x.heard) parts.push(`你听到的台词/旁白：${String(x.heard).slice(0, 200)}`)
        return parts.join('\n')
      }).join('\n\n')

      const sys = '你就是网络上的鲸鱼娘「大肥鱼」，爱刷抖音。下面是你刚刷到的几条视频，每条都附着你**真实看到的画面 + 听到的台词**。\n'
        + '请挑【一条你自己最感兴趣、最想甩到群里给朋友看】的。按你自己的口味来：搞笑、可爱、美食、猎奇、感慨、共鸣都行。\n'
        + '硬性排除（一律不挑）：政治、时政、宗教、争议话题、广告、低俗。\n'
        + '只回一行 JSON，不要解释、不要代码块：{"i":编号,"why":"你为什么感兴趣（10字内）","comment":"发到群里的一句话（20字内，像真人说话）"}'
      let picked = null
      try {
        // ★ callLlm 返回的是对象 { text, diag }，不是字符串！（踩了一整轮）
        // ★ 不要传 'low'：resolveRoute() 可能返回「上次用过的模型」（比如刚做完识图的
        //   视觉模型 deepseek-v4-flash-vision-exp），它不支持 reasoningEffort='low'，
        //   直接报 UNSUPPORTED_REASONING_EFFORT → 空回复（实测 2026-10-20 13:06）。
        const r1 = await callLlm(TEXT_ROUTE, sys, list, undefined)
        let out = (r1 && typeof r1 === 'object') ? String(r1.text || '') : String(r1 || '')
        if (!out.trim()) {
          // 空回复 → 把诊断打出来（chunks/finish/failure/err），再用短提示词重试一次
          try { log('抖音：挑视频 LLM 空回复，诊断=' + JSON.stringify(r1 && r1.diag || {}).slice(0, 320)) } catch { }
          const shortSys = '从下面几条抖音里挑一条最好玩的，只回一行 JSON：{"i":编号,"why":"10字内","comment":"20字内"}'
          const shortList = fresh.map((x) => `#${x.i} ${String(x.desc || '').split('\n')[0].slice(0, 30)}`).join('\n')
          const r1b = await callLlm(TEXT_ROUTE, shortSys, shortList, undefined)
          out = (r1b && typeof r1b === 'object') ? String(r1b.text || '') : String(r1b || '')
          if (out.trim()) log('抖音：短提示词重试成功 → ' + out.slice(0, 80))
          else { try { log('抖音：短提示词也空，诊断=' + JSON.stringify(r1b && r1b.diag || {}).slice(0, 320)) } catch { } }
        }
        // ★ callLlm 有时直接返回对象（不是字符串）→ 直接 String() 会变 [object Object]
        const raw = typeof out === 'string' ? out : JSON.stringify(out || '')
        // ★ 贪婪匹配【最外层】JSON：模型有时会返回 {"i":1,"comment":{"text":"..."}} 这种嵌套，
        //   非贪婪会把内层括号切出来，导致 picked.i 丢失。
        if (out && typeof out === 'object' && (out.i || out.comment)) {
          picked = out
        } else {
          const mm = raw.match(/\{[\s\S]*\}/)
          if (mm) picked = JSON.parse(mm[0])
          else log('抖音：模型输出里没有 JSON → ' + raw.slice(0, 140))
        }
      } catch (e) { log('抖音：挑视频失败 ' + String(e?.message || e).slice(0, 80)) }
      if (!picked || !picked.i) {
        // 兜底：挑第一条她真看懂的（至少不是瞎挑）
        const first = fresh.find((x) => x.seen) || fresh[0]
        picked = { i: first.i, why: '看着还行', comment: '刷到这个，有点意思' }
        log('抖音：模型没挑出结果 → 兜底选第一条她看懂的 #' + first.i)
      }
      const item = fresh.find((x) => Number(x.i) === Number(picked.i))
        || fresh.find((x) => x.seen) || fresh[0]
      if (picked.why) log(`抖音：她为什么挑它 = 「${String(picked.why).slice(0, 20)}」`)
      const r = targets[0]
      const title = String(item.desc || '抖音上刷到的').split('\n')[0].slice(0, 80)
      // ★ 防 [object Object]：模型有时把 comment 返回成嵌套对象，必须先取字符串
      const pickStr = (v) => (typeof v === 'string' ? v : (v && typeof v === 'object' ? String(v.comment || v.text || v.msg || '') : ''))
      let caption = pickStr(picked.comment).slice(0, 60)
      // ★ 她已经"看过"这条了（上面逐条视觉理解时拿到的），直接用，不重复识别。
      let seen = item.seen || ''
      const heard = item.heard || ''
      if (seen) log('抖音：已看懂这条视频（画面）→ ' + String(seen).slice(0, 70))
      if (heard) log('抖音：已听到台词 → ' + String(heard).slice(0, 70))
      try {
        const sys2 = '你就是网络上的鲸鱼娘「大肥鱼」。你刚把这条抖音视频从头看到尾，现在要把它甩到群里，\n'
          + '告诉朋友【你觉得最戳你、最好玩的那个点在哪】。\n'
          + '要求：\n'
          + '1) 直接说【好玩在哪】—— 是哪个画面/哪句话/哪个反差让你笑了或觉得绝，具体到点上；\n'
          + '2) 不要说"这个视频很有意思"这种空话，也不要复述标题；\n'
          + '3) 25 字以内，一句话，像人随口说的；\n'
          + '4) 语气是你自己的（有点贫、爱吐槽），可以笑、可以模仿、可以感慨。\n'
          + '只回这一句，不要引号、不要解释、不要换行。'
        const user2 = '【你看到的画面】\n' + (seen || '（没看清）') + '\n\n'
          + (heard ? '【你听到的台词】\n' + heard + '\n\n' : '')
          + (caption ? '【你第一眼的感觉】' + caption + '\n\n' : '')
          + '现在用你自己的话，说出你觉得最好玩/最戳你的那个点。'
        const r2 = await callLlm(TEXT_ROUTE, sys2, user2, undefined)
        const out2 = (r2 && typeof r2 === 'object') ? String(r2.text || '') : String(r2 || '')
        if (!String(out2).trim()) {
          try { log('抖音：写评论 LLM 空回复，诊断=' + JSON.stringify(r2 && r2.diag || {}).slice(0, 320)) } catch { }
        }
        const t2 = String(out2 || '').replace(/^["'「『]+|["'」』]+$/g, '').split('\n')[0].trim()
        if (t2) caption = t2.slice(0, 80)
      } catch (e) { log('抖音：生成吐槽失败（用兜底文案） ' + String(e?.message || e).slice(0, 60)) }
      await waitBridge()
      if (item.shot && typeof item.shot === 'string') {
        let ok = false
        for (let k = 0; k < 3 && !ok; k++) {
          try { await client.call('sendImage', { roomId: r.roomId, path: item.shot }, 60_000); ok = true }
          catch (e) {
            log(`抖音：发截图失败（第 ${k + 1}/3 次）` + String(e?.message || e).slice(0, 50))
            await new Promise((res) => setTimeout(res, 5000))
            await waitBridge()
          }
        }
      }
      // ★ 让她"按自己的理解发言"：只用她【看完视频后】说的这一句，
      //   不再拼「刷到一个好玩的：<标题>」—— 那行标题会让人以为它只是在读文案。
      //   截图就在上面，群里天然知道"这是她刷到的"。
      // 最后一道守卫：绝不允许把 [object Object] / undefined 发出去
      let safeCaption = String(caption || '').trim()
      if (!safeCaption || safeCaption.includes('[object ') || safeCaption === 'undefined' || safeCaption === 'null') {
        const fb = ['这个有点意思', '刷到了个不错的', '有点东西啊', '哈哈哈哈这个', '这个我可以']
        safeCaption = fb[Math.floor(Math.random() * fb.length)]
      }
      const outText = [safeCaption, String(item.shareUrl || '').trim()]
        .filter(Boolean).join('\n')
      let sent = false
      for (let k = 0; k < 3 && !sent; k++) {
        try { await getOutbox().sendText(r.roomId, outText); sent = true }
        catch (e) {
          log(`抖音：发文字失败（第 ${k + 1}/3 次）` + String(e?.message || e).slice(0, 50))
          await new Promise((res) => setTimeout(res, 5000))
          await waitBridge()
        }
      }
      if (!sent) { log('抖音：文字 3 次都没发出去 → 放弃本轮'); return }
      log(`抖音：分享文案 = 「${outText.slice(0, 40)}」`)
      douyinDayCount++
      try { seenKeys.add(keyOf(item)) } catch { }
      stats.douyinShared = (stats.douyinShared || 0) + 1
      log(`抖音：已分享「${title.slice(0, 30)}」→ ${r.roomId}（今日第 ${douyinDayCount} 条）`)
    } catch (e) {
      log('抖音：出错 ' + String(e?.message || e).slice(0, 140))
    } finally { douyinBusy = false }
  }
  ctx.effect(() => {
    const iv = setInterval(() => { void douyinTick() }, 10 * 60_000)   // 每 10 分钟看一次该不该刷
    return () => clearInterval(iv)
  }, SHORT + ': douyin share')

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
  /** 最近有过消息的群（探针优先用它：分片里一定有它的表） */
  function mostActiveRoom() {
    let best = ''
    let bestTs = 0
    for (const [rid, r] of rooms.entries()) {
      const ts = (r.msgs || []).reduce((m, x) => Math.max(m, Number(x.ts) || 0), Number(r.lastActivityAt) || 0)
      if (ts > bestTs) { bestTs = ts; best = rid }
    }
    return best
  }

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
    // ★ 2026-10-28 修复（这是"误判 → 自愈重启微信"的真凶）：
    //   以前探针固定用 config.rooms[0]（或第一个已知群）。但微信的消息库是**分片**的，
    //   某个会话在当前分片里不一定有消息表 → 查询报「没找到这个会话的表」 →
    //   hook 存活 + 数据库可读 同时判 bad → 连续 3 次 → 自愈把微信重启一遍。
    //   今天 12:06 / 16:07 两次重启都是这么来的。
    //   现在：按候选列表依次试（filehelper 一定有表 → 最近有消息的群 → 配置里的群），
    //   任何一个成功就算可读；只有全失败才判不可读。
    const probeCandidates = []
    const pushP = (x) => { const v = String(x || '').trim(); if (v && !probeCandidates.includes(v)) probeCandidates.push(v) }
    pushP('filehelper')                                        // 一定有会话表，最可靠
    pushP(mostActiveRoom())                                    // 最近有消息的群
    for (const x of (config.rooms || [])) pushP(x)              // 用户指定的群
    pushP([...rooms.keys()][0])                                 // 兜底：任意已知会话
    const probeRoom = probeCandidates[0]
    let dbOk = false
    let dbText = ''
    let dbAdvice = ''
    let dbProbeRoom = ''
    if (!cs.connected) {
      dbText = '未检查（桥未连接）'
      dbAdvice = '桥恢复后自动可查'
    } else {
      const tried = []
      for (const cand of probeCandidates.slice(0, 3)) {
        tried.push(cand)
        try {
          const res = await client.call('searchMessages', { roomId: cand, query: '', limit: 1, scan: 50 }, 8000)
          // 桥的这个 op **不抛错**，失败时返回 { items: [], error: '…' }
          if (Array.isArray(res?.items) && !res?.error) {
            dbOk = true
            dbProbeRoom = cand
            dbText = `消息库可读（探针会话「${cand}」取到 ${res.items.length} 条）`
            break
          }
          // 换个会话再试（"没找到这个会话的表" 属于会话维度的问题，不代表库坏了）
          dbText = res?.error ? '查询失败：' + String(res.error).slice(0, 80) : '查询返回结构异常'
        } catch (e) {
          dbText = '读不到：' + String(e?.message || e).slice(0, 90)
        }
      }
      if (!dbOk) {
        dbAdvice = `已试 ${tried.join(' / ')} 都读不到：hook 的 QueryDB 或轮询器异常（看 bridge 日志的 SQL 失败行）`
      }
    }
    // 桥连着却读不出库 → 判 bad；连不上 → warn
    const dbLevel = dbOk ? 'ok' : (cs.connected ? 'bad' : 'warn')
    add('hook 存活', dbOk ? 'ok' : dbLevel, dbOk ? 'QueryDB 有响应（hook 正常）' : dbText, dbAdvice)
    add('数据库可读', dbLevel, dbText, dbAdvice)

    // ⑤ 消息轮询：判断「轮询到底在不在跑」，而不是「库能不能读」。
    //   硬闸（_hardGiveUp）状态下探针查 filehelper 照样成功 → 只看 dbOk 会全绿，
    //   但 tick 早就不干活了，群里说话一条都进不来。
    //   这是 2026-10-24「自检全绿却八小时没收到消息」的根因。
    const idleMin = lastMsgAt ? Math.round((Date.now() - lastMsgAt) / 60000) : null
    const wakeMin = lastWakeAt ? Math.round((Date.now() - lastWakeAt) / 60000) : null
    const poll = (br && br.poll) || {}
    const pollInfo = poll.exists
      ? `已查 ${poll.polls || 0} 轮、读到 ${poll.msgs || 0} 条 / ${poll.tables || 0} 表`
      : '轮询器未启动'
    let pollLevel = 'ok'
    let pollText = idleMin == null
      ? `还没收到过消息（${pollInfo}）`
      : `最近一条消息 ${idleMin} 分钟前（${pollInfo}）`
    // 当前实际在用的消息库分片（微信会轮换 message_0 → message_1 …），文案里别写死
    const shardName = String(poll.shard || '').trim() || '消息库'
    // 唤醒后是否已恢复：唤醒之后只要还收到过消息，就说明自愈成功
    const wokeAfter = (lastWakeAt && lastMsgAt) ? (lastMsgAt > lastWakeAt) : false
    let pollAdvice = ''
    if (poll.hardStopped) {
      pollLevel = 'bad'
      pollText += '｜轮询被硬停（客户端不重登就一直哑）'
      pollAdvice = '面板点「恢复轮询」，或 POST /api/pollResume'
    } else if (poll.stopped) {
      pollLevel = 'bad'
      pollText += '｜轮询器已停止（进程在，但没在跑）'
      pollAdvice = '点「恢复轮询」或重启桥'
    } else if (poll.paused) {
      pollLevel = 'warn'
      pollText += `｜轮询暂停中（剩 ${poll.pauseLeftSec || 0} 秒，连续失败 ${poll.consecFail || 0} 次）`
      pollAdvice = `桥会自动重试；持续出现说明 ${shardName} 打不开`
    } else if (!dbOk && cs.connected && probeRoom) {
      pollLevel = 'bad'; pollText += '｜数据库读不到，轮询必然停了'; pollAdvice = '先修 hook/数据库（见上）'
    } else if (wakeMin != null && wakeMin <= 15 && wokeAfter) {
      // ★ 2026-10-27：唤醒之后又收到过消息 = 已自愈。
      //   以前这里无条件判 bad（只看"15 分钟内喊过"），于是重启客户端触发的正常唤醒，
      //   会被连续报 3 次 ❌ 并触发「失联告警」——明明轮询在跑（用户实测踩到）。
      pollText += `｜${wakeMin} 分钟前唤醒过一次（之后已收到消息，已恢复）`
    } else if (wakeMin != null && wakeMin <= 15) {
      // 喊过但之后一条都没收到 → 还没恢复，但桥在自动重试，先判 warn（不触发失联告警）
      pollLevel = 'warn'
      pollText += `｜${wakeMin} 分钟前唤醒过，之后还没收到消息`
      pollAdvice = `桥会自动重试；持续超过 5 分钟说明 ${shardName} 打不开（可能是客户端句柄没挂上）`
    } else if (idleMin != null && idleMin > 180) {
      pollLevel = 'warn'; pollText += '（超过 3 小时没消息）'; pollAdvice = '如果群里明明有人在说话，说明轮询断了'
    } else if (idleMin == null && !poll.exists) {
      pollLevel = 'warn'; pollText += '｜轮询器未启动'; pollAdvice = '桥可能刚起来；一直这样说明 startPoller 没跑起来'
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
  // ── 受限自愈（默认关闭）─────────────────────────────────────
  //   只针对「hook 死锁」这一个特征：status 正常、execute 永远超时、桥和客户端都活着。
  //   满足全部条件才执行：连续 3 次检查 + 08:00-23:00 + 每天最多 1 次
  //   + 用 safe-restart 脚本（备份 → 正常关 → 重启 → 自动点「进入微信」）。
  //   ★ 永远不会强杀进程（规则 R1）。
  let selfHealDay = ''
  let selfHealCount = 0
  let selfHealBusy = false
  // wechatPower.start 的每日计数（与自愈分开，但同样有上限）
  let powerDay = ''
  let powerCount = 0
  async function trySelfHeal(reason) {
    if (!config.selfHeal || selfHealBusy) return
    const hour = new Date().getHours()
    if (hour < 8 || hour >= 23) { log(`自愈：不在允许时段 08:00-23:00（现在 ${hour} 点）→ 跳过`); return }
    const dstr = new Date().toISOString().slice(0, 10)
    if (dstr !== selfHealDay) { selfHealDay = dstr; selfHealCount = 0 }
    if (selfHealCount >= (Number(config.selfHealMaxPerDay) || 1)) { log('自愈：今天已自动重启过 → 跳过'); return }
    const script = String(config.selfHealScript || '')
    try {
      const fs = await import('node:fs')
      if (!script || !fs.existsSync(script)) { log('自愈：没配置 selfHealScript 或文件不存在 → 跳过'); return }
    } catch { }
    selfHealBusy = true
    selfHealCount++
    log(`自愈：检测到「${reason}」→ 执行安全重启（备份 → 正常关 → 重启 → 自动点进入微信）`)
    try { await alertHealth([{ name: '自动重启', text: `检测到${reason}，正在自动重启微信（会先备份数据库）` }], { mins: 0 }) } catch { }
    try {
      const { execFile } = await import('node:child_process')
      const args = ['-NoProfile', '-File', script]
      if (config.selfHealWeChatDir) args.push('-WeChatDir', String(config.selfHealWeChatDir))
      if (config.selfHealBridgeDir) args.push('-BridgeDir', String(config.selfHealBridgeDir))
      const r = await new Promise((resolve) => {
        execFile('pwsh', args, { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
          (err, stdout, stderr) => resolve({ err, stdout, stderr }))
      })
      log('自愈：脚本返回 ' + (r.err ? ('失败：' + String(r.err.message).slice(0, 120)) : '成功'))
      log('自愈：' + String(r.stdout || '').split('\n').slice(-4).join(' / ').slice(0, 300))
    } catch (e) {
      log('自愈：执行失败 ' + String(e?.message || e).slice(0, 140))
    } finally { selfHealBusy = false }
  }


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
        // ★ 死锁特征：hook 存活 + 数据库可读 同时异常（status 正常但 execute 超时）
    if (healthStreak >= 3) {
      const hookBad = badItems.some((i) => i.name === 'hook 存活')
      const dbBad = badItems.some((i) => i.name === '数据库可读')
      if (hookBad && dbBad) {
        // ★ 2026-10-28：两种情况下的"读不到库"是**预期内**的，重启微信只会更糟：
        //   ① 桥正在暂停/退避（我们自己停了手，库当然读不到）
        //   ② 微信正在备份/重建数据库（material 刚被写过，句柄短暂失效）
        //   实测：12:06 那次自愈就是 ① 误判成"数据库死锁"，白重启了一次微信。
        void (async () => {
          try {
            const ps = await client.call('pollStatus', {}, 6000)
            if (ps && (ps.paused || ps.hardStopped || Number(ps.pauseLeftSec) > 0)) {
              log('自愈跳过：桥正在暂停/退避中（此时读不到库属预期，不重启微信）')
              return
            }
            if (ps && ps.maintaining) {
              log('自愈跳过：微信正在备份/重建数据库（material 刚更新，稍后会自己恢复）')
              return
            }
          } catch { /* 状态拿不到就走原流程 */ }
          void trySelfHeal('数据库死锁（hook 存活/数据库可读 同时异常）')
        })()
      }
    }
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
    // 桥侧若还只会返回 roomId，用本插件的群名缓存补一层（不改桥也能显示群名）
    if (!roomNameCache.size) { try { await refreshNameCaches() } catch { /* ignore */ } }
    for (const x of roomsList) {
      const n = roomNameCache.get(x.roomId)
      if (n) x.name = n
    }
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

  /**
   * 面板读写记忆专用：从磁盘还原一个"影子群对象"，**不创建活动群状态**。
   * 为什么不能用 roomState()：它会建 policy、回填数据库、拉群成员，还会被主动发言/
   * 记忆提炼的定时器看到 —— 用户只是打开面板看一眼某个群，不应该让机器人开始在
   * 那个群"主动冒泡"或额外调用 LLM。
   */
  function panelRoomView(room) {
    const liveName = room.name && !String(room.name).endsWith('@chatroom') ? room.name : ''
    const r = { roomId: room.roomId, roomName: liveName || room.roomId, msgs: [], facts: [] }
    try {
      const raw = JSON.parse(readFileSync(memFile(room.roomId), 'utf8'))
      if (Array.isArray(raw?.msgs)) r.msgs = raw.msgs
      // 同样：旧文件里的 roomName 可能是 roomId，不能盖掉真群名
      if (!liveName && raw?.roomName && !String(raw.roomName).endsWith('@chatroom')) r.roomName = raw.roomName
    } catch { /* 没有短期记忆 */ }
    try {
      const saved = JSON.parse(readFileSync(factsPathFor(room.roomId), 'utf8'))
      let arr = Array.isArray(saved) ? saved : []
      // ★ 面板/工具读取路径也要做同样的 v2 归一化，否则这里显示的是"没有强度/情绪的旧数据"，
      //   而机器人内部用的是归一化后的（两边不一致，排查时会被误导）。
      //   只读不写：写完的值由面板的写操作（固定/归档/复习/提炼）负责落盘。
      if (config.memoryV2 !== false) {
        const mig = MV2.migrateList(arr, Date.now(), memCfg())
        arr = MV2.ensureIds(mig.items, Date.now()).items
        arr = MV2.backfillEmotion(arr, Date.now()).items
      }
      r.facts = enrichSourceNames(arr)
    } catch { /* 没有长期记忆 */ }
    return r
  }

  // ── 模型接口：读取 DSH 的 provider 目录 / 设置（面板「模型接口」页用）──
  const getSvc = (name) => {
    try { return (typeof ctx.get === 'function' ? ctx.get(name) : null) ?? ctx[name] } catch { return null }
  }

  async function panelProvidersState() {
    const out = { ok: true, registered: [], configurable: [], settings: [], error: '' }
    try {
      const llm = getSvc('llm')
      if (llm && typeof llm.listProviders === 'function') {
        out.registered = llm.listProviders().map((p) => ({ id: p.id, name: p.name }))
      }
      if (llm && typeof llm.listConfigurableProviders === 'function') {
        out.configurable = llm.listConfigurableProviders().map((p) => ({
          provider: p.provider,
          displayName: p.displayName,
          settingsNs: String(p.settingsNs || ''),
          settingsPath: Array.isArray(p.settingsPath) ? [...p.settingsPath] : [],
          declared: !!p.declared,
        }))
      }
      const settings = getSvc('settings')
      if (settings && typeof settings.describe === 'function') {
        const desc = await settings.describe({ redactSecrets: true })
        out.settings = (desc || [])
          .filter((d) => d.value && (d.value.providers || String(d.ns) === 'agent-default-model'))
          .map((d) => ({
            ns: String(d.ns),
            revision: d.revision,
            value: d.value,
            writable: settings.writable !== false,
          }))
      }
      // 每个 provider 的 key 引用是否真的配了（只看 configured/source，不返回值）
      const creds = getSvc('credentials')
      out.credentials = {}
      if (creds && typeof creds.describe === 'function') {
        const pi = out.settings.find((s) => s.ns === 'llm-pi-ai')
        for (const [id, p] of Object.entries(pi?.value?.providers || {})) {
          const ref = p?.apiKeyEnv
          if (!ref) continue
          try {
            const info = await creds.describe(ref)
            out.credentials[id] = { ref, configured: !!info?.configured, source: info?.source || '', writable: info?.writable !== false }
          } catch { out.credentials[id] = { ref, configured: false, source: '', writable: false } }
        }
      }
    } catch (e) {
      out.ok = false
      out.error = String(e?.stack || e?.message || e)
      log('模型接口：读取 provider 状态失败 ' + String(e?.message || e))
    }
    return out
  }

  /** 找到某个 provider 的 settings 命名空间与当前描述符。 */
  async function providerDoc(provider) {
    const llm = getSvc('llm')
    const settings = getSvc('settings')
    if (!llm || typeof llm.listConfigurableProviders !== 'function') throw new Error('当前 DSH 没有 llm 服务')
    if (!settings || typeof settings.describe !== 'function') throw new Error('当前 DSH 没有 settings 服务')
    const dir = llm.listConfigurableProviders().find((p) => p.provider === provider)
    if (!dir) throw new Error('DSH 不认识这个 provider：' + provider)
    const descs = await settings.describe({ redactSecrets: true })
    const desc = (descs || []).find((d) => String(d.ns) === String(dir.settingsNs))
    if (!desc) throw new Error('找不到设置命名空间：' + String(dir.settingsNs))
    return { llm, settings, dir, desc, ns: String(dir.settingsNs) }
  }

  /**
   * 新增/修改一个模型服务商。
   * 只写「凭据引用 + 端点 + 模型清单」，API key 存 DSH 凭据库，绝不回显、不写进配置。
   * 保存后 pi-ai 会原子地注册/替换路由，下一次请求即生效（无需重启 DSH）。
   */
  async function panelProviderSave(body) {
    const provider = String(body?.provider || '').trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider)) throw new Error('provider id 不合法')
    const { settings, desc, ns, dir } = await providerDoc(provider)
    const providers = JSON.parse(JSON.stringify(desc.value?.providers || {}))
    const profile = providers[provider] || {}

    if (body.displayName !== undefined && String(body.displayName).trim()) profile.displayName = String(body.displayName).trim()
    if (body.baseURL !== undefined && String(body.baseURL).trim()) profile.baseURL = String(body.baseURL).trim()
    if (body.api !== undefined && String(body.api).trim()) profile.api = String(body.api).trim()
    if (body.models !== undefined) {
      const list = String(body.models).split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
      if (list.length) profile.models = list.map((id) => ({ id }))
      else delete profile.models          // 留空 = 用内置目录，不要写空数组（会被当成"没有模型"）
    }

    // key：显式传入才写凭据；只给 keyRef 则只改引用（用于沿用已有 key）
    // ★ 先注册路由（settings.update）成功后再写凭据：否则模型清单/协议写错导致整次保存失败时，
    //   会在凭据库里留下一个没有归属的 key（实测踩过）。
    let ref = String(body.keyRef || '').trim()
    const pendingKey = body.apiKey !== undefined && String(body.apiKey).trim() ? String(body.apiKey).trim() : ''
    if (pendingKey) {
      const creds = getSvc('credentials')
      if (!creds || typeof creds.set !== 'function') throw new Error('当前 DSH 没有 credentials 服务，无法保存 API key')
      ref = ref || ('WECHAT_LLM_' + provider.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_KEY')
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error('keyRef 必须是 POSIX 变量名（如 OPENAI_API_KEY）')
    }
    if (ref) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error('keyRef 必须是 POSIX 变量名（如 OPENAI_API_KEY）')
      profile.apiKeyEnv = ref
    }
    // 用 mutate(set) 整段替换 profile：这样删掉 models/displayName 等字段时能真正消失
    // （settings.update 对 dict 是合并语义，删字段/删 provider 都不会生效）。
    if (typeof settings.mutate === 'function' && Array.isArray(dir.settingsPath) && dir.settingsPath.length) {
      await settings.mutate(ns, [{ op: 'set', path: [...dir.settingsPath], value: profile }], desc.revision)
    } else {
      providers[provider] = profile
      await settings.update(ns, { providers }, desc.revision)
    }
    if (pendingKey) {
      const creds = getSvc('credentials')
      await creds.set(ref, pendingKey)
    }

    // 可选：直接设为机器人聊天/视觉默认路由
    if (body.setChat && body.model) applyConfigPatch({ provider, model: String(body.model) })
    if (body.setVision && body.model) applyConfigPatch({ visionProvider: provider, visionModel: String(body.model) })

    log(`模型接口：已保存 ${provider}（keyRef=${profile.apiKeyEnv || '未设置'}）`)
    const state = await panelProvidersState()
    return { ok: true, provider, profile, state }
  }

  /** 删除一个服务商配置（不删凭据，方便以后重新启用）。 */
  async function panelProviderRemove(body) {
    const provider = String(body?.provider || '').trim()
    const { settings, desc, ns, dir } = await providerDoc(provider)
    const providers = JSON.parse(JSON.stringify(desc.value?.providers || {}))
    const ref = providers[provider]?.apiKeyEnv || String(body?.keyRef || '').trim()
    const purge = async () => {
      if (!ref) return
      const creds = getSvc('credentials')
      if (creds && typeof creds.unset === 'function') {
        try { await creds.unset(ref) } catch (e) { log('模型接口：删凭据失败 ' + String(e?.message || e)) }
      }
    }
    if (!providers[provider]) {
      if (body.purgeKey) await purge()
      return { ok: true, removed: false, state: await panelProvidersState() }
    }
    // ★ 删除必须用 mutate({op:'unset'})：settings.update 对 dict 是"合并"，
    //   把某个 provider 从对象里删掉再 update 并不会真的删除（实测踩过）。
    if (typeof settings.mutate === 'function' && Array.isArray(dir.settingsPath) && dir.settingsPath.length) {
      await settings.mutate(ns, [{ op: 'unset', path: [...dir.settingsPath] }], desc.revision)
    } else {
      delete providers[provider]
      await settings.update(ns, { providers }, desc.revision)
    }
    // 可选：连凭据一起删（默认保留，方便以后重新启用）
    if (body.purgeKey) await purge()
    // 如果机器人正指着它，顺手退回默认，避免之后每条消息都报 MISSING_CREDENTIAL/UNKNOWN_MODEL
    if (config.provider === provider) applyConfigPatch({ provider: '', model: '' })
    if (config.visionProvider === provider) applyConfigPatch({ visionProvider: '', visionModel: '' })
    log('模型接口：已移除 ' + provider)
    return { ok: true, removed: true, state: await panelProvidersState() }
  }

  /** 用一次极小的真实请求验证路由是否可用（会消耗几个 token）。 */
  async function panelProviderTest(body) {
    const provider = String(body?.provider || '').trim()
    const llm = getSvc('llm')
    if (!llm || typeof llm.stream !== 'function') throw new Error('当前 DSH 没有 llm 服务')
    let model = String(body?.model || '').trim()
    if (!model && typeof llm.listModels === 'function') {
      const list = await llm.listModels(provider)
      model = list?.[0]?.id || ''
    }
    if (!model) throw new Error('请填模型 id（该服务商没有可自动挑选的模型）')
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('模型测试超时（25s）')), 25_000)
    const t0 = Date.now()
    let text = ''
    try {
      const stream = llm.stream({
        provider,
        model,
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '只回复两个字：在的' }] })],
        maxTokens: 32,
        signal: ac.signal,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'block-end' && !text && chunk.block?.type === 'text') text = chunk.block.text || ''
      }
    } finally {
      clearTimeout(timer)
    }
    return { ok: true, provider, model, text: String(text).trim().slice(0, 300), ms: Date.now() - t0 }
  }

  /**
   * 模型目录（面板「人设模型」页的下拉框用）。
   *
   * 为什么要有这个：原来 provider / model 是纯文本框，用户得自己记住
   * 「deepseek-account / deepseek-flash」这种 id，写错就静默回退到别的路由。
   * DSH 本体是「provider 下拉 → model 下拉」，这里复刻同样的体验。
   *
   * 数据来源全部走 DSH 的 llm 服务，不自己维护清单：
   *   llm.listProviders()        → 已注册（真正能用）的 provider
   *   llm.listConfigurableProviders() → 声明了但可能没启用/没配 key 的
   *   llm.listModels(provider)   → 该 provider 的模型清单（异步，未注册会抛）
   *
   * @param {string} [provider] 要给哪个 provider 取模型清单；缺省用当前配置或 DSH 当前选择
   */
  async function panelModelCatalog(provider) {
    const out = {
      ok: true,
      providers: [],       // [{id,name,enabled,models?}]
      models: [],          // 当前 provider 的模型 [{id,name,inputModalities}]
      modelsFor: '',       // 上面这份 models 属于哪个 provider
      current: { provider: '', model: '', visionProvider: '', visionModel: '' },
      dshSelection: null,  // DSH 自己的当前选择（给面板显示「跟随 DSH」用）
      error: '',
    }
    const llm = getSvc('llm')
    try {
      if (llm && typeof llm.listProviders === 'function') {
        out.providers = llm.listProviders()
          .map((x) => ({ id: String(x.id || ''), name: String(x.name || x.id || ''), enabled: true }))
          .filter((x) => x.id)
      }
      // 声明了但没注册成功的，也列出来（标 enabled:false，并标原因由前端提示）
      if (llm && typeof llm.listConfigurableProviders === 'function') {
        const seen = new Set(out.providers.map((x) => x.id))
        for (const c of llm.listConfigurableProviders() || []) {
          const id = String(c.provider || '')
          if (!id || seen.has(id)) continue
          out.providers.push({ id, name: String(c.displayName || id), enabled: false })
          seen.add(id)
        }
      }
      try {
        // 这个服务要用 ctx.get 拿；直接 ctx.agentDefaultModel 在插件里通常是 undefined
        const adm = getSvc('agentDefaultModel') || ctx.agentDefaultModel
        const sel = adm?.currentSelection?.()
        if (sel?.provider && sel?.model) out.dshSelection = { provider: sel.provider, model: sel.model }
        else if (adm && typeof adm.currentSelection === 'function') {
          // 服务在但没配置：把"DSH 没设默认模型"这个事实带出去，面板就不用瞎猜
          out.dshSelection = null
        }
      } catch (e) { out.dshSelectionError = String(e?.message || e).slice(0, 120) }
    } catch (e) {
      out.error = String(e?.message || e)
    }

    out.current = {
      provider: String(config.provider || ''),
      model: String(config.model || ''),
      visionProvider: String(config.visionProvider || ''),
      visionModel: String(config.visionModel || ''),
    }

    // 取哪一份模型清单：显式传入 > 当前配置 > DSH 当前选择
    const want = String(provider || out.current.provider || out.dshSelection?.provider || '')
    out.modelsFor = want
    if (want && llm && typeof llm.listModels === 'function') {
      try {
        const list = await llm.listModels(want)
        out.models = (list || []).map((m) => ({
          id: String(m.id || ''),
          name: String(m.name || m.id || ''),
          inputModalities: Array.isArray(m.inputModalities) ? [...m.inputModalities] : [],
        })).filter((m) => m.id)
      } catch (e) {
        // 未注册 / adapter 报错都只是"这一项拿不到"，不要让整个面板报错
        out.error = out.error || ('取 ' + want + ' 的模型清单失败：' + String(e?.message || e))
      }
    }
    return out
  }

  async function panelProviderModels(provider) {
    const llm = getSvc('llm')
    if (!llm || typeof llm.listModels !== 'function') return []
    try {
      const list = await llm.listModels(provider)
      return (list || []).map((m) => ({ id: m.id, name: m.name, modalities: m.inputModalities || [] }))
    } catch (e) {
      return { error: String(e?.message || e) }
    }
  }

  // ── 图像生成接口（桥侧 data/image-gen.json，每次生成都会重新读）──
  const bridgeDataDir = dirname(process.env.WECHAT_BRIDGE_LOG_DIR || 'D:\\微信deepseek\\data\\logs')
  const imageCfgFile = join(bridgeDataDir, 'image-gen.json')

  function readImageConfig() {
    let cfg = {}
    try { cfg = JSON.parse(readFileSync(imageCfgFile, 'utf8')) || {} } catch { /* 默认 */ }
    return {
      apiUrl: String(cfg.apiUrl || 'https://apihub.agnes-ai.com/v1/images/generations'),
      model: String(cfg.model || 'agnes-image-2.1-flash'),
      keyRef: String(cfg.keyRef || 'AGNES_API_KEY'),
      mode: String(cfg.mode || 'i2i'),
      backend: String(cfg.backend || 'agnes'),
      style: String(cfg.style || 'agnes'),
      hasApiKey: !!(cfg.apiKey && String(cfg.apiKey).trim()),
      file: imageCfgFile,
    }
  }

  async function panelImageSave(body) {
    const cfg = readImageConfig()
    const next = {
      apiUrl: String(body.apiUrl || cfg.apiUrl).trim(),
      model: String(body.model || cfg.model).trim(),
      keyRef: String(body.keyRef || cfg.keyRef).trim(),
      mode: ['i2i', 't2i'].includes(String(body.mode)) ? String(body.mode) : cfg.mode,
      backend: ['agnes', 'comfy'].includes(String(body.backend)) ? String(body.backend) : cfg.backend,
      style: ['agnes', 'openai'].includes(String(body.style)) ? String(body.style) : cfg.style,
    }
    if (!/^https?:\/\//i.test(next.apiUrl)) throw new Error('接口地址必须是 http(s) URL')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(next.keyRef)) throw new Error('keyRef 必须是 POSIX 变量名（如 OPENAI_API_KEY）')
    if (body.apiKey !== undefined && String(body.apiKey).trim()) {
      const creds = getSvc('credentials')
      if (!creds || typeof creds.set !== 'function') throw new Error('没有 credentials 服务，无法保存 API key')
      await creds.set(next.keyRef, String(body.apiKey).trim())
    }
    const existing = (() => { try { return JSON.parse(readFileSync(imageCfgFile, 'utf8')) || {} } catch { return {} } })()
    delete existing.apiKey                 // key 一律走凭据库，不落明文配置
    const merged = { ...existing, ...next }
    delete merged.hasApiKey
    mkdirSync(dirname(imageCfgFile), { recursive: true })
    writeFileSync(imageCfgFile, JSON.stringify(merged, null, 2), 'utf8')
    log(`图像接口：apiUrl=${next.apiUrl}｜model=${next.model}｜keyRef=${next.keyRef}｜mode=${next.mode}`)
    return { ok: true, config: readImageConfig() }
  }

  // ── 自动更新（2026-10-22）────────────────────────────────────────
  //   机制：以 GitHub main 分支的 commit sha 作为版本号
  //     · 检查：GET api.github.com/repos/<owner>/<repo>/commits/main
  //     · 公告：最近 N 个 commit message
  //     · 下载：codeload.github.com 的 zip（实测可用；raw.githubusercontent 被墙，别用）
  //     · 覆盖：白名单（只动代码，绝不碰 config.json / data / facts / memory）
  //     · 备份：更新前把当前代码打包到 backups/，失败自动回滚
  //   为什么用 main 分支而不是 Release：用户要求"新功能都要更新"，
  //   走 main 就不用每次手动发 Release。
  const UPDATE_REPO = process.env.WECHAT_UPDATE_REPO || 'mengyunqwq/wechat-bot'

  // 启动时做一次「热重载自身」的预检演练（只 import + 校验导出，不替换旧代，零风险）。
  //   面板诊断页的「热重载插件」按钮走的是同一段逻辑，这里先证明它在本宿主上跑得通。
  setTimeout(() => {
    try {
      const lc = ctx.loader?.internal?.loadCache
      let url = null
      if (lc && typeof lc.keys === 'function') {
        for (const u of lc.keys()) {
          if (typeof u === 'string' && decodeURIComponent(u).includes('wechat-group-agent/lib/index.js')) { url = u; break }
        }
      }
      log('[selfReload] 能力探测：loadCache=' + (lc ? 'ok' : '不可用')
        + '，自身模块=' + (url ? '命中' : '未命中')
        + '，registry=' + (ctx.registry && typeof ctx.registry.plugin === 'function' ? 'ok' : '不可用'))
      if (!url) return
      const oldJob = lc.get(url)
      Map.prototype.delete.call(lc, url)
      ctx.loader.import(url, () => []).then((ns) => {
        const fresh = ctx.loader.unwrapExports(ns)
        const good = !!(fresh && (typeof fresh === 'function' || typeof fresh.apply === 'function'))
        if (!good && oldJob) lc.set(url, oldJob)   // 预检不过 → 恢复缓存，旧代不受影响
        log('[selfReload] 预检演练：' + (good ? '✅ 新代码可加载（缓存已恢复，未替换旧代）' : '❌ 导出无效'))
      }).catch((e) => {
        if (oldJob) lc.set(url, oldJob)
        log('[selfReload] 预检演练：❌ import 失败（缓存已恢复）：' + String(e?.message || e).slice(0, 160))
      })
    } catch (e) { log('[selfReload] 能力探测异常：' + String(e?.message || e)) }
  }, 8000)

  // 让 clientModules 重新扫描本插件的 client 声明（DSH 侧边栏的「微信机器人」入口）。
  //   为什么需要：注入/重载进来的插件是运行时才进 loader 的，client 注册表可能没它，
  //   于是侧边栏入口消失。clientModules 监听 internal/plugin 事件，手动 emit 一次就能重扫。
  setTimeout(() => {
    try {
      ctx.emit('internal/plugin', ctx.fiber)
      const cm = ctx.get('clientModules')
      // 直接调 flush 并捕获真实错误（只 emit 不够，dirty 可能没包含本包）
      try {
        if (cm && cm.dirty && typeof cm.dirty.add === 'function') cm.dirty.add('@dsh-external/dsh-wechat-bot')
        if (cm && typeof cm.flush === 'function') cm.flush((err) => {
          log('[client] flush：' + (err ? '❌ ' + String(err?.message || err).slice(0, 240) : 'ok'))
        })
      } catch (e) { log('[client] flush 调用异常：' + String(e?.message || e)) }
      setTimeout(() => {
        try {
          const p = cm && typeof cm.clientPath === 'function' ? cm.clientPath('@dsh-external/dsh-wechat-bot') : ''
          log('[client] 侧栏入口注册：' + (p ? 'ok（' + String(p).split(/[\\/]/).slice(-2).join('/') + '）' : '仍未注册（clientPath 为空）'))
        } catch (e) { log('[client] 查询失败：' + String(e?.message || e)) }
      }, 1200)
    } catch (e) { log('[client] 触发 internal/plugin 失败：' + String(e?.message || e)) }
  }, 10000)

  const UPDATE_STATE_FILE = join(dirname(memoryDir), 'update-state.json')
  const UPDATE_BACKUP_DIR = join(dirname(memoryDir), 'backups')
  const updateState = { commit: '', version: '', checkedAt: 0, latest: null, history: [], lastResult: null }
  try {
    const u = JSON.parse(readFileSync(UPDATE_STATE_FILE, 'utf8')) || {}
    updateState.commit = String(u.commit || '')
    updateState.version = String(u.version || '')
    updateState.checkedAt = Number(u.checkedAt) || 0
    updateState.latest = u.latest || null
    updateState.history = Array.isArray(u.history) ? u.history.slice(0, 20) : []
  } catch { /* 首次 */ }
  function saveUpdateState() {
    try { writeFileSync(UPDATE_STATE_FILE, JSON.stringify(updateState, null, 1), 'utf8') } catch { /* ignore */ }
  }
  // 为什么不用 fetch：本机网络经过代理/防火墙（中间人解密），Node 的 fetch 报
  //   UNABLE_TO_VERIFY_LEAF_SIGNATURE（证书链不完整）。
  // 为什么不用 powershell：execFileSync 在 Windows 上会闪一个控制台窗口（用户能看到）。
  // 所以用 node:https + 仅对 GitHub 这两个域名关闭证书校验 —— 只读公开仓库、不传任何凭据，
  // 被劫持最多是拿到假代码，所以风险可接受。
  // ★ 2026-10-25：拆出「能看到状态码/响应头」的版本 —— ETag 条件请求需要读 304 和 etag。
  const httpsGetRaw = (url, ms = 20000, extraHeaders = null) => new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch { reject(new Error('bad url')); return }
    const req = httpsRequest(u, {
      method: 'GET',
      timeout: ms,
      rejectUnauthorized: false,
      headers: Object.assign({ 'user-agent': 'dsh-wechat-bot', accept: 'application/vnd.github+json' }, extraHeaders || {}),
    }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    req.end()
  })
  const httpsGet = async (url, ms = 20000) => {
    const r = await httpsGetRaw(url, ms)
    if (r.status >= 400) throw new Error('HTTP ' + r.status)
    return r.body
  }
  // ★ 2026-10-25：GitHub API 走 ETag 条件请求。
  //   GitHub 明确规定：返回 304 的请求**不计入 rate limit**（匿名只有 60 次/小时）。
  //   所以「没发新版」的时候怎么查都不烧额度，发了新版才真正消耗一次。
  const ghEtagCache = new Map()   // path -> { etag, body }
  const ghJson = async (path, ms = 20000) => {
    const prev = ghEtagCache.get(path)
    const headers = prev && prev.etag ? { 'if-none-match': prev.etag } : null
    const res = await httpsGetRaw('https://api.github.com' + path, ms, headers)
    if (res.status === 304) {
      if (prev) return prev.body
      throw new Error('HTTP 304 但本地无缓存')
    }
    if (res.status >= 400) throw new Error('HTTP ' + res.status)
    const text = res.body.toString('utf8')
    let body
    try { body = JSON.parse(text) } catch { throw new Error('响应不是 JSON：' + text.slice(0, 80)) }
    const etag = res.headers.etag || ''
    if (etag) ghEtagCache.set(path, { etag, body })
    return body
  }
  /** 检查更新：返回 { available, local, remote, behind, commits[] } */
  // ── 版本号（2026-10-22 改）──────────────────────────────────────
  //   为什么用版本号而不是 commit sha：
  //     · commit 每次 push 都变 → 开发者自己改代码/提交，部署方就会看到"有更新"（误报）
  //     · 版本号只在"发版"时升 → 改代码不升版本 = 不提示（开发场景正确）
  //   发版流程：改代码 → 改仓库 version.json 的 version → push
  // ★ 2026-10-25：本地版本号定位不再只认 WECHAT_BOT_HOME。
  //   现象：面板「本地」显示 v0.0.0，但 D:\微信deepseek\version.json 明明存在且合法（无 BOM，329B）。
  //   → 说明插件进程里的 WECHAT_BOT_HOME 指到了别的目录，单路径读取进了 catch。
  //   现在按候选顺序试，谁先读到合法的 version 字段就用谁；全失败才回 0.0.0 并留下诊断。
  const SELF_LIB_DIR = dirname(fileURLToPath(import.meta.url))   // …/wechat-group-agent/lib
  const PKG_ROOT = dirname(SELF_LIB_DIR)                          // …/wechat-group-agent
  // ★ 2026-10-25：项目根自动探测，不再死认 D:\微信deepseek。
  //   实测一台机器把机器人装在 X:\DeepSeek\wechat-bot（WECHAT_BOT_HOME 没设）：
  //     → 版本读到 0.0.0（去 D:\微信deepseek 找 version.json，当然没有）
  //     → 「立即更新」把代码覆盖到 D:\微信deepseek（那里根本没有项目），
  //       而 DSH 实际加载的是 X:\DeepSeek\wechat-bot\wechat-group-agent
  //     → 更新「成功」但永远不生效，重启也没用。
  //   规则：WECHAT_BOT_HOME 显式指定优先 → 插件包上一级若含 wx-bridge 就当项目根 → 最后兜底老路径。
  const PROJECT_ROOT = dirname(PKG_ROOT)
  const BOT_HOME = process.env.WECHAT_BOT_HOME
    || (existsSync(join(PROJECT_ROOT, 'wx-bridge')) ? PROJECT_ROOT : 'D:\\微信deepseek')
  const VERSION_CANDIDATES = Array.from(new Set([
    join(BOT_HOME, 'version.json'),
    'D:\\微信deepseek\\version.json',
    join(PROJECT_ROOT, 'version.json'),
    join(process.cwd(), 'version.json'),
  ].filter(Boolean)))
  const LOCAL_VERSION_FILE = VERSION_CANDIDATES[0]
  const versionDiag = { file: '', errors: [] }
  function readLocalVersion() {
    const errs = []
    for (const f of VERSION_CANDIDATES) {
      try {
        const j = JSON.parse(readFileSync(f, 'utf8')) || {}
        // ★ 空版本 / 0.0.0 视为无效：某些插件脚手架目录里就有 {"version":"0.0.0"} 的 version.json，
        //   一旦 WECHAT_BOT_HOME 指过去就会先命中它（这正是面板显示 v0.0.0 的来源）。
        if (!j.version || String(j.version) === '0.0.0') throw new Error('version 为空或 0.0.0，视为无效')
        versionDiag.file = f
        versionDiag.errors = errs
        return {
          version: String(j.version),
          notes: String(j.notes || ''),
          releasedAt: String(j.releasedAt || ''),
        }
      } catch (e) {
        errs.push(f + ' → ' + String(e?.message || e).slice(0, 60))
      }
    }
    versionDiag.file = ''
    versionDiag.errors = errs
    // ★ 2026-10-25 第二次修：所有候选都读不到时**必须**回插件自身的版本常量。
    //   之前这里返回 '0.0.0'，而 checkUpdate 的失败分支是 `localVersion: readLocalVersion().version`
    //   → 网络一抖（GitHub 限流 / CDN 超时）面板就显示 v0.0.0。
    //   那台机器「仓库最新 1.3.7」来自上次成功的缓存，本地却是 0.0.0，就是这个组合。
    return { version, notes: '', releasedAt: '' }
  }
  async function readRepoVersion() {
    // ★ 2026-10-25：通道优先级重排 —— API 与 Release 是权威，CDN 只做兜底。
    //   旧逻辑只靠 jsDelivr，而它的节点缓存不同步（@main 可能还停在几天前），
    //   ?ts= 查询参数也绕不过缓存，于是「仓库最新」会读出旧版本甚至来回跳。
    let j = null
    let apiErr = null
    const cands = []
    // ① 权威源：API contents/version.json（带 ETag，304 不计限额）
    try {
      const r = await ghJson(`/repos/${UPDATE_REPO}/contents/version.json`)
      const txt = Buffer.from(String(r.content || '').replace(/\n/g, ''), 'base64').toString('utf8')
      const jj = JSON.parse(txt) || {}
      if (jj.version) { j = jj; cands.push({ via: 'api', j: jj }) }
    } catch (e) {
      apiErr = e
    }
    // ② 权威源：Releases API —— 官方发布的 tag 是"最新版本"的事实依据，不经过任何 CDN。
    //   它同时用来给 CDN 结果做上限校验：CDN 不可能比官方发布更新，超过的一律是脏数据。
    let releaseVer = ''
    try {
      const rel = await ghJson(`/repos/${UPDATE_REPO}/releases/latest`)
      const tag = String(rel?.tag_name || '').replace(/^v/i, '')
      if (tag) {
        releaseVer = tag
        // Release body 是 markdown，取第一行有意义的文字当发布说明，避免面板里全是符号
        const line = String(rel?.body || '').split('\n').map((s) => s.trim())
          .find((s) => s && !/^[#>*\-|`]/.test(s))
        cands.push({ via: 'release', j: { version: tag, notes: line || '', releasedAt: String(rel?.published_at || '') } })
      }
    } catch { /* Release 拿不到不影响，CDN 仍可用 */ }
    // ③ 自定义版本源：真正不依赖 GitHub。用户在面板里填 URL（可多个），返回
    //   {"version":"1.3.x","notes":"..."} 就采用。这一档**不受 Release 上限校验**——
    //   它可能是自己发布的版本，比 GitHub 上的还新。
    const mirrorUrls = String(config.updateMirror || '')
      .split(/[\s,;，]+/).map((s) => s.trim()).filter((u) => /^https?:\/\//i.test(u))
    if (mirrorUrls.length) {
      const ms = await Promise.allSettled(mirrorUrls.map((url) => (async () => {
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), 12000)
        try {
          const res = await fetch(url, { signal: ac.signal, headers: { 'cache-control': 'no-cache' } })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const jj = await res.json()
          if (!jj || !jj.version) throw new Error('无 version 字段')
          return { via: 'mirror', j: jj }
        } finally { clearTimeout(timer) }
      })()))
      for (const r of ms) {
        if (r.status === 'fulfilled') cands.push(r.value)
        else log('[update] 自定义版本源失败：' + String(r.reason?.message || r.reason).slice(0, 80))
      }
    }
    // ④ 兜底：多节点 CDN 并发。实测各节点缓存不同步（gcore 新鲜、fastly@main 可能停在几天前）。
    const cdns = [
      ['gcore', `https://gcore.jsdelivr.net/gh/${UPDATE_REPO}@main/version.json`],
      ['testingcf', `https://testingcf.jsdelivr.net/gh/${UPDATE_REPO}@main/version.json`],
      ['cdn@latest', `https://cdn.jsdelivr.net/gh/${UPDATE_REPO}@latest/version.json`],
      ['ghproxy', `https://gh-proxy.com/https://raw.githubusercontent.com/${UPDATE_REPO}/main/version.json`],
      ['cdn@main', `https://cdn.jsdelivr.net/gh/${UPDATE_REPO}@main/version.json`],
      ['fastly@main', `https://fastly.jsdelivr.net/gh/${UPDATE_REPO}@main/version.json`],
    ]
    const settled = await Promise.allSettled(cdns.map(([via, url]) => (async () => {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 12000)
      try {
        const res = await fetch(url, { signal: ac.signal, headers: { 'cache-control': 'no-cache' } })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const jj = await res.json()
        if (!jj || !jj.version) throw new Error('无 version 字段')
        return { via, j: jj }
      } finally { clearTimeout(timer) }
    })()))
    for (const r of settled) {
      if (r.status !== 'fulfilled') continue
      const c = r.value
      // ★ 有官方 Release 版本时，CDN 报出比它还高的版本 = 脏数据/幻觉，直接丢弃，
      //   否则会误判"有更新"然后去下载一个不存在的 commit。
      if (releaseVer && cmpSemver(c.j.version, releaseVer) > 0) {
        log('[update] CDN(' + c.via + ') 报 v' + c.j.version + '，高于 Release v' + releaseVer + ' → 视为脏数据丢弃')
        continue
      }
      cands.push(c)
    }
    if (!cands.length) {
      throw new Error('版本读取失败：API=' + String(apiErr?.message || apiErr).slice(0, 50) + '；CDN 全部失败')
    }
    let best = cands[0]
    for (const c of cands) if (cmpSemver(c.j.version, best.j.version) > 0) best = c
    j = best.j
    if (best.via !== 'api') {
      log('[update] 用 ' + best.via + ' 读到仓库版本 v' + j.version
        + (apiErr ? '（API=' + String(apiErr?.message || apiErr).slice(0, 40) + '）' : ''))
    }
    // ★ 2026-10-22：r.sha 是**文件内容的 blob sha**，不能拿去 codeload 下载 zip
    //   （codeload.github.com/<repo>/zip/<blob sha> → HTTP 404，实测 14 字节的 404 响应）。
    //   下载必须用 **commit sha**，所以这里额外查一次 commits/main。
    //   这是 v1.1.2 及以前「点更新就 404」的根因。
    let sha = ''
    try {
      const head = await ghJson(`/repos/${UPDATE_REPO}/commits/main`)
      sha = String(head?.sha || '')
    } catch { /* 拿不到就留空，downloadAndExtract 里会再取一次 */ }
    return {
      version: String(j.version || '0.0.0'),
      notes: String(j.notes || ''),
      releasedAt: String(j.releasedAt || ''),
      sha,
      via: best.via,
    }
  }
  /** semver 比较（容忍 v 前缀和位数不同）：a>b 返回 1 */
  function cmpSemver(a, b) {
    const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
    const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0
      const y = pb[i] || 0
      if (x > y) return 1
      if (x < y) return -1
    }
    return 0
  }
  /** 检查更新：比较本地 version.json 与仓库 version.json */
  async function checkUpdate() {
    const local = readLocalVersion()
    // 本地文件读不到时用插件版本常量，避免拿 0.0.0 去比较、误报"有更新"
    let localVer = local.version === '0.0.0' ? version : local.version
    // ★ 2026-10-25：version.json 落后于代码本身时以代码为准。
    //   旧更新器不覆盖根目录 version.json（代码 1.3.10、文件 1.3.9），
    //   会让「本地版本」永远停在旧值、检查更新无限提示"有更新"。
    if (cmpSemver(version, localVer) > 0) localVer = version
    const remote = await readRepoVersion()
    const available = cmpSemver(remote.version, localVer) > 0
    updateState.checkedAt = Date.now()
    updateState.version = localVer
    updateState.latest = {
      version: remote.version, notes: remote.notes, releasedAt: remote.releasedAt, sha: remote.sha,
    }
    saveUpdateState()
    let commits = []
    if (available) {
      try {
        const list = await ghJson(`/repos/${UPDATE_REPO}/commits?per_page=10`)
        commits = (Array.isArray(list) ? list : []).map((c) => ({
          sha: String(c.sha || '').slice(0, 7),
          msg: String(c.commit?.message || '').split('\n')[0],
          date: c.commit?.author?.date || '',
        }))
      } catch { /* 提交列表拿不到不影响 */ }
    }
    log('[update] 本地 v' + localVer + ' 远程 v' + remote.version + ' → ' + (available ? '有更新' : '已是最新'))
    return {
      available,
      localVersion: localVer, remoteVersion: remote.version,
      localNotes: local.notes, notes: remote.notes, releasedAt: remote.releasedAt,
      source: remote.via,
      commits,
    }
  }
  /** 下载 zip 并解压到临时目录。返回解压后的根目录 */
  async function downloadAndExtract(sha) {
    // ★ 2026-10-22：如果传进来的 sha 为空，现取 commits/main（绝不能拿 blob sha 去 codeload）
    if (!sha) {
      const head = await ghJson(`/repos/${UPDATE_REPO}/commits/main`)
      sha = String(head?.sha || '')
    }
    if (!/^[0-9a-f]{40}$/i.test(String(sha))) throw new Error('要下载的 commit sha 不合法：' + sha)
    const tmp = join((process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp'), 'dsh-wb-update-' + Date.now())
    mkdirSync(tmp, { recursive: true })
    const zipPath = join(tmp, 'src.zip')
    const url = `https://codeload.github.com/${UPDATE_REPO}/zip/${sha}`
    // 走 node:https（不用 powershell → 不闪控制台窗口）
    const buf = await httpsGet(url, 180000)
    if (!buf || !buf.length) throw new Error('下载内容为空')
    writeFileSync(zipPath, buf)
    const bytes = buf.length
    // 解压（Node 无内置 zip，用 PowerShell；Windows 环境固定）
          execFileSync(TAR_EXE, ['-xf', zipPath, '-C', tmp], { stdio: 'pipe', timeout: 120000, windowsHide: true })
    // 找解压出来的顶层目录（GitHub zip 会有一层 <repo>-<sha>/）
    const dirs = readdirSync(tmp).filter((f) => {
      try { return statSync(join(tmp, f)).isDirectory() } catch { return false }
    })
    if (!dirs.length) throw new Error('解压后没找到目录')
    return { root: join(tmp, dirs[0]), tmp, bytes }
  }
  /** 备份当前代码目录到 backups/（2026-10-22 修：逐目录打包，避免同名目录被合并） */
  function backupCode() {
    mkdirSync(UPDATE_BACKUP_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const out = join(UPDATE_BACKUP_DIR, `code-${stamp}.zip`)
    const rt = runtimeDirs().filter((d) => existsSync(d.dir))
    if (!rt.length) return ''
    // 先把各目录复制到临时区的子结构里，再整体打包 —— 这样解压后能按原结构还原
    const stage = join(process.env.TEMP || 'C:\\Windows\\Temp', 'wb-bk-' + Date.now())
    try {
      for (const d of rt) {
        const dest = join(stage, d.repo)   // 例如 stage/wechat-group-agent/lib
        mkdirSync(dest, { recursive: true })
        for (const f of readdirSync(d.dir, { withFileTypes: true })) {
          const sp = join(d.dir, f.name); const dp = join(dest, f.name)
          if (f.isDirectory()) copyRecursive(sp, dp)
          else copyFileSync(sp, dp)
        }
      }
      execFileSync(TAR_EXE, ['-a', '-cf', out, '-C', stage, '.'], { stdio: 'pipe', timeout: 180000, windowsHide: true })
    } finally {
      try { rmRecursive(stage) } catch { /* ignore */ }
    }
    return out
  }
  function copyRecursive(s, d) {
    mkdirSync(d, { recursive: true })
    for (const f of readdirSync(s, { withFileTypes: true })) {
      const sp = join(s, f.name); const dp = join(d, f.name)
      if (f.isDirectory()) copyRecursive(sp, dp)
      else copyFileSync(sp, dp)
    }
  }
  function rmRecursive(p) {
    try {
      for (const f of readdirSync(p, { withFileTypes: true })) {
        const fp = join(p, f.name)
        if (f.isDirectory()) rmRecursive(fp)
        else unlinkSync(fp)
      }
      rmSync(p)
    } catch { /* ignore */ }
  }
  /** 运行时目录 ↔ 仓库目录 的映射（白名单：只覆盖这些） */
  function runtimeDirs() {
    const base = BOT_HOME
    return [
      { repo: 'wechat-group-agent/lib',    dir: join(base, 'wechat-group-agent', 'lib'),    label: '插件代码' },
      { repo: 'wechat-group-agent/panel',  dir: join(base, 'wechat-group-agent', 'panel'),  label: '控制面板' },
      { repo: 'wx-bridge/lib',             dir: join(base, 'wx-bridge', 'lib'),             label: '桥代码' },
      { repo: 'scripts',                   dir: join(base, 'scripts'),                      label: '脚本' },
    ]
  }
  /** 把解压出来的代码覆盖到运行时（按白名单） */
  function applyFiles(srcRoot) {
    const report = []
    for (const rt of runtimeDirs()) {
      const src = join(srcRoot, rt.repo)
      if (!existsSync(src)) { report.push({ label: rt.label, skipped: '仓库里没有' }); continue }
      mkdirSync(rt.dir, { recursive: true })
      let n = 0
      const walk = (s, d) => {
        mkdirSync(d, { recursive: true })
        for (const f of readdirSync(s, { withFileTypes: true })) {
          const sp = join(s, f.name); const dp = join(d, f.name)
          if (f.isDirectory()) walk(sp, dp)
          else { copyFileSync(sp, dp); n++ }
        }
      }
      walk(src, rt.dir)
      // wx-bridge 根目录的 *.mjs（server.mjs 等）单独处理
      report.push({ label: rt.label, files: n, dir: rt.dir })
    }
    // 桥根目录的 .mjs 文件（server.mjs / 其他）
    const bridgeRoot = join(BOT_HOME, 'wx-bridge')
    const srcBridge = join(srcRoot, 'wx-bridge')
    if (existsSync(srcBridge)) {
      let n = 0
      for (const f of readdirSync(srcBridge, { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith('.mjs')) {
          copyFileSync(join(srcBridge, f.name), join(bridgeRoot, f.name)); n++
        }
      }
      if (n) report.push({ label: '桥入口文件', files: n, dir: bridgeRoot })
    }
    // ★ 2026-10-25：根目录的 version.json 必须一起更新。
    //   之前白名单里只有 lib/panel/scripts，版本号文件不覆盖 →
    //   代码已经是 1.3.10，version.json 还停在 1.3.9 →
    //   面板「本地」永远显示旧版、检查更新又提示有更新，形成死循环（用户实测踩到）。
    try {
      const srcVer = join(srcRoot, 'version.json')
      if (existsSync(srcVer)) {
        const vj = JSON.parse(readFileSync(srcVer, 'utf8')) || {}
        const dst = join(BOT_HOME, 'version.json')
        writeFileSync(dst, JSON.stringify({
          version: String(vj.version || ''),
          notes: String(vj.notes || ''),
          releasedAt: String(vj.releasedAt || ''),
        }, null, 2) + '\n', 'utf8')
        if (vj.version) updateState.version = String(vj.version)
        report.push({ label: '版本号', files: 1, detail: 'v' + String(vj.version || '?'), dir: dst })
      } else {
        report.push({ label: '版本号', skipped: '仓库里没有 version.json' })
      }
    } catch (e) {
      report.push({ label: '版本号', skipped: String(e?.message || e).slice(0, 60) })
    }
    return report
  }
  // ── 环境诊断（2026-10-22）────────────────────────────────────────
  //   面板的「诊断」页用。为什么要有：崩溃 / 库读不到 / 不回话这几种故障，
  //   在面板上原来只能靠"消息收不到"间接猜，看不出根因。
  //   这里把三类证据一次性拉齐：
  //     ① 微信崩溃 dump（时间/大小/趋势）—— 判断客户端是否稳定
  //     ② hook 的 //Debug/DBRescan + /Debug/ApiTable —— 判断数据库链路
  //     ③ hires 目录 + 磁盘占用 —— 判断"眼睛"是否在工作
  async function collectDiag() {
    const out = { at: Date.now() }
    const HOOK = process.env.WECHAT_HOOK_HTTP || 'http://127.0.0.1:30001'

    // ① 崩溃 dump
    try {
      const dir = join(process.env.APPDATA || '', 'Tencent', 'xwechat', 'crashinfo', 'reports')
      const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.dmp')) : []
      const items = names.map((f) => {
        try { const s = statSync(join(dir, f)); return { f, t: s.mtimeMs, bytes: s.size } } catch { return null }
      }).filter(Boolean).sort((a, b) => b.t - a.t)
      const t0 = new Date(); t0.setHours(0, 0, 0, 0)
      const todayMs = t0.getTime()
      const today = items.filter((x) => x.t >= todayMs)
      const yesterday = items.filter((x) => x.t >= todayMs - 86400_000 && x.t < todayMs)
      out.crash = {
        dir, total: items.length, today: today.length, yesterday: yesterday.length,
        lastAt: items[0]?.t || 0, lastMB: items[0] ? +(items[0].bytes / 1048576).toFixed(1) : 0,
        recent: items.slice(0, 5).map((x) => ({ at: x.t, mb: +(x.bytes / 1048576).toFixed(1) })),
      }
    } catch (e) { out.crash = { error: String(e?.message || e).slice(0, 120) } }

    // ② 桥状态（登录 / 自己 / 表情包库）
    try {
      const st = await client.call('status', {}, 8000)
      out.wechat = {
        loggedIn: st?.loggedIn ?? null, mock: st?.mock ?? null,
        self: st?.self || '', stickers: st?.stickers?.count ?? null,
      }
    } catch (e) { out.wechat = { error: String(e?.message || e).slice(0, 120) } }

    // ③ hook 诊断端点
    const getJson = async (path, ms = 6000) => {
      const r = await fetch(HOOK + path, { signal: AbortSignal.timeout(ms) })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return await r.json()
    }
    // 三个端点并发拉取（串行的话 hook 挂了要等 18 秒）
    const [dbRes, apiRes, hookRes] = await Promise.allSettled([
      getJson('/Debug/DBRescan'), getJson('/Debug/ApiTable'), getJson('/QueryDB/debug'),
    ])
    out.db = dbRes.status === 'fulfilled' ? dbRes.value : { error: String(dbRes.reason?.message || dbRes.reason).slice(0, 120) }
    out.api = apiRes.status === 'fulfilled' ? apiRes.value : { error: String(apiRes.reason?.message || apiRes.reason).slice(0, 120) }
    if (hookRes.status === 'fulfilled') {
      const q = hookRes.value
      out.hook = {
        IsLogin: q.IsLogin ?? null, base: q.base ?? 0, module_size: q.module_size ?? 0,
        dbs: Array.isArray(q.dbs) ? q.dbs.length : 0,
        api_ptrs_in_module: q.api_ptrs_in_module ?? null, hooks: q.hooks || null,
      }
    } else { out.hook = { error: String(hookRes.reason?.message || hookRes.reason).slice(0, 120) } }

    // ④ hires 目录（眼睛）：本机可选组件写进来的原图/整片视频
    try {
      const dir = process.env.WECHAT_HIRES_DIR || 'D:\\cdndl-replay'
      const files = existsSync(dir) ? readdirSync(dir) : []
      let bytes = 0; let newest = 0
      for (const f of files) {
        try { const s = statSync(join(dir, f)); bytes += s.size; if (s.mtimeMs > newest) newest = s.mtimeMs } catch { /* ignore */ }
      }
      out.hires = { dir, count: files.length, mb: +(bytes / 1048576).toFixed(1), newestAt: newest }
    } catch (e) { out.hires = { error: String(e?.message || e).slice(0, 120) } }

    // ⑤ 磁盘占用（几个会长大的文件/目录）
    try {
      const cfgDir = dirname(memoryDir)
      const sizeOf = (p) => { try { return statSync(p).size } catch { return 0 } }
      const dirSize = (d) => {
        let n = 0
        try { for (const f of readdirSync(d)) { try { n += statSync(join(d, f)).size } catch { /* ignore */ } } } catch { /* ignore */ }
        return n
      }
      out.disk = {
        configKB: +(sizeOf(CONFIG_FILE) / 1024).toFixed(1),
        usageKB: +(sizeOf(usageFile) / 1024).toFixed(1),
        membersKB: +(sizeOf(namesFile) / 1024).toFixed(1),
        memoryMB: +(dirSize(memoryDir) / 1048576).toFixed(1),
        cfgDir,
      }
    } catch (e) { out.disk = { error: String(e?.message || e).slice(0, 120) } }

    // ⑥ LLM 路由（为空 = 会抛「无法确定 LLM 路由」→ 完全不回话）
    out.llm = {
      provider: config.provider || '', model: config.model || '',
      visionProvider: config.visionProvider || '', visionModel: config.visionModel || '',
      explicit: !!(config.provider && config.model),
      lastRoute: lastTextRoute || null,
    }
    return out
  }
  /**
   * 检测微信安装目录（version.dll 就放在这里）。
   *
   * 为什么需要它：原来有 9 处路径硬编码成 D:\wxhook\wx4110 —— 那是开发机的目录，
   * 别人（微信装在 C:\Program Files\Tencent\Weixin 之类）一用就
   * ENOENT: no such file or directory, open '...\version.dll'。
   *
   * 顺序：环境变量 WECHAT_DIR → config.wechatExe → 运行中的微信进程 → 空字符串。
   */
  let _wxDirCache = null
  function detectWechatDir() {
    if (_wxDirCache !== null) return _wxDirCache
    let found = ''
    const envDir = String(process.env.WECHAT_DIR || '').trim()
    if (envDir && existsSync(envDir)) found = envDir
    if (!found) {
      try {
        const exe = String(config.wechatExe || '').trim()
        if (exe && existsSync(exe)) found = dirname(exe)
      } catch { /* ignore */ }
    }
    if (!found) {
      try {
        const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
          '(Get-Process -Name Weixin -EA SilentlyContinue | Select-Object -First 1).Path'],
          { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
        const exe = String(out).trim()
        if (exe && existsSync(exe)) found = dirname(exe)
      } catch { /* ignore */ }
    }
    _wxDirCache = found
    return found
  }
  /** 用完清缓存（面板改了微信目录后调用） */
  function resetWechatDirCache() { _wxDirCache = null }
  // ── 面板动作（HTTP → 机器人能力）────────────────────────────
  // 只暴露明确列出的 op；参数在插件侧再解析一次，面板拿到的是"结果对象"，不是任意代码执行。
  async function handlePanelAction(op, args = {}) {
    const a = args || {}
    switch (op) {
      case 'status':
        return await client.call('status', {}, 8000)
      case 'postMoment': {
        // 手动发一条（面板「立即发一条」/ 指定文案两条路都走这里）
        const text = String(a.text || '').trim()
        if (!text) return { ok: false, error: '朋友圈内容不能为空' }
        if (text.length > 1500) return { ok: false, error: '内容太长（最多 1500 字）' }
        // 手动发布也支持配图（面板勾了「配图」才生成，避免白等 25 秒）
        let images = []
        let imageError = ''
        const wantedImage = a.image === true
        if (wantedImage) {
          log(`[postMoment] 正在生成配图（图生图，锁角色）…`)
          const g = await pickMomentImg(text)
          if (g.ok) images = [g.file]
          else { imageError = String(g.error || '配图生成失败'); log(`[postMoment] 配图失败（${g.error}），改发纯文字`) }
        }
        const r = await postMomentNow(text, images)
        const verified = r.ok ? 1 : 0
        momentState.lastAt = Date.now()
        momentState.lastText = text
        momentState.lastRet = r.ret
        momentState.lastErr = r.ok ? '' : (r.error || ('ret=' + r.ret))
        momentState.lastVerified = verified ? 1 : 0
        if (r.ok) { if (momentState.dayKey === momentDayKey()) momentState.dayCount += 1 }
        saveMomentState()
        log(`[postMoment] ret=${r.ret} verified=${momentState.lastVerified} len=${text.length}`)
        return {
          ok: r.ok, ret: r.ret, diag: r.diag, text,
          wantedImage,
          withImage: images.length > 0,
          imageError,          // 勾了配图但没成 → 面板要如实说"纯文字已发"
        }
      }
      case 'momentEvalTest': {
        // 试评估：拿某个群最近的聊天让 AI 判断一次，**只返回结果，不发布**
        // 用途：调门槛 / 看它会不会乱发 / 验证 LLM 判定链路
        const roomId = String(a.room || '')
        let r = roomId ? rooms.get(roomId) : null
        if (!r) {
          // 没指定群就挑最近最活跃的一个
          let best = null
          for (const x of rooms.values()) {
            if (!x.msgs || !x.msgs.length) continue
            if (!best || (x.lastActivityAt || 0) > (best.lastActivityAt || 0)) best = x
          }
          r = best
        }
        if (!r) return { ok: false, error: '还没有可评估的群聊记录（先让群里聊几句）' }
        const look = Math.max(8, Math.min(60, Number(config.momentChatLookback) || 25))
        const msgs = (r.msgs || []).slice(-look).filter((x) => x && x.text)
        if (msgs.length < 4) return { ok: false, error: '这个群记录太少（' + msgs.length + ' 条），至少 4 条' }
        const transcript = msgs
          .map((x) => (x.isSelf ? '我' : (x.senderName || '群友')) + '：' + String(x.text).slice(0, 120))
          .join('\n')
        const minScore = Math.max(1, Math.min(10, Number(config.momentChatMinScore) || 7))
        const j = await judgeChatMomentBar(transcript, minScore)
        const gate = momentQuotaGate()
        return {
          ok: !j.error,
          room: r.roomName || r.roomId,
          messages: msgs.length,
          verdict: j,
          // 就算 worthy，真实发送还要过这些闸门
          wouldPost: !!(!j.error && j.worthy && (Number(j.score) || 0) >= minScore && gate.ok),
          gate,
          threshold: minScore,
        }
      }
      case 'momentNow': {
        // 让 AI 自己写一条并立刻发（不用等排期）
        // args.image === true 时强制生成配图；=== false 时强制纯文字；不传则看开关
        const opt = {}
        if (a.image === true) opt.image = true
        else if (a.image === false) opt.image = false
        const r = await momentTick(true, opt)
        return r
      }
      case 'momentStatus': {
        let hwnd = 0, hasEditor = false, hookOk = false
        try {
          const res = await fetch(`${HOOK_API_BASE}/Moment/Ready`)
          const j = await res.json().catch(() => ({}))
          hwnd = Number(j.main || 0)
          hasEditor = Number(j.editor || 0) > 0
          hookOk = j.ok === true
        } catch { /* hook 不在也不影响状态展示 */ }
        return {
          ok: true,
          hookOk,
          hasEditor,
          hwnd,
          auto: !!config.momentAuto,
          hours: config.momentHours || '',
          useLLM: !!config.momentUseLLM,
          autoImage: !!config.momentAutoImage,
          fromChat: !!config.momentFromChat,
          chatMinScore: Number(config.momentChatMinScore) || 7,
          chatRooms: Array.isArray(config.momentChatRooms) ? config.momentChatRooms : [],
          imageSource: config.momentImageSource || 'char',
          imageStyle: config.momentImageStyle || '',
          imageRatio: config.momentImageRatio || '4:3',
          minGapMs: Number(config.momentMinGapMs) || 0,
          maxGapMs: Number(config.momentMaxGapMs) || 0,
          dailyMax: Number(config.momentDailyMax) || 0,
          state: {
            lastAt: momentState.lastAt || 0,
            nextAt: momentState.nextAt || 0,
            dayCount: momentState.lastDayKey === momentDayKey() ? 0 : 0,
            dayKey: momentState.dayKey || '',
            todayCount: momentState.dayKey === momentDayKey() ? momentState.dayCount : 0,
            lastText: momentState.lastText || '',
            lastTrigger: momentState.lastTrigger || '',
            lastScore: momentState.lastScore || 0,
            lastReason: momentState.lastReason || '',
            lastRoom: momentState.lastRoom || '',
            lastRet: momentState.lastRet,
            lastErr: momentState.lastErr || '',
            lastVerified: momentState.lastVerified || 0,
          },
        }
      }
      case 'wechatPower': {
        // ★ 2026-10-28：这条路径原来是"点了就重启"，既没有"已经在跑"的判断，
        //   也没有次数上限 —— 误触一次就是全部数据库句柄重来 + 一轮假崩溃记录
        //   （今天 15:12 那次就是这么来的）。下面加两道闸。
        // 微信客户端电源开关：关 = 杀进程，开 = 启动并自动点「进入微信」
        // 实际动作在桥 → scripts/wechat-power.ps1（UIA 点击只能在 PowerShell 做）
        const action = String(a.action || 'status')
        if (!['status', 'kill', 'start'].includes(action)) {
          return { ok: false, error: 'action 只能是 status / kill / start' }
        }
        // ★ 闸①：已经在运行 + 已登录 → 不重启（按钮叫"启动"，不是"重启"）
        if (action === 'start') {
          try {
            const st = await client.call('wechatPower', { action: 'status' }, 15000)
            if (st && Number(st.procs) > 0 && (st.isLogin === 1 || st.isLogin === true)) {
              log('[wechatPower] start 被跳过：微信已在运行且已登录（procs=' + st.procs + '）')
              return { ...st, ok: true, skipped: true, reason: '客户端已在运行且已登录，未重启（避免句柄全部重来）' }
            }
          } catch { /* 状态拿不到就继续尝试启动 */ }
          // ★ 闸②：显式重启每天最多 2 次（和自愈分开计数，但同样有上限）
          const dstr = new Date().toISOString().slice(0, 10)
          if (powerDay !== dstr) { powerDay = dstr; powerCount = 0 }
          if (powerCount >= 2) {
            log('[wechatPower] start 被拒绝：今天已启动/重启过 ' + powerCount + ' 次')
            return { ok: false, error: '今天微信已被启动/重启 ' + powerCount + ' 次，为保护数据库不再自动重启（如需强制，请手动运行 deploy-hook.ps1）' }
          }
          powerCount++
        }
        // start 要等 UIA 点进主界面 + hook 就绪，放宽到 150 秒
        const timeout = action === 'start' ? 150000 : 40000
        try {
          const r = await client.call('wechatPower', { action }, timeout)
          log('[wechatPower] ' + action + ' → ' + JSON.stringify(r).slice(0, 200))
          return r
        } catch (e) {
          return { ok: false, error: String(e?.message || e).slice(0, 200) }
        }
      }
      case 'usage': {
        const today = new Date().toISOString().slice(0, 10)
        return {
          prompt: usageStats.prompt, completion: usageStats.completion,
          total: usageStats.total, calls: usageStats.calls,
          today: usageStats.byDay[today] || { prompt: 0, completion: 0, total: 0, calls: 0 },
          byModel: usageStats.byModel, byDay: usageStats.byDay,
          startedAt: usageStats.startedAt, file: usageFile,
        }
      }
      case 'diag': {
        return await collectDiag()
      }
      case 'diagCleanHires': {
        // 清理 hires 目录（眼睛的缓存）：只删本机缓存的原图/整片，不影响微信
        const dir = process.env.WECHAT_HIRES_DIR || 'D:\\cdndl-replay'
        let removed = 0
        try {
          for (const f of readdirSync(dir)) {
            try { unlinkSync(join(dir, f)); removed++ } catch { /* ignore */ }
          }
        } catch (e) {
          return { ok: false, error: String(e?.message || e).slice(0, 120), dir }
        }
        return { ok: true, removed, dir }
      }
      case 'selfReload': {
        // 热重载插件自身：改完 lib/index.js 不用重启 DSH。
        //   流程照抄注入器的稳态路径：找 entry → 清 loadCache → import 新代码 →
        //   预检导出有效 → 延迟 dispose 旧 fiber + registry.plugin 重建。
        //   关键安全点：**先预检再替换**，新代码加载失败时旧代继续跑，不会把插件搞挂。
        try {
          const me = 'dsh-wechat-bot'
          const entry = [...ctx.loader.entries()].find((e) => String(e.options?.name || '').includes(me))
          if (!entry) return { ok: false, error: '找不到自己的 loader entry' }
          const loadCache = ctx.loader.internal?.loadCache
          if (!loadCache || typeof loadCache.keys !== 'function') {
            return { ok: false, error: 'loader.internal.loadCache 不可用（宿主版本不支持）' }
          }
          // ★ 2026-10-26：原来只清 index.js 的缓存 → panel.mjs 等被 import 的模块
          //   仍然命中旧缓存，于是「热重载后 ALLOWED_OPS 还是旧的」（用户实测：
          //   更新后调 momentStatus 报「不允许的操作」，重启 DSH 才正常）。
          //   现在把本插件 lib/ 下**所有**模块的缓存都清掉，整张模块图重新求值。
          const ownUrls = []
          let url = null
          for (const u of loadCache.keys()) {
            if (typeof u !== 'string') continue
            const d = decodeURIComponent(u)
            if (!d.includes('wechat-group-agent/lib/')) continue
            ownUrls.push(u)
            if (d.includes('wechat-group-agent/lib/index.js')) url = u
          }
          if (!url) return { ok: false, error: 'loadCache 里找不到自己的模块（可能刚启动还没缓存）' }
          const oldJobs = new Map()
          for (const u of ownUrls) {
            oldJobs.set(u, loadCache.get(u))
            Map.prototype.delete.call(loadCache, u)
          }
          const restoreAll = () => {
            for (const [u, job] of oldJobs) if (job) loadCache.set(u, job)
          }
          const oldJob = oldJobs.get(url)
          let fresh = null
          try {
            fresh = ctx.loader.unwrapExports(await ctx.loader.import(url, () => []))
          } catch (e) {
            restoreAll()
            return { ok: false, error: '新代码 import 失败（旧代继续运行）：' + String(e?.message || e).slice(0, 200) }
          }
          if (!fresh || (typeof fresh !== 'function' && typeof fresh.apply !== 'function')) {
            restoreAll()
            return { ok: false, error: '新代码导出无效（缺 apply），已取消，旧代继续运行' }
          }
          // ★ 2026-10-27 修（事故复盘）：
          //   原来是【先 dispose 旧 fiber、再建新的】。一旦新建失败
          //   （实测错误：cannot create effect on inactive context —— 旧 ctx 已经失效），
          //   旧实例已拆、新实例没建 → /wechat-bot 整站 404，只能重启 DSH。
          //   现在改成【先建新的，成功才拆旧的】；任何一步失败都保留旧实例继续跑。
          // ════════════════════════════════════════════════════════════════
          //  ⚠️ 2026-10-27 结论：**不要从插件内部替换自己**。
          //
          //  试过两条路，都会把面板搞挂 / 把 reload 卡死：
          //   ① 先 dispose 再 registry.plugin(新) → 旧 ctx 失效，新实例建不起来 → 404
          //   ② 先 registry.plugin(新) 再 dispose 旧 → 新实例挂载撞车(duplicate route)，
          //      旧实例拆掉后路由为空 → 404；且新实例的父 ctx 就是旧实例，父一死子也死
          //   ③ entry.fiber=undefined + entry.refresh() → 第一次成功，第二次 fiber 状态未知、
          //      再 404；且留下"半死实例"（工具注册没注销），之后每次 reload 都 await 卡死
          //
          //  每次失败都会留一具残骸（日志里 11 条"工具已存在（热重载残留）"就是它），
          //  残骸让下一次 reload 的 await fiber.dispose() 永远等不到 → 卡死。
          //
          //  所以现在：**只做预检（确认新代码能加载），绝不碰运行中的实例**。
          //  改完代码请**重启 DSH**（或在干净状态下用注入器重载）。
          // ════════════════════════════════════════════════════════════════
          return {
            ok: true,
            verified: true,
            needRestart: true,
            hint: '新代码已确认可加载（预检通过）。插件不支持在内部替换自身——请重启 DSH 生效；'
              + '面板此期间保持可用。',
          }
        } catch (e) {
          return { ok: false, error: String(e?.message || e).slice(0, 200) }
        }
      }
      case 'pollStatus': {
        // 只读：轮询器快照（硬闸/暂停/连续失败/轮数/条数/表数），转发给桥
        try { return await client.call('pollStatus', {}, 8000) } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) } }
      }
      case 'pollResume': {
        // 解除硬闸 + 真正重启轮询（桥侧走 restartPoller）
        try { return await client.call('pollResume', {}, 15000) } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) } }
      }
      case 'checkUpdate': {
        // ★ 60 秒节流：面板刷新会触发检查，GitHub 匿名限额只有 60 次/小时，
        //   连刷几次就 403，之后只能读 CDN 缓存（会看到版本倒退）。点按钮时带 force 绕过。
        const now = Date.now()
        if (a.force) log('[checkUpdate] force=true → 跳过 60 秒节流，真的去查 GitHub')
        if (!a.force && updateState.lastResult && now - updateState.checkedAt < 60_000) {
          return updateState.lastResult
        }
        try {
          const r = await checkUpdate()
          updateState.lastResult = r
          return r
        } catch (e) {
          // ★ 远程失败也要带上本地版本号：本地版本是纯本地读取，永远拿得到。
          //   否则面板会退化成 "v?"（用户 2026-10-25 报的就是这个）。
          return {
            available: false,
            error: String(e?.message || e).slice(0, 160),
            localVersion: readLocalVersion().version,
          }
        }
      }
      case 'updateInfo': {
        // ★ 兜底：候选 version.json 全都读不到时，用插件自身的版本常量（export const version），
        //   绝不再把 "v0.0.0" 抛给用户看。
        const lv = readLocalVersion()
        // 同上：version.json 若落后于代码（旧更新器不覆盖根文件），以代码版本为准
        let localVer = lv.version === '0.0.0' ? version : lv.version
        if (cmpSemver(version, localVer) > 0) localVer = version
        return {
          repo: UPDATE_REPO,
          // ★ version 必须从本地 version.json 现读：它是纯本地操作，绝不依赖网络/GitHub 限流。
          //   之前只返回 commit，面板回退到 info.version（undefined）→ 网络失败时显示 "v?"。
          version: localVer,
          // 读的是哪个文件 / 哪些候选失败了 —— 面板悬停可见，出问题不用再猜
          versionFile: (localVer === lv.version && versionDiag.file)
            ? versionDiag.file
            : `(以代码版本为准 @ ${version}；version.json=${versionDiag.file || '未读到'})`,
          versionErrors: versionDiag.errors,
          botHome: BOT_HOME,
          local: updateState.commit,
          checkedAt: updateState.checkedAt,
          latest: updateState.latest,
          history: updateState.history,
        }
      }
      case 'applyUpdate': {
        // 目标 sha：默认用「检查到的最新」；也允许显式指定
        const target = String(a.sha || updateState.latest?.sha || '').trim()
        if (!/^[0-9a-f]{7,40}$/i.test(target)) return { ok: false, error: '目标版本无效（先检查更新）' }
        const steps = []
        let backupPath = ''
        let tmpRoot = ''
        try {
          steps.push({ step: '下载源码包', ok: true, detail: target.slice(0, 7) })
          const dl = await downloadAndExtract(target)
          tmpRoot = dl.root
          steps.push({ step: '解压', ok: true, detail: Math.round(dl.bytes / 1024) + 'KB' })
          backupPath = backupCode()
          steps.push({ step: '备份当前代码', ok: !!backupPath, detail: backupPath || '（跳过）' })
          const report = applyFiles(tmpRoot)
          steps.push({ step: '覆盖代码', ok: true, detail: report.map((r) => `${r.label}:${r.files ?? r.skipped}`).join(' / ') })
          // 记录新版本
          const oldCommit = updateState.commit
          updateState.commit = target
          try { const vj = JSON.parse(readFileSync(join(tmpRoot, 'version.json'), 'utf8')); updateState.version = String(vj.version || updateState.version) } catch { /* applyFiles 已处理 */ }
          updateState.history.unshift({ at: Date.now(), from: oldCommit.slice(0, 7), to: target.slice(0, 7) })
          updateState.history = updateState.history.slice(0, 20)
          updateState.latest = null
          saveUpdateState()
          steps.push({ step: '记录版本', ok: true, detail: oldCommit.slice(0, 7) + ' → ' + target.slice(0, 7) })
          // 桥需要重启才生效：先记下旧桥的启动参数，杀掉，再按原参数拉起
          try {
            const psFind = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $c = Get-NetTCPConnection -LocalPort 17300 -State Listen -EA SilentlyContinue | Select-Object -First 1; if ($c) { $c.OwningProcess } else { 0 }"
            const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psFind], { encoding: 'utf8', timeout: 15000, windowsHide: true })
            const pid = parseInt(String(out).trim(), 10)
            if (pid > 0) {
              // 取旧桥的命令行，重启时沿用（这样自定义参数不会丢）
              let oldCmd = ''
              try {
                const psCmd = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
                oldCmd = String(execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psCmd], { encoding: 'utf8', timeout: 15000, windowsHide: true })).trim()
              } catch { /* 拿不到就用手册参数 */ }
              try { process.kill(pid) } catch { /* ignore */ }
              steps.push({ step: '停止旧桥', ok: true, detail: 'pid=' + pid })
              // 等端口释放
              const t0 = Date.now()
              while (Date.now() - t0 < 8000) {
                try {
                  const still = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
                    "if (Get-NetTCPConnection -LocalPort 17300 -State Listen -EA SilentlyContinue) { '1' } else { '0' }"], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim()
                  if (still === '0') break
                } catch { break }
                await new Promise((r) => setTimeout(r, 500))
              }
              // 拉起新桥
              const base = BOT_HOME
              const bridgeDir = join(base, 'wx-bridge')
              let nodeArgs
              if (oldCmd && /server\.mjs/.test(oldCmd)) {
                // 从旧命令行里剥掉 "node" 前缀，保留参数
                nodeArgs = oldCmd.replace(/^"[^"]*node\.exe"\s*/i, '').replace(/^\S*node\.exe\s*/i, '').replace(/^node\s*/i, '').trim()
              }
              const argv = nodeArgs
                ? nodeArgs.match(/"[^"]*"|\S+/g).map((x) => x.replace(/^"|"$/g, ''))
                : ['server.mjs', '--transport=wechat-hook', '--api-port=30001', '--cb-port=18998',
                   '--data-dir=' + join(base, 'data'), '--wechat=' + (process.env.WECHAT_EXE || (detectWechatDir() ? join(detectWechatDir(), 'Weixin.exe') : ''))]
              const { spawn } = await import('node:child_process')
              const child = spawn(process.execPath, argv, { cwd: bridgeDir, detached: true, stdio: 'ignore', windowsHide: true })
              child.unref()
              // 等它真的监听上
              let up = false
              const t1 = Date.now()
              while (Date.now() - t1 < 25000) {
                try {
                  const ok = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
                    "if (Get-NetTCPConnection -LocalPort 17300 -State Listen -EA SilentlyContinue) { '1' } else { '0' }"], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim()
                  if (ok === '1') { up = true; break }
                } catch { /* ignore */ }
                await new Promise((r) => setTimeout(r, 1000))
              }
              bridgeRestarted = up
              steps.push({ step: up ? '重启桥' : '重启桥（超时未监听）', ok: up, detail: up ? '已监听 17300' : '请手动启动' })
            } else {
              steps.push({ step: '桥重启', ok: true, detail: '没找到运行中的桥，跳过' })
            }
          } catch (e) {
            steps.push({ step: '重启桥', ok: false, detail: String(e?.message || e).slice(0, 100) })
          }
          return {
            ok: true, target, backup: backupPath, steps,
            needRestart: { bridge: true, plugin: true, panel: false },
            hint: '面板刷新即生效；桥会自动重启；插件代码需要重启 DSH 才加载',
          }
        } catch (e) {
          // 失败 → 尝试回滚
          let rolledBack = false
          if (backupPath && existsSync(backupPath)) {
            try {
              const tmp2 = join(process.env.TEMP || 'C:\\Windows\\Temp', 'dsh-wb-rollback-' + Date.now())
              mkdirSync(tmp2, { recursive: true })
              execFileSync(TAR_EXE, ['-xf', backupPath, '-C', tmp2], { stdio: 'pipe', timeout: 120000, windowsHide: true })
              applyFiles(tmp2)
              rolledBack = true
            } catch { /* ignore */ }
          }
          return {
            ok: false, error: String(e?.message || e).slice(0, 200),
            steps, backup: backupPath, rolledBack,
          }
        } finally {
          // 清理临时目录
          if (tmpRoot) {
            try {
              const { rmSync } = await import('node:fs')
              rmSync(tmpRoot.replace(/[\\/][^\\/]+$/, ''), { recursive: true, force: true })
            } catch { /* ignore */ }
          }
        }
      }
      case 'selfcheck': {
        const h = await healthCheck({ deep: true })
        healthLast = h
        return h
      }
      case 'rooms': {
        const list = await client.call('rooms', {}, 10_000)
        await refreshNameCaches()
        return (list || []).map((x) => ({ ...x, name: roomNameCache.get(x.roomId) || x.name }))
      }
      case 'members': {
        const room = await resolveRoom(a.room)
        const res = await client.call('members', { roomId: room.roomId }, 20_000)
        if (!contactNameCache.size) { try { await refreshNameCaches() } catch { /* ignore */ } }
        for (const m of res?.members || []) {
          const n = contactNameCache.get(String(m.wxid || ''))
          if (n) m.name = n
          if (!m.name) m.name = n || m.nick || m.wxid
        }
        return res
      }
      case 'history': {
        const room = await resolveRoom(a.room)
        const res = await client.call('history', { roomId: room.roomId, limit: Number(a.limit) || 20 }, 10_000)
        const items = Array.isArray(res) ? res : (res?.items || [])
        for (const it of items) {
          if (it && !it.isSelf) it.senderName = nameOf(it.sender, it.senderName)
        }
        return res
      }
      case 'searchMessages': {
        const room = await resolveRoom(a.room)
        const res = await client.call('searchMessages', {
          roomId: room.roomId, query: String(a.query || ''), limit: Number(a.limit) || 20, scan: Number(a.scan) || 800,
        }, 25_000)
        if (!contactNameCache.size) { try { await refreshNameCaches() } catch { /* ignore */ } }
        for (const it of res?.items || []) {
          if (it && !it.isSelf) it.senderName = nameOf(it.sender, it.senderName)
        }
        return res
      }
      case 'sendText': {
        const room = await resolveRoom(a.room)
        const text = String(a.text ?? '').trim()
        if (!text) throw new Error('text 不能为空')
        const r0 = roomState(room.roomId, room.name)
        // 真 @：与 wechat_bot_say 同一条路径（成员索引是异步的，先确保一次）
        if (config.allowAt && text.includes('@')) await ensureAtIndex(r0)
        const mm = resolveMentions(r0, text)
        const sent = await client.call('sendText', {
          roomId: room.roomId, text: mm.text,
          ...(mm.mentions.length ? { mentions: mm.mentions } : {}),
        }, 20_000)
        stats.sentText++
        push(r0, { ts: Date.now(), isSelf: true, sender: 'self', senderName: '我', text: mm.text })
        let stickerId = ''
        if (a.sticker) {
          const picked = await client.call('pickSticker', { text, roomId: room.roomId, minScore: 0 }, 10_000)
          if (picked?.id) {
            await client.call('sendSticker', { roomId: room.roomId, stickerId: picked.id }, 15_000)
            stats.sentSticker++
            stickerId = picked.id
          }
        }
        return { room: room.name, roomId: room.roomId, rc: sent?.rc ?? sent, mentions: mm.mentions.length, stickerId }
      }
      case 'sayVoice': {
        const room = await resolveRoom(a.room)
        const text = String(a.text ?? '').trim()
        if (!text) throw new Error('text 不能为空')
        const r = await client.call('sayVoice', {
          roomId: room.roomId, text, emotion: String(a.emotion || 'main'),
        }, 90_000)
        if (r?.ok) {
          stats.sentVoice = (stats.sentVoice || 0) + 1
          push(roomState(room.roomId, room.name), { ts: Date.now(), isSelf: true, sender: 'self', senderName: '我', text })
        }
        return r
      }
      case 'sendSticker': {
        const room = await resolveRoom(a.room)
        const payload = { roomId: room.roomId }
        if (a.stickerId) payload.stickerId = String(a.stickerId)
        else payload.text = String(a.text || '')
        const res = await client.call('sendSticker', payload, 20_000)
        if (res?.stickerId) stats.sentSticker++
        return res
      }
      case 'pickSticker':
        return await client.call('pickSticker', { text: String(a.text || ''), minScore: 0 }, 8000)
      case 'voiceSwitch':
        return await client.call('voiceSwitch', a.on === undefined ? {} : { on: !!a.on }, 8000)

      // ── TTS 服务（GPT-SoVITS api_v2）真正的控制面 ──
      case 'ttsStatus':
        return await ttsStatus()
      case 'ttsControl': {
        const r = await ttsControl(a.action)
        log('[ttsControl] ' + String(a.action || 'status') + ' → ' + JSON.stringify(r).slice(0, 200))
        return r
      }
      case 'ttsTest':
        return await ttsTest(a.text)

      case 'stickers':
        return await client.call('stickers', { limit: Number(a.limit) || 30 }, 10_000)
      case 'genEmotions':
        return await client.call('genEmotions', {}, 10_000)
      case 'genSticker':
        return await client.call('genSticker', {
          emotion: String(a.emotion || '开心'),
          extra: String(a.extra || ''),
          bubble: String(a.bubble || ''),
          force: !!a.force,
        }, 240_000)
      case 'memory.list': {
        const room = globalMemory() ? globalHostRoom() : await resolveRoom(a.room)
        const r = panelRoomView(room)
        const now = Date.now()
        const cfg = memCfg()
        const all = (r.facts || []).filter(Boolean)
        const showArchived = !!a.archived
        const list = all.filter((f) => (showArchived ? f.archived : !f.archived))
        return {
          roomId: r.roomId, roomName: r.roomName,
          facts: list.slice(showArchived ? -100 : -200).map((f) => ({
            ...f,
            text: prettyNames(f.text),
            retention: +MV2.retention(f, now).toFixed(3),          // 当前保持率，面板画进度条
          })),
          stats: MV2.stats(all, now, cfg),
          v2: config.memoryV2 !== false,
          cfg,
          msgs: (r.msgs || []).length,
          pendingQuestion: '',
        }
      }
      // ── 记忆 v2 单项操作（面板用）──────────────────────────
      case 'memory.pin': {
        const room = globalMemory() ? globalHostRoom() : await resolveRoom(a.room)
        const r = panelRoomView(room)
        const hit = (r.facts || []).find((f) => f && f.id === a.id)
        if (!hit) return { ok: false, error: '找不到这条记忆（id 可能已变）' }
        hit.pinned = a.pinned === undefined ? !hit.pinned : !!a.pinned
        if (hit.pinned) hit.archived = false
        saveFacts(r)
        return { ok: true, pinned: hit.pinned }
      }
      case 'memory.archive': {
        const room = globalMemory() ? globalHostRoom() : await resolveRoom(a.room)
        const r = panelRoomView(room)
        const hit = (r.facts || []).find((f) => f && f.id === a.id)
        if (!hit) return { ok: false, error: '找不到这条记忆' }
        hit.archived = a.archived === undefined ? true : !!a.archived
        if (hit.archived) { hit.archivedAt = Date.now(); hit.archivedReason = '面板手动归档' }
        else { delete hit.archivedAt; delete hit.archivedReason }
        saveFacts(r)
        return { ok: true, archived: hit.archived }
      }
      case 'memory.review': {
        // "复习"：手动把强度提上去（相当于又被想起来了）
        const room = globalMemory() ? globalHostRoom() : await resolveRoom(a.room)
        const r = panelRoomView(room)
        const hit = (r.facts || []).find((f) => f && f.id === a.id)
        if (!hit) return { ok: false, error: '找不到这条记忆' }
        const before = Number(hit.strength) || 1
        hit.strength = MV2.reinforceStrength(hit, Date.now(), memCfg())
        hit.recallCount = (Number(hit.recallCount) || 0) + 1
        hit.lastRecallAt = Date.now()
        saveFacts(r)
        return { ok: true, strengthBefore: +before.toFixed(2), strengthAfter: +Number(hit.strength).toFixed(2) }
      }
      // ── 性格（内心）：状态 / 写日记 / 好恶 / 目标 ──────────────
      case 'persona.state': {
        const room = globalHostRoom()
        const r = panelRoomView(room)
        const st = personaOf(r)
        const bodyNow = (() => { try { return PS.bodyState(st) } catch { return null } })()
        const human = {
          moodCause: (() => { try { return config.humanMoodCause === false ? '' : PS.describeMoodCause(st) } catch { return '' } })(),
          body: bodyNow ? { note: bodyNow.note, sleepy: !!bodyNow.sleepy, hungry: !!bodyNow.hungry } : null,
          nag: (() => { try { return PS.nagLevel(st) } catch { return 0 } })(),
          learnedTerms: (() => { try { return PS.learnedTerms(st, 8) } catch { return [] } })(),
          unlearnedTerms: (() => { try { return PS.unlearnedTerms(st) } catch { return [] } })(),
          selfReview: st.selfReview || null,
          // ★ 优化后：让面板能看见"队列里有几条在等结算"，而不是只显示 0 条调整记录
          feedback: {
            pending: (st.pendingFeedback || []).length,
            settled: (st.feedbackLog || []).length,
            settleMin: Number(config.personaFeedbackSettleMin) || 3,
            lr: config.personaFeedbackLr === undefined ? 0.018 : Number(config.personaFeedbackLr),
            enabled: feedbackEnabled(),
          },
          relations: (() => {
            try {
              if (config.humanRelationTiers === false) return []
              const masterWxid2 = Object.keys(st.affinity || {}).find((x) => {
                const nm = String((config.memberNames || {})[x] || '').trim()
                return config.masterName && nm && nm === String(config.masterName).trim()
              }) || ''
              const topPerson = PS.topAffinityPerson(st, { masterName: config.masterName || '', masterWxid: masterWxid2 })
              // ★ 面板要"点阶段看都有谁" → 返回全部（按好感降序）
              return Object.entries(st.affinity || {}).sort((a, b) => Number(b[1]) - Number(a[1])).map(([w, v]) => ({
                who: w,
                name: (config.memberNames || {})[w] || w,
                // ★ 2026-10-29：主人默认心动 —— 面板直接按 95%（心动档）显示，
                //   跟插件内部 topAffinityPerson 的算法保持一致（否则面板 76% 会让人困惑）。
                value: +Number(w === masterWxid2 ? Math.max(Number(v), 0.95) : v).toFixed(2),
                rawValue: +Number(v).toFixed(2),
                isMaster: w === masterWxid2,
                tier: PS.affinityTier(w === masterWxid2 ? Math.max(Number(v), 0.95) : v),
                // ★ 七阶：阶段名 + 语气 + 是否心动对象（亲密独占）
                stageKey: PS.affinityStage(w === masterWxid2 ? Math.max(Number(v), 0.95) : v).key,
                stage: PS.affinityStage(w === masterWxid2 ? Math.max(Number(v), 0.95) : v).label,
                tone: PS.affinityStage(w === masterWxid2 ? Math.max(Number(v), 0.95) : v).tone,
                isTop: !!(topPerson && topPerson.wxid === w),
              }))
            } catch { return [] }
          })(),
        }
        return { ok: true, ...PS.summarize(st), human, enabled: config.personaEnabled !== false, roomId: r.roomId, roomName: r.roomName }
      }
      case 'persona.diaryWrite': {
        const room = globalHostRoom()
        const r = panelRoomView(room)
        return await writeDiary(r, { force: true })
      }
      case 'persona.tasteAdd': {
        const room = globalHostRoom()
        const r = panelRoomView(room)
        const kind = a.kind === 'dislikes' ? 'dislikes' : 'likes'
        const res = PS.addTaste(personaOf(r), kind, a.text, 'manual', Date.now(), personaCfg())
        savePersona(r, res.state)
        return { ok: true, added: !!res.added, kind }
      }
      case 'persona.tasteRemove': {
        const room = globalHostRoom()
        const r = panelRoomView(room)
        const st = personaOf(r)
        const kind = a.kind === 'dislikes' ? 'dislikes' : 'likes'
        const list = ((st.tastes && st.tastes[kind]) || []).filter((x) => x.text !== a.text)
        savePersona(r, { ...st, tastes: { ...st.tastes, [kind]: list }, updatedAt: Date.now() })
        return { ok: true, left: list.length }
      }
      case 'persona.narrativeWrite': {
        const room = globalHostRoom()
        const r = panelRoomView(room)
        return await writeNarrative(r, { force: true })
      }
      case 'persona.load': {
        const room = globalHostRoom()
        const r = panelRoomView(room)
        const st = personaOf(r)
        return { ok: true, ...PS.explainLoad(st, loadCfg()), activeRooms: activeRoomCount() }
      }
      case 'persona.selfReview': {
        const r = globalHostRoom()
        return await selfReview(r, { force: true })
      }
      case 'persona.addTerm': {
        const w = String(args.term || args.text || '').trim()
        if (!w) return { ok: false, reason: '词不能为空' }
        const host = globalHostRoom()
        const st = personaOf(host)
        const r1 = PS.addTerm(st, w, Date.now())
        if (!r1.ok) return { ok: false, reason: r1.why }
        savePersona(host, r1.state)
        log(`手动加群梗：「${w}」（${r1.why}）`)
        return { ok: true, reason: r1.why, term: w, learned: !!(r1.state.lexicon || {})[w]?.learned }
      }
      case 'persona.removeTerm': {
        const w = String(args.term || args.text || '').trim()
        if (!w) return { ok: false, reason: '词不能为空' }
        const host = globalHostRoom()
        const st = personaOf(host)
        const r1 = PS.removeTerm(st, w, Date.now())
        if (!r1.ok) return { ok: false, reason: r1.why }
        savePersona(host, r1.state)
        log(`删掉群梗：「${w}」`)
        return { ok: true, term: w }
      }
      case 'outbox.stats': {
        try { return { ok: true, ...getOutbox().stats } } catch (e) { return { ok: false, reason: String(e?.message || e) } }
      }
      case 'persona.settleNow': {
        const res = settleFeedback()
        return { ok: true, ...res }
      }
      case 'persona.traits': {
        const room = globalHostRoom()
        const r = panelRoomView(room)
        const st = personaOf(r)
        return { ok: true, ...PS.summarizeTraits(st), enabled: feedbackEnabled(), settleMin: Number(config.personaFeedbackSettleMin) || 10 }
      }
      case 'persona.traitsReset': {
        const room = globalHostRoom()
        const r = panelRoomView(room)
        const st = PS.ensureTraits(personaOf(r), Date.now())
        savePersona(r, { ...st, traits: { ...st.traitBaseline }, feedbackLog: [], traitsUpdatedAt: Date.now() })
        log(`性格漂移已复位「${r.roomName || r.roomId}」`)
        return { ok: true }
      }
      case 'persona.narrativeRestore': {
        const room = globalHostRoom()
        const r = panelRoomView(room)
        const st = personaOf(r)
        const res = PS.restoreNarrative(st, a.version, Date.now(), narrativeCfg())
        if (!res.ok) return { ok: false, error: res.reason }
        savePersona(r, res.state)
        log(`自传回滚「${r.roomName || r.roomId}」→ v${a.version}（新版本 v${res.state.narrative.version}）`)
        return { ok: true, narrative: res.state.narrative }
      }
      case 'persona.goalReroll': {
        const room = globalHostRoom()
        const r = panelRoomView(room)
        const st = PS.rerollGoals(personaOf(r), Date.now(), personaCfg())
        savePersona(r, st)
        return { ok: true, goals: st.goals }
      }
      case 'memory.purgePreview': {
        // 只列清单，不动数据
        const room = globalMemory() ? globalHostRoom() : await resolveRoom(a.room)
        const r = panelRoomView(room)
        const cand = MV2.findForgettable(r.facts || [], {
          maxWeight: a.maxWeight === undefined ? 0.15 : Number(a.maxWeight),
          onlyUnknown: !!a.onlyUnknown,
          neverUsed: a.neverUsed === undefined ? true : !!a.neverUsed,
          olderThanDays: Number(a.olderThanDays) || 0,
        }, Date.now())
        return {
          ok: true,
          count: cand.length,
          total: (r.facts || []).filter((x) => x && !x.archived).length,
          items: cand.slice(0, 50).map((x) => ({
            id: x.id, text: x.text, w: x._weight, r: x._retention, ageDays: x._ageDays,
            emotion: (x.emotion || {}).label || '', importance: x.importance,
          })),
        }
      }
      case 'memory.purge': {
        // confirm=false → 只回数量；confirm=true → 归档（软删，30 天内可恢复）
        const room = globalMemory() ? globalHostRoom() : await resolveRoom(a.room)
        const r = panelRoomView(room)
        const cand = MV2.findForgettable(r.facts || [], {
          maxWeight: a.maxWeight === undefined ? 0.15 : Number(a.maxWeight),
          onlyUnknown: !!a.onlyUnknown,
          neverUsed: a.neverUsed === undefined ? true : !!a.neverUsed,
          olderThanDays: Number(a.olderThanDays) || 0,
        }, Date.now())
        if (!a.confirm) return { ok: true, count: cand.length, done: false }
        const ids = new Set(cand.map((x) => x.id))
        let n = 0
        const now = Date.now()
        const next = (r.facts || []).map((x) => {
          if (!x || !ids.has(x.id)) return x
          n++
          return { ...x, archived: true, archivedAt: now, archivedReason: '面板手动清理（低权重）' }
        })
        saveFacts({ ...r, facts: next })
        log(`记忆手动清理：归档 ${n} 条（权重 < ${a.maxWeight === undefined ? 0.15 : a.maxWeight}）`)
        return { ok: true, count: cand.length, archived: n, done: true }
      }
      case 'memory.sweep': {
        const res = memorySweepAll()
        return { ok: true, ...res }
      }
      case 'memory.add': {
        const room = globalMemory() ? globalHostRoom() : await resolveRoom(a.room)
        const r = panelRoomView(room)
        const ok = addFact(r, String(a.add || ''), 'manual')
        return { ok, count: (r.facts || []).length }
      }
      case 'memory.clear': {
        const room = globalMemory() ? globalHostRoom() : await resolveRoom(a.room)
        const r = panelRoomView(room)
        r.facts = []
        saveFacts(r)
        return { ok: true, count: 0 }
      }
      case 'memory.extract': {
        const room = globalMemory() ? globalHostRoom() : await resolveRoom(a.room)
        const r = panelRoomView(room)
        // ★ 2026-10-28：开关关着时 extractFacts 直接 return 0，面板却提示"提炼完成：新增 0 条"，
        //   看起来像"提炼失败但没报错"。这里把原因带出去。
        if (!config.memoryExtract) {
          return {
            ok: false,
            added: 0,
            count: (r.facts || []).length,
            reason: 'memoryExtract 已关闭（面板「记忆」页的「自动提炼」开关 / 配置 memoryExtract）',
          }
        }
        const added = await extractFacts(r, { force: true })
        return {
          ok: true, added, count: (r.facts || []).length,
          reason: added ? '' : '这次没有提炼出新内容（可能消息太少，或和已有记忆重复）',
        }
      }
      case 'names.set': {
        const wxid = String(a.wxid || '').trim()
        const name = cleanAtName(String(a.name || ''))
        if (!wxid || !name) throw new Error('需要 wxid 与 name')
        ;(config.memberNames ||= {})[wxid] = name
        saveNames()
        persistConfig()
        return { ok: true, wxid, name, count: Object.keys(config.memberNames).length }
      }
      case 'names.add': {
        const list = String(a.names || '').split(/[,，、\s]+/).map((s) => cleanAtName(s)).filter(Boolean)
        const added = []
        for (const n of list) {
          if (!atNames.includes(n)) { atNames.push(n); added.push(n) }
        }
        if (atNames.length > 60) atNames = atNames.slice(-60)
        if (added.length) saveNames()
        return { ok: true, added, total: atNames.length }
      }
      case 'names.refresh': {
        // ★ 2026-10-28：以前只把配置里的旧值原样返回，看起来"刷新成功"其实什么也没做。
        //   现在真的重读 contact_fts.db（跳过节流），并回报前后变化。
        const before = { rooms: roomNameCache.size, people: contactNameCache.size }
        let err = ''
        try { await refreshNameCaches(true) } catch (e) { err = String(e?.message || e).slice(0, 160) }
        const after = { rooms: roomNameCache.size, people: contactNameCache.size }
        log(`[names.refresh] 群名 ${before.rooms}→${after.rooms}｜人名 ${before.people}→${after.people}`)
        return {
          ok: !err,
          error: err,
          memberNames: config.memberNames || {},
          atNames: [...atNames],
          // 页面直接显示这两个数字，一眼看出到底刷没刷
          rooms: after.rooms,
          people: after.people,
          addedRooms: Math.max(0, after.rooms - before.rooms),
          addedPeople: Math.max(0, after.people - before.people),
          at: Date.now(),
        }
      }
      default:
        throw new Error('未知操作：' + op)
    }
  }

  /**
   * 注册工具的安全包装。
   *
   * 为什么需要它：DSH 的 ctx.tools.register() 内部是
   *   return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, def), ...)
   * 用的是**服务自己的 root ctx** 做 owner，不是插件 ctx。所以：
   *   · 工具注册在「全局层」（scope === undefined）
   *   · disposer 挂在 root ctx 上，插件卸载时清不掉
   * 结果就是热重载时新实例注册同名工具 → "tool ... is already registered" → apply 抛异常。
   *
   * 这里不能根治（那是 DSH 的全局工具语义），但至少做到：
   *   ① 重复注册不抛异常，apply 不会整个失败
   *   ② 只在「已存在」这一种情况下吞掉，别的错误照抛
   *   ③ 记一条日志，排查时能看到「这次是跳过的」
   *
   * 想彻底干净地重载工具：用 uninject + inject（已验证有效），
   * 或者重启 DSH。dsd 的 reload 路径清不掉全局层。
   */
  function safeRegister(def) {
    try {
      return ctx.tools.register(def)
    } catch (e) {
      const msg = String(e?.message || e)
      if (/already registered/i.test(msg)) {
        log('工具 ' + (def?.name || '?') + ' 已存在（热重载残留），本次跳过注册')
        return () => {}
      }
      throw e
    }
  }

  ctx.effect(() => safeRegister({
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

  ctx.effect(() => safeRegister({
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

  ctx.effect(() => safeRegister({
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

  ctx.effect(() => safeRegister({
    name: 'wechat_bot_config',
    description: '读取或实时修改微信机器人的拟人参数（无需重启）。key 留空 = 查看全部；给了 value = 修改。可改：enabled/dryRun/persona/replyProbability/minReplyGapMs/maxRepliesPer10Min/quietHours/stickerChance/splitChance/botName/rooms/temperature/voiceOnVoice/voiceSay/voiceSayProbability/voiceSayOnVoiceProbability/voiceSayMaxChars/healthAlert/healthAlertQuietMs/healthCheckMs/videoDeleteAfterRead/videoUpgradeDelayMs/videoFrames/linkVideo/linkVideoProbability/linkVideoMaxSeconds/linkVideoMaxMB/linkVideoCooldownMs/linkVideoTimeoutMs/linkVideoFrames。',
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
      const r = applyConfigPatch({ [key]: args.value })
      if (!r.ok) return `值不合法：${r.rejected.map((x) => x.reason).join('；')}`
      return `已更新：${key} = ${JSON.stringify(config[key])}（立即生效）`
    },
  }), SHORT + ': wechat_bot_config')

  ctx.effect(() => safeRegister({
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

  ctx.effect(() => safeRegister({
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
      // ★ extra 若是中文场景，也翻译成英文标签（本地模型只认标签）
      const rawExtra = String(args?.extra || '').trim()
      const extraTags = /[\u4e00-\u9fa5]/.test(rawExtra) ? await sceneToTags(rawExtra) : rawExtra
      const gen = await client.call('genSticker', {
        emotion, extra: extraTags || '', force: !!args?.force,
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

  ctx.effect(() => safeRegister({
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

  ctx.effect(() => safeRegister({
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
      lines.push('长期记忆 ' + ((r.facts || []).length) + ' 条（' + (globalMemory() ? '全局共享，所有群通用' : '本群独立') + '）｜文件：' + factsPathFor(r.roomId))
      for (const f of (r.facts || []).slice(-25)) {
        const d = new Date(f.at).toLocaleString('zh-CN', { hour12: false })
        lines.push('  [' + f.kind + '] ' + d + '  ' + f.text)
      }
      if (r.pendingQuestion) lines.push('待答问题（不会再重复追问）：' + r.pendingQuestion.text)
      lines.push('短期记忆：' + r.msgs.length + ' 条消息｜群成员名字 ' + Object.keys(config.memberNames || {}).length + ' 条')
      return lines.join('\n')
    },
  }), SHORT + ': wechat_bot_memory')


  ctx.effect(() => safeRegister({
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

  ctx.effect(() => safeRegister({
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

  ctx.effect(() => safeRegister({
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

  // ── Web 控制面板（挂在 DSH 已有 webServer 的 /wechat-bot）──────────────
  // 没有 webServer 的环境（纯 CLI / 别的 profile）会自动跳过，不影响机器人本体。
  // 用带 ?t= 的动态 import：Node 的 ESM 缓存不会因为 dev_reload_package 清掉子模块，
  // 不这样做会出现"面板代码改了、热重载后还是旧页面"（实测踩过）。
  let panelDisposed = false
  ctx.effect(() => () => { panelDisposed = true }, SHORT + ': panel dispose flag')
  const panelApi = {
    version: BUILD_VER,
    config,
    defaults: DEFAULT_CONFIG,
    stats,
    rooms,
    client,
    log,
    applyConfigPatch,
    healthCheck,
    lastHealth: () => healthLast,
    lastRoute: () => lastTextRoute || lastRoute,
    // 路由从哪来：config（插件自己配的）/ dsh（跟随 DSH）/ last（兜底上次）
    routeSource: () => (config.provider && config.model ? 'config' : 'dsh'),
    hasSpeech: () => !!speechService(),
    hasAttachments: () => {
      try { return !!(ctx.get?.('attachments') ?? ctx.attachments) } catch { return false }
    },
    handleAction: handlePanelAction,
    // 面板每次收到请求时报回自己的 host，插件用它拼自动打开面板的地址
    notePanelHost,
    providersState: panelProvidersState,
    refreshRoomNames: refreshNameCaches,
    roomName: (roomId) => roomNameCache.get(roomId) || '',
    senderName: (wxid) => contactNameCache.get(String(wxid || '')) || (config.memberNames || {})[String(wxid || '')] || '',
    nameCounts: () => ({ rooms: roomNameCache.size, people: contactNameCache.size }),
    providerSave: panelProviderSave,
    providerRemove: panelProviderRemove,
    providerTest: panelProviderTest,
    providerModels: panelProviderModels,
    modelCatalog: panelModelCatalog,
    imageConfig: readImageConfig,
    imageSave: panelImageSave,
    configFile: CONFIG_FILE,
    memoryDir,
    logFile,
    // 桥日志目录（本机固定在工作区；可用环境变量覆盖）
    bridgeLogDir: process.env.WECHAT_BRIDGE_LOG_DIR || 'D:\\微信deepseek\\data\\logs',
  }
  void (async () => {
    try {
      const stamp = Date.now()
      const [panelMod, metaMod] = await Promise.all([
        import('./panel.mjs?t=' + stamp),
        import('./panel-meta.mjs?t=' + stamp),
      ])
      if (panelDisposed) return
      CONFIG_META = metaMod.CONFIG_META
      panelMod.setupPanel(ctx, {
        ...panelApi,
        meta: metaMod.publicMeta(),
        groups: metaMod.GROUPS,
        features: metaMod.FEATURES,
      })
    } catch (e) {
      log('面板初始化失败（不影响机器人）：' + String(e?.stack || e?.message || e))
    }
  })()

  // TTS 服务：按"开机自启"意图自动拉起（以前只有开关、没有启动时执行 → 配置说开实际没跑）
  track(setTimeout(() => {
    void (async () => {
      try {
        if (config.voiceModelOn === false) { log('TTS：voiceModelOn=关，跳过自动启动'); return }
        if ((await ttsPids()).length) { log('TTS：api_v2 已在运行'); return }
        const r = ttsSpawn()
        log('TTS 自动启动：' + (r.ok ? '已发出启动命令' : ('失败 ' + r.error)))
      } catch (e) { log('TTS 自动启动异常：' + String(e?.message || e).slice(0, 140)) }
    })()
  }, 8000))

  try {
    // 清掉历史版本可能留下的合成房间（它没有 policy，会让配置保存失败）
    if (rooms.has('_global')) { rooms.delete('_global'); log('已清理残留的合成房间 _global') }
  } catch { }
  try {
    const mig = migrateToGlobalMemory()
    if (mig.merged) log(`记忆作用域：全局（${mig.from} 个群的 ${mig.merged} 条已合并为一份，所有群共用）`)
    else if (globalMemory()) log('记忆作用域：全局（所有群共用一份记忆库）')
    else log('记忆作用域：每群独立（memoryScope=room）')
  } catch (e) { log('记忆合并检查失败：' + String(e?.message || e).slice(0, 120)) }
  loadNames()      // 载入群成员名字映射
  startDiaryTimer() // 性格：自我叙事（写日记）
  startNarrativeTimer() // 性格：自传（她自己写的"我是个什么样的人"）
  startFeedbackTimer()  // 性格：反馈驱动的漂移（默认关，需手动打开）
  startHumanTimer()     // 人性化：自我复盘 + 身体感
  startImpressionTimer() // ② 印象卡：定期生成"对这个人的判断"
  startHuman2Timer()    // 人性化②：承诺兑现 + 自己的事
  // 群名缓存：等 hook/微信稍就绪再拉一次（失败也不影响启动，面板请求时会重试）
  track(setTimeout(() => { void refreshNameCaches() }, 5000))
  log(`插件已启动｜bridge=${config.bridgeUrl}｜昵称=${config.botName}｜闲聊概率=${config.replyProbability}｜安静时段=${config.quietHours || 'off'}｜记忆目录=${memoryDir}`)
  // ★ 2026-10-28：吃过"ESM 缓存导致用旧模块"的亏（PS.shouldWriteNarrative is not a function）。
  //   启动时直接检查关键导出，缺了立刻在日志里喊出来。
  try {
    const need = {
      'memory-v2': ['selectMemories', 'reinforceList', 'sweep', 'stats', 'guessEmotion', 'migrateList'],
      persona: ['createState', 'applyMessage', 'describeState', 'buildInnerBlock',
        'shouldWriteDiary', 'pushDiary', 'parseDiaryJson', 'addTaste', 'tasteHit', 'rerollGoals', 'progressGoals',
        'shouldWriteNarrative', 'writeNarrative', 'restoreNarrative', 'validateNarrative', 'buildNarrativePrompt'],
    }
    const missing = []
    if (need['memory-v2'].some((k) => typeof MV2[k] !== 'function')) missing.push('memory-v2')
    if (need.persona.some((k) => typeof PS[k] !== 'function')) {
      const lack = need.persona.filter((k) => typeof PS[k] !== 'function')
      missing.push('persona（缺 ' + lack.join('/') + '）')
    }
    if (missing.length) {
      log('❌ 模块自检失败：' + missing.join('；') + ' —— 多半是 ESM 缓存用了旧文件，需要重启 DSH 或换 ?v=')
    } else {
      log('模块自检：memory-v2 ✓｜persona ✓（含自传）')
    }
  } catch (e) { log('模块自检异常：' + String(e?.message || e).slice(0, 120)) }
  log(`当前人格：${config.persona}`)
}