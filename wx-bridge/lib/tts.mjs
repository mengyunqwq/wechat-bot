/**
 * 文字 → **微信 SILK 语音**（TTS）。
 *
 * 分工：真正干活的是纯 Python 的 `tts-silk.py`（edge-tts → ffmpeg 24k PCM → pilk 编码 SILK），
 * 本模块只做三件事：**挑音色预设 / 加护栏 / 调脚本 + 解析 JSON**。
 * 为什么这样分：SILK 编码只有 pilk（Python）能干，Node 侧没有可用实现；
 * 与 `wechat-video.mjs` 调 `video-probe.py` 的写法保持一致（execFileSync + 解析末行 `JSON: {...}`）。
 *
 * 调用约定（给上层插件用）：
 *   const r = synthesizeVoice('哼，主人你终于来啦', { emotion: 'sweet' })
 *   if (r) sendVoice(r.file) else 发文字            ← **失败返回 null，绝不抛**
 *
 * 护栏（都是有意加的）：
 *   ① 空文本 / 超过 MAX_TEXT_CHARS 字 → 直接拒绝（语音太长很怪，而且 edge-tts 也更慢）
 *   ② 超时 90s（脚本内部另有 60s 合成超时）→ 杀掉子进程，返回 null
 *   ③ 并发上限 2：满了就拒绝这一条（降级发文字），避免把网络/CPU 打满
 *   ④ 临时文件写在 data\tts\，超 1 小时自动清（正常由调用方发完删；插件崩了就靠这个兜底）
 *   ⑤ 总开关：环境变量 WECHAT_TTS=0 关闭（默认开）
 *
 * ⚠️ 音色预设的数值是**用户实测挑好的**，别顺手改（改了声音就不对了）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE_DIR = join(HERE, '..')
const SCRIPT = join(BRIDGE_DIR, 'tts-silk.py')
const TTS_TMP = join(BRIDGE_DIR, '..', 'data', 'tts')
const PY_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8' }

/**
 * Python 解释器：**每次调用时才读** PYTHON_EXE。
 * 为什么不做成 import 时的常量（video/voice 那两个模块是常量）：常量会把"import 之后再改
 * 环境变量"变成静默无效（实测踩到：测试里改 PYTHON_EXE 完全没生效，还以为护栏坏了）。
 */
function pyExe() { return process.env.PYTHON_EXE || 'D:\\Python311\\python.exe' }
const PY = pyExe()   // 仅用于 paths 展示

/**
 * 音色预设（**用户已选定，别改数值**）。
 * voice  = edge-tts 音色名
 * rate   = 语速（±N%）
 * pitch  = 音调（±NHz）
 */
export const VOICES = {
  main: { voice: 'zh-CN-XiaoyiNeural', rate: '+8%', pitch: '+18Hz' },     // 主声（用户选定）
  sweet: { voice: 'zh-CN-XiaoyiNeural', rate: '-6%', pitch: '+8Hz' },     // 撒娇/委屈
  angry: { voice: 'zh-CN-XiaoxiaoNeural', rate: '+10%', pitch: '-4Hz' },  // 生气/吐槽
  serious: { voice: 'zh-CN-XiaoxiaoNeural', rate: '+5%', pitch: '+12Hz' }, // 正经回答
}

export const MAX_TEXT_CHARS = 120      // 超过直接拒绝（语音太长很怪）
const TIMEOUT_MS = 90_000              // 子进程硬超时（脚本内部合成超时 60s，留足 ffmpeg/pilk 余量）
const MAX_CONCURRENT = 2               // 同时最多 2 个合成
const TMP_KEEP_MS = 60 * 60_000        // 临时文件保留上限

/** TTS 总开关（环境变量 WECHAT_TTS=0 关闭） */
export function ttsEnabled() {
  return String(process.env.WECHAT_TTS ?? '1').trim() !== '0'
}

/** 正在合成的数量（护栏③） */
let inFlight = 0

/** 清掉临时目录里的陈年产物（调用方发完就删；插件崩了靠这个兜底） */
export function pruneTtsTemp(maxAgeMs = TMP_KEEP_MS) {
  let n = 0
  try {
    if (!existsSync(TTS_TMP)) return 0
    for (const f of readdirSync(TTS_TMP)) {
      const p = join(TTS_TMP, f)
      try {
        if (Date.now() - statSync(p).mtimeMs > maxAgeMs) { unlinkSync(p); n++ }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return n
}

/** 清空 TTS 临时目录（排查时手动用） */
export function purgeTtsTemp() {
  try { rmSync(TTS_TMP, { recursive: true, force: true }); return true } catch { return false }
}

/**
 * 从脚本输出里抠出 `JSON: {...}`（成功/失败都认 —— 失败时脚本也会打一行 JSON 再非 0 退出）
 * @returns {object|null}
 */
function parseJsonLine(out) {
  const lines = String(out || '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('JSON:')) continue
    try { return JSON.parse(line.slice(5).trim()) } catch { /* 继续往前找 */ }
  }
  return null
}

/**
 * 文字 → SILK 语音文件。
 *
 * @param {string} text                 要合成的话（会自动压掉换行/多余空白）
 * @param {object} [o]
 * @param {string} [o.emotion='main']   VOICES 里的预设名（不认识就退回 main）
 * @param {string} [o.voice]            直接指定音色（覆盖预设）
 * @param {string} [o.rate]             直接指定语速（覆盖预设）
 * @param {string} [o.pitch]            直接指定音调（覆盖预设）
 * @param {string} [o.verifyWav]        额外回解一份 16k WAV 到这个路径（调试/转写验证用）
 * @param {(s:string)=>void} [o.log]    日志回调
 * @returns {{file:string, bytes:number, durationMs:number, emotion:string, voice:string,
 *            rate:string, pitch:string, wav:string, elapsedSec:number}|null}
 *          **失败一律返回 null**（调用方降级发文字），不抛异常。
 */
export function synthesizeVoice(text, { emotion = 'main', voice, rate, pitch, verifyWav = '', log = () => {} } = {}) {
  // ── 护栏⑤：总开关 ──
  if (!ttsEnabled()) { log('TTS：已用 WECHAT_TTS=0 关闭'); return null }

  // ── 护栏①：文本 ──
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) { log('TTS：文本为空，跳过'); return null }
  const chars = [...clean].length            // 按码点算，避免代理对被算成 2
  if (chars > MAX_TEXT_CHARS) {
    log(`TTS：文本太长（${chars} 字 > ${MAX_TEXT_CHARS} 字上限），降级发文字`)
    return null
  }

  // ── 音色预设（不认识的 emotion 退回 main） ──
  let preset = VOICES[emotion]
  if (!preset) {
    log(`TTS：不认识的 emotion=${emotion}，退回 main`)
    preset = VOICES.main
  }
  const useVoice = voice || preset.voice
  const useRate = rate || preset.rate
  const usePitch = pitch || preset.pitch

  // ── 护栏③：并发上限 ──
  if (inFlight >= MAX_CONCURRENT) {
    log(`TTS：并发已满（${inFlight}/${MAX_CONCURRENT}），这条降级发文字`)
    return null
  }

  if (!existsSync(SCRIPT)) { log(`TTS：脚本不存在（${SCRIPT}）`); return null }
  const py = pyExe()
  if (!existsSync(py)) { log(`TTS：Python 不存在（${py}，可用 PYTHON_EXE 覆盖）`); return null }

  let out = ''
  try {
    mkdirSync(TTS_TMP, { recursive: true })
    const n = pruneTtsTemp()
    if (n) log(`TTS 临时目录：清掉 ${n} 个陈年产物`)
  } catch (e) {
    log('TTS：临时目录不可用：' + String(e?.message || e).slice(0, 120))
    return null
  }
  // 文件名带 pid + 随机串：多进程同时合成也不会撞车
  out = join(TTS_TMP, `tts-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.silk`)

  // ⚠️ 一律用 `--opt=value` 形式：`--rate -6%` 会被 argparse 当成选项（"expected one argument"），
  // sweet/-6%、angry/-4Hz 必挂（实测踩到）。脚本里另有 normalize_argv 兜底，这里是第二层保险。
  const args = [SCRIPT, `--text=${clean}`, `--out=${out}`,
    `--voice=${useVoice}`, `--rate=${useRate}`, `--pitch=${usePitch}`]
  if (verifyWav) args.push(`--verify-wav=${verifyWav}`)

  inFlight++
  const t0 = Date.now()
  try {
    const stdout = execFileSync(py, args, { timeout: TIMEOUT_MS, encoding: 'utf8', env: PY_ENV, maxBuffer: 8 * 1024 * 1024 })
    const r = parseJsonLine(stdout)
    if (!r || !r.ok) {
      log('TTS：脚本没给出成功 JSON（输出：' + String(stdout || '').replace(/\s+/g, ' ').slice(0, 200) + '）')
      return null
    }
    log(`TTS：${emotion} → ${r.bytes} 字节 / ${r.durationMs}ms（${useVoice} rate=${useRate} pitch=${usePitch}，${((Date.now() - t0) / 1000).toFixed(1)}s）`)
    return {
      file: r.silk,
      bytes: Number(r.bytes) || 0,
      durationMs: Number(r.durationMs) || 0,
      emotion,
      voice: r.voice || useVoice,
      rate: r.rate || useRate,
      pitch: r.pitch || usePitch,
      wav: r.verifyWav || '',
      elapsedSec: Number(r.elapsedSec) || 0,
    }
  } catch (e) {
    // 脚本非 0 退出（网络/edge-tts/ffmpeg/pilk 失败）→ 尽力把它的 JSON 读出来，日志里给明原因
    const stdout = String(e?.stdout || '')
    const stderr = String(e?.stderr || '')
    const r = parseJsonLine(stdout) || parseJsonLine(stderr)
    if (r && r.error) {
      log(`TTS 失败[${r.stage || '?'}]：${r.error}`)
    } else if (e?.killed || e?.signal || /ETIMEDOUT|timed out/i.test(String(e?.message))) {
      log(`TTS 失败：子进程超时（>${TIMEOUT_MS / 1000}s）`)
    } else {
      const tail = (stdout + ' ' + stderr + ' ' + String(e?.message || e)).replace(/\s+/g, ' ').trim()
      log('TTS 失败：' + tail.slice(0, 300))
    }
    return null
  } finally {
    inFlight--
  }
}

export const paths = { TTS_TMP, SCRIPT, PY, BRIDGE_DIR }
