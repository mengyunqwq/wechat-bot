/**
 * 只测「精简 XML」——排除完整 XML 里长 cdnurl / &amp; 实体等干扰。
 * 若精简版能发出去，说明接口可用，我们只要从收藏的 XML 里抽字段重建即可。
 */
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const API = 'http://127.0.0.1:30001'
const TO = process.argv[2] || 'filehelper'
const store = JSON.parse(readFileSync('D:\\微信deepseek\\data\\stickers\\index.json', 'utf8'))
const item = store.items.find((i) => i.kind === 'emoticon' && i.xml)
if (!item) { console.log('没有带 XML 的表情'); process.exit(1) }

const pick = (k) => new RegExp(`${k}="([^"]*)"`).exec(item.xml)?.[1] ?? ''
const minimal = `<msg><emoji type="${pick('type') || '2'}" md5="${pick('md5')}" len="${pick('len')}" `
  + `width="${pick('width')}" height="${pick('height')}" productid="${pick('productid')}"></emoji></msg>`
console.log('精简 XML:', minimal)

const alive = async () => { try { const r = await fetch(`${API}/QueryDB/status`, { signal: AbortSignal.timeout(3000) }); return r.ok } catch { return false } }
console.log('调用前存活:', await alive())
try {
  const r = await fetch(`${API}/ForwardXMLMsg`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to_wxid: TO, content: minimal }), signal: AbortSignal.timeout(20000),
  })
  console.log('响应:', await r.text())
} catch (e) { console.log('请求异常:', e.message) }
await sleep(3000)
console.log('调用后存活:', await alive())
