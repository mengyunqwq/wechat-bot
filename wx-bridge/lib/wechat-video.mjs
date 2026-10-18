/**
 * 微信视频消息（type 43）：取那张**明文 JPG 封面**给识图用。
 *
 * 为什么这么简单（实测确认，别凭猜改）：
 *  ① 微信给每条视频都落了一张**明文 JPG 封面**（未加密）：
 *       <数据根>\msg\video\<年-月>\<某hash>_thumb.jpg
 *     所以**不需要 ffmpeg、不需要解密、不需要下载** ✓。
 *  ② ⚠️ **封面文件名里的 hash ≠ 视频 XML 里的 md5**（实测：XML md5=cb616e8d…，
 *     封面却叫 caf76cdc…_thumb.jpg）→ **不能拼文件名**，只能按 **mtime 最接近消息时间** 找，
 *     再用 XML 的 `cdnthumblength`（封面字节数）**校验大小**（实测 148167 ≈ 144.7KB ✓ 完全吻合）。
 *  ③ ⚠️ **必须复制一份到临时目录再返回**：插件识别完会 `unlinkSync(返回的文件)`，
 *     直接把微信自己的封面路径给它 = 会把微信的封面删掉 ✗。
 *  ④ 找不到封面 → 返回 null（插件优雅降级成 `[视频]`，不抛错）。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { paths as imagePaths, md5 } from './wechat-image.mjs'   // 临时目录/数据根沿用图片那套

const TMP_DIR = imagePaths.TMP_DIR
const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE_DIR = join(HERE, '..')
const PY = process.env.PYTHON_EXE || 'D:\\Python311\\python.exe'
const SCRIPT = join(BRIDGE_DIR, 'video-probe.py')
const VIDEO_TMP = join(TMP_DIR, 'video')          // 抽帧/联系表/音轨都放这里
const PY_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8' }

/** 明确不是视频的扩展名（封面、缩略图、图片、文档…） */
const NOT_VIDEO_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.hevc', '.dat',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.txt', '.json', '.xml',
])
/** 视频常见的扩展名（优先选这些） */
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.wmv', '.flv', '.ts', '.mpg', '.mpeg', '.3gp'])

/** 封面文件名的后缀（微信就是 *_thumb.jpg；个别版本可能是 jpeg） */
const COVER_RE = /_thumb\.(jpe?g)$/i

/**
 * 从视频消息的 XML 里取元数据（校验/日志用，不参与定位）。
 * 实测样例：
 *   <videomsg aeskey="…" cdnvideourl="…" length="1586397" playlength="8"
 *             cdnthumblength="148167" cdnthumbwidth="398" cdnthumbheight="708"
 *             fromusername="…" md5="cb616e8d…" />
 */
export function xmlVideoMeta(xml) {
  const s = String(xml || '')
  const num = (k) => {
    // 负向后顾锚定属性名（否则 length 会先匹配到 cdnthumblength —— 这个坑在语音那边踩过）
    const m = new RegExp('(?<![\\w-])' + k + '="(\\d+)"').exec(s)
    return m ? Number(m[1]) : 0
  }
  return {
    length: num('length'),                 // 视频本体字节数（用不上，只报日志）
    playlength: num('playlength'),         // 时长（秒）
    cdnthumblength: num('cdnthumblength'), // 封面字节数 ← 校验用
    cdnthumbwidth: num('cdnthumbwidth'),
    cdnthumbheight: num('cdnthumbheight'),
  }
}

/**
 * 定位视频封面并**复制**到临时目录，返回副本路径；失败返回 null。
 *
 * @param {string} root  微信数据根（含 msg\video）
 * @param {object} o
 * @param {number} [o.nearTs]        消息时间戳（毫秒）—— 封面落盘时间≈收到时间，用它挑最接近的
 * @param {number} [o.toleranceMs]   允许的时间偏差（默认 ±30 分钟）
 * @param {number} [o.declaredBytes] XML 的 cdnthumblength（封面字节数，用于校验；0=不校验）
 * @param {(s:string)=>void} [o.log]
 * @returns {string|null} 临时副本的绝对路径
 */
/**
 * **硬校验**：XML 声明了字节数时，把大小不符（>±10%）的候选**直接丢掉**。
 *
 * 为什么必须硬（线上真 bug，2026-10-18 实测）：
 *   群里两条视频挨着，第二条还没落盘，但"按 mtime 最接近"会匹配到**第一条的文件**；
 *   旧逻辑只记一句"可能选错了文件，仍按找到的返回" → 结果把**另一个视频的内容**当成这条描述了 ✗
 *   （有人问"这个视频说了什么"，答的是前一条 meme）。
 *   描述一个错的视频，比只用封面更糟 —— 封面至少确定是这条视频的封面。
 * @returns {Array|null} 过滤后的候选；声明大小对不上任何一个时返回 null（调用方应放弃主路 → 退回封面）
 */
function sizeFiltered(cands, declaredBytes, tag, log) {
  if (!declaredBytes || declaredBytes <= 0) {
    log(`${tag}：XML 没给字节数，只能按时间匹配（有选错的风险）`)
    return cands
  }
  const ok = cands.filter((c) => Math.abs(c.size - declaredBytes) / declaredBytes <= 0.10)
  if (!ok.length) {
    const near = cands.reduce((a, b) => (Math.abs(b.size - declaredBytes) < Math.abs(a.size - declaredBytes) ? b : a))
    const ratio = Math.abs(near.size - declaredBytes) / declaredBytes
    log(`${tag}：${cands.length} 个候选都与声明大小不符（最接近的 ${near.name} 差 ${(ratio * 100).toFixed(1)}%），`
      + '已全部丢弃 → 放弃主路')
    return null
  }
  if (ok.length < cands.length) {
    log(`${tag}：按声明大小筛掉 ${cands.length - ok.length} 个候选（保留 ${ok.length} 个）`)
  }
  return ok
}

export function findVideoCover(root, { nearTs = 0, toleranceMs = 30 * 60_000, declaredBytes = 0, log = () => {} } = {}) {
  if (!root || !existsSync(root)) { log(`视频封面定位：数据根不存在（${root || '空'}）`); return null }
  const base = join(root, 'msg', 'video')
  if (!existsSync(base)) { log(`视频封面定位：目录不存在（${base}）`); return null }

  const cands = []
  let months = 0
  for (const month of readdirSync(base)) {
    const d = join(base, month)
    try { if (!statSync(d).isDirectory()) continue } catch { continue }
    months++
    for (const f of readdirSync(d)) {
      if (!COVER_RE.test(f)) continue
      const p = join(d, f)
      try {
        const st = statSync(p)
        if (st.isFile() && st.size > 1024) cands.push({ path: p, mtime: st.mtimeMs, size: st.size, name: f })
      } catch { /* ignore */ }
    }
  }
  log(`视频封面定位：扫了 ${months} 个月份目录 → 候选 ${cands.length} 个 *_thumb.jpg`)
  if (!cands.length) {
    log('视频封面定位：没找到任何封面（这条视频可能没下载过封面）')
    return null
  }

  // ── 用 XML 的 cdnthumblength 做**硬校验**：不符的候选直接丢 ──
  // 为什么要硬：宁可退回 [视频]，也不要拿**别人视频的封面**去描述（制造错误信息比降级更糟）。
  const pool = sizeFiltered(cands, declaredBytes, '视频封面定位', log)
  if (!pool) return null

  let best
  if (nearTs) {
    best = pool.reduce((a, b) => (Math.abs(b.mtime - nearTs) < Math.abs(a.mtime - nearTs) ? b : a))
    const diff = Math.abs(best.mtime - nearTs)
    if (diff > toleranceMs) {
      log(`视频封面定位：最近的候选偏离消息时间 ${Math.round(diff / 60000)} 分钟（>${Math.round(toleranceMs / 60000)} 分钟容差），放弃：${best.name}`)
      return null
    }
    log(`视频封面定位：按时间命中 ${best.name}（偏离 ${Math.round(diff / 1000)}s）`)
  } else {
    pool.sort((a, b) => b.mtime - a.mtime)
    best = pool[0]
    log(`视频封面定位：无消息时间戳，取最新的 ${best.name}`)
  }
  if (declaredBytes > 0) log(`视频封面定位：大小与声明吻合（${best.size} ≈ ${declaredBytes}）`)

  // ⚠️ 复制到临时目录：插件会删掉返回的文件，绝不能把微信自己的封面路径交出去
  let dst
  try {
    mkdirSync(TMP_DIR, { recursive: true })
    dst = join(TMP_DIR, `video-${nearTs || Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`)
    copyFileSync(best.path, dst)
  } catch (e) {
    log('视频封面定位：复制到临时目录失败：' + String(e?.message || e).slice(0, 120))
    return null
  }
  log(`视频封面定位：${best.name}（${Math.round(best.size / 1024)}KB，声明 ${declaredBytes || '?'} 字节）→ 临时副本 ${dst}`)
  return dst
}

export const paths = { TMP_DIR, VIDEO_TMP, SCRIPT, PY }

// ══════════════════════════════════════════════════════════════════════
//  主路：找到**视频文件本身**（微信按需下载，落盘后就是普通 mp4，明文不用解密）
//  找不到才退回上面的封面兜底。
// ══════════════════════════════════════════════════════════════════════

/** 列出目录里的文件（不递归），出错返回 [] */
function listFiles(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

/**
 * 找一条视频消息对应的**视频文件**。
 *
 * 位置（两条都扫，因为不同版本目录名不一定）：
 *   ① <数据根>\msg\video\<年-月>\*            （和封面同级；排除 *_thumb.jpg）
 *   ② <数据根>\msg\attach\<md5(群id)>\<年-月>\**\*.mp4   （兜底：不确定目录名，递归扫）
 * 匹配：mtime 最接近消息 ts（±30 分钟）+ 用 XML 的 `length` 校验大小（±10%，不符只记日志）。
 *
 * @returns {{path:string,size:number,mtime:number,name:string,why:string}|null}
 */
export function findVideoFile(root, roomId, { nearTs = 0, toleranceMs = 30 * 60_000, declaredBytes = 0, minBytes = 8 * 1024, log = () => {} } = {}) {
  if (!root || !existsSync(root)) { log(`视频文件定位：数据根不存在（${root || '空'}）`); return null }
  const cands = []
  const collect = (p, why) => {
    try {
      const st = statSync(p)
      if (!st.isFile() || st.size < minBytes) return
      const ext = extname(p).toLowerCase()
      if (NOT_VIDEO_EXT.has(ext)) return
      // 明确的视频扩展名优先；其它（无扩展名/.bin 等）也收，但排在后面
      cands.push({ path: p, mtime: st.mtimeMs, size: st.size, name: p.split(/[\\/]/).pop(), why, score: VIDEO_EXT.has(ext) ? 1 : 0 })
    } catch { /* ignore */ }
  }

  // ① msg\video\<年-月>\*
  const vdir = join(root, 'msg', 'video')
  let looked = 0
  if (existsSync(vdir)) {
    for (const month of listFiles(vdir)) {
      const d = join(vdir, month)
      try { if (!statSync(d).isDirectory()) continue } catch { continue }
      looked++
      for (const f of listFiles(d)) collect(join(d, f), `msg\\video\\${month}`)
    }
    log(`视频文件定位：扫了 msg\\video 下 ${looked} 个月份目录 → 候选 ${cands.length} 个`)
  } else {
    log(`视频文件定位：目录不存在（${vdir}）`)
  }

  // ② 兜底：attach\<群hash>\<年-月>\**\*.mp4（递归，排除 Img）
  if (!cands.length && roomId) {
    const base = join(root, 'msg', 'attach', md5(roomId))
    if (existsSync(base)) {
      const walk = (dir, depth) => {
        if (depth > 3) return
        for (const name of listFiles(dir)) {
          const p = join(dir, name)
          let st
          try { st = statSync(p) } catch { continue }
          if (st.isDirectory()) {
            if (/^img$/i.test(name)) continue
            walk(p, depth + 1)
          } else collect(p, 'attach 树内按时间找')
        }
      }
      walk(base, 0)
      log(`视频文件定位：attach 树兜底扫描 → 候选 ${cands.length} 个`)
    }
  }

  if (!cands.length) {
    log('视频文件定位：没找到视频文件（微信视频按需下载 —— 没人播过/没开自动下载就不会落盘）')
    return null
  }

  // ── 先用 XML 的 length（视频本体字节数）**硬筛**，再按时间挑 ──
  // 顺序很关键：旧逻辑"先按时间挑、再事后校验、不符也返回"正是线上答错视频的根因 ✗
  // （两条视频挨着时，mtime 最接近的往往是**邻居的文件**）。
  const pool = sizeFiltered(cands, declaredBytes, '视频文件定位', log)
  if (!pool) {
    log('视频文件定位：放弃主路 → 退回封面')
    return null
  }

  // 有消息时间戳 → mtime 最接近的（同分时优先"扩展名像视频"的）
  let best
  if (nearTs) {
    best = pool.reduce((a, b) => {
      const da = Math.abs(a.mtime - nearTs), db = Math.abs(b.mtime - nearTs)
      if (db !== da) return db < da ? b : a
      return b.score > a.score ? b : a
    })
    const diff = Math.abs(best.mtime - nearTs)
    if (diff > toleranceMs) {
      log(`视频文件定位：最近的候选偏离消息时间 ${Math.round(diff / 60000)} 分钟（>${Math.round(toleranceMs / 60000)} 分钟容差），放弃：${best.name}`)
      return null
    }
    log(`视频文件定位：按时间命中 ${best.name}（${Math.round(best.size / 1024)}KB，偏离 ${Math.round(diff / 1000)}s，来源：${best.why}）`)
  } else {
    pool.sort((a, b) => b.mtime - a.mtime)
    best = pool[0]
    log(`视频文件定位：无消息时间戳，取最新的 ${best.name}（${Math.round(best.size / 1024)}KB，来源：${best.why}）`)
  }
  if (declaredBytes > 0) log(`视频文件定位：大小与声明吻合（${best.size} ≈ ${declaredBytes}）`)
  return best
}

/** 清理临时目录里的陈年视频产物（插件正常会删；插件崩了就靠这个兜底） */
export function pruneVideoTemp(maxAgeMs = 60 * 60_000) {
  let n = 0
  try {
    if (!existsSync(VIDEO_TMP)) return 0
    for (const f of listFiles(VIDEO_TMP)) {
      const p = join(VIDEO_TMP, f)
      try {
        if (Date.now() - statSync(p).mtimeMs > maxAgeMs) { unlinkSync(p); n++ }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return n
}

/**
 * 跑 video-probe.py：抽帧拼联系表 + 抽音轨成 16k WAV。
 * @returns {{sheet:string,wav:string,durationSec:number,frames:number,sheetBytes:number,wavSeconds:number}|null}
 */
export function probeVideo(videoPath, { frames = 6, tag = 'video', log = () => {} } = {}) {
  if (!existsSync(SCRIPT)) { log(`视频抽帧：脚本不存在（${SCRIPT}）`); return null }
  if (!existsSync(videoPath)) { log(`视频抽帧：源文件不存在（${videoPath}）`); return null }
  try {
    mkdirSync(VIDEO_TMP, { recursive: true })
    const n = pruneVideoTemp()
    if (n) log(`视频临时目录：清掉 ${n} 个陈年产物`)
  } catch { /* ignore */ }
  const safe = String(tag).replace(/[^\w.-]/g, '_').slice(0, 40) || 'video'
  try {
    const out = execFileSync(PY, [SCRIPT, '--in', videoPath, '--out-dir', VIDEO_TMP,
      '--frames', String(Number(frames) || 6), '--tag', safe],
    { timeout: 300_000, encoding: 'utf8', env: PY_ENV })
    for (const line of String(out || '').split(/\r?\n/)) {
      if (line.startsWith('JSON: ')) {
        const r = JSON.parse(line.slice(6))
        if (r && r.ok) return r
        log('视频抽帧：脚本说没抽到画面也没抽到音轨')
        return null
      }
    }
    log('视频抽帧：脚本没有输出 JSON（输出片段：' + String(out || '').replace(/\s+/g, ' ').slice(0, 200) + '）')
    return null
  } catch (e) {
    const out = String(e?.stdout || '') + String(e?.stderr || '')
    log('视频抽帧失败：' + (out || String(e?.message || e)).replace(/\s+/g, ' ').slice(0, 300))
    return null
  }
}

/** 清空视频临时目录（排查时手动用） */
export function purgeVideoTemp() {
  try { rmSync(VIDEO_TMP, { recursive: true, force: true }); return true } catch { return false }
}
