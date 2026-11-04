// 朋友圈配图：网上搜动漫图 / AI 生成，统一归一化成微信能发的 JPEG
//
// 为什么单独抽出来：这段要能被测试脚本直接 import 验证（不依赖插件生命周期）。
//
// 实测结论（2026-10-26）：
//  - nekos.best 可用（PNG，可能 3MB）
//  - nekosapi 可用（webp，微信文件对话框不认 webp → 必须转 jpg）
//  - lolicon（pixiv 代理）在本网络全部超时，弃用
//  - 微信只能发 jpg/png/gif；webp 会弹"格式不支持"提示框
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const DEFAULT_STYLE = '生活感照片，真实质感，自然光，构图干净；不要任何文字、水印、logo'

export function resolveAgnesKey(ref = 'AGNES_API_KEY') {
  if (process.env[ref]?.trim()) return process.env[ref].trim()
  const cands = []
  if (process.env.DSH_HOME) cands.push(join(process.env.DSH_HOME, '.credentials.yaml'))
  cands.push(join(homedir(), '.dsh', '.credentials.yaml'))
  for (const f of cands) {
    try {
      const m = new RegExp(`^\\s*${ref}:\\s*(\\S+)\\s*$`, 'm').exec(readFileSync(f, 'utf8'))
      if (m) return m[1].trim()
    } catch { /* 试下一个 */ }
  }
  return ''
}

function readImageCfg() {
  const cands = [
    process.env.IMAGE_GEN_JSON,
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), '..', 'data', 'image-gen.json'),
    join(homedir(), '.dsh', '..', 'data', 'image-gen.json'),
  ].filter(Boolean)
  for (const p of cands) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      if (j && (j.apiUrl || j.model)) return j
    } catch { /* 下一个 */ }
  }
  return {}
}

// webp/超大图 → JPEG（走 PIL；缺 PIL 时返回 false）
const HERE = dirname(fileURLToPath(import.meta.url))

export function normalizeToJpeg(src, dst, maxSide = 1600, quality = 88) {
  try {
    const script = join(HERE, 'normalize-image.py')
    execFileSync('python', [script, src, dst, String(maxSide), String(quality)], { timeout: 60_000 })
    return true
  } catch {
    return false
  }
}

const PROVIDERS = [
  {
    name: 'nekos.best',
    kinds: ['neko', 'waifu', 'kitsune'],
    url: (k) => `https://nekos.best/api/v2/${k}?amount=1`,
    pick: (j) => j?.results?.[0]?.url,
    credit: (j) => j?.results?.[0]?.artist_name || '',
  },
  {
    name: 'nekosapi',
    kinds: ['safe'],
    url: () => 'https://api.nekosapi.com/v4/images/random?limit=1&rating=safe',
    pick: (j) => j?.[0]?.url,
    credit: (j) => j?.[0]?.artist_name || '',
  },
]

/** 从网上找一张动漫图并落盘成 jpg */
export async function fetchWebMomentImage({ dir, log = () => {} } = {}) {
  mkdirSync(dir, { recursive: true })
  for (const p of PROVIDERS) {
    const tries = p.name === 'nekos.best' ? 2 : 1
    for (let attempt = 0; attempt < tries; ++attempt) {
    const kind = p.kinds[Math.floor(Math.random() * p.kinds.length)]
    try {
      const r = await fetch(p.url(kind), { signal: AbortSignal.timeout(15_000) })
      if (!r.ok) { log(`配图：${p.name} 列表 HTTP ${r.status}`); continue }
      const j = await r.json()
      const imgUrl = p.pick(j)
      if (!imgUrl) { log(`配图：${p.name} 没解析到图片`); continue }

      const ir = await fetch(imgUrl, { signal: AbortSignal.timeout(45_000) })
      if (!ir.ok) { log(`配图：${p.name} 下载 HTTP ${ir.status}`); continue }
      const buf = Buffer.from(await ir.arrayBuffer())
      if (!buf.length) { log(`配图：${p.name} 空文件`); continue }

      const ts = Date.now()
      const raw = join(dir, `raw-${ts}`)
      const out = join(dir, `web-${ts}.jpg`)
      writeFileSync(raw, buf)

      let ok = normalizeToJpeg(raw, out)
      if (!ok) {
        const ct = ir.headers.get('content-type') || ''
        if (/image\/(jpeg|png)/i.test(ct)) { writeFileSync(out, buf); ok = true }
      }
      try { unlinkSync(raw) } catch { /* ignore */ }
      if (!ok) { log(`配图：${p.name} 需要转码但 PIL 不可用`); continue }

      const credit = p.credit(j) || ''
      log(`配图：${p.name}/${kind} → ${out}（作者 ${credit || '未知'}）`)
      return { ok: true, file: out, provider: p.name, kind, credit, url: imgUrl }
    } catch (e) {
      log(`配图：${p.name} 失败 ${String(e?.message || e).slice(0, 80)}`)
    }
    }
  }
  return { ok: false, error: '所有图源都失败' }
}

/** 按文案用 Agnes 生成一张图并落盘成 jpg */
export async function genMomentImage(text, { dir, style = '', ratio = '4:3', log = () => {} } = {}) {
  try {
    const cfg = readImageCfg()
    const apiUrl = cfg.apiUrl || 'https://apihub.agnes-ai.com/v1/images/generations'
    const model = cfg.model || 'agnes-image-2.5-flash'
    const key = resolveAgnesKey(cfg.keyRef || 'AGNES_API_KEY')
    if (!key) return { ok: false, error: '没有 AGNES_API_KEY' }

    const prompt = [
      `为下面这句话配一张图：「${text}」`,
      '画面要能传达这句话的情绪和场景，像随手拍的生活照片/插画，有真实的光影和细节。',
      `风格：${style || DEFAULT_STYLE}。`,
      '【禁止】不要出现任何文字、字幕、水印、logo、二维码。',
    ].join('')

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, size: '1K', ratio, extra_body: { response_format: 'url' } }),
      signal: AbortSignal.timeout(180_000),
    })
    const txt = await res.text()
    if (!res.ok) return { ok: false, error: `生图 HTTP ${res.status}: ${txt.slice(0, 160)}` }
    let j = {}
    try { j = JSON.parse(txt) } catch { return { ok: false, error: '生图返回不是 JSON' } }
    const item = j?.data?.[0] || {}
    let buf = null
    if (item.b64_json) buf = Buffer.from(item.b64_json, 'base64')
    else if (item.url) {
      const ir = await fetch(item.url, { signal: AbortSignal.timeout(120_000) })
      if (!ir.ok) return { ok: false, error: `下载图片 HTTP ${ir.status}` }
      buf = Buffer.from(await ir.arrayBuffer())
    }
    if (!buf?.length) return { ok: false, error: '生图接口没返回图片' }

    mkdirSync(dir, { recursive: true })
    const ts = Date.now()
    const raw = join(dir, `airaw-${ts}`)
    const out = join(dir, `ai-${ts}.jpg`)
    writeFileSync(raw, buf)
    if (!normalizeToJpeg(raw, out)) writeFileSync(out, buf)
    try { unlinkSync(raw) } catch { /* ignore */ }
    log(`配图：AI 生成 → ${out}`)
    return { ok: true, file: out, provider: 'agnes', url: item.url || '' }
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) }
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// 角色图（char）：拿蓝色大肥鱼的参考图做图生图，保证"必须是本人"
//
// 为什么只能这么做：蓝色大肥鱼是自创角色（Q 版鲸鱼娘），网上搜不到；
// 随机动漫图源（nekos.best 等）只能保证"是动漫少女"，保证不了"是她"。
// 参考图与表情包共用 data/stickers/ref/main.jpg（换角色图两边一起变）。
// ─────────────────────────────────────────────────────────────────────────────
const CHAR_DESC =
  '一个 Q 版可爱的鲸鱼娘角色：深蓝到浅蓝渐变的及腰长发，白色蕾丝荷叶边头饰（像女仆帽），' +
  '发间有两个小小的鲸鱼鳍状耳朵装饰，头顶有一撮海豚尾形状的呆毛；蓝色大眼睛、圆脸、脸颊有红晕；' +
  '穿深蓝白相间的女仆裙（裙摆有鲸鱼刺绣和小蝴蝶结），身后有一条鲸鱼尾巴。'

function findCharRef(explicit) {
  const cands = [
    explicit,
    process.env.MOMENT_CHAR_REF,
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), '..', 'data', 'stickers', 'ref', 'main.jpg'),
    join(homedir(), '.dsh', '..', 'data', 'stickers', 'ref', 'main.jpg'),
    // 兜底：仓库自带的角色参考图（随插件分发）
    join(HERE, '..', 'assets', 'char-ref.jpg'),
  ].filter(Boolean)
  for (const p of cands) {
    try { if (readFileSync(p).length > 1000) return p } catch { /* 下一个 */ }
  }
  return ''
}

export async function genMomentImageChar(text, { dir, refImage, style = '', ratio = '4:3', log = () => {} } = {}) {
  try {
    const ref = findCharRef(refImage)
    if (!ref) return { ok: false, error: '找不到角色参考图（stickers/ref/main.jpg）' }
    const cfg = readImageCfg()
    const apiUrl = cfg.apiUrl || 'https://apihub.agnes-ai.com/v1/images/generations'
    const model = cfg.model || 'agnes-image-2.5-flash'
    const key = resolveAgnesKey(cfg.keyRef || 'AGNES_API_KEY')
    if (!key) return { ok: false, error: '没有 AGNES_API_KEY' }

    const refB64 = readFileSync(ref).toString('base64')
    const prompt = [
      `【角色（必须完全照参考图画，就是她本人）】${CHAR_DESC}`,
      '**画面里只能有这一个角色**，不要画成两个人，也不要换发色/换服装/换脸。',
      '参考图只用来定角色长相与画风；**背景、构图、镜头、姿势、道具全部按本次题材重新画**。',
      `【本次题材】${text}`,
      '【场景】为这句文案新画一个完整场景，有环境细节和光影，不要纯白底、不要角色悬空。',
      style ? `【风格】${style}。` : '',
      '【禁止】不要任何文字、字幕、水印、logo、二维码、对话框。',
    ].filter(Boolean).join('')

    let res = null
    let txt = ''
    for (let attempt = 1; attempt <= 3; ++attempt) {
      res = await fetch(apiUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          size: '1K',
          ratio,
          // i2i：带参考图（和表情包同一条路）
          extra_body: { image: [`data:image/jpeg;base64,${refB64}`], response_format: 'url' },
        }),
        signal: AbortSignal.timeout(180_000),
      })
      txt = await res.text()
      if (res.ok) break
      const busy = res.status === 503 || res.status === 429 || /queue is full|retry later|rate limit/i.test(txt)
      if (!busy || attempt === 3) break
      const waitMs = 4_000 * attempt * attempt     // 4s → 16s
      log(`配图：Agnes 忙（HTTP ${res.status}）→ ${Math.round(waitMs / 1000)}s 后重试（${attempt}/3）`)
      await new Promise(r => setTimeout(r, waitMs))
    }
    if (!res || !res.ok) return { ok: false, error: `图生图 HTTP ${res ? res.status : '?'}: ${txt.slice(0, 160)}` }
    let j = {}
    try { j = JSON.parse(txt) } catch { return { ok: false, error: '返回不是 JSON' } }
    const item = j?.data?.[0] || {}
    let buf = null
    if (item.b64_json) buf = Buffer.from(item.b64_json, 'base64')
    else if (item.url) {
      const ir = await fetch(item.url, { signal: AbortSignal.timeout(120_000) })
      if (!ir.ok) return { ok: false, error: `下载图片 HTTP ${ir.status}` }
      buf = Buffer.from(await ir.arrayBuffer())
    }
    if (!buf?.length) return { ok: false, error: '没返回图片' }

    mkdirSync(dir, { recursive: true })
    const ts = Date.now()
    const raw = join(dir, `charraw-${ts}`)
    const out = join(dir, `char-${ts}.jpg`)
    writeFileSync(raw, buf)
    if (!normalizeToJpeg(raw, out)) writeFileSync(out, buf)
    try { unlinkSync(raw) } catch { /* ignore */ }
    log(`配图：角色图（i2i）→ ${out}`)
    return { ok: true, file: out, provider: 'char', ref }
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) }
  }
}

/** 按来源挑图；两种来源互相兜底 */
export async function pickMomentImage(text, opts = {}) {
  const source = String(opts.source || 'char')
  const log = opts.log || (() => {})

  // char = 蓝色大肥鱼本人（**只走图生图**）
  //   刻意不降级到文生图/网上随机图：那两个保证不了"是她"，宁可这条不发图
  if (source === 'char') {
    const first = await genMomentImageChar(text, opts)
    if (first.ok) return first
    log(`配图：图生图失败（${first.error}），5 秒后再试一次`)
    await new Promise(r => setTimeout(r, 5000))
    const second = await genMomentImageChar(text, opts)
    if (second.ok) return second
    return { ok: false, error: `图生图两次都失败：${second.error}`, giveUp: true }
  }

  // 最近被爆过的问题：webp 微信不认 → 这里统一走 normalize，不会再出现
  if (source === 'ai') {
    const a = await genMomentImage(text, opts)
    if (a.ok) return a
    log('配图：AI 生成失败，改用网上动漫图')
    const w = await fetchWebMomentImage(opts)
    return w.ok ? w : { ok: false, error: `${a.error} / ${w.error}` }
  }
  const w = await fetchWebMomentImage(opts)
  if (w.ok) return w
  log('配图：网上找图失败，改用 AI 生成')
  const a = await genMomentImage(text, opts)
  return a.ok ? a : { ok: false, error: `${w.error} / ${a.error}` }
}
