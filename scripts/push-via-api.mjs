/**
 * push-via-api.mjs —— github.com:443 不通时用 GitHub Git Data API 推送
 *
 * 为什么需要：本机实测 `github.com:443` 会连不上（`api.github.com` 却正常），
 * 这时 `git push` 会一直超时。用 REST API 一样能推：
 *   blobs → tree → commit → 更新 ref →（可选）移动 tag
 *
 * 关键点（踩过的坑）：
 *   ① 必须用 `git ls-files -z` 读路径 —— 不带 -z 时 git 会把中文路径转义成
 *      "docs/\346\212..." → 读不到文件 → 漏传（而 tree 不带 base_tree 等于把它们删了）
 *   ② blob 内容必须取 **git 对象**（`git cat-file --batch`，规范 LF），
 *      不能用工作区文件（CRLF），否则远端 blob sha 和本地 git 对不上
 *
 * 用法：
 *   node scripts/push-via-api.mjs              # 推当前 HEAD 的工作区快照
 *   node scripts/push-via-api.mjs --tag        # 顺便把 v<version> tag 指到新 commit
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = process.env.GH_REPO || 'mengyunqwq/wechat-bot'
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const wantTag = process.argv.includes('--tag')

function gh(method, path, body) {
  const args = ['api', '--method', method, path]
  if (body) args.push('--input', '-')
  const out = execFileSync('gh', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input: body ? JSON.stringify(body) : undefined,
    maxBuffer: 128 * 1024 * 1024,
  })
  return out.trim() ? JSON.parse(out) : {}
}

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8').split('\0').filter(Boolean)
console.log('跟踪文件:', files.length)

const buf = execFileSync('git', ['cat-file', '--batch'], {
  cwd: ROOT,
  input: files.map((f) => `HEAD:${f}`).join('\n') + '\n',
  maxBuffer: 256 * 1024 * 1024,
})
const blobs = new Map()
let pos = 0
for (const f of files) {
  const nl = buf.indexOf(0x0a, pos)
  const parts = buf.slice(pos, nl).toString('utf8').split(' ')
  if (parts.length < 3) { pos = nl + 1; continue }
  const size = Number(parts[2])
  const start = nl + 1
  blobs.set(f, buf.slice(start, start + size))
  pos = start + size + 1
}
console.log('读到 blob:', blobs.size)

const remoteSha = gh('GET', `/repos/${REPO}/git/ref/heads/main`).object.sha
const msg = execFileSync('git', ['log', '-1', '--format=%B'], { cwd: ROOT, encoding: 'utf8' })

const entries = []
for (const f of files) {
  const content = blobs.get(f)
  if (!content) { console.log('  缺失:', f); continue }
  const blob = gh('POST', `/repos/${REPO}/git/blobs`, { content: content.toString('base64'), encoding: 'base64' })
  entries.push({ path: f.split('\\').join('/'), mode: '100644', type: 'blob', sha: blob.sha })
  if (entries.length % 50 === 0) console.log('  blob', entries.length)
}

const tree = gh('POST', `/repos/${REPO}/git/trees`, { tree: entries })
const commit = gh('POST', `/repos/${REPO}/git/commits`, { message: msg, tree: tree.sha, parents: [remoteSha] })
gh('PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: commit.sha, force: true })
console.log('✅ main →', commit.sha)

if (wantTag) {
  const ver = JSON.parse(readFileSync(join(ROOT, 'version.json'), 'utf8')).version
  try {
    gh('POST', `/repos/${REPO}/git/refs`, { ref: `refs/tags/v${ver}`, sha: commit.sha })
  } catch {
    gh('PATCH', `/repos/${REPO}/git/refs/tags/v${ver}`, { sha: commit.sha, force: true })
  }
  console.log('✅ tag v' + ver)
}
