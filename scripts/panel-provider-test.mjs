// 验证「模型接口」后端：用已有凭据引用注册 deepseek 路由 → 列模型 → 真实测试一次。
// 只在本机跑；不打印任何 secret。
import { readFileSync } from 'node:fs'
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
const b64u = (b) => Buffer.from(b).toString('base64url')
const authority = '127.0.0.1:3080'
const name = 'dsh-auth-' + b64u(createHash('sha256').update(authority).digest())
const now = Date.now()
const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 3600_000 }), 'utf8'))
const sig = b64u(createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest())
const cookie = `${name}=v1.${body}.${sig}`

const call = async (path, opts = {}) => {
  const r = await fetch('http://127.0.0.1:3080' + path, { ...opts, headers: { cookie, 'content-type': 'application/json', ...(opts.headers || {}) } })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* html */ }
  return { status: r.status, json, text }
}

const out = {}
let r = await call('/wechat-bot/api/providers')
out.before = { registered: (r.json?.registered || []).map((x) => x.id), config: r.json?.config }

r = await call('/wechat-bot/api/providers/save', {
  method: 'POST',
  body: JSON.stringify({ provider: 'deepseek', displayName: 'DeepSeek 直连', keyRef: 'DEEPSEEK_API_KEY', models: 'deepseek-chat,deepseek-reasoner' }),
})
out.save = { status: r.status, ok: r.json?.ok, error: r.json?.error, profile: r.json?.profile, registered: (r.json?.state?.registered || []).map((x) => x.id) }

r = await call('/wechat-bot/api/providers/models?provider=deepseek')
out.models = { status: r.status, models: Array.isArray(r.json?.models) ? r.json.models.map((m) => m.id) : r.json?.models }

r = await call('/wechat-bot/api/providers/test', { method: 'POST', body: JSON.stringify({ provider: 'deepseek', model: 'deepseek-chat' }) })
out.test = { status: r.status, ok: r.json?.ok, error: r.json?.error, text: r.json?.text, ms: r.json?.ms }

r = await call('/wechat-bot/api/providers')
out.after = { registered: (r.json?.registered || []).map((x) => x.id), piProviders: Object.keys((r.json?.settings || []).find((s) => s.ns === 'llm-pi-ai')?.value?.providers || {}), creds: r.json?.credentials?.deepseek }

r = await call('/wechat-bot/api/image')
out.imageBefore = r.json?.config

r = await call('/wechat-bot/api/image', { method: 'POST', body: JSON.stringify({ apiUrl: 'https://apihub.agnes-ai.com/v1/images/generations', model: 'agnes-image-2.5-flash', keyRef: 'AGNES_API_KEY', mode: 'i2i', style: 'agnes' }) })
out.imageSave = { status: r.status, ok: r.json?.ok, error: r.json?.error, config: r.json?.config }

// 凭据写入/删除自测：用 openrouter 假 key，测完连 provider 带 key 一起删
r = await call('/wechat-bot/api/providers/save', {
  method: 'POST',
  body: JSON.stringify({ provider: 'openrouter', displayName: '自测（马上删）', apiKey: 'sk-panel-selftest', keyRef: 'WECHAT_PANEL_SELFTEST_KEY' }),
})
out.selftestSave = { status: r.status, ok: r.json?.ok, error: r.json?.error }
r = await call('/wechat-bot/api/providers')
out.selftestCred = r.json?.credentials?.openrouter
r = await call('/wechat-bot/api/providers/remove', { method: 'POST', body: JSON.stringify({ provider: 'openrouter', purgeKey: true, keyRef: 'WECHAT_PANEL_SELFTEST_KEY' }) })
out.selftestRemove = { status: r.status, ok: r.json?.ok, error: r.json?.error, removed: r.json?.removed }
r = await call('/wechat-bot/api/providers')
out.selftestAfter = { openrouterProfile: !!((r.json?.settings || []).find((s) => s.ns === 'llm-pi-ai')?.value?.providers || {}).openrouter, cred: r.json?.credentials?.openrouter }

console.log(JSON.stringify(out, null, 2))
