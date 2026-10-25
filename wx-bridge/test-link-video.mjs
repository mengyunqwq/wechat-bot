/**
 * 链接视频自测（真实链接，真跑）—— `node test-link-video.mjs [用例]`
 *
 * 覆盖：链接识别（含短链/卡片 XML/不支持站）+ 真下载（B站/b23.tv 短链）+ 失败路径（无效/超长/不支持）。
 * 只读网络 + 只写 data/link-video 临时目录，不碰微信、不发消息。
 */
import { existsSync } from 'node:fs'
import {
  detectVideoLink, detectUnsupportedLink, extractUrls, ffmpegExe, siteLabel,
  fetchLinkVideoSheet, fetchLinkVideo, cleanupLinkVideo, paths,
} from './lib/link-video.mjs'

const only = process.argv[2] || ''
const run = (name) => !only || name.includes(only)
const log = (s) => console.log('  · ' + s)
let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

// ── ① 链接识别（纯函数，不联网）────────────────────────────────
if (run('detect')) {
  console.log('\n=== ① 链接识别 ===')
  const cases = [
    ['纯文本抖音短链', '快看这个 https://v.douyin.com/iRNBho6/ 笑死', 'douyin'],
    ['纯文本抖音长链', 'https://www.douyin.com/video/6553113300429704452', 'douyin'],
    ['纯文本 B站', 'https://www.bilibili.com/video/BV1uT4y1P7CX?share_source=copy_web', 'bilibili'],
    ['B站短链', 'https://b23.tv/BV1uT4y1P7CX', 'bilibili'],
    ['不带协议裸域名', 'b23.tv/BV1uT4y1P7CX', 'bilibili'],
    ['小红书短链', 'https://xhslink.com/a/abcdefg 复制本条信息', 'xiaohongshu'],
    ['小红书长链', 'https://www.xiaohongshu.com/explore/65f0c0c0000000001203abcd', 'xiaohongshu'],
    ['微博', 'https://weibo.com/1234567890/Nabcdefg', 'weibo'],
    ['微博移动', 'https://m.weibo.cn/status/4999999999999999', 'weibo'],
    ['链接卡片 XML', '<msg appmsg type="5"><title>标题</title><url>https://www.bilibili.com/video/BV1uT4y1P7CX</url></msg>', 'bilibili'],
    ['XML 带 &amp;', '<url>https://www.bilibili.com/video/BV1uT4y1P7CX?spm_id_from=333.999&amp;vd_source=abc</url>', 'bilibili'],
    ['尾巴带中文标点', '这个 https://b23.tv/BV1uT4y1P7CX，你看看', 'bilibili'],
  ]
  for (const [name, text, want] of cases) {
    const hit = detectVideoLink(text)
    check(name, hit?.site === want, hit ? `${hit.site} ${hit.url}` : 'null')
  }
  const neg = [
    ['普通文字无链接', '今天天气不错，吃饭了吗'],
    ['非白名单站', 'https://www.example.com/video/123'],
    ['快手（不支持）', 'https://v.kuaishou.com/abcdef 快手视频'],
    ['YouTube（网络不通）', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ]
  for (const [name, text] of neg) {
    const hit = detectVideoLink(text)
    check(name + ' → null', hit === null, hit ? JSON.stringify(hit) : 'null')
  }
  const un = detectUnsupportedLink('https://v.kuaishou.com/abcdef')
  check('不支持站能被单独识别出来（供日志）', un?.site === 'kuaishou', JSON.stringify(un))
  check('extractUrls 能一次抠出多个', extractUrls('https://b23.tv/a 和 https://v.douyin.com/b/').length === 2)
  check('站点中文名', siteLabel('bilibili') === 'B站' && siteLabel('xiaohongshu') === '小红书')
}

// ── ② ffmpeg 位置 ───────────────────────────────────────────
if (run('ffmpeg')) {
  console.log('\n=== ② ffmpeg 位置（yt-dlp 合并音视频必须）===')
  const ff = ffmpegExe()
  check('imageio_ffmpeg 给出了 ffmpeg 路径', !!ff && existsSync(ff), ff || '(空)')
}

// ── ③ 真下载（B站 + b23.tv 短链）────────────────────────────
if (run('download')) {
  console.log('\n=== ③ 真下载：B站长链 + b23.tv 短链 ===')
  const urls = [
    ['B站长链', 'https://www.bilibili.com/video/BV1uT4y1P7CX'],
    ['b23.tv 短链（要跟重定向）', 'https://b23.tv/BV1uT4y1P7CX'],
  ]
  for (const [name, url] of urls) {
    console.log(`\n── ${name}：${url}`)
    const r = await fetchLinkVideoSheet(url, { frames: 6, maxSeconds: 300, maxMB: 80, timeoutMs: 180_000, log })
    check(`${name} 成功拿到联系表`, !!r?.sheet, r ? `sheet=${r.sheet}` : 'null')
    if (r) {
      console.log(`     title=${JSON.stringify(r.title)} durationSec=${r.durationSec} site=${r.site}/${r.siteName}`)
      console.log(`     resolvedUrl=${r.resolvedUrl}`)
      console.log(`     frames=${r.frames} sheetBytes=${r.sheetBytes} videoBytes=${r.videoBytes}`)
      console.log(`     wav=${r.wav || '(无音轨)'}`)
      check(`${name} 抽到了帧`, r.frames > 0)
      check(`${name} 联系表文件存在`, existsSync(r.sheet))
      check(`${name} 有音轨 WAV`, !!r.wav && existsSync(r.wav))
      check(`${name} 短链已重定向到真实地址`, /bilibili\.com/i.test(r.resolvedUrl), r.resolvedUrl)
      console.log(`     （产物留在这里给插件复用/删除：${r.sheet}${r.wav ? ' | ' + r.wav : ''}）`)
    }
  }
}

// ── ④ 失败路径：都必须优雅返回 null ──────────────────────────
if (run('fail')) {
  console.log('\n=== ④ 失败路径（都要优雅 null + 日志，不抛错）===')
  const bad = [
    ['无效链接（不存在的 BV）', 'https://www.bilibili.com/video/BV0000000000'],
    ['无效短链（404）', 'https://b23.tv/zzzzzzzz'],
    ['快手（不支持，白名单外）', 'https://v.kuaishou.com/abcdef'],
    ['超长视频（限 60s，实际 212s）', 'https://www.bilibili.com/video/BV1uT4y1P7CX', { maxSeconds: 60 }],
    ['大小超限（限 1MB，实际 34MB）', 'https://www.bilibili.com/video/BV1uT4y1P7CX', { maxMB: 1 }],
    ['超时（限 1s，必定被杀）', 'https://www.bilibili.com/video/BV1uT4y1P7CX', { timeoutMs: 1_000 }],
    ['空链接', ''],
  ]
  for (const [name, url, opts] of bad) {
    console.log(`\n── ${name}`)
    let threw = null
    let r = null
    try {
      r = await fetchLinkVideoSheet(url, { frames: 4, maxSeconds: 300, maxMB: 80, timeoutMs: 120_000, log, ...(opts || {}) })
    } catch (e) { threw = e }
    check(`${name} 没有抛异常`, !threw, threw ? String(threw?.message || threw) : '')
    check(`${name} 返回 null`, r === null, r ? JSON.stringify(r) : 'null')
  }
}

// ── ⑤ 临时目录不泄漏 ────────────────────────────────────────
if (run('temp')) {
  console.log('\n=== ⑤ 临时目录残留检查 ===')
  const { readdirSync } = await import('node:fs')
  let left = []
  try { left = readdirSync(paths.LINK_TMP) } catch { /* 目录可能不存在 */ }
  // 失败路径下也可能留下"下载到一半"的目录（那是有意保留给排查的？不 —— 我们的实现会清掉）
  console.log(`  data/link-video 下剩余：${left.length ? left.join(', ') : '(空)'}`)
  check('下载成功的调用不留临时目录', left.filter((n) => !n.startsWith('__')).length === 0, left.join(', '))
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
