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
const PY = process.env.PYTHON_EXE || 'python'
const SCRIPT = join(BRIDGE_DIR, 'decode-wechat-image.py')
const KEY_CACHE = join(BRIDGE_DIR, '..', 'data', 'wechat-image-key.json')
const TMP_DIR = join(BRIDGE_DIR, '..', 'data', 'wechat-image-tmp')

/** 数据根目录（含 msg\attach）。默认值可用环境变量覆盖；也可从 DB 的 PRAGMA 反推。 */
let cachedRoot = process.env.WECHAT_DATA_ROOT || ''

export function md5(s) {
  return createHash('md5').update(String(s)).digest('hex')
}

/** 从微信数据库反推数据目录（PRAGMA database_list 给出真实路径） */
export async function resolveDataRoot(api) {
  if (cachedRoot && existsSync(cachedRoot)) return cachedRoot
  try {
    const r = await api('/QueryDB/execute', { optDbName: 'contact.db', SQL: 'PRAGMA database_list' }, 'POST', 20000)
    const file = r?.data?.[0]?.file || ''
    // …\xwechat_files\wxid_xxx\db_storage\contact\contact.db → 上溯到 wxid_xxx 那一层
    const m = String(file).match(/^(.*[\\/]xwechat_files[\\/][^\\/]+)[\\/]/i)
    if (m) {
      cachedRoot = m[1]
      return cachedRoot
    }
  } catch { /* ignore */ }
  return cachedRoot
}

/** 找某个会话的加密图片文件。nearTs（消息时间戳）优先：取 mtime 最接近它的那个 */
export function findLatestDat(root, roomId, { maxAgeMs = 10 * 60_000, nearTs = 0, toleranceMs = 6 * 60_000, minBytes = 1024 } = {}) {
  if (!root) return null
  const chatHash = md5(roomId)
  const base = join(root, 'msg', 'attach', chatHash)
  if (!existsSync(base)) return null
  const out = []
  for (const month of readdirSync(base)) {
    const imgDir = join(base, month, 'Img')
    if (!existsSync(imgDir)) continue
    for (const f of readdirSync(imgDir)) {
      if (!f.endsWith('.dat')) continue
      const p = join(imgDir, f)
      try {
        const st = statSync(p)
        if (st.size < minBytes) continue
        out.push({ path: p, mtime: st.mtimeMs, size: st.size, name: f })
      } catch { /* ignore */ }
    }
  }
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

/** 解密一个 .dat 到临时目录，返回输出路径；失败返回 null */
export function decryptDat(srcPath, { tag = 'img' } = {}) {
  if (!existsSync(SCRIPT)) return null
  mkdirSync(TMP_DIR, { recursive: true })
  const dst = join(TMP_DIR, `${tag}-${Date.now()}.jpg`)
  try {
    const out = execFileSync(PY, [SCRIPT, srcPath, dst], { timeout: 60_000, encoding: 'utf8' })
    if (existsSync(dst) && statSync(dst).size > 512) return dst
    // 有些格式（WXGF）解出来不是 jpg 后缀，脚本会按实际格式写；扫一下同名前缀
    const alt = dst.replace(/\.jpg$/, '')
    if (existsSync(alt)) return alt
    return null
  } catch {
    return null
  }
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
    const out = execFileSync(PY, [SCRIPT, '--find-key'], { timeout: 300_000, encoding: 'utf8' })
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
