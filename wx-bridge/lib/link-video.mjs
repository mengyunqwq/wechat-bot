/**
 * 链接视频 —— 群里分享的**视频链接**（抖音 / B站 / 小红书 / 微博 / TikTok / X）→ 下载 → 复用视频管线。
 *
 * 为什么单独一个模块（而不是塞进 wechat-video.mjs）：
 *   wechat-video.mjs 管的是**微信自己的视频消息（type 43）**——文件在微信数据目录里，找出来就行。
 *   这里是**外部平台的链接**——得先下载。两者下游完全一样：都交给 `probeVideo()` 抽帧拼联系表 + 抽音轨。
 *   所以本模块**只负责"链接 → 本地 mp4"**，抽帧/拼表/音轨一律复用现成的 probeVideo（不重造轮子）。
 *
 * 关键前提（实测，别凭猜改）：
 *  ① `yt-dlp` 已装（`python -m yt_dlp`），支持 抖音/B站/小红书/微博/TikTok/X；**快手不支持**。
 *  ② **本机没有系统 ffmpeg** ✗ → 必须用 `imageio_ffmpeg.get_ffmpeg_exe()` 拿路径，
 *     并显式传给 yt-dlp 的 `--ffmpeg-location`，否则 `bv*+ba` 的音视频**合并会失败**（拿到没声的视频）。
 *  ③ 抖音**需要新鲜 cookies**（yt-dlp 报 "Fresh cookies (not necessarily logged in) are needed"）——
 *     没有 cookies 时**优雅失败**（返回 null + 日志），绝不抛错。cookies 参数留着，需要时传 Netscape cookies.txt。
 *  ④ 时长/大小/超时三道闸都在 yt-dlp 参数里（`--match-filter` / `--max-filesize` / 子进程 timeout），
 *     超了就是"不下载"，不是"下载完再判断" —— 省流量、省时间。
 *  ⑤ 产物全部落在 `<bridge>/../data/link-video/<随机tag>/` 一个独立子目录里，
 *     删的时候整目录 `rmSync` 一次干净（**不会漏下 yt-dlp 的 .part/.info.json/.fNNN.m4a 残留**）。
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeVideo } from './wechat-video.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE_DIR = join(HERE, '..')
const LINK_TMP = join(BRIDGE_DIR, '..', 'data', 'link-video')   // 与 wechat-image.mjs 的 data/ 同级
const PY = process.env.PYTHON_EXE || 'D:\\Python311\\python.exe'
const PY_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8' }

export const paths = { LINK_TMP, PY }

// ══════════════════════════════════════════════════════════════════════
//  ① 链接识别：host 白名单（**绝不"见 URL 就下"**）
// ══════════════════════════════════════════════════════════════════════

/**
 * 受支持的站点 → host 白名单。
 * host 匹配规则：完全相等，或 `xxx.<host>`（域名后缀，带点边界 —— `evildouyin.com` 不会误命中）。
 */
export const SITE_HOSTS = [
  { site: 'douyin', hosts: ['douyin.com', 'iesdouyin.com', 'v.douyin.com'] },
  { site: 'bilibili', hosts: ['bilibili.com', 'b23.tv', 'bili2233.cn'] },
  { site: 'xiaohongshu', hosts: ['xiaohongshu.com', 'xhslink.com'] },
  { site: 'weibo', hosts: ['weibo.com', 'weibo.cn', 'm.weibo.cn', 't.cn'] },
  { site: 'tiktok', hosts: ['tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com'] },
  { site: 'twitter', hosts: ['twitter.com', 'x.com', 't.co'] },
]

/** 已知的**视频平台但本管线不支持**（用于给出"不支持"的日志，而不是静默忽略） */
export const UNSUPPORTED_HOSTS = [
  { site: 'kuaishou', hosts: ['kuaishou.com', 'gifshow.com', 'chenzhongtech.com', 'kwai.com'] },
  { site: 'youtube', hosts: ['youtube.com', 'youtu.be'] },   // yt-dlp 支持，但这台机器网络不通 ✗
]

/** 站点 id → 给群里看的中文名 */
const SITE_LABELS = {
  douyin: '抖音', bilibili: 'B站', xiaohongshu: '小红书',
  weibo: '微博', tiktok: 'TikTok', twitter: 'X', kuaishou: '快手', youtube: 'YouTube',
}
export function siteLabel(site) { return SITE_LABELS[String(site || '')] || String(site || '链接') }

/** 从一个 host 找受支持站点 id（找不到返回 ''） */
export function siteOfHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '')
  if (!h) return ''
  for (const s of SITE_HOSTS) {
    for (const dom of s.hosts) if (h === dom || h.endsWith('.' + dom)) return s.site
  }
  return ''
}

/** 从一个 host 找"已知但不支持"的站点 id（找不到返回 ''） */
export function unsupportedSiteOfHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '')
  if (!h) return ''
  for (const s of UNSUPPORTED_HOSTS) {
    for (const dom of s.hosts) if (h === dom || h.endsWith('.' + dom)) return s.site
  }
  return ''
}

/** 取 host（容错：没有协议就补 https://；中文/非法 URL 返回 ''） */
export function hostOf(url) {
  const u = String(url || '').trim()
  if (!u) return ''
  try { return new URL(/^https?:/i.test(u) ? u : 'https://' + u).hostname.toLowerCase() } catch { return '' }
}

/** 补全协议 + 去掉尾巴上的中文标点（群里粘贴的链接常带 "，" "。" "）"） */
export function normalizeUrl(raw) {
  let u = String(raw || '').trim()
  u = u.replace(/[）)】\]>」，。、；;！!？?'"]+$/g, '')
  if (!/^https?:/i.test(u)) u = 'https://' + u
  return u
}

/**
 * 从一段文本里抠出所有候选 URL。
 * 覆盖三种真实来源（都要能提取 ✓）：
 *   ① 纯文本里的裸 URL：`https://v.douyin.com/xxx/`
 *   ② 用户手打的不带协议的裸域名：`b23.tv/xxxx`
 *   ③ 链接卡片（type 49/42）XML 里的 `<url>https://…</url>`（`&amp;` 先还原成 `&`）
 */
export function extractUrls(text) {
  const s = String(text || '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'")
  const out = []
  const seen = new Set()
  const push = (raw) => {
    const u = normalizeUrl(raw)
    if (!u || seen.has(u)) return
    seen.add(u)
    out.push(u)
  }
  // ①/③ 带协议的
  for (const m of s.matchAll(/https?:\/\/[^\s<>"'`）)】，。、；;]+/gi)) push(m[0])
  // ② 裸域名（只认常见的顶级域，避免把 "index.js" 之类当链接）
  for (const m of s.matchAll(/(?:^|[\s（(【[，,、:：])((?:[a-z0-9-]+\.)+(?:com|cn|net|org|tv|me|be|cc|io|co)(?:\/[^\s<>"'`）)】，。、；;]*)?)/gi)) {
    push(m[1])
  }
  return out
}

/**
 * 从一段文本里找出**受支持的视频链接**。
 *
 * @param {string} text 消息文本 / 链接卡片 XML（两者都吃 ✓）
 * @returns {{url:string, site:string, host:string}|null} 找到就返回；没有受支持链接返回 null
 */
export function detectVideoLink(text) {
  for (const url of extractUrls(text)) {
    const host = hostOf(url)
    const site = siteOfHost(host)
    if (site) return { url, site, host }
  }
  return null
}

/**
 * 找出"已知的视频平台但本管线不支持"的链接（**只用于日志**：让"不支持"这件事看得见）。
 * 不支持的站**不会被下载** —— detectVideoLink 已经返回 null 了。
 * @returns {{url:string, site:string, host:string}|null}
 */
export function detectUnsupportedLink(text) {
  for (const url of extractUrls(text)) {
    const host = hostOf(url)
    const site = unsupportedSiteOfHost(host)
    if (site) return { url, site, host }
  }
  return null
}

// ══════════════════════════════════════════════════════════════════════
//  ② yt-dlp 下载
// ══════════════════════════════════════════════════════════════════════

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.flv', '.ts'])

let ffmpegProbed = false
let ffmpegPath = ''

/**
 * 拿到 ffmpeg 可执行文件路径（**必须传给 yt-dlp 的 --ffmpeg-location**，否则合并音视频会失败 ✗）。
 * 顺序：env FFMPEG_EXE / FFMPEG_LOCATION → imageio_ffmpeg.get_ffmpeg_exe() → ''（交给 yt-dlp 自己找 PATH）
 */
export function ffmpegExe() {
  if (ffmpegProbed) return ffmpegPath
  ffmpegProbed = true
  for (const k of ['FFMPEG_EXE', 'FFMPEG_LOCATION']) {
    const v = process.env[k]
    if (v && existsSync(v)) { ffmpegPath = v; return ffmpegPath }
  }
  try {
    const out = execFileSync(PY, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'],
      { windowsHide: true, encoding: 'utf8', timeout: 30_000, env: PY_ENV })
    const p = String(out || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
    if (p && existsSync(p)) ffmpegPath = p
  } catch { /* 拿不到就不传，交给 yt-dlp 自己找 */ }
  return ffmpegPath
}

/** 目录里的文件（不递归），出错返回 [] */
function listFiles(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

/** 清掉一次下载的整个临时目录（mp4/音轨残留/.info.json/.part 一次全没） */
export function cleanupLinkVideo(dirOrFile) {
  const p = String(dirOrFile || '')
  if (!p) return false
  try {
    // 传进来的既可能是目录（fetchLinkVideo 返回的 tmpDir），也可能是文件
    const target = existsSync(p) && statSync(p).isDirectory() ? p : dirname(p)
    if (!existsSync(target)) return true                     // 已经没了 = 干净
    if (!target.startsWith(LINK_TMP)) return false           // 安全阀：只删自己的临时目录
    rmSync(target, { recursive: true, force: true })
    return !existsSync(target)
  } catch { return false }
}

/**
 * 删临时目录（带重试）——**Windows 上这一步会偶发失败**（实测踩到）：
 * yt-dlp 刚退出时那个 34MB 的 mp4 句柄可能还被占着（杀软扫描/延迟关闭），
 * `rmSync` 抛 EBUSY/EPERM → 目录留在盘上。所以这里退避重试几次，
 * 真删不掉也**不算失败**：`pruneLinkVideoTemp()` 1 小时后会兜底清掉（服务端还有定时兜底）。
 */
export async function removeLinkVideoDir(dir) {
  const p = String(dir || '')
  if (!p) return true
  for (let i = 0; i < 4; i++) {
    if (cleanupLinkVideo(p) && !existsSync(p)) return true
    await new Promise((r) => setTimeout(r, 300 + i * 400))
  }
  return !existsSync(p)
}

/** 清理陈年临时产物（插件正常会删；插件崩了/桥被强杀时靠这个兜底） */
export function pruneLinkVideoTemp(maxAgeMs = 60 * 60_000) {
  let n = 0
  try {
    if (!existsSync(LINK_TMP)) return 0
    for (const name of listFiles(LINK_TMP)) {
      const p = join(LINK_TMP, name)
      try {
        if (Date.now() - statSync(p).mtimeMs > maxAgeMs) { rmSync(p, { recursive: true, force: true }); n++ }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return n
}

/** 清空整个链接视频临时目录（排查时手动用） */
export function purgeLinkVideoTemp() {
  try { rmSync(LINK_TMP, { recursive: true, force: true }); return true } catch { return false }
}

/**
 * 用 yt-dlp 把一个受支持的视频链接下到本地临时目录。
 *
 * 参数（都在 yt-dlp 命令行里，超限就是"不下载"）：
 *   `-f "bv*+ba/b"`           带音轨的完整视频（抽帧和音轨都要用 ✓）；没有分离流时退回单文件 `b`
 *   `--merge-output-format mp4`  合并成 mp4
 *   `--ffmpeg-location <path>`   **关键**：本机没有系统 ffmpeg，不传就合并不了
 *   `--no-playlist`            只下这一条
 *   `--match-filter "duration < N"`  时长上限（默认 300s）
 *   `--max-filesize <N>M`      大小上限（默认 80MB）
 *   子进程 timeout              超时（默认 120s，到点直接杀）
 *
 * @param {string} url 受支持的视频链接（短链也行，重定向交给 yt-dlp）
 * @param {object} [o]
 * @param {number} [o.maxSeconds=300] 时长上限（秒）
 * @param {number} [o.maxMB=80]       大小上限（MB）
 * @param {number} [o.timeoutMs=120000] 子进程超时
 * @param {string} [o.cookies='']     可选：Netscape 格式 cookies.txt 路径（抖音/小红书可能要登录态）
 * @param {(s:string)=>void} [o.log]
 * @returns {Promise<{file:string,title:string,durationSec:number,site:string,host:string,
 *   resolvedUrl:string,tmpDir:string,bytes:number}|null>} 失败**只记日志，返回 null，不抛错**
 */
export function fetchLinkVideo(url, {
  maxSeconds = 300, maxMB = 80, timeoutMs = 120_000, cookies = '', log = () => {},
} = {}) {
  const tag = '链接视频'
  return new Promise((resolve) => {
    const raw = String(url || '').trim()
    if (!raw) { log(`${tag}：没有链接 → 放弃`); resolve(null); return }
    const host = hostOf(raw)
    const site = siteOfHost(host)
    if (!site) {
      const un = unsupportedSiteOfHost(host)
      log(un
        ? `${tag}：不支持的站点（${siteLabel(un)} ${host}）→ 放弃`
        : `${tag}：站点不在白名单（${host || '无法解析'}）→ 放弃`)
      resolve(null)
      return
    }
    const target = normalizeUrl(raw)

    // 每次下载一个独立子目录：删的时候整目录 rm -rf，绝不留下 .part/.info.json/.fNNN.m4a 残留
    const tmpDir = join(LINK_TMP, `${site}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    try {
      mkdirSync(tmpDir, { recursive: true })
      const n = pruneLinkVideoTemp()
      if (n) log(`${tag}：清掉 ${n} 个陈年临时目录`)
    } catch (e) {
      log(`${tag}：建临时目录失败：${String(e?.message || e).slice(0, 120)}`)
      resolve(null)
      return
    }

    const ff = ffmpegExe()
    const args = [
      '-m', 'yt_dlp',
      '-f', 'bv*+ba/b',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--no-warnings', '--quiet', '--no-progress',
      '--no-mtime',
      '--match-filter', `duration < ${Math.max(1, Math.floor(Number(maxSeconds) || 300))}`,
      '--max-filesize', `${Math.max(1, Math.floor(Number(maxMB) || 80))}M`,
      '--socket-timeout', '20',
      '--retries', '3',
      '--fragment-retries', '3',
      '--write-info-json',
      '-o', join(tmpDir, '%(id)s.%(ext)s'),
    ]
    if (ff) args.push('--ffmpeg-location', ff)
    if (cookies && existsSync(cookies)) args.push('--cookies', cookies)
    args.push(target)

    const started = Date.now()
    log(`${tag}：${siteLabel(site)} 链接开始下载（上限 ${maxSeconds}s / ${maxMB}MB / ${Math.round(timeoutMs / 1000)}s 超时`
      + `${ff ? '' : '；⚠️ 没拿到 ffmpeg 路径'}${cookies && existsSync(cookies) ? '；带 cookies' : ''}）：${target}`)

    execFile(PY, args, {
      // 下限 1s（只为拦住"0/负数"这种误传；正常调用是 120s）
      timeout: Math.max(1_000, Number(timeoutMs) || 120_000),
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      env: PY_ENV,
    }, (err, stdout, stderr) => {
      const took = Math.round((Date.now() - started) / 1000)
      const out = `${stdout || ''}${stderr || ''}`.replace(/\s+/g, ' ').trim()
      if (err) {
        // 超时 / 被 --match-filter 挡掉 / 网络失败 / 需要 cookies —— 都走这里
        const killed = err.killed || err.signal
        log(`${tag}：下载未完成（${took}s${killed ? '，超时被杀' : ''}）：`
          + (out || String(err?.message || err)).slice(0, 300))
      }
      const hit = pickDownloaded(tmpDir)
      if (!hit) {
        log(`${tag}：临时目录里没有可用的视频文件（时长超限/大小超限/需要 cookies/网络失败都可能）→ 放弃`)
        // 失败路径同样要清（下到一半的 .part/纯音轨也一起删）；带重试，删不掉交给 1 小时后的兜底
        void removeLinkVideoDir(tmpDir).then((ok) => {
          if (!ok) log(`${tag}：⚠️ 失败路径的临时目录没删掉（${tmpDir}）—— 已交给 pruneLinkVideoTemp 兜底`)
        })
        resolve(null)
        return
      }
      const info = readInfoJson(tmpDir)
      const title = String(info?.title || info?.fulltitle || '').slice(0, 120)
      const durationSec = Math.round(Number(info?.duration) || 0)
      const resolvedUrl = String(info?.webpage_url || info?.original_url || target)
      log(`${tag}：下载完成（${Math.round(hit.bytes / 1024)}KB，${took}s）`
        + `｜${title ? `标题「${title}」` : '无标题'}${durationSec ? `｜时长 ${durationSec}s` : ''}`
        + `｜${siteLabel(site)}｜最终地址 ${resolvedUrl}`)
      resolve({
        file: hit.path, title, durationSec, site, host,
        resolvedUrl, tmpDir, bytes: hit.bytes,
      })
    })
  })
}

/** 从临时目录里挑出"真正的视频文件"（排除 info.json / .part / 纯音频 .m4a） */
function pickDownloaded(dir) {
  const cands = []
  for (const name of listFiles(dir)) {
    if (/\.info\.json$/i.test(name) || /\.(part|ytdl|temp|json|jpg|jpeg|png|webp|vtt|srt|description)$/i.test(name)) continue
    const ext = extname(name).toLowerCase()
    if (!VIDEO_EXT.has(ext)) continue
    const p = join(dir, name)
    try {
      const st = statSync(p)
      if (st.isFile() && st.size > 4096) {
        // 合并后的成品是 `<id>.mp4`；`<id>.f100026.mp4` 是**只有画面没声音**的中间产物 → 排后面
        cands.push({ path: p, bytes: st.size, merged: /\.f\d+\./i.test(name) ? 0 : 1 })
      }
    } catch { /* ignore */ }
  }
  if (!cands.length) return null
  cands.sort((a, b) => (b.merged - a.merged) || (b.bytes - a.bytes))
  return cands[0]
}

/** 读 yt-dlp 写的 info.json（拿标题/时长/最终地址；读不到就返回 null） */
function readInfoJson(dir) {
  for (const name of listFiles(dir)) {
    if (!/\.info\.json$/i.test(name)) continue
    try { return JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { /* ignore */ }
  }
  return null
}

// ══════════════════════════════════════════════════════════════════════
//  ③ 一步到位：链接 → 联系表 + 音轨（**复用现成的 probeVideo** ✓✓）
// ══════════════════════════════════════════════════════════════════════

/**
 * 下载链接视频并**复用 wechat-video.mjs 的 probeVideo**抽帧拼联系表 + 抽音轨。
 *
 * 返回前会把**下载下来的 mp4 及其整个临时目录删掉** —— 因为下游只需要
 * `sheet`（联系表 JPG）和 `wav`（16k 音轨）：
 *   sheet → 插件侧 `describeImageCached(sheet, 'videoSheet')` 交给视觉模型
 *   wav   → 插件侧 `transcribeVoice(wav)` 交给 speechToText
 * 这两个是**给插件删的**（跟微信视频那条路一致：插件识别完 unlinkSync）。
 *
 * @returns {Promise<{sheet:string,wav:string,durationSec:number,title:string,site:string,
 *   siteName:string,host:string,resolvedUrl:string,videoBytes:number,frames:number,
 *   sheetBytes:number}|null>}
 */
export async function fetchLinkVideoSheet(url, {
  maxSeconds = 300, maxMB = 80, timeoutMs = 120_000, cookies = '', frames = 6, log = () => {},
} = {}) {
  const tag = '链接视频'
  const v = await fetchLinkVideo(url, { maxSeconds, maxMB, timeoutMs, cookies, log })
  if (!v?.file) return null
  try {
    // ⚠️ tag 必须**唯一**：probeVideo/video-probe.py 的产物文件名是 `<tag>-sheet.jpg` / `<tag>-audio.wav`，
    // tag 撞了的话两条链接同时处理会互相覆盖联系表（描述到别人的视频 ✗）——和 type 43 那条路的 tag 一个道理。
    const tag = `link-${v.site}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const r = probeVideo(v.file, { frames: Number(frames) || 6, tag, log })
    if (!r?.sheet) {
      log(`${tag}：抽帧/拼表失败（下载是成功的，${Math.round(v.bytes / 1024)}KB）→ 放弃`)
      return null
    }
    log(`${tag}：联系表已生成（${r.frames} 帧，${Math.round(r.sheetBytes / 1024)}KB）`
      + `｜时长 ${r.durationSec || v.durationSec}s${r.wav ? `｜音轨 ${r.wavSeconds}s` : '｜无音轨'}`)
    return {
      sheet: r.sheet,
      wav: r.wav || '',
      durationSec: r.durationSec || v.durationSec || 0,
      title: v.title,
      site: v.site,
      siteName: siteLabel(v.site),
      host: v.host,
      resolvedUrl: v.resolvedUrl,
      videoBytes: v.bytes,
      frames: r.frames || 0,
      sheetBytes: r.sheetBytes || 0,
    }
  } finally {
    // 抽帧/音轨已经拿到 → mp4 没用了，整个临时目录删干净（不留 .part/.info.json/纯音轨残留）
    // 带重试：Windows 上刚下完的大文件句柄可能还没释放（实测踩到过），删不掉就交给 1 小时后的兜底清理
    if (await removeLinkVideoDir(v.tmpDir)) log(`${tag}：已删除下载的临时视频目录`)
    else log(`${tag}：⚠️ 临时目录这次没删掉（${v.tmpDir}）—— 已交给 pruneLinkVideoTemp 兜底（1 小时后自动清）`)
  }
}
