/**
 * Agnes 图像生成 → 微信表情包
 *
 * 为什么这么设计：
 *  - 用**图生图**（extra_body.image 传参考图 Data URI），严格保留角色外观，
 *    只换表情/情绪 —— 这样生成的表情包主体始终是同一个角色。
 *  - 生成后缩到 512×512 JPEG（jimp 纯 JS），从 ~840KB 降到 ~57KB，
 *    发微信快很多，也更像表情包尺寸。
 *  - **按情绪缓存**：同一种情绪只生成一次，之后复用（省调用 + 角色一致）。
 *
 * Agnes 接口（实测通过）：
 *   POST https://apihub.agnes-ai.com/v1/images/generations
 *   { model:'agnes-image-2.1-flash', prompt, size:'1K', ratio:'1:1',
 *     extra_body:{ image:['data:image/jpeg;base64,...'], response_format:'url' } }
 *   返回 data[0].url（图片在 platform-outputs.agnes-ai.space）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const API = 'https://apihub.agnes-ai.com/v1/images/generations'
const MODEL = 'agnes-image-2.1-flash'

/** 情绪 → 画面描述（提示词片段） */
export const EMOTION_PROMPTS = {
  大笑: '角色开心大笑，眼睛弯成月牙，笑得很放肆',
  开心: '角色开心微笑，眼睛弯弯，心情很好',
  得意: '角色一脸得意，嘴角上扬，有点小骄傲',
  无语: '角色无语地翻个白眼，嘴角下压，一副"服了"的表情',
  生气: '角色生气鼓腮，眉毛皱起，脸颊通红',
  委屈: '角色委屈巴巴，眼眶含着泪，嘴角向下',
  震惊: '角色睁大眼睛，嘴巴张成 O 形，一脸震惊',
  困: '角色打着哈欠，眼睛半闭，快睡着了',
  馋: '角色盯着吃的，眼睛发亮，嘴角挂着口水',
  害羞: '角色脸红，眼神躲闪，手指戳手指',
  认真: '角色认真专注，眉头微皱，盯着前方',
  比心: '角色双手比心，笑得很甜',
  点赞: '角色竖起大拇指，一脸"牛"的表情',
  疑惑: '角色歪着头一脸疑惑，头顶飘着问号',
  晚安: '角色抱着枕头准备睡觉，闭着眼睛',
  摸鱼: '角色瘫着划水偷懒，一脸悠闲',
}

export function listEmotions() { return Object.keys(EMOTION_PROMPTS) }
export function emotionPrompt(e) { return EMOTION_PROMPTS[e] || `角色露出「${e}」的表情` }

/**
 * 活动/生活场景库 —— 让角色"做别的事情"，不只是摆表情。
 * 每个题材都自带适配的场景、道具、动作（用户要求：场景也要适配）。
 */
export const ACTIVITY_PROMPTS = {
  吃饭: '坐在餐桌前大口扒饭，桌上摆满热菜，腮帮子鼓鼓的，嘴角沾着饭粒',
  睡觉: '躺在床上盖着被子睡得正香，枕边有月亮和星星，呼吸均匀',
  摸鱼: '瘫在办公椅上偷懒，电脑屏幕上开着工作文档，手里却在刷手机',
  打游戏: '戴着耳机握着手柄打游戏，眼睛发亮，屏幕上光影闪烁',
  上班: '坐在工位对着电脑，桌上堆着文件和咖啡杯，一脸生无可恋',
  加班: '深夜还在加班，办公室只剩一盏灯，桌上摞着空咖啡杯',
  写代码: '对着满屏代码敲键盘，头顶飘着一个亮起的电灯泡',
  喝奶茶: '双手捧着大杯奶茶吸溜，一脸满足，珍珠在杯里翻滚',
  做饭: '系着围裙在厨房炒菜，锅里冒着热气，动作利落',
  洗澡: '泡在满是泡沫的浴缸里，头上顶着一坨泡泡',
  看书: '捧着书认真读，旁边一杯冒着热气的茶',
  发呆: '坐在窗边放空，眼神飘忽，窗外飘着云',
  健身: '举着哑铃努力锻炼，满头大汗，肌肉紧绷',
  追剧: '窝在沙发里抱着零食追剧，眼泪汪汪',
  逛街: '提着好几个购物袋开心逛街，街边橱窗亮着灯',
  起床: '刚睡醒揉着眼睛，头发乱糟糟，被子还裹在身上',
  下雨: '撑着伞在雨中走，脚下踩着水洼，雨滴溅起',
  夏天: '吹着风扇吃西瓜，汁水流到手肘，一脸爽',
  冬天: '裹着厚被子发抖，呼出的气都是白的',
  被夸: '被人夸得飘飘然，脸红又得意，旁边飘着爱心',
  被骂: '被人数落，委屈地低着头，耳朵耷拉下来',
  撒娇: '拉着对方的袖子撒娇，眼睛水汪汪的',
  等消息: '盯着手机屏幕等回复，一脸焦急，头上有省略号',
}

/** 情绪 + 活动，统一查表 */
export function subjectPrompt(x) {
  const k = String(x || '').trim()
  return EMOTION_PROMPTS[k] || ACTIVITY_PROMPTS[k] || `角色正在做「${k}」这件事，动作和场景贴合这个题材`
}
export function listActivities() { return Object.keys(ACTIVITY_PROMPTS) }
export function listSubjects() { return [...Object.keys(EMOTION_PROMPTS), ...Object.keys(ACTIVITY_PROMPTS)] }

/**
 * 文字气泡文案库。
 * 为什么不让 AI 直接画字：AI 画中文经常糊/写错，所以 AI 只画角色和场景，
 * 气泡和文字由我们用 Pillow 精确后画（见 add-bubble.py）。
 */
export const BUBBLE_PHRASES = {
  大笑: ['笑死我了', '哈哈哈哈', '绷不住了', '我不行了'],
  开心: ['嘿嘿', '今天不错', '心情好'],
  得意: ['那必须的', '看我的', '还行吧'],
  无语: ['……', '服了', '我谢谢您', '无语'],
  生气: ['别惹我', '生气了', '你完了'],
  委屈: ['不给就不给', '我错了嘛', '别骂了'],
  震惊: ['啊？', '真的假的', '不是吧'],
  困: ['困死了', '睡了', '撑不住了'],
  馋: ['饿了', '想吃', '就一口'],
  害羞: ['别看我', '嘿嘿', '没有啦'],
  认真: ['我在想', '别吵', '让我想想'],
  比心: ['爱你', '比心', '抱抱'],
  点赞: ['牛', '厉害', '可以的'],
  疑惑: ['？', '啥意思', '真的吗'],
  晚安: ['睡了', '晚安', '明天见'],
  摸鱼: ['摸鱼中', '别叫我', '在忙（摸鱼）'],
  // 活动场景的配词
  吃饭: ['干饭了', '真香', '再来一碗'],
  睡觉: ['睡了', 'zzz', '别吵我'],
  打游戏: ['开黑吗', '这把稳了', '上号'],
  上班: ['上班中', '不想上班', '摸一会儿'],
  加班: ['还没下班', '救命', '几点了'],
  写代码: ['在写了', '别催', '有 bug'],
  喝奶茶: ['续命', '真香', '就一口'],
  做饭: ['下厨了', '尝尝', '别挑'],
  洗澡: ['洗澡中', '别敲门'],
  看书: ['看书呢', '别吵', '学到了'],
  发呆: ['放空', '……', '什么都没想'],
  健身: ['练着呢', '累死了', '再来一组'],
  追剧: ['追剧中', '别剧透', '好看'],
  逛街: ['买买买', '钱包空了'],
  起床: ['早', '再睡五分钟', '起了起了'],
  下雨: ['下雨了', '带伞了吗'],
  夏天: ['热死了', '开空调'],
  冬天: ['冷死了', '不想出门'],
  被夸: ['嘿嘿', '没有啦', '还行吧'],
  被骂: ['我错了', '别骂了', '委屈'],
  撒娇: ['就一下', '好不好嘛', '求你了'],
  等消息: ['在吗', '怎么不回', '？'],
}

/** 没给文案时，按情绪随机挑一句（带抖动，不会老发同一句） */
export function autoBubble(emotion, rand = Math.random()) {
  const pool = BUBBLE_PHRASES[emotion]
  if (!pool || !pool.length) return ''
  return pool[Math.min(pool.length - 1, Math.floor(rand * pool.length))]
}

/** 从环境变量或 ~/.dsh/.credentials.yaml 取密钥 */
export function resolveAgnesKey(ref = 'AGNES_API_KEY') {
  if (process.env[ref] && process.env[ref].trim()) return process.env[ref].trim()
  try {
    const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const m = new RegExp(`^\\s*${ref}:\\s*(\\S+)\\s*$`, 'm').exec(text)
    return m ? m[1].trim() : ''
  } catch { return '' }
}

/**
 * 生成一张表情包图片。
 *
 * 提示词策略（用户确认过）：**角色严格锁定，场景/动作自由发挥**。
 *  - 锁定：外观、配色、造型、画风 = 参考图里的同一个角色（不许换脸/换发色/换衣服）
 *  - 放开：场景、道具、动作、构图、镜头都可以自己编
 *  - 保留：表情包该有的"主体清晰、一眼看懂"，且不要文字
 *
 * @param {object} o
 * @param {string} o.emotion 情绪（见 EMOTION_PROMPTS）
 * @param {string} o.refImage 参考图（主体基准）路径
 * @param {string} o.outDir 输出目录
 * @param {string} [o.extra] 场景/动作自由描述
 * @param {string} [o.style] 风格后缀（默认 Q 版贴纸风）
 * @param {number} [o.size] 边长，默认 512
 * @param {(s:string)=>void} [o.log]
 * @returns {Promise<{file:string, raw:string, url:string}>}
 */
export async function generateStickerImage({
  emotion, refImage, outDir, extra = '', style = '', size = 512, log = () => {},
}) {
  const key = resolveAgnesKey()
  if (!key) throw new Error('没有 AGNES_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）')
  if (!refImage || !existsSync(refImage)) throw new Error('参考图不存在：' + refImage)

  const refB64 = readFileSync(refImage).toString('base64')
  const styleText = style || 'Q 版卡通贴纸风格，线条干净，色彩明快，主体清晰突出'
  const prompt = [
    '【角色锁定】以参考图中的角色为唯一主体：外观、发色发型、服装、配色、脸型、画风必须与参考图完全一致，',
    '是同一个人物；不要换脸、不要换发色、不要换服装、不要改画风。',
    `【自由发挥】场景、道具、动作、姿态、构图、镜头都可以自由创作，只要符合这个题材：${subjectPrompt(emotion)}。`,
    extra ? `【本次画面要求】${extra}。` : '',
    '【背景】必须画出与情境相符的**完整场景背景**（房间、街道、桌面、户外等环境元素），',
    '不要纯白底、不要只有人物悬浮在空背景上；背景要有层次但不能抢主体。',
    `【风格】${styleText}，整体像一张聊天里发的表情包。`,
    '【禁止】不要出现任何文字、字幕、水印、对话框。',
  ].filter(Boolean).join('')

  log(`Agnes 图生图：${emotion}${extra ? '｜' + extra : ''}（参考图 ${Math.round(refB64.length / 1024)}KB base64）`)

  // 带退避的重试：Agnes 高峰期会返回 503 "image queue is full"，直接放弃会白丢一张表情
  const body = JSON.stringify({
    model: MODEL,
    prompt,
    size: '1K',
    ratio: '1:1',
    extra_body: { image: [`data:image/jpeg;base64,${refB64}`], response_format: 'url' },
  })
  let res = null
  let text = ''
  for (let attempt = 1; attempt <= 4; attempt++) {
    res = await fetch(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(180_000),
    })
    text = await res.text()
    if (res.ok) break
    const busy = res.status === 503 || res.status === 429 || /queue is full|retry later|rate limit/i.test(text)
    if (!busy || attempt === 4) break
    const waitMs = 3_000 * attempt * attempt      // 3s → 12s → 27s（原来 5/20/45 太拖）
    log(`Agnes 忙（HTTP ${res.status}）→ ${Math.round(waitMs / 1000)}s 后重试（第 ${attempt}/3 次）`)
    await new Promise((r) => setTimeout(r, waitMs))
  }
  if (!res.ok) throw new Error(`Agnes HTTP ${res.status}：${text.slice(0, 200)}`)
  let json = null
  try { json = JSON.parse(text) } catch { /* ignore */ }
  const url = json?.data?.[0]?.url
  if (!url) throw new Error('Agnes 没返回图片 URL：' + text.slice(0, 200))
  log('Agnes 返回图片：' + url)

  const imgRes = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!imgRes.ok) throw new Error('下载生成图失败 HTTP ' + imgRes.status)
  const buf = Buffer.from(await imgRes.arrayBuffer())

  mkdirSync(outDir, { recursive: true })
  const raw = join(outDir, `agnes-${emotion}-${Date.now()}.png`)
  writeFileSync(raw, buf)

  // 缩到表情包尺寸（jimp 纯 JS）
  try {
    const { Jimp } = await import('jimp')
    const img = await Jimp.read(raw)
    img.resize({ w: size, h: size })
    const out = join(outDir, `agnes-${emotion}-${Date.now()}.jpg`)
    writeFileSync(out, await img.getBuffer('image/jpeg', { quality: 88 }))
    log(`生成完成：${out}（${Math.round((await import('node:fs')).statSync(out).size / 1024)}KB）`)
    // 成品已经压好了 → 删掉原始 PNG。
    // 用户要求：入库后不留原图（否则每生成一张就多堆一个 1MB+ 的中间文件，实测攒了 31 个 / 23.8MB）。
    try {
      if (raw && raw !== out) { unlinkSync(raw); log('已删除原始图：' + raw) }
    } catch (e) {
      log('删除原始图失败（不影响使用）：' + String(e?.message || e))
    }
    return { file: out, raw, url }
  } catch (e) {
    log('缩放失败，直接用原图：' + String(e?.message || e))
    return { file: raw, raw, url }
  }
}
