/**
 * 微信聊天语音（type 34）：本地定位音频文件 → 解码成 ASR 要的 16k 单声道 WAV。
 *
 * 背景（我们一步步查出来的，别凭猜改）：
 *  ① 语音的**音频不在数据库里**：message_content 只是 368 字节的 XML 元数据
 *     （hex+zstd），真正的音频是磁盘文件。
 *  ② 微信媒体**按需下载**：没人播放过的老语音，磁盘上压根没有文件 ——
 *     所以这里的"定位"必须容错 + 带日志，找不到就优雅降级（事件照旧发 [语音]）。
 *  ③ 布局与图片同源（见 wechat-image.mjs）：
 *       <数据根>\msg\attach\<md5(群id)>\<年-月>\Img\...      ← 图片（要排除）
 *     语音目录名各版本不一（Voice/Audio/Silk…），本机**暂时还没有**语音目录，
 *     所以策略是：先按群 hash + 月份找语音目录；找不到就在 attach 树里按
 *     **消息 create_time ±30 分钟修改过**的文件里找（.dat 也算候选 —— 微信可能把语音也存成 .dat）。
 *  ④ 微信 4.x 的媒体 .dat 可能是 **V2 加密**（图片就是这样）。若候选文件是 V2，
 *     先用 decode-wechat-image.py 把容器剥掉，再喂给语音解码（同一条链路的兜底，失败只记日志）。
 *
 * 本模块负责：定位 → 解码到 data\voice\ → 返回 WAV 路径（转写完由插件删）。
 * 开关：环境变量 WECHAT_VOICE=0 关闭（默认开）。
 */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { md5 } from './wechat-image.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE_DIR = join(HERE, '..')
const PY = process.env.PYTHON_EXE || 'D:\\Python311\\python.exe'
const SCRIPT = join(BRIDGE_DIR, 'decode-wechat-voice.py')
const IMAGE_SCRIPT = join(BRIDGE_DIR, 'decode-wechat-image.py')
const TMP_DIR = join(BRIDGE_DIR, '..', 'data', 'voice')
const PY_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8' }

/** 语音目录可能的命名（各版本不一，全部当候选） */
const VOICE_DIR_NAMES = ['Voice', 'voice', 'Audio', 'audio', 'Silk', 'silk', 'Aud', 'aud', 'voice2']
/** 扫描时排除的目录（图片/视频/文件目录里不可能是语音） */
const SKIP_DIR_NAMES = new Set(['img', 'image', 'video', 'file', 'thumb', 'thumbnail', 'migrate'])
/** 明确不是语音的扩展名（其余一律当候选，含 .dat / 无扩展名） */
const SKIP_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.hevc', '.mp4', '.mov', '.avi',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.7z',
  '.txt', '.json', '.db', '.xml', '.log',
])
const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])   // 微信 4.x V2 加密容器

/** 语音处理总开关（环境变量 WECHAT_VOICE=0 关闭） */
export function voiceEnabled() {
  return String(process.env.WECHAT_VOICE ?? '1').trim() !== '0'
}

/** 读文件头若干字节（只读前 N 字节，不把整文件读进内存；读不到返回空 Buffer） */
function headOf(p, n = 16) {
  let fd = null
  try {
    fd = openSync(p, 'r')
    const buf = Buffer.alloc(n)
    const got = readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, Math.max(0, got))
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}

function isV2(p) {
  const h = headOf(p, 6)
  return h.length >= 6 && h.equals(V2_MAGIC)
}

// ── 库里的 voice_data（主路）────────────────────────────────────
// 实测（2026-10-18，真机 dump）：音频**不在文件系统里**，在 media_0.db 的 VoiceInfo.voice_data（BLOB），
// hook 的 /QueryDB/execute 把它返回成 **hex 字符串**。真实字节布局：
//   02 | 23 21 53 49 4C 4B 5F 56 33 | <SILK 数据…>
//   ↑ 容器前缀 1 字节            ↑ "#!SILK_V3"（明文）
// 也就是**明文 SILK，不需要 AES 解密**（XML 里的 aeskey 是网络传输用的，本地 blob 是明文）。
// 消息表 Msg_<hash>.local_id 与 VoiceInfo.local_id **是同一个值**，用它关联。
const SILK_MAGIC_BUF = Buffer.from('#!SILK_V3')

/**
 * 从语音消息的 XML 里取元数据（只用于校验/日志，不参与解码）。
 * 实测样例：`<voicemsg voiceformat="4" voicelength="1440" length="2488" ... />`
 *   length      = voice_data 的**总字节数**（含 1 字节前缀）
 *   voicelength = 语音时长（毫秒）
 */
export function xmlVoiceMeta(xml) {
  const s = String(xml || '')
  const num = (k) => {
    // 必须用负向后顾锚定属性名：否则 `length` 会先匹配到 `voicelength="1440"`
    // （真实 XML 里 voicelength 在 length 前面，实测踩到：2488 被读成 1440）
    const m = new RegExp('(?<![\\w-])' + k + '="(\\d+)"').exec(s)
    return m ? Number(m[1]) : 0
  }
  return { length: num('length'), voicelength: num('voicelength'), voiceformat: num('voiceformat') }
}

/**
 * 剥掉容器前缀，取出从 `#!SILK_V3` 开始的 SILK 字节。
 * 按"查找魔数"而不是"硬编码 offset=1"（更稳：不同版本前缀长度可能不同）。
 * @returns {{silk: Buffer, offset: number}|null} 找不到头返回 null（调用方记日志降级）
 */
export function stripSilkHeader(buf) {
  if (!buf || !buf.length) return null
  const off = buf.indexOf(SILK_MAGIC_BUF)
  if (off < 0) return null
  return { silk: buf.subarray(off), offset: off }
}

/**
 * 把「库里的 voice_data 字节」直接解码成 16k/单声道/PCM16 WAV（主路）。
 * pilk 只吃文件路径，所以中间落一个临时 .silk —— 成功失败都删掉（规矩：临时文件不留）。
 *
 * @returns {{wav:string, note:string}|null} 失败返回 null（调用方只记日志、继续走 [语音]）
 */
export function decodeVoiceBytes(bytes, { tag = 'voice', log = () => {} } = {}) {
  if (!existsSync(SCRIPT)) { log(`语音解码：解码脚本不存在（${SCRIPT}）`); return null }
  if (!bytes || bytes.length < 16) { log(`语音解码：blob 太小（${bytes ? bytes.length : 0} 字节）`); return null }
  mkdirSync(TMP_DIR, { recursive: true })
  const safe = String(tag).replace(/[^\w.-]/g, '_').slice(0, 60)
  const dst = join(TMP_DIR, `${safe}.wav`)
  const stripped = stripSilkHeader(bytes)
  let feed = bytes
  let note = ''
  if (stripped) {
    feed = stripped.silk
    note = stripped.offset ? `已剥前缀 ${stripped.offset} 字节` : ''
  } else {
    log(`语音解码：blob 里没找到 #!SILK_V3（前 16 字节 ${bytes.subarray(0, 16).toString('hex')}）→ 按裸流再试一次`)
  }
  const silkTmp = join(TMP_DIR, `${safe}.silk`)
  try {
    writeFileSync(silkTmp, feed)
    let r = runDecoder(silkTmp, dst)
    if (!r.ok && !stripped) r = runDecoder(silkTmp, dst, ['--force-silk'])   // 裸流：补个头再试
    if (!r.ok) {
      log(`语音解码失败（库 blob ${bytes.length} 字节）：` + String(r.out).replace(/\s+/g, ' ').slice(0, 300))
      try { if (existsSync(dst)) unlinkSync(dst) } catch { /* ignore */ }
      return null
    }
    log(`语音解码成功${note ? '（' + note + '）' : ''}：VoiceInfo blob ${bytes.length} 字节 → ${dst}（${Math.round(statSync(dst).size / 1024)}KB）`)
    return { wav: dst, note }
  } finally {
    try { if (existsSync(silkTmp)) unlinkSync(silkTmp) } catch { /* ignore */ }
  }
}

/** 列出目录下的文件（不递归），出错返回 [] */
function listFiles(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

/** 把候选文件收进 out（含 size/mtime），失败静默跳过 */
function collect(out, path, why) {
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size < 256) return
    out.push({ path, mtime: st.mtimeMs, size: st.size, name: path.split(/[\\/]/).pop(), why })
  } catch { /* ignore */ }
}

/**
 * 定位一条语音的音频文件。
 *
 * @param {string} root      微信数据根（含 msg\attach）
 * @param {string} roomId    会话 id（群为 xxx@chatroom）
 * @param {object} o
 * @param {number} o.nearTs  消息时间戳（毫秒）—— 音频落盘时间≈收到时间，用它挑最接近的
 * @param {number} [o.toleranceMs] 允许的时间偏差（默认 ±30 分钟，任务书要求）
 * @param {(s:string)=>void} [o.log]
 * @returns {{path:string,size:number,mtime:number,name:string,why:string}|null}
 */
export function findVoiceFile(root, roomId, { nearTs = 0, toleranceMs = 30 * 60_000, log = () => {} } = {}) {
  if (!root || !existsSync(root)) {
    log(`语音定位：数据根不存在（root=${root || '空'}）`)
    return null
  }
  const chatHash = md5(roomId)
  const base = join(root, 'msg', 'attach', chatHash)
  const cands = []
  const looked = []

  // ── ① 首选：群目录 + 月份目录下的语音目录 ──────────────────────
  if (existsSync(base)) {
    for (const month of listFiles(base)) {
      const monthDir = join(base, month)
      try { if (!statSync(monthDir).isDirectory()) continue } catch { continue }
      for (const sub of listFiles(monthDir)) {
        const subDir = join(monthDir, sub)
        try { if (!statSync(subDir).isDirectory()) continue } catch { continue }
        if (!VOICE_DIR_NAMES.includes(sub)) continue
        looked.push(subDir)
        for (const f of listFiles(subDir)) {
          if (SKIP_EXT.has(extname(f).toLowerCase())) continue
          collect(cands, join(subDir, f), `语音目录 ${sub}`)
        }
      }
    }
  } else {
    log(`语音定位：该会话的 attach 目录不存在（md5(${roomId})=${chatHash}）`)
  }

  // ── ② 兜底：attach\<群hash> 全树按 mtime 找（排除 Img/Video/File）──
  if (!cands.length && existsSync(base)) {
    const walk = (dir, depth) => {
      if (depth > 3) return
      for (const name of listFiles(dir)) {
        const p = join(dir, name)
        let st
        try { st = statSync(p) } catch { continue }
        if (st.isDirectory()) {
          if (SKIP_DIR_NAMES.has(name.toLowerCase())) continue
          walk(p, depth + 1)
        } else {
          if (SKIP_EXT.has(extname(name).toLowerCase())) continue
          collect(cands, p, 'attach 树内按时间找')
        }
      }
    }
    walk(base, 0)
    looked.push(base + '（全树，已排除 Img/Video/File）')
  }

  // ── ③ 再兜底：msg\voice（与 msg\video 同级，跨会话）────────────
  if (!cands.length) {
    for (const top of ['voice', 'audio', 'Voice', 'Audio']) {
      const d = join(root, 'msg', top)
      if (!existsSync(d)) continue
      looked.push(d)
      const walk = (dir, depth) => {
        if (depth > 3) return
        for (const name of listFiles(dir)) {
          const p = join(dir, name)
          let st
          try { st = statSync(p) } catch { continue }
          if (st.isDirectory()) walk(p, depth + 1)
          else if (!SKIP_EXT.has(extname(name).toLowerCase())) collect(cands, p, `msg\\${top} 内按时间找`)
        }
      }
      walk(d, 0)
    }
  }

  log(`语音定位：查了 ${looked.length} 个目录 → 候选 ${cands.length} 个`
    + (looked.length ? `（${looked.slice(0, 6).join(' | ')}${looked.length > 6 ? ' …' : ''}）` : ''))

  if (!cands.length) {
    log('语音定位：没找到任何候选音频（微信媒体按需下载 —— 这条语音可能从没被播放过，磁盘上就没有文件）')
    return null
  }

  // 有消息时间戳 → 挑 mtime 最接近的（落盘时间≈收到时间）；超出容差就放弃
  if (nearTs) {
    const best = cands.reduce((a, b) => (Math.abs(b.mtime - nearTs) < Math.abs(a.mtime - nearTs) ? b : a))
    const diff = Math.abs(best.mtime - nearTs)
    if (diff > toleranceMs) {
      log(`语音定位：最近的候选偏离消息时间 ${Math.round(diff / 60000)} 分钟（>${Math.round(toleranceMs / 60000)} 分钟容差），放弃：${best.name}`)
      return null
    }
    log(`语音定位：命中 ${best.name}（${best.size}B，偏离 ${Math.round(diff / 1000)}s，来源：${best.why}）`)
    return best
  }
  // 没有时间戳 → 取最新的
  cands.sort((a, b) => b.mtime - a.mtime)
  log(`语音定位：无消息时间戳，取最新的 ${cands[0].name}（${cands[0].size}B，来源：${cands[0].why}）`)
  return cands[0]
}

/** 调 Python 解码器；返回 { ok, wav, out } —— 失败把 Python 的失败原因带回来 */
function runDecoder(src, dst, extraArgs = []) {
  try {
    const out = execFileSync(PY, [SCRIPT, '--in', src, '--out', dst, ...extraArgs],
      { windowsHide: true, timeout: 120_000, encoding: 'utf8', env: PY_ENV })
    return { ok: existsSync(dst) && statSync(dst).size > 44, wav: dst, out: String(out || '').trim() }
  } catch (e) {
    const out = String(e?.stdout || '') + String(e?.stderr || '')
    return { ok: false, wav: null, out: (out || String(e?.message || e)).trim().slice(0, 400) }
  }
}

/** 清理临时目录里的陈年 WAV（插件正常会删；插件崩了就靠这个兜底） */
export function pruneTemp(maxAgeMs = 60 * 60_000) {
  try {
    if (!existsSync(TMP_DIR)) return 0
    let n = 0
    for (const f of readdirSync(TMP_DIR)) {
      const p = join(TMP_DIR, f)
      try {
        if (Date.now() - statSync(p).mtimeMs > maxAgeMs) { unlinkSync(p); n++ }
      } catch { /* ignore */ }
    }
    return n
  } catch { return 0 }
}

/**
 * 把一条语音解码成 ASR 要的 16k 单声道 WAV。
 *
 * @param {string} srcPath  定位到的音频文件
 * @param {object} o
 * @param {string} [o.tag]  输出文件名标签（带消息 id 防冲突）
 * @param {(s:string)=>void} [o.log]
 * @returns {{wav:string, note:string}|null}  失败返回 null（调用方只记日志、继续走 [语音]）
 */
export function decodeVoice(srcPath, { tag = 'voice', log = () => {} } = {}) {
  if (!existsSync(SCRIPT)) { log(`语音解码：解码脚本不存在（${SCRIPT}）`); return null }
  if (!existsSync(srcPath)) { log(`语音解码：源文件不存在（${srcPath}）`); return null }
  mkdirSync(TMP_DIR, { recursive: true })
  try { const n = pruneTemp(); if (n) log(`语音临时目录：清掉 ${n} 个陈年 WAV`) } catch { /* ignore */ }

  const safe = String(tag).replace(/[^\w.-]/g, '_').slice(0, 60)
  const dst = join(TMP_DIR, `${safe}.wav`)

  // ── V2 加密兜底：微信 4.x 的媒体 .dat 可能是 V2 容器，先剥壳 ──
  let feed = srcPath
  let note = ''
  if (isV2(srcPath)) {
    log(`语音解码：源文件是 V2 加密容器（${srcPath.split(/[\\/]/).pop()}），先用图片链路剥壳…`)
    const bare = join(TMP_DIR, `${safe}.bare.bin`)
    try {
      execFileSync(PY, [IMAGE_SCRIPT, srcPath, bare], { windowsHide: true, timeout: 120_000, encoding: 'utf8', env: PY_ENV })
      if (existsSync(bare) && statSync(bare).size > 256) { feed = bare; note = 'V2剥壳后' }
      else { log('语音解码：V2 剥壳没产出内容（密钥可能失效）') }
    } catch (e) {
      log('语音解码：V2 剥壳失败（图片密钥可能未缓存/已轮换）：' + String(e?.message || e).slice(0, 120))
    }
    // 注意：图片脚本会**先写文件、再以非 0 退出**（格式认不出时），所以这里必须单独兜底清理，
    // 不能只靠下面 feed!==srcPath 那一处 —— 否则会漏下一个 .bare.bin（实测踩到）。
    if (feed !== bare) { try { if (existsSync(bare)) unlinkSync(bare) } catch { /* ignore */ } }
  }

  let r = runDecoder(feed, dst)
  // 剥壳后的裸流常常缺 #!SILK_V3 头 → 用 --force-silk 再试一次
  if (!r.ok && (note || feed !== srcPath)) {
    const r2 = runDecoder(feed, dst, ['--force-silk'])
    if (r2.ok) r = r2
  }
  if (!r.ok) {
    log(`语音解码失败（源 ${srcPath.split(/[\\/]/).pop()}）：` + String(r.out).replace(/\s+/g, ' ').slice(0, 300))
    try { if (existsSync(dst)) unlinkSync(dst) } catch { /* ignore */ }
    if (feed !== srcPath) { try { if (existsSync(feed)) unlinkSync(feed) } catch { /* ignore */ } }
    return null
  }
  // 剥壳中间文件用完即删（规矩：临时文件不留下）
  if (feed !== srcPath) { try { if (existsSync(feed)) unlinkSync(feed) } catch { /* ignore */ } }

  const size = statSync(dst).size
  log(`语音解码成功${note ? '（' + note + '）' : ''}：${srcPath.split(/[\\/]/).pop()} → ${dst}（${Math.round(size / 1024)}KB）`)
  return { wav: dst, note }
}

/** 用完删掉（插件转写完会调；这里给桥侧兜底用） */
export function cleanup(paths) {
  for (const p of [].concat(paths || [])) {
    try { if (p && existsSync(p)) unlinkSync(p) } catch { /* ignore */ }
  }
}

/** 清空整个临时目录（排查时手动用） */
export function purgeTemp() {
  try { rmSync(TMP_DIR, { recursive: true, force: true }); return true } catch { return false }
}

export const paths = { SCRIPT, IMAGE_SCRIPT, TMP_DIR, PY }
