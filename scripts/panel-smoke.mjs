// 本机验证脚本：用 DSH 的 browser-session secret 现签一个 cookie，访问面板 API。
// 只用于本机自测，不写入磁盘、不打印 secret。
import { existsSync, readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'

const HOME = process.env.DSH_HOME || 'D:/dsh/data'
const yaml = readFileSync(HOME + '/.credentials.yaml', 'utf8')
const lines = yaml.split(/\r?\n/)
let secret = ''
for (let i = 0; i < lines.length; i++) {
  if (/^\s*client-connection\/browser-session:\s*$/.test(lines[i])) {
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const m = lines[j].match(/^\s*secret:\s*(\S+)\s*$/)
      if (m) { secret = m[1]; break }
    }
  }
}
if (!secret) throw new Error('找不到 browser-session secret')

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const authority = '127.0.0.1:3080'
const name = 'dsh-auth-' + b64u(createHash('sha256').update(authority).digest())
const now = Date.now()
const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 3600_000 }
const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'))
const sig = b64u(createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest())
const cookie = `${name}=v1.${body}.${sig}`

const base = 'http://127.0.0.1:3080'
async function call(path, opts = {}) {
  const r = await fetch(base + path, {
    ...opts,
    headers: { cookie, 'content-type': 'application/json', ...(opts.headers || {}) },
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* html */ }
  return { status: r.status, json, text }
}

const out = {}
let r = await call('/wechat-bot')
out.page = { status: r.status, hasTitle: r.text.includes('微信机器人控制台'), hasAppDebug: r.text.includes('window.__APP'), len: r.text.length }

r = await call('/wechat-bot/api/state')
out.state = {
  status: r.status,
  ok: r.json?.ok,
  version: r.json?.version,
  configKeys: r.json?.config ? Object.keys(r.json.config).length : 0,
  metaKeys: r.json?.meta ? Object.keys(r.json.meta).length : 0,
  features: r.json?.features?.length,
  rooms: r.json?.rooms?.length,
  bridgeRooms: r.json?.bridgeRooms,
  recent: (r.json?.rooms || [])[0]?.recent,
  bridgeConnected: r.json?.bridge?.connected,
  stats: r.json?.stats,
  services: r.json?.services,
  names: r.json?.names,
  missingMeta: Object.keys(r.json?.config || {}).filter((k) => !(k in (r.json?.meta || {}))),
}

r = await call('/wechat-bot/api/action', { method: 'POST', body: JSON.stringify({ op: 'rooms' }) })
out.rooms = { status: r.status, ok: r.json?.ok, count: Array.isArray(r.json?.result) ? r.json.result.length : null, sample: Array.isArray(r.json?.result) ? r.json.result.slice(0, 2) : r.json?.error }

r = await call('/wechat-bot/api/action', { method: 'POST', body: JSON.stringify({ op: 'stickers', args: { limit: 3 } }) })
out.stickers = { status: r.status, ok: r.json?.ok, count: r.json?.result?.stats?.count, items: r.json?.result?.items?.length }

r = await call('/wechat-bot/api/action', { method: 'POST', body: JSON.stringify({ op: 'searchMessages', args: { room: '47390425951@chatroom', query: '', limit: 5 } }) })
out.senders = (r.json?.result?.items || []).map((x) => ({ sender: x.sender, senderName: x.senderName, text: String(x.text || '').slice(0, 20) }))

r = await call('/wechat-bot/api/action', { method: 'POST', body: JSON.stringify({ op: 'memory.list', args: { room: '47390425951@chatroom' } }) })
out.memoryRoom = { status: r.status, ok: r.json?.ok, roomName: r.json?.result?.roomName, error: r.json?.error }
out.memorySample = (r.json?.result?.facts || []).slice(-3).map((f) => f.text)
out.memoryWxids = (r.json?.result?.facts || []).filter((f) => /wxid_/.test(f.text)).map((f) => f.text)

const before = (await call('/wechat-bot/api/state'))?.json?.config?.temperature
r = await call('/wechat-bot/api/config', { method: 'POST', body: JSON.stringify({ patch: { temperature: 0.91 } }) })
out.patch = { status: r.status, ok: r.json?.ok, applied: r.json?.applied }
await new Promise((res) => setTimeout(res, 120))
const after = (await call('/wechat-bot/api/state'))?.json?.config?.temperature
const disk = JSON.parse(readFileSync(HOME + '/wechat-bot/config.json', 'utf8')).temperature
out.patchVerify = { before, after, disk }
// 改回去
await call('/wechat-bot/api/config', { method: 'POST', body: JSON.stringify({ patch: { temperature: before } }) })
const restored = JSON.parse(readFileSync(HOME + '/wechat-bot/config.json', 'utf8')).temperature
out.restored = restored

r = await call('/wechat-bot/api/config', { method: 'POST', body: JSON.stringify({ patch: { replyProbability: 1.5 } }) })
out.badPatch = { status: r.status, ok: r.json?.ok, rejected: r.json?.rejected }

r = await call('/wechat-bot/api/config', { method: 'POST', body: JSON.stringify({ patch: { quietHours: 'not-a-time' } }) })
out.badQuiet = { status: r.status, ok: r.json?.ok, rejected: r.json?.rejected }

r = await call('/wechat-bot/api/logs?lines=5')
out.logs = { status: r.status, ok: r.json?.ok, lines: (r.json?.text || '').split('\n').length, tail: (r.json?.text || '').slice(-120) }

r = await call('/wechat-bot/api/logs?source=bridge&lines=3')
out.bridgeLogs = { status: r.status, ok: r.json?.ok, file: r.json?.file, lines: (r.json?.text || '').split('\n').length }

r = await call('/wechat-bot/api/export')
out.exportCfg = { status: r.status, ok: r.json?.ok, keys: Object.keys(r.json?.config || {}).length }

r = await call('/wechat-bot/api/import', { method: 'POST', body: JSON.stringify({ config: {}, confirm: 'import' }) })
out.importCfg = { status: r.status, ok: r.json?.ok, applied: (r.json?.applied || []).length }

const auditFile = HOME + '/wechat-bot/panel-audit.log'
out.audit = { exists: existsSync(auditFile), lines: existsSync(auditFile) ? readFileSync(auditFile, 'utf8').trim().split('\n').length : 0 }

r = await call('/wechat-bot/api/state?lite=1')
out.version = r.json?.version

r = await call('/wechat-bot/api/providers')
out.providers = {
  status: r.status,
  ok: r.json?.ok,
  error: r.json?.error,
  registered: (r.json?.registered || []).map((p) => p.id),
  configurable: (r.json?.configurable || []).map((p) => p.provider),
  settings: (r.json?.settings || []).map((s) => ({ ns: s.ns, rev: s.revision, keys: Object.keys(s.value || {}) })),
  config: r.json?.config,
  pi: (r.json?.settings || []).find((s) => s.ns === 'llm-pi-ai'),
  interesting: (r.json?.configurable || []).filter((p) => ['anthropic', 'openai', 'xai', 'zai', 'moonshotai', 'xiaomi', 'qwen-token-plan', 'deepseek', 'google'].includes(p.provider)),
}

console.log(JSON.stringify(out, null, 2))
