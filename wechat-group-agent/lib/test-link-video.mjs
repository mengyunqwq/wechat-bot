/**
 * 插件侧：链接视频的链接识别 + 下载决策单测（纯函数，不联网、不碰微信）。
 *   node lib/test-link-video.mjs
 * 真下载链路由桥侧 `wx-bridge/test-link-video.mjs` 负责（那边才有 yt-dlp）。
 */
import { detectLinkVideo, detectUnsupportedLink, decideLinkVideo } from './index.js'

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

console.log('=== ① 链接识别（纯文本 / 裸域名 / 链接卡片 XML）===')
const cases = [
  ['抖音短链', '快看 https://v.douyin.com/iRNBho6/ 笑死', '抖音'],
  ['抖音长链', 'https://www.douyin.com/video/6553113300429704452', '抖音'],
  ['B站长链', 'https://www.bilibili.com/video/BV1uT4y1P7CX?share_source=copy_web', 'B站'],
  ['B站短链', 'https://b23.tv/BV1uT4y1P7CX', 'B站'],
  ['裸域名（不带协议）', 'b23.tv/BV1uT4y1P7CX 这个', 'B站'],
  ['小红书短链', 'https://xhslink.com/a/abcdefg', '小红书'],
  ['小红书长链', 'https://www.xiaohongshu.com/explore/65f0c0c0000000001203abcd', '小红书'],
  ['微博', 'https://weibo.com/1234567890/Nabcdefg', '微博'],
  ['微博移动', 'https://m.weibo.cn/status/4999999999999999', '微博'],
  ['链接卡片 XML', '<msg><appmsg type="5"><title>标题</title><url>https://www.bilibili.com/video/BV1uT4y1P7CX</url></appmsg></msg>', 'B站'],
  ['XML 带 &amp;', '<url>https://www.bilibili.com/video/BV1uT4y1P7CX?a=1&amp;b=2</url>', 'B站'],
  ['尾巴带中文标点', '这个 https://b23.tv/BV1uT4y1P7CX，你看看', 'B站'],
  ['@ 我 + 链接', '@蓝色大肥鱼 https://b23.tv/BV1uT4y1P7CX 看看', 'B站'],
]
for (const [name, text, want] of cases) {
  const hit = detectLinkVideo(text)
  check(name, hit?.site === want, hit ? `${hit.site} ${hit.url}` : 'null')
}
for (const [name, text] of [
  ['普通文字无链接', '今天天气不错，吃饭了吗'],
  ['非白名单站', 'https://www.example.com/video/123'],
  ['快手（不支持）', 'https://v.kuaishou.com/abcdef'],
  ['YouTube（网络不通）', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ['貌似域名的普通词', 'index.js 和 readme.md 都不算链接'],
]) {
  const hit = detectLinkVideo(text)
  check(`${name} → null`, hit === null, hit ? JSON.stringify(hit) : 'null')
}
const un = detectUnsupportedLink('https://v.kuaishou.com/abcdef')
check('不支持站单独识别（供日志）', un?.site === '快手', JSON.stringify(un))
check('YouTube 也算"已知但不支持"', detectUnsupportedLink('https://youtu.be/xxx')?.site === 'YouTube')

console.log('\n=== ② 下载决策 decideLinkVideo（五种日志情况）===')
const now = 1_000_000_000
const cd = 120_000
check('被@ → 必须处理（跳过作息/冷却/概率）',
  decideLinkVideo({ forced: true, quiet: true, lastAt: now - 1, rand: 0.99, probability: 0, cooldownMs: cd, now }).ok === true)
check('安静时段且没被@ → 跳过',
  decideLinkVideo({ quiet: true, lastAt: 0, rand: 0, probability: 1, cooldownMs: cd, now }).reason.includes('安静时段'))
check('冷却中（30s<120s）→ 跳过',
  decideLinkVideo({ lastAt: now - 30_000, rand: 0, probability: 1, cooldownMs: cd, now }).reason.includes('冷却中'))
check('冷却已过（130s>120s）→ 继续走概率',
  decideLinkVideo({ lastAt: now - 130_000, rand: 0.1, probability: 0.5, cooldownMs: cd, now }).ok === true)
check('概率未命中（rand 0.9 > p 0.5）→ 跳过',
  decideLinkVideo({ lastAt: 0, rand: 0.9, probability: 0.5, cooldownMs: cd, now }).reason.includes('概率未命中'))
check('概率命中（rand 0.1 < p 0.5）→ 处理',
  decideLinkVideo({ lastAt: 0, rand: 0.1, probability: 0.5, cooldownMs: cd, now }).reason.includes('概率命中'))
check('冷却设为 0 = 不冷却',
  decideLinkVideo({ lastAt: now, rand: 0, probability: 1, cooldownMs: 0, now }).ok === true)

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
