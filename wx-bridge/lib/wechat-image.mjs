/**
 * 微信聊天图片：本地解密（给识图用）。
 *
 * 背景（我们一步步查出来的）：
 *  ① 微信收到的图片落盘为 **V2 加密** 的 .dat：
 *     <数据目录>\msg\attach\<md5(群id)>\<年-月>\Img\<md5>[_t|_h].dat
 *  ② 消息回调（type 3）只给 md5/fileid，**没有任何下载地址**；
 *     原图常常压根没下载（DB 里 status=0）。
 *  ③ V2 的 AES 密钥**不在文件里**，只在微信进程内存中（每份安装独立），
 *     而且需要客户端真的解密过一次图片才会出现（我们这次是趁"图片和视频"查看器开着扫到的）。
 *  ④ hook 自带的 /Decode_Pic 调的内部函数偏移对这个构建失效，所以这里自己解。
 *
 * 本模块负责：定位 .dat → 调 Python 解密到临时目录 → 返回路径（用完由调用方删）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE_DIR = join(HERE, '..')
const PY = process.env.PYTHON_EXE || 'D:\\Python311\\python.exe'
const SCRIPT = join(BRIDGE_DIR, 'decode-wechat-image.py')
const KEY_CACHE = join(BRIDGE_DIR, '..', 'data', 'wechat-image-key.json')
const TMP_DIR = join(BRIDGE_DIR, '..', 'data', 'wechat-image-tmp')

/** 数据根目录（含 msg\attach）。默认值可用环境变量覆盖；也可从 DB 的 PRAGMA 反推。 */
let cachedRoot = process.env.WECHAT_DATA_ROOT || ''

export function md5(s) {
  return createHash('md5').update(String(s)).digest('hex')
}

/** 从微信数据库反推数据目录（PRAGMA database_list 给出真实路径） */
/** 文件系统兜底：直接找 <盘>:\Users\<用户>\{Documents\,}xwechat_files\wxid_*
 *  为什么需要：这套构建的 /QueryDB/execute 常常是坏的（contact.db 打不开），
 *  靠 PRAGMA 反推数据根会失败 → findLatestDat 直接返回 null → 图片永远「取不到」。
 *  实测 .dat 明明落在磁盘上（14:05 的两张 71KB），只是没找到目录。 */
function scanDataRoots(selfWxid = '') {
  const bases = []
  const add = (p) => { if (p && !bases.includes(p)) bases.push(p) }
  const up = process.env.USERPROFILE || ''
  if (up) {
    add(join(up, 'Documents', 'xwechat_files'))
    add(join(up, 'xwechat_files'))
  }
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    const usersDir = drive + '\\Users'
    try {
      for (const u of readdirSync(usersDir)) {
        add(join(usersDir, u, 'Documents', 'xwechat_files'))
        add(join(usersDir, u, 'xwechat_files'))
      }
    } catch { /* 该盘没有 Users */ }
    add(drive + '\\xwechat_files')
  }
  const out = []
  for (const b of bases) {
    try {
      for (const d of readdirSync(b)) {
        const p = join(b, d)
        if (!/^wxid_/i.test(d) && !/^[0-9a-f]{6,}_[0-9a-z]{4}$/i.test(d)) continue
        if (!existsSync(join(p, 'msg', 'attach'))) continue
        out.push(p)
      }
    } catch { /* 目录不存在 */ }
  }
  // 优先自己 wxid 那个目录
  if (selfWxid) out.sort((a, b) => (b.includes(selfWxid) ? 1 : 0) - (a.includes(selfWxid) ? 1 : 0))
  return out
}

/** 数据根目录（含 msg\attach）。顺序：缓存 → 环境变量 → QueryDB 反推 → 文件系统扫描 */
export async function resolveDataRoot(api, selfWxid = '') {
  if (cachedRoot && existsSync(cachedRoot)) return cachedRoot
  if (process.env.WECHAT_DATA_ROOT && existsSync(process.env.WECHAT_DATA_ROOT)) {
    cachedRoot = process.env.WECHAT_DATA_ROOT
    return cachedRoot
  }
  try {
    const r = await api('/QueryDB/execute', { optDbName: 'contact.db', SQL: 'PRAGMA database_list' }, 'POST', 20000)
    const file = r?.data?.[0]?.file || ''
    // …\xwechat_files\wxid_xxx\db_storage\contact\contact.db → 上溯到 wxid_xxx 那一层
    const m = String(file).match(/^(.*[\\/]xwechat_files[\\/][^\\/]+)[\\/]/i)
    if (m) { cachedRoot = m[1]; return cachedRoot }
  } catch { /* QueryDB 坏了，走下面的兜底 */ }
  // ★ 兜底：直接扫盘找 xwechat_files\wxid_*
  const hits = scanDataRoots(selfWxid)
  if (hits.length) {
    cachedRoot = hits[0]
    return cachedRoot
  }
  return ''
}

/** 找某个会话的加密图片文件。nearTs（消息时间戳）优先：取 mtime 最接近它的那个 */
export function findLatestDat(root, roomId, { maxAgeMs = 30 * 60_000, nearTs = 0, toleranceMs = 30 * 60_000, minBytes = 1024 } = {}) {
  if (!root) return null
  const chatHash = md5(roomId)
  const base = join(root, 'msg', 'attach', chatHash)
  if (!existsSync(base)) return null
  // 一张图在磁盘上有三个变体：原图（无后缀）/ _h（高清预览）/ _t（缩略图，通常只有 8KB）。
  // 以前这里只按 mtime 挑 → 经常挑中 _t 缩略图 → 视觉模型"看不清"（用户实测反馈）。
  // 现在按 md5 基名分组，每组优先取清晰度高的：原图 > _h > _t；再在组间按时间挑。
  const rank = (n) => (n.endsWith('_t.dat') ? 0 : (n.endsWith('_h.dat') ? 1 : 2))
  const groups = new Map()
  for (const month of readdirSync(base)) {
    const imgDir = join(base, month, 'Img')
    if (!existsSync(imgDir)) continue
    for (const f of readdirSync(imgDir)) {
      if (!f.endsWith('.dat')) continue
      const p = join(imgDir, f)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.size < minBytes) continue
      const key = f.replace(/_[th]\.dat$/, '.dat')       // 同一张图的三个变体归到一组
      const cand = { path: p, mtime: st.mtimeMs, size: st.size, name: f, rank: rank(f) }
      const cur = groups.get(key)
      if (!cur || cand.rank > cur.rank || (cand.rank === cur.rank && cand.size > cur.size)) groups.set(key, cand)
    }
  }
  const out = [...groups.values()]
  if (!out.length) return null
  // 1) 有消息时间戳 -> 挑 mtime 最接近的（图片落盘时间 ~ 收到时间）
  if (nearTs) {
    const best = out.reduce((a, b) => (Math.abs(b.mtime - nearTs) < Math.abs(a.mtime - nearTs) ? b : a))
    if (Math.abs(best.mtime - nearTs) <= toleranceMs) return best
  }
  // 2) 否则退化成"最近的，且足够新"
  out.sort((a, b) => b.mtime - a.mtime)
  const newest = out[0]
  if (Date.now() - newest.mtime > maxAgeMs) return null
  return newest
}
/** 返回同一张图的【多个候选】，按「能解出正常画面」的可靠性排序：
 *    _h（高清预览 JPCG，通常完整）> _t（缩略图 JPEG，完整但小）> 原图（WXGF/HEVC，常不完整 → 花屏）
 *  为什么这样排：实测原图 .dat 只有 45~70KB（还在下/不完整），
 *  解出来是纯白或纯绿的花屏；而 _t/_h 是完整的小 JPEG，反而能看清。
 *  调用方依次解密，用「亮度」判断这张能不能用（255 = 纯白 = 白图）。
 */
export function findDatCandidates(root, roomId, { maxAgeMs = 30 * 60_000, nearTs = 0, toleranceMs = 30 * 60_000, minBytes = 1024 } = {}) {
  if (!root) return []
  const chatHash = md5(roomId)
  const base = join(root, 'msg', 'attach', chatHash)
  if (!existsSync(base)) return []
  const byKey = new Map()          // md5 基名 → { t, h, o }
  for (const month of readdirSync(base)) {
    const imgDir = join(base, month, 'Img')
    if (!existsSync(imgDir)) continue
    for (const f of readdirSync(imgDir)) {
      if (!f.endsWith('.dat')) continue
      const p = join(imgDir, f)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.size < minBytes) continue
      const key = f.replace(/_[th]\.dat$/, '.dat')
      const slot = f.endsWith('_t.dat') ? 't' : (f.endsWith('_h.dat') ? 'h' : 'o')
      const cur = byKey.get(key) || {}
      const prev = cur[slot]
      if (!prev || st.mtimeMs > prev.mtimeMs) cur[slot] = { path: p, mtimeMs: st.mtimeMs, size: st.size, name: f }
      byKey.set(key, cur)
    }
  }
  // 每个基名一组；组间按「离消息时间最近」排序
  const groups = [...byKey.entries()].map(([key, v]) => ({ key, ...v, best: Math.max(v.t?.mtimeMs || 0, v.h?.mtimeMs || 0, v.o?.mtimeMs || 0) }))
  groups.sort((a, b) => (nearTs ? Math.abs(a.best - nearTs) - Math.abs(b.best - nearTs) : b.best - a.best))
  const now = Date.now()
  // ★ 有 nearTs 时只认「3 分钟内」的组，避免拿错成邻居的图（描述错图比模糊更糟）
  // ★ 有 nearTs 时优先「3 分钟内」的组，避免拿错邻居的图
  let kept = nearTs
    ? groups.filter((g) => Math.abs(g.best - nearTs) <= 180_000)
    : groups.filter((g) => now - g.best <= maxAgeMs)
  // 兜底：窗口内没有（图晚到/时间戳偏差）→ 只取「最接近」的那一组，绝不混入其他图
  if (!kept.length && nearTs) kept = groups.filter((g) => Math.abs(g.best - nearTs) <= 30 * 60_000).slice(0, 1)
  const out = []
    // ★ 微信把「原图」加密缓存在 cache\<年-月>\Message\<群md5>\Bubble\<图md5>_b.dat
    //   实测：456KB 的那种解密后是 1079x809 的真 JPEG（不是 HEVC，不会花屏）→ 最优来源
    function bubbleBigPath(key) {
      const md5hex = key.replace(/\.dat$/, "")
      const roots = []
      const cacheDir = join(root, "cache")
      if (existsSync(cacheDir)) {
        for (const mon of readdirSync(cacheDir)) roots.push(join(cacheDir, mon, "Message", chatHash, "Bubble"))
      }
      for (const d of roots) {
        try {
          for (const f of readdirSync(d)) {
            if (f === md5hex + "_b.dat") {
              const p = join(d, f)
              const st = statSync(p)
              return { path: p, mtimeMs: st.mtimeMs, size: st.size, name: f }
            }
          }
        } catch { /* ignore */ }
      }
      return null
    }
  for (const g of kept.slice(0, 6)) {          // 最多试 6 组，别太慢
    // ★ 用户指定优先级：原图 > 高清预览 > 缩略图
    //   但原图常不完整（解出来花屏），调用方会用「霓虹占比」检测后降级
    // ★ 实测证据：XML 的 hdlength(195KB) == _h.dat 大小；length(90KB) == 无后缀 .dat
    //   → _h 才是真正的原图（高清），无后缀那个是 HEVC 中图（解码易花屏）
    //   顺序：_h 高清 > 原图(中图) > _t 缩略图
    // ★ 组内按【文件大小】降序：越大通常越清晰
    //   实测：456KB Bubble = 1079x809 真高清；195KB _h 也是好图；90KB 中图易花屏；7~21KB _t 是缩略
    const pool = []
    const bb = bubbleBigPath(g.key)
    if (bb) pool.push({ ...bb, __src: 'cache 原图(Bubble)' })
    if (g.h) pool.push({ ...g.h, __src: '_h 高清' })
    if (g.o) pool.push({ ...g.o, __src: '原图(中图)' })
    if (g.t) pool.push({ ...g.t, __src: '_t 缩略图' })
    // ★ 先试「普通 JPEG」源（Bubble / _h），按大小降序；再试 HEVC 中图；最后缩略图
    //   为什么：HEVC 中图解码经常花屏，白花 2~4 秒；JPEG 源一解就能用
    const jpegPool = pool.filter((c) => c.__src !== '原图(中图)' && c.__src !== '_t 缩略图')
    const otherPool = pool.filter((c) => c.__src === '原图(中图)' || c.__src === '_t 缩略图')
    jpegPool.sort((a, b) => b.size - a.size)
    otherPool.sort((a, b) => b.size - a.size)
    for (const c of [...jpegPool, ...otherPool]) out.push({ ...c, label: c.__src })
  }
  return out
}


/** 解密一个 .dat 到临时目录，返回输出路径；失败返回 null */
/** 解密一个 .dat 到临时目录，返回 { path, brightness }；失败返回 null
 *  brightness：解密结果的平均亮度（255 = 纯白 = 白图/花屏，不能拿去识图）
 */
export function decryptDat(srcPath, { tag = 'img' } = {}) {
  if (!existsSync(SCRIPT)) return null
  mkdirSync(TMP_DIR, { recursive: true })
  const dst = join(TMP_DIR, `${tag}-${Date.now()}.jpg`)
  let stdout = ''
  try {
    stdout = execFileSync(PY, [SCRIPT, srcPath, dst], { windowsHide: true, timeout: 90_000, encoding: 'utf8' }) || ''
  } catch (e) {
    stdout = String(e?.stdout || '')
  }
  const m = /亮度=(\d+)/.exec(stdout)
  const brightness = m ? Number(m[1]) : -1
  const n2 = /霓虹=([\d.]+)/.exec(stdout)
  const neon = n2 ? Number(n2[1]) : -1
  const dm = /尺寸=(\d+)x(\d+)/.exec(stdout)
  const dims = dm ? { w: Number(dm[1]), h: Number(dm[2]) } : null
  if (existsSync(dst) && statSync(dst).size > 512) return { path: dst, brightness, neon, dims, stdout }
  const alt = dst.replace(/\.jpg$/, '')
  if (existsSync(alt)) return { path: alt, brightness, neon, dims, stdout }
  return null
}

/** 密钥是否已缓存 */
export function hasKey() {
  try {
    const j = JSON.parse(readFileSync(KEY_CACHE, 'utf8'))
    return !!j.image_aes_key
  } catch {
    return false
  }
}

/** 主动扫一次内存找密钥（需要客户端最近解密过图片） */
export function scanKey() {
  try {
    const out = execFileSync(PY, [SCRIPT, '--find-key'], { windowsHide: true, timeout: 300_000, encoding: 'utf8' })
    return /结果:\s*([0-9a-zA-Z]{16})/.test(out) || /★ 找到 AES 密钥/.test(out)
  } catch {
    return false
  }
}

/** 用完删掉临时文件（用户要求：识别完就删，别占地方） */
export function cleanup(paths) {
  for (const p of [].concat(paths || [])) {
    try { if (p && existsSync(p)) unlinkSync(p) } catch { /* ignore */ }
  }
}

export const paths = { SCRIPT, KEY_CACHE, TMP_DIR, PY }
