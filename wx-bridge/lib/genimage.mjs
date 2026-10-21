/**
 * 图像生成 → 微信表情包（**后端可配置**）
 *
 * 为什么这么设计：
 *  - 用**图生图**（extra_body.image 传参考图 Data URI），严格保留角色外观，
 *    只换表情/情绪 —— 这样生成的表情包主体始终是同一个角色。
 *  - 生成后缩到 512×512 JPEG（jimp 纯 JS），从 ~840KB 降到 ~57KB，
 *    发微信快很多，也更像表情包尺寸。
 *  - **按情绪缓存**：同一种情绪只生成一次，之后复用（省调用 + 角色一致）。
 *
 * 后端可配置（不需要改代码）：
 *   优先级：环境变量 > data/image-gen.json > 内置默认
 *     IMAGE_API_URL   图片生成接口（默认 Agnes：https://apihub.agnes-ai.com/v1/images/generations）
 *     IMAGE_MODEL     模型 id（默认 agnes-image-2.1-flash）
 *     IMAGE_API_KEY   接口 key（也支持沿用 AGNES_API_KEY）
 *
 *   data/image-gen.json 例子：
 *   {
 *     "apiUrl": "https://apihub.agnes-ai.com/v1/images/generations",
 *     "model": "mimov2.6flash",
 *     "apiKey": "sk-xxxx"
 *   }
 *
 * 接口约定（OpenAI images/generations 风格）：
 *   POST {apiUrl}
 *   { model, prompt, size:'1K', ratio:'1:1',
 *     extra_body:{ image:['data:image/jpeg;base64,...'], response_format:'url' } }
 *   返回 data[0].url
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

// ★★ 角色文字描述（图生图 i2i 换成了文生图 t2i，靠这段文字锁定角色形象）
//   为什么换：Agnes 的 i2i 队列很小，高峰期一直 503（实测熬 3 分钟都不通）；
//   而 t2i 队列空，11 秒就出图，只要描述够细，出来的还是同一只鲸鱼娘（已实测对比）。
// ★★ 本地 ComfyUI 用的【英文 danbooru 标签】映射（三个底模都是标签流，中文几乎无效）
export const EN_EMOTION = {
  '大笑': 'huge smile, open mouth, closed eyes, laughing, happy',
  '开心': 'smile, happy, closed mouth, blush',
  '得意': 'smug, smirk, confident, one eye closed',
  '无语': 'expressionless, half-closed eyes, annoyed, sigh',
  '生气': 'angry, pout, puffed cheeks, blush',
  '委屈': 'teary eyes, pout, sad, trembling',
  '震惊': 'surprised, wide eyes, open mouth, exclamation',
  '困': 'sleepy, yawning, half-closed eyes',
  '馋': 'drooling, sparkling eyes, hungry, looking at food',
  '害羞': 'blush, shy, looking away, embarrassed',
  '认真': 'serious, focused, furrowed brow, determined',
  '比心': 'heart hands, smile, love',
  '点赞': 'thumbs up, smug, grin',
  '疑惑': 'confused, head tilt, question mark, puzzled',
  '晚安': 'sleeping, holding pillow, closed eyes',
  '摸鱼': 'lying down, lazy, relaxed, slacking off',
};
export const EN_ACTIVITY = {
  '吃饭': 'eating, holding bowl, rice, chopsticks, dining table',
  '睡觉': 'sleeping in bed, blanket, closed eyes',
  '打游戏': 'playing video game, holding gamepad, headphones',
  '上班': 'office, desk, computer, tired, tie',
  '加班': 'office at night, desk lamp, overtime, tired',
  '写代码': 'coding, multiple monitors, keyboard, programmer',
  '喝奶茶': 'holding bubble tea, drinking, straw',
  '做饭': 'cooking, kitchen, apron, frying pan',
  '洗澡': 'bubble bath, bathtub, towel on head',
  '看书': 'reading book, cup of tea, sitting',
  '发呆': 'spacing out, staring, window, clouds',
  '健身': 'dumbbell, workout, sweating, gym',
  '追剧': 'watching tv, sofa, popcorn, blanket',
  '逛街': 'shopping bags, street, storefront',
  '起床': 'just woke up, messy hair, rubbing eyes, blanket',
  '下雨': 'umbrella, rain, puddle, wet',
  '夏天': 'fan, watermelon, summer, hot',
  '冬天': 'thick blanket, shivering, snow, breath vapor',
  '被夸': 'flustered, blush, happy, hearts',
  '被骂': 'sad, head down, drooping ears, dejected',
  '等消息': 'looking at phone, waiting, anxious, ellipsis',
};
// 本地模型用的角色标签（配参考图 img2img 用，越短越稳）
export const EN_CHARACTER =
  'blue hair, long hair, gradient hair, blue eyes, maid outfit, white apron, ' +
  'whale tail, fin ears, ahoge, chibi, cute, single character';
// 本地模型的通用质量标签
export const EN_QUALITY = 'masterpiece, best quality, great quality, absurdres, 1girl, solo, sticker';
export const EN_NEGATIVE =
  'lowres, bad anatomy, bad hands, extra digits, fewer digits, text, watermark, signature, ' +
  'worst quality, low quality, blurry, multiple girls, 2girls, 3girls, nsfw';

export const CHARACTER_DESC =
  '一个 Q 版可爱的鲸鱼娘角色：深蓝到浅蓝渐变的及腰长发，' +
  '白色蕾丝荷叶边头饰（像女仆帽），发间有两个小小的鲸鱼鳍状耳朵装饰，' +
  '头顶有一撮海豚尾形状的呆毛；蓝色大眼睛、圆脸、脸颊有红晕；' +
  '穿深蓝色女仆装 + 白色蕾丝围裙（围裙上绣着一只小鲸鱼），' +
  '背后有一条深蓝色的鲸鱼尾巴；Q 版卡通贴纸画风，线条干净，色彩明快';

const DEFAULTS = {
  apiUrl: 'https://apihub.agnes-ai.com/v1/images/generations',
  model: 'agnes-image-2.1-flash',
  keyRef: 'AGNES_API_KEY',
}

/** 图片生成的配置（每次调用都读一次，改 json 不用重启桥） */
export function loadImageConfig() {
  let fileCfg = {}
  try {
    // data/image-gen.json（相对 wx-bridge/lib/../../data）
    const here = dirname(fileURLToPath(import.meta.url))
    const f = join(here, '..', '..', 'data', 'image-gen.json')
    if (existsSync(f)) fileCfg = JSON.parse(readFileSync(f, 'utf8')) || {}
  } catch { /* 没配置就用默认 */ }
  return {
    apiUrl: String(process.env.IMAGE_API_URL || fileCfg.apiUrl || DEFAULTS.apiUrl),
    model: String(process.env.IMAGE_MODEL || fileCfg.model || DEFAULTS.model),
    apiKey: String(process.env.IMAGE_API_KEY || fileCfg.apiKey || ''),
    keyRef: String(process.env.IMAGE_KEY_REF || fileCfg.keyRef || DEFAULTS.keyRef),
    // i2i = 图生图（带参考图，角色最像，但 Agnes 的 i2i 队列很小容易 503）
    // t2i = 文生图（不带图，队列空、快，但角色只有约 95% 像）
    mode: String(process.env.IMAGE_MODE || fileCfg.mode || 'i2i'),
    // backend: comfy = 用本机 ComfyUI（推荐，10 秒出图、不排队）；agnes = 用云端（会排队 503）
    backend: String(process.env.IMAGE_BACKEND || fileCfg.backend || 'comfy'),
    comfyUrl: String(process.env.COMFY_URL || fileCfg.comfyUrl || 'http://127.0.0.1:8188'),
    comfyModel: String(process.env.COMFY_MODEL || fileCfg.comfyModel || 'animagineXL40_opt.safetensors'),
    comfyDenoise: Number(process.env.COMFY_DENOISE || fileCfg.comfyDenoise || 0.55),
  }
}

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
// ★★ 全局串行锁：同一时刻【只允许一个】图片生成请求。
//   踩过的坑（2026-10-21 01:16 实测）：一次 genSticker 会发出
//   1 次原始请求 + 3 次内联重试（3s/12s/27s）+ 后台队列再试，
//   而 Agnes 的队列本来就小 → 自己把自己的队列挤爆，永远 503。
//   现在所有调用（工具/后台队列/自动气泡）都走这个锁，串行执行。
let _genChain = Promise.resolve()
let _genBusy = 0
function withGenLock(fn) {
  const run = async () => {
    _genBusy++
    try { return await fn() } finally { _genBusy-- }
  }
  const p = _genChain.then(run, run)
  _genChain = p.catch(() => {})
  return p
}
export function genQueueState() { return { busy: _genBusy } }

async function _generateStickerImageInner({
  emotion, refImage, outDir, extra = '', style = '', size = 512, log = () => {},
}) {
  const cfg = loadImageConfig()
  const key = cfg.apiKey || resolveAgnesKey(cfg.keyRef)
  if (!key) throw new Error('没有 AGNES_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）')
  if (!refImage || !existsSync(refImage)) throw new Error('参考图不存在：' + refImage)

  const refB64 = readFileSync(refImage).toString('base64')
  const styleText = style || 'Q 版卡通贴纸风格，线条干净，色彩明快，主体清晰突出'
  // ★ 场景灵感（每次随机一个）：避免背景总是"家里 / 室内客厅"同一个样子。
  //   实测：只在提示词里写"房间/街道/户外"，模型会默认画室内客厅；
  //   给一个具体的场景灵感，背景才有变化。
  const SCENE_IDEAS = [
    '户外街边，有路灯和店铺招牌', '窗边的咖啡店，玻璃上有反光',
    '热闹的夜市，灯笼和小摊', '阳光下的公园草地，远处有树',
    '海边沙滩，有浪花和海鸥', '深夜的办公室，只亮着一盏台灯',
    '山顶看日落，天边一大片橘红', '老式厨房，挂着的锅铲和蒸汽',
    '地铁车厢里，车窗外的光带', '下雨的屋檐下，雨帘和水洼',
    '雪地里，脚下有脚印', '屋顶天台，城市的楼群在远处',
    '书堆成山的小房间，台灯发黄', '菜市场，摊位上堆满蔬果',
  ]
  const sceneIdea = extra ? '' : SCENE_IDEAS[Math.floor(Math.random() * SCENE_IDEAS.length)]
  // ★ 为什么这么写（2026-10-20 实测教训）：
  //   参考图本身是一张【完整场景 + 画框 + 气泡】的图。原来第一条写的是
  //   "画风必须与参考图完全一致"，图生图模型于是把【整张图】当基准照抄，
  //   背景/构图/姿势全被带走 → 生成出来的背景永远一样，而且永远是"家里"。
  //   所以现在：① 第一句就明确"参考图只用来定角色长相" ② 背景明确禁止默认室内
  //   ③ 每次给一个随机场景灵感，逼它换地方。
  const prompt = [
    `【角色（必须完全照这个画）】${CHARACTER_DESC}。`,
    '**画面里只能有这一个角色**（不要画成两个/多个人物）。',

    '**背景、构图、镜头、姿势、道具、光影全部重新设计**，必须与参考图完全不同；',
    '禁止出现任何画框、气泡、文字、摆件。',
    `【题材】${subjectPrompt(emotion)}。`,
    extra ? `【本次画面要求】${extra}。` : '',
    '【背景】必须为这个题材**新画一张**完整的场景，要有这个题材该有的道具和环境细节',
    '（例如：吃饭=摆满热菜的餐桌；加班=只剩一盏灯的深夜办公室）。',
    '**不要默认画成室内客厅 / 家里的沙发** —— 场景可以自由发挥：户外、街边、办公室、咖啡店、',
    '夜市、海边、山顶、雪地、菜市场、地铁……只要跟题材搭得上、有画面感就行。',
    sceneIdea ? `本次可以试试这个场景：**${sceneIdea}**。` : '',
    '背景要有层次但不能抢主体；**禁止纯白底，禁止只有人物悬浮在空背景上**。',
    '【构图】人物居中偏下，半身或七分身，头部和表情清晰可辨。',
    `【风格】${styleText}，整体像一张聊天里发的表情包。`,
    '【禁止】不要任何文字、字幕、水印、对话框、气泡。',
  ].filter(Boolean).join('')

  log(`图片生成(${cfg.mode})：${emotion}${extra ? '｜' + extra : ''}｜model=${cfg.model}｜${String(cfg.apiUrl).replace(/^https?:\/\//, '').slice(0, 40)}（参考图 ${Math.round(refB64.length / 1024)}KB base64）`)

  // 带退避的重试：Agnes 高峰期会返回 503 "image queue is full"，直接放弃会白丢一张表情
  const body = JSON.stringify({
    model: cfg.model,
    prompt,
    size: '1K',
    ratio: '1:1',
    // ★ 默认走 t2i（不传 image）：i2i 队列挤到不可用。想用图生图就设 IMAGE_MODE=i2i。
    extra_body: cfg.mode === 't2i'
      ? { response_format: 'url' }
      : { image: [`data:image/jpeg;base64,${refB64}`], response_format: 'url' },
  })
  let res = null
  let text = ''
  for (let attempt = 1; attempt <= 1; attempt++) {   // ★ 不再内联重试（会把自己队列挤爆），失败交给后台补生成队列
    res = await fetch(cfg.apiUrl, {
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

// ★ 释放 ComfyUI 显存：unload_models + free_memory
//   为什么：SDXL 权重约 3~4G，常驻会把 8G 卡吃满。每次出完图就踢掉，
//   下次再出时重新加载（冷启动 +10~30s，可接受）。
async function freeComfyVram(BASE, log = () => {}) {
  try {
    const r = await fetch(BASE + '/free', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(20_000),
    })
    if (r.ok) log('已释放显存（unload_models + free_memory）')
    else log('释放显存失败 HTTP ' + r.status)
  } catch (e) {
    log('释放显存异常：' + String(e?.message || e).slice(0, 80))
  }
}

// ★★ 本地 ComfyUI 后端（图生图）：上传参考图 → img2img → 拉回图片
//   为什么用它：Agnes 的 i2i 队列太窄（高峰期一直 503，熬 3 分钟都不通），
//   本机 ComfyUI 单卡单队列串行，实测 10 秒出图，且角色一致（参考图 + denoise 0.55）。
async function generateViaComfy({ emotion, refImage, outDir, extra = '', size = 512, log = () => {} }, cfg) {
  const BASE = String(cfg.comfyUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '')
  const fs = await import('node:fs')
  const pathmod = await import('node:path')

  // 0) 服务自检
  try {
    const r = await fetch(BASE + '/system_stats', { signal: AbortSignal.timeout(8000) })
    if (!r.ok) throw new Error('HTTP ' + r.status)
  } catch (e) {
    throw new Error('本地生图服务没启动（' + BASE + '）：双击 D:\\本地部署生图模型\\启动ComfyUI.bat。原始错误：' + String(e?.message || e))
  }

  // 1) 上传参考图（ComfyUI input 目录，幂等覆盖）
  const refName = 'dsh_ref.png'
  const refBuf = fs.readFileSync(refImage)
  const boundary = '----dsh' + Date.now()
  const parts = []
  for (const [k, v] of [['type', 'input'], ['overwrite', 'true']]) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + v + '\r\n'))
  }
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="image"; filename="' + refName + '"\r\nContent-Type: image/png\r\n\r\n'))
  parts.push(refBuf)
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'))
  const upRes = await fetch(BASE + '/upload/image', {
    method: 'POST', body: Buffer.concat(parts),
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    signal: AbortSignal.timeout(60_000),
  })
  if (!upRes.ok) throw new Error('上传参考图失败 HTTP ' + upRes.status)
  const upJson = await upRes.json()
  const uploaded = upJson?.name || refName

  // 2) 组装 img2img 工作流
  const subj = EN_EMOTION[emotion] || EN_ACTIVITY[emotion] || String(emotion || 'smile')
  // ★ 背景/动作可以自由发挥，只锁角色（用户要求）。
  //   注意：这里【绝不能】写 "white background / simple background" —— 那等于强制白底。
  const SCENES = [
    'outdoors, street, city lights', 'cafe, window seat, indoor',
    'night market, lanterns, food stalls', 'park, grass, sunny, cherry blossoms',
    'beach, ocean, waves', 'office at night, desk lamp',
    'mountain top, sunset, clouds', 'kitchen, steam, hanging pots',
    'subway train, window light', 'rainy street, umbrella, puddle',
    'snow field, footprints', 'rooftop, city skyline',
    'cozy room, books piled up, warm lamp', 'market, vegetable stalls',
  ]
  // extra 里如果已经描述了场景，就不再随机（以调用方为准）
  const sceneTag = extra ? '' : SCENES[Math.floor(Math.random() * SCENES.length)]
  // ★ 场景放最前面（SD 里越靠前权重越高）→ 保证背景真的按场景画
  //   角色细节靠 [参考图 img2img + 服装标签 maid outfit / white apron] 锁住
  const pos = [extra ? String(extra) : '', sceneTag,
    'detailed background, scenery, ' + subj,
    EN_CHARACTER,
    'masterpiece, best quality, very aesthetic, sticker']
    .filter(Boolean).join(', ')
  // ★★ 三种模式：
  //   ipadapter（推荐，默认）：t2i + IPAdapter 锁角色 —— 动作/背景随便变，角色细节由 IPAdapter 图"教"给模型。
  //       8G 显存下必须用 SD1.5（SDXL + IPAdapter + CLIP-ViT-H 会 OOM，实测崩过一次）
  //   i2i        ：img2img（参考图整图混合）—— 背景不太变得动，衣服容易漂
  //   inpaint    ：只重画背景 —— 角色 100% 不变但动作也变不了
  const MODE = String(cfg.comfyMode || 'ipadapter')
  let model = String(cfg.comfyModel || 'animagineXL40_opt.safetensors')
  if (MODE === 'ipadapter' && !/meinamix|sd15|v1-5/i.test(model)) {
    // 自动降级到 SD1.5，避免 8G 显存 OOM
    log(`IPAdapter 模式下 8G 显存用 SDXL 会 OOM → 改用 SD1.5（${model} → meinamix_v11）`)
    model = 'meinamix_v11.safetensors'
  }
  const isSd15 = /meinamix|sd15|v1-5/i.test(model)
  const w = isSd15 ? 512 : 832
  const h = isSd15 ? 768 : 1216
  let wf
  if (MODE === 'ipadapter') {
    wf = {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
      // IPAdapter 三件套：模型 + CLIP Vision + 参考图
      '20': { class_type: 'IPAdapterModelLoader', inputs: {
        ipadapter_file: String(cfg.ipadapterFile || 'ip-adapter-plus_sd15.safetensors') } },
      '21': { class_type: 'CLIPVisionLoader', inputs: {
        clip_name: String(cfg.clipVision || 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors') } },
      '10': { class_type: 'LoadImage', inputs: { image: uploaded } },
      '22': { class_type: 'IPAdapterAdvanced', inputs: {
        model: ['4', 0], ipadapter: ['20', 0], image: ['10', 0], clip_vision: ['21', 0],
        weight: Number(cfg.ipadapterWeight || 0.9), weight_type: 'linear',
        combine_embeds: 'concat', start_at: 0.0, end_at: 1.0, embeds_scaling: 'V only' } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: pos, clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: {
        // ★ 负面里显式排除会改发色的颜色词（实测 IPAdapter 权重不够时头发会变银/金）
        text: EN_NEGATIVE + ', silver hair, blonde hair, white hair, pink hair', clip: ['4', 1] } },
      '5': { class_type: 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: 1 } },
      '3': { class_type: 'KSampler', inputs: {
        seed: Math.floor(Math.random() * 1e9), steps: isSd15 ? 26 : 28, cfg: isSd15 ? 7.0 : 5.0,
        sampler_name: isSd15 ? 'dpmpp_2m' : 'euler_ancestral', scheduler: isSd15 ? 'karras' : 'normal',
        denoise: 1.0,
        model: ['22', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh_sticker', images: ['8', 0] } },
    }
  } else {
    wf = {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
      '10': { class_type: 'LoadImage', inputs: { image: uploaded } },
      '11': { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: pos, clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: EN_NEGATIVE, clip: ['4', 1] } },
      '3': { class_type: 'KSampler', inputs: {
        seed: Math.floor(Math.random() * 1e9), steps: isSd15 ? 26 : 28, cfg: isSd15 ? 7.0 : 5.0,
        sampler_name: isSd15 ? 'dpmpp_2m' : 'euler_ancestral', scheduler: isSd15 ? 'karras' : 'normal',
        denoise: Number(cfg.comfyDenoise || 0.55),
        model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['11', 0] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh_sticker', images: ['8', 0] } },
    }
  }
  log(`本地出图(${MODE})：${emotion}｜model=${model}｜${w}x${h}｜IP权重=${cfg.ipadapterWeight || 0.9}`)

  // 3) 提交 + 轮询
  const subRes = await fetch(BASE + '/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: wf }), signal: AbortSignal.timeout(30_000),
  })
  const subJson = await subRes.json()
  if (!subRes.ok || !subJson?.prompt_id) {
    throw new Error('提交失败：' + JSON.stringify(subJson?.node_errors || subJson).slice(0, 300))
  }
  const pid = subJson.prompt_id
  let img = null
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 1500))
    const hr = await fetch(BASE + '/history/' + pid, { signal: AbortSignal.timeout(20_000) })
    const hj = await hr.json()
    const ent = hj?.[pid]
    if (!ent) continue
    if (ent.status?.status_str === 'error') {
      throw new Error('本地出图报错：' + JSON.stringify(ent.status?.messages || '').slice(0, 300))
    }
    for (const k of Object.keys(ent.outputs || {})) {
      if (ent.outputs[k]?.images?.length) { img = ent.outputs[k].images[0]; break }
    }
    break
  }
  if (!img) { await freeComfyVram(BASE, log); throw new Error('本地出图超时（4 分钟内没出图）') }

  // 4) 拉图
  const qs = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: 'output' })
  const vRes = await fetch(BASE + '/view?' + qs, { signal: AbortSignal.timeout(120_000) })
  if (!vRes.ok) throw new Error('取图失败 HTTP ' + vRes.status)
  const buf = Buffer.from(await vRes.arrayBuffer())

  fs.mkdirSync(outDir, { recursive: true })
  const rawPath = pathmod.join(outDir, 'comfy-' + String(emotion).replace(/[\\/:*?"<>|]/g, '_') + '-' + Date.now() + '.png')
  fs.writeFileSync(rawPath, buf)

  // 5) 缩到表情包尺寸
  try {
    const { Jimp } = await import('jimp')
    const im = await Jimp.read(rawPath)
    im.resize({ w: size, h: size })
    const out = rawPath.replace(/\.png$/, '.jpg')
    fs.writeFileSync(out, await im.getBuffer('image/jpeg', { quality: 88 }))
    try { fs.unlinkSync(rawPath) } catch { }
    log('本地出图完成：' + out + '（' + Math.round(fs.statSync(out).size / 1024) + 'KB）')
    // ★ 用完立刻释放显存（用户要求：不想让大模型常驻占着 3~4G）
    await freeComfyVram(BASE, log)
    return { file: out, raw: out, url: BASE + '/view?filename=' + encodeURIComponent(img.filename) }
  } catch (e) {
    log('缩图失败（直接用原图）：' + String(e?.message || e).slice(0, 80))
    return { file: rawPath, raw: rawPath, url: '' }
  }
}

// 导出包装：所有调用都串行化
export function generateStickerImage(opts) {
  const cfg = loadImageConfig()
  if (String(cfg.backend || '').toLowerCase() === 'comfy') {
    return withGenLock(() => generateViaComfy(opts, cfg))
  }
  return withGenLock(() => _generateStickerImageInner(opts))
}
