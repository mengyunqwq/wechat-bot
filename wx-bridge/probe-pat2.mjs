// 探针 2：统计所有消息类型，并解码每种类型的最近样本（找「拍了拍」在哪个 type）
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
function decode(hex) {
  try {
    const buf = Buffer.from(String(hex || ''), 'hex')
    if (buf.length > 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC)) return Buffer.from(zstd(buf)).toString('utf8')
    return buf.toString('utf8')
  } catch { return '' }
}

const tabs = (await q('message_1.db', "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'")).map((x) => x.name)
const byType = new Map()
for (const t of tabs) {
  let rows = []
  try { rows = await q('message_1.db', `SELECT local_type, COUNT(*) AS n FROM ${t} GROUP BY local_type`) } catch { continue }
  for (const r of rows) byType.set(Number(r.local_type), (byType.get(Number(r.local_type)) || 0) + Number(r.n))
}
console.log('消息类型分布:', [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '×' + v).join('  '))

// 对非文本类型各取 2 条样本解码
for (const t of tabs) {
  for (const [ty, n] of byType) {
    if ([1, 3, 34, 43, 47, 49].includes(ty)) continue
    let rows = []
    try {
      rows = await q('message_1.db', `SELECT local_type, create_time, message_content FROM ${t} WHERE local_type=${ty} ORDER BY create_time DESC LIMIT 1`)
    } catch { continue }
    for (const r of rows) {
      const txt = decode(String(r.message_content || ''))
      if (!txt) continue
      console.log(`\n=== type=${ty} table=${t} ===`)
      console.log(txt.slice(0, 600))
    }
  }
}
