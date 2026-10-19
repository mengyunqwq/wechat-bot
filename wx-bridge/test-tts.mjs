/**
 * TTS → SILK 自测（真跑，联网）。
 *
 * 跑法：node test-tts.mjs
 * 做什么：
 *   ① 四个情绪预设各合成一条（同一句真话），报告 SILK 字节数 / get_duration 时长 / 耗时
 *      —— 时长差异能证明 rate/pitch 参数真的生效
 *   ② 顺手把主声那条回解成 16k/mono/PCM16 WAV 落到 data\_tts\verify\
 *      —— 这个 WAV 交给 DSH 的 speechToText（sensevoice-local）转写，就能证明"微信能听清"
 *   ③ 护栏自测：空文本 / 超长文本 / 不认识的 emotion 各跑一次，确认降级行为符合预期
 */
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { synthesizeVoice, VOICES, MAX_TEXT_CHARS, paths } from './lib/tts.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const VERIFY_DIR = join(HERE, '..', 'data', '_tts', 'verify')
const TEXT = '哼，主人你终于来啦。本鱼刚才在群里潜水呢，才不是偷懒哦。'

const log = (s) => console.log('   ' + s)
const rows = []
let fail = 0

console.log('TTS → SILK 自测')
console.log('文本: ' + TEXT + `（${[...TEXT].length} 字）`)
console.log('脚本: ' + paths.SCRIPT)
console.log('临时目录: ' + paths.TTS_TMP)
console.log('')

mkdirSync(VERIFY_DIR, { recursive: true })

console.log('① 四个情绪预设')
for (const emotion of Object.keys(VOICES)) {
  const wav = join(VERIFY_DIR, `${emotion}.16k.wav`)
  const r = synthesizeVoice(TEXT, { emotion, verifyWav: wav, log })
  if (!r) { fail++; rows.push([emotion, '失败', '-', '-', '-']); continue }
  const wavBytes = existsSync(wav) ? statSync(wav).size : 0
  rows.push([emotion, `${r.bytes}B`, `${r.durationMs}ms`, `${(r.durationMs / 1000).toFixed(2)}s`,
    `${r.voice} ${r.rate} ${r.pitch}${wavBytes ? ` ｜ wav ${wavBytes}B` : ''}`])
}
console.log('')
console.log('  预设         SILK      get_duration  秒     参数 / 回解WAV')
for (const [a, b, c, d, e] of rows) console.log(`  ${a.padEnd(12)} ${String(b).padEnd(9)} ${String(c).padEnd(13)} ${String(d).padEnd(6)} ${e}`)
console.log('')

console.log('② 护栏')
const guards = [
  ['空文本', () => synthesizeVoice('   ', { log })],
  ['超长文本（%d 字）'.replace('%d', MAX_TEXT_CHARS + 1), () => synthesizeVoice('啊'.repeat(MAX_TEXT_CHARS + 1), { log })],
  ['不认识的 emotion（应退回 main）', () => synthesizeVoice('测试一下。', { emotion: 'nope', log })],
]
for (const [name, fn] of guards) {
  console.log('   ── ' + name)
  const r = fn()
  const want = name.startsWith('不认识的') ? '有结果（退回 main）' : 'null（拒绝）'
  const got = r ? '有结果（退回 main）' : 'null（拒绝）'
  const ok = got === want
  if (!ok) fail++
  console.log(`   ${ok ? '✓' : '✗'} 期望 ${want} → 实际 ${got}${r ? `（${r.bytes}B / ${r.durationMs}ms）` : ''}`)
}
console.log('')

console.log('③ 回解 WAV 位置（交给 speechToText 转写用）')
for (const emotion of Object.keys(VOICES)) {
  const wav = join(VERIFY_DIR, `${emotion}.16k.wav`)
  console.log(`   ${emotion.padEnd(8)} ${existsSync(wav) ? wav : '（没生成）'}`)
}
console.log('')
console.log(fail === 0 ? '结果: 全部通过' : `结果: 有 ${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
