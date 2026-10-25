/**
 * 验证微信 CDN 图片下载 + AES 解密管道。
 * 用收藏到的表情 XML 里的完整 cdnurl + aeskey 试：
 *   http://vweixinf.tc.qq.com/110/20401/stodownload?m=...&filekey=...&aeskey=...
 * 微信 CDN 的图是 AES-128-ECB 加密的，解密后应能看到 GIF/PNG/JPEG 文件头。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createDecipheriv } from 'node:crypto'

const store = JSON.parse(readFileSync('D:\\微信deepseek\\data\\stickers\\index.json', 'utf8'))
const item = store.items.find((i) => i.kind === 'emoticon' && i.xml)
if (!item) { console.log('没有带 XML 的表情'); process.exit(1) }

const xml = item.xml
const pick = (k) => new RegExp(`${k}="([^"]*)"`).exec(xml)?.[1] ?? ''
const url = pick('cdnurl').replace(/&amp;/g, '&')
const aeskey = pick('aeskey')
const md5 = pick('md5')
console.log('URL:', url.slice(0, 120) + '…')
console.log('aeskey:', aeskey, '｜md5:', md5)

if (!url || !aeskey) { console.log('XML 里没有 cdnurl/aeskey'); process.exit(2) }

const res = await fetch(url, { headers: { 'user-agent': 'MicroMessenger' } })
console.log('HTTP', res.status, res.headers.get('content-type'), res.headers.get('content-length'))
const buf = Buffer.from(await res.arrayBuffer())
console.log('下载字节:', buf.length)

const magic = (b) => {
  if (b.length < 4) return '太短'
  if (b[0] === 0xff && b[1] === 0xd8) return 'JPEG'
  if (b[0] === 0x89 && b[1] === 0x50) return 'PNG'
  if (b.slice(0, 3).toString('latin1') === 'GIF') return 'GIF'
  if (b[0] === 0x52 && b[1] === 0x49) return 'WEBP/RIFF'
  return '未知(' + b.slice(0, 8).toString('hex') + ')'
}
console.log('原始文件头:', magic(buf))

try {
  const key = Buffer.from(aeskey, 'hex')
  const d = createDecipheriv('aes-128-ecb', key, null)
  d.setAutoPadding(false)
  const out = Buffer.concat([d.update(buf), d.final()])
  console.log('解密后字节:', out.length, '｜文件头:', magic(out))
  mkdirSync('D:\\微信deepseek\\data\\stickers\\decoded', { recursive: true })
  const ext = magic(out) === 'GIF' ? 'gif' : magic(out) === 'PNG' ? 'png' : 'jpg'
  const p = `D:\\微信deepseek\\data\\stickers\\decoded\\${md5}.${ext}`
  writeFileSync(p, out)
  console.log('已保存:', p)
} catch (e) {
  console.log('解密失败:', e.message)
}
