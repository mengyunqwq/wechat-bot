/**
 * style.mjs —— 口气像人：标点规约 / 口语碎片 / 情绪→语气（用户选的 ②③⑥）
 *
 * 纯函数，无 IO。三条都只作用在"发出去之前"的文本上，改坏了最坏是句子变短。
 *
 * ② 标点与长度：真人聊天句号多、感叹号少、句子短
 * ③ 口语碎片：低频出现"呃…/那个…/就是…"，只在闲聊时
 * ⑥ 情绪→语气：心情/精力真的影响句子长短、语气词多少、标点
 */

const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d)

// ══════════════════════════════════════════════════════════════════════
// ⑥ 情绪 → 语气档位
// ══════════════════════════════════════════════════════════════════════
/**
 * @returns {{key, maxLen, exclaim, ellipsis, filler, note}} 句子长度上限 / 允许感叹号 / 允许省略号…
 */
export function moodProfile(state, { now = Date.now() } = {}) {
  const v = num(state?.mood?.valence, 0)          // 心情：-1 差 … 1 好
  const a = num(state?.mood?.arousal, 0.3)        // 兴奋度
  const e = num(state?.energy, 0.7)               // 精力
  if (e < 0.35) {
    return { key: 'tired', maxLen: 12, exclaim: false, ellipsis: true, filler: false, note: '很困：句子极短，几乎不用语气词，句号收尾' }
  }
  if (v <= -0.35) {
    return { key: 'low', maxLen: 14, exclaim: false, ellipsis: true, filler: false, note: '心情低：短句、少语气词、不撒娇，也别装没事' }
  }
  if (v >= 0.35 && a >= 0.45) {
    return { key: 'up', maxLen: 20, exclaim: true, ellipsis: false, filler: true, note: '心情好且兴奋：可以叠词、可以用一次感叹号' }
  }
  return { key: 'normal', maxLen: 18, exclaim: false, ellipsis: true, filler: true, note: '平常：短句、句号或省略号收尾，少用感叹号' }
}

/** 注入提示词的一行语气要求 */
export function moodToneBlock(profile) {
  if (!profile) return ''
  return '  【此刻的语气】' + profile.note
    + `（一条最多约 ${profile.maxLen} 字；${profile.exclaim ? '最多一个感叹号' : '不要用感叹号'}）`
}

// ══════════════════════════════════════════════════════════════════════
// ② 标点规约 + 长度控制
// ══════════════════════════════════════════════════════════════════════
/**
 * 把"AI 腔标点"掰成聊天标点：
 *   ！！ → 。   ？？ → 。   连续省略号保留一个
 *   默认不加感叹号（除非 profile.exclaim）
 * @returns {string}
 */
export function normalizePunct(text, profile = {}) {
  let t = String(text || '').trim()
  if (!t) return ''
  const allowExclaim = !!profile.exclaim
  // 连续标点收敛
  t = t.replace(/[!！]{2,}/g, allowExclaim ? '！' : '。')
  t = t.replace(/[?？]{2,}/g, '。')
  t = t.replace(/[.。]{2,}/g, '。')
  t = t.replace(/…{2,}/g, '…')
  t = t.replace(/~{2,}/g, '～')
  // 单个感叹号：不允许就转句号（"啊/呀/啦"前面保留语气，只换符号）
  if (!allowExclaim) {
    t = t.replace(/[!！]/g, '。')
  } else {
    // 允许也只留第一个
    let seen = false
    t = t.replace(/[!！]/g, (m) => { if (seen) return '。'; seen = true; return '！' })
  }
  // 句末问号：真人常打成句号，这里按 60% 概率保留问号（确定性用长度哈希，避免随机不可测）
  t = t.replace(/[?？]/g, (m, off) => ((String(text).length + off) % 5 < 2 ? '？' : '。'))
  // 收尾不能是逗号
  t = t.replace(/[，,、；;：:]$/, '。')
  // 去掉多余空格
  t = t.replace(/[ \t]+/g, ' ').trim()
  return t
}

/**
 * 把长句按标点切成 ≤maxLen 的几段（返回数组）
 * 只在"确实过长"时才切，避免把正常一句话拆碎。
 */
export function splitByLength(text, maxLen = 18) {
  const chunks = []
  const hardLen = Math.max(6, num(maxLen, 18))
  for (const unit of String(text || '').split(/\n+/)) {
    let cur = ''
    for (const ch of unit) {
      cur += ch
      if ([...cur].length >= hardLen && /[，,。！？…～]/.test(ch)) {
        chunks.push(cur.trim()); cur = ''
      }
    }
    if (cur.trim()) {
      // 剩下太长的，硬切
      const rest = cur.trim()
      if ([...rest].length > hardLen * 1.6) {
        const cs = [...rest]
        for (let i = 0; i < cs.length; i += hardLen) chunks.push(cs.slice(i, i + hardLen).join(''))
      } else chunks.push(rest)
    }
  }
  return chunks.filter(Boolean)
}

// ══════════════════════════════════════════════════════════════════════
// ③ 口语碎片（低频）
// ══════════════════════════════════════════════════════════════════════
export const FILLERS = ['呃…', '那个…', '就是…', '反正', '好像']

/**
 * 偶尔给句首加一个口语碎片。
 * @param {string} text
 * @param {{rnd?:Function, chance?:number, allow?:boolean}} o
 * @returns {string}
 */
export function maybeFiller(text, { rnd = Math.random, chance = 0.12, allow = true } = {}) {
  const t = String(text || '')
  if (!allow || !t || chance <= 0) return t
  if (rnd() > chance) return t
  // 已经有语气词 / 太短 / 以标点开头 → 不加
  if (/^[呃那就反好]/.test(t)) return t
  if ([...t].length < 4) return t
  // 技术/任务型回复不加（有数字或英文多）
  if (/[0-9]{2,}|[A-Za-z]{6,}/.test(t)) return t
  const f = FILLERS[Math.floor(rnd() * FILLERS.length)]
  return f + t
}
