/**
 * 精确测试发表情包（/ForwardXMLMsg）：
 *   ① 完整收藏 XML  ② 精简 XML（只留提取器要的字段）
 * 每次调用前后都检查微信是否存活，定位是不是这一步弄崩的。
 */
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const API = 'http://127.0.0.1:30001'
const INDEX = 'D:\\微信deepseek\\data\\stickers\\index.json'
const TO = process.argv[2] || 'filehelper'

const store = JSON.parse(readFileSync(INDEX, 'utf8'))
const item = store.items.find((i) => i.kind === 'emoticon' && i.xml)
if (!item) { console.log('库里没有带 XML 的表情'); process.exit(1) }
console.log('使用表情:', item.id)

const alive = async () => {
  try { const r = await fetch(`${API}/QueryDB/status`, { signal: AbortSignal.timeout(3000) }); return r.ok }
  catch { return false }
}

async function tryForward(tag, xml) {
  console.log(`\n--- ${tag}（XML ${xml.length} 字）---`)
  console.log('调用前存活:', await alive())
  try {
    const r = await fetch(`${API}/ForwardXMLMsg`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to_wxid: TO, content: xml }), signal: AbortSignal.timeout(20000),
    })
    console.log('响应:', await r.text())
  } catch (e) {
    console.log('请求异常:', e.message)
  }
  await sleep(3000)
  const a = await alive()
  console.log('调用后存活:', a)
  return a
}

// ① 完整 XML
let ok = await tryForward('① 完整收藏 XML', item.xml)

// ② 精简 XML（只保留 ExtractXmlFields 需要的字段）
if (ok) {
  const md5 = /md5="([^"]+)"/.exec(item.xml)?.[1] || ''
  const len = /len="([^"]+)"/.exec(item.xml)?.[1] || '0'
  const w = /width="([^"]+)"/.exec(item.xml)?.[1] || '0'
  const h = /height="([^"]+)"/.exec(item.xml)?.[1] || '0'
  const minimal = `<msg><emoji type="2" md5="${md5}" len="${len}" width="${w}" height="${h}" productid=""></emoji></msg>`
  ok = await tryForward('② 精简 XML', minimal)
} else {
  console.log('\n① 已把微信弄崩，跳过 ②')
}
console.log('\n结束')
