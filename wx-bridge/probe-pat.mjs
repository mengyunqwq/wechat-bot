// 探针：翻 message_1.db 里的系统消息（local_type=10000），找「拍一拍」的真实 payload 格式
// 运行：node probe-pat.mjs（在 D:\微信deepseek\wx-bridge 下）
import { decompress as zstd } from 'fzstd'

const HOOK = 'http://127.0.0.1:30001/QueryDB/execute'
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

async function q(db, sql) {
  const r = await fetch(HOOK, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ optDbName: db, SQL: sql }),
  })
  const j = await r.json()
  if (j.status !== 0) throw new Error(JSON.stringify(j).slice(0, 200))
  return j.data || []
}

function decodeContent(hex) {
  try {
    if (typeof hex !== 'string' || !hex) return ''
    const buf = Buffer.from(hex, 'hex')
    if (buf.length > 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC)) return Buffer.from(zstd(buf)).toString('utf8')
    return buf.toString('utf8')
  } catch { return '' }
}

const tabs = (await q('message_1.db', "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'")).map(x => x.name)
console.log('Msg 表:', tabs.length)

let found = 0
for (const t of tabs) {
  let rows = []
  try {
    rows = await q('message_1.db', `SELECT local_id, local_type, create_time, message_content, real_sender_id FROM ${t} WHERE local_type=10000 ORDER BY create_time DESC LIMIT 20`)
  } catch (e) { console.log('  跳过', t, String(e.message).slice(0, 60)); continue }
  for (const r of rows) {
    const txt = decodeContent(String(r.message_content || ''))
    if (/pat|拍了拍|sysmsg/i.test(txt)) {
      found++
      console.log('--- 命中 table=' + t + ' local_id=' + r.local_id + ' create=' + new Date((Number(r.create_time) || 0) * 1000).toISOString() + ' ---')
      console.log(txt.slice(0, 800))
    }
  }
}
console.log('\n系统消息里命中 pat/拍一拍 的条数:', found)
