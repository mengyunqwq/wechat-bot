/**
 * Web 控制面板的配置元数据。
 *
 * 为什么单独一份：配置项有 90+ 个，散在 DEFAULT_CONFIG 里只有类型信息，
 * 没有「叫什么、放哪组、范围多少、能不能乱改」。面板靠这份表生成界面 + 做校验，
 * 新增配置时只要在 DEFAULT_CONFIG 和这里各加一行，面板自动出现。
 *
 * type:
 *   bool      开关
 *   number    数字（min/max/step/unit）
 *   text      单行文本
 *   textarea  多行文本
 *   enum      下拉（options）
 *   csv       逗号分隔数组
 *   quiet     时段字符串（"23:00-08:00"）
 *   map       对象（memberNames，面板单独渲染）
 *
 * risk: normal | warn | high | critical
 */

export const GROUPS = [
  { id: 'reply', title: '回复节奏', icon: '💬', desc: '什么时候回、回多快、一次聊多久' },
  { id: 'proactive', title: '主动行为', icon: '🌱', desc: '没人说话时自己冒泡、睡前晚安/醒来说早' },
  { id: 'moment', title: '朋友圈', icon: '📸', desc: '自己发朋友圈：频率、时段、每天上限、文案由 AI 写' },
  { id: 'style', title: '说话方式', icon: '🗣', desc: '拆句、@、拍一拍、敷衍' },
  { id: 'sticker', title: '表情包', icon: '😄', desc: '补图概率、现场生成、题材库' },
  { id: 'vision', title: '识图与视频', icon: '🖼', desc: '图片、表情包、群视频' },
  { id: 'link', title: '链接视频', icon: '🔗', desc: '分享的抖音/B站/小红书链接' },
  { id: 'douyin', title: '抖音', icon: '🎵', desc: '只读刷推荐，挑一条分享' },
  { id: 'voiceIn', title: '语音识别（听）', icon: '🎧', desc: '群里语音 → 文字' },
  { id: 'voiceOut', title: '语音发送（说）', icon: '🎙', desc: '把回复合成微信语音气泡' },
  { id: 'memory', title: '记忆与检索', icon: '🧠', desc: '上下文、长期记忆、历史查询' },
  { id: 'identity', title: '群与人', icon: '👥', desc: '群白名单、昵称、成员名字' },
  { id: 'model', title: '人设与模型', icon: '🐟', desc: '人格、模型、温度、长度' },
  { id: 'health', title: '健康告警', icon: '❤️', desc: '失联监控与告警' },
  { id: 'selfheal', title: '自愈（高危）', icon: '🚨', desc: '仅 hook 死锁时自动重启客户端' },
  { id: 'pet', title: '桌宠联动', icon: '🐟', desc: '桌面上的大肥鱼跟着做动作' },
  { id: 'advanced', title: '高级/接入', icon: '🔧', desc: '桥地址、日志与记忆目录' },
]

/** key → 元数据。顺序即界面顺序。 */
export const CONFIG_META = {
  // ── 回复节奏 ────────────────────────────────────────────────
  replyProbability: {
    group: 'reply', label: '闲聊插话概率', type: 'number', min: 0, max: 1, step: 0.01,
    help: '没被叫到时主动插话的概率。越低越"潜水"，0.8 = 很爱插话。',
  },
  minReplyGapMs: {
    group: 'reply', label: '同群最小回复间隔', type: 'number', min: 0, max: 600000, step: 500, unit: 'ms',
    help: '两次回复之间至少隔这么久，防止刷屏。对话延续时只要求 2 秒。',
  },
  maxRepliesPer10Min: {
    group: 'reply', label: '10 分钟回复上限', type: 'number', min: 0, max: 200, step: 1, unit: '条',
    help: '同一个群 10 分钟内最多回几条；太大会像客服。',
  },
  debounceMs: {
    group: 'reply', label: '连发合并窗口', type: 'number', min: 0, max: 10000, step: 100, unit: 'ms',
    help: '群里连续发几条时，等这么久合并成一批再判断，避免每条都回。',
  },
  quietHours: {
    group: 'reply', label: '安静时段', type: 'quiet',
    help: '睡觉时段不主动插话（被@仍可回，见 quietAllow）。格式 23:00-08:00。',
  },
  quietAllow: {
    group: 'reply', label: '安静时段仍回应', type: 'csv', options: ['at', 'name'],
    help: '逗号分隔：at=被@，name=被点名。留空 = 彻底静音。',
  },
  quietAllowAt: {
    group: 'reply', label: '（旧）安静时仍回@', type: 'bool', advanced: true,
    help: '旧配置的兼容项；建议只用上面的 quietAllow。',
  },
  repeatWindowMs: {
    group: 'reply', label: '同句防重复窗口', type: 'number', min: 0, max: 86400000, step: 60000, unit: 'ms',
    help: '同一句话在这个时间内回过就不再回。',
  },
  conversationWindowMs: {
    group: 'reply', label: '对话延续窗口', type: 'number', min: 0, max: 86400000, step: 60000, unit: 'ms',
    help: '对方在这个时间内又说话，视为"还在聊"，更容易接话。',
  },
  continuationChance: {
    group: 'reply', label: '对话延续必回概率', type: 'number', min: 0, max: 1, step: 0.05,
    help: '1 = 聊起来就一直回。',
  },
  maxConsecutiveTurns: {
    group: 'reply', label: '连续对聊轮数上限', type: 'number', min: 0, max: 200, step: 1, unit: '轮',
  },
  cannedChance: {
    group: 'reply', label: '敷衍回复概率', type: 'number', min: 0, max: 1, step: 0.01,
    help: '按概率直接回"哈哈/确实/6"这类低信息量短句。默认 0（交给模型判断）。',
  },
  pendingQuestionWaitMs: {
    group: 'reply', label: '待答问题等待时长', type: 'number', min: 0, max: 86400000, step: 60000, unit: 'ms', advanced: true,
    help: '问过的问题在这期间不再重复追问。',
  },
  contextMessages: {
    group: 'memory', label: '每次带多少条上下文', type: 'number', min: 0, max: 100, step: 1, unit: '条',
  },
  backfillLimit: {
    group: 'memory', label: '重启后回补条数', type: 'number', min: 0, max: 100, step: 1, unit: '条', advanced: true,
  },

  // ── 主动行为 ────────────────────────────────────────────────
  proactive: {
    group: 'proactive', label: '主动找话题', type: 'bool',
    help: '群里安静一段时间后自己冒个泡，不做"只应答的客服"。',
  },
  // ── 朋友圈（2026-10-26）：让自己发朋友圈，频率/时段/每日上限都可调 ──
  momentAuto: {
    group: 'moment', label: '自动发朋友圈', type: 'bool',
  },
  momentUseLLM: {
    group: 'moment', label: '文案由 AI 写', type: 'bool',
  },
  momentMinGapMs: {
    group: 'moment', label: '最短间隔', type: 'number', min: 600000, max: 86400000, step: 600000, unit: 'ms',
  },
  momentMaxGapMs: {
    group: 'moment', label: '最长间隔（区间随机）', type: 'number', min: 600000, max: 172800000, step: 600000, unit: 'ms',
  },
  momentDailyMax: {
    group: 'moment', label: '每天最多', type: 'number', min: 1, max: 12, step: 1, unit: '条',
  },
  momentHours: {
    group: 'moment', label: '允许时段', type: 'text',
  },
  momentCheckMs: {
    group: 'moment', label: '检查间隔', type: 'number', min: 60000, max: 3600000, step: 60000, unit: 'ms',
  },
  momentTopic: {
    group: 'moment', label: '文案风格提示', type: 'text',
  },
  momentNotifyRoom: {
    group: 'moment', label: '发完在群里吱一声', type: 'text',
  },
  momentAutoImage: {
    group: 'moment', label: '自动配图', type: 'bool',
    help: '开启后：发之前先配一张图（来源见下一项）；配图失败自动退回纯文字',
  },
  momentImageSource: {
    group: 'moment', label: '配图方式', type: 'enum', options: ['char', 'ai', 'web'],
    help: 'char = 图生图（锁「蓝色大肥鱼」形象，约 20 秒，推荐）；ai = 文生图（不锁角色，可能不是她）；web = 网上随机动漫图（不保证是她）',
  },
  momentImageStyle: {
    group: 'moment', label: '配图风格提示', type: 'text',
    help: '给生图的风格要求，例如「生活感照片，真实质感，自然光」',
  },
  momentImageRatio: {
    group: 'moment', label: '配图画幅', type: 'enum', options: ['1:1', '4:3', '3:4', '16:9', '9:16'],
  },
  momentFromChat: {
    group: 'moment', label: '群聊事件触发', type: 'bool',
    help: '开启后：群里出现好玩的梗/名场面/温情时刻，AI 判断值得才发（比定时更自然）',
  },
  momentChatMinScore: {
    group: 'moment', label: '事件门槛（越高越挑）', type: 'number', min: 1, max: 10, step: 1, unit: '分',
  },
  momentChatLookback: {
    group: 'moment', label: '评估看多少条消息', type: 'number', min: 8, max: 60, step: 1, unit: '条',
  },
  momentChatDebounceMs: {
    group: 'moment', label: '群里安静多久再评估', type: 'number', min: 15000, max: 600000, step: 15000, unit: 'ms',
  },
  momentChatCooldownMs: {
    group: 'moment', label: '同群评估冷却', type: 'number', min: 300000, max: 21600000, step: 300000, unit: 'ms',
  },
  momentChatRooms: {
    group: 'moment', label: '只看这些群（空=全部）', type: 'csv',
  },
  proactiveQuietMs: {
    group: 'proactive', label: '安静多久才考虑', type: 'number', min: 60000, max: 86400000, step: 60000, unit: 'ms',
  },
  proactiveMinGapMs: {
    group: 'proactive', label: '同群主动最小间隔', type: 'number', min: 60000, max: 86400000, step: 60000, unit: 'ms',
  },
  proactiveChance: {
    group: 'proactive', label: '每次检查触发概率', type: 'number', min: 0, max: 1, step: 0.05,
  },
  proactiveMaxStreak: {
    group: 'proactive', label: '连续没人理就停', type: 'number', min: 0, max: 10, step: 1, unit: '次',
  },
  proactiveCheckMs: {
    group: 'proactive', label: '检查间隔', type: 'number', min: 30000, max: 3600000, step: 30000, unit: 'ms',
  },
  proactiveHours: {
    group: 'proactive', label: '允许主动的时段', type: 'quiet',
    help: '只在这个时间段主动冒泡，例如 08:00-23:00。',
  },
  sleepAnnounce: {
    group: 'proactive', label: '睡前晚安 / 醒来说早', type: 'bool',
    help: '每群每天各一次，且群里最近有人说话才说。',
  },
  sleepAnnounceWindowMs: {
    group: 'proactive', label: '问候前的活跃窗口', type: 'number', min: 60000, max: 86400000, step: 60000, unit: 'ms',
    help: '群里这么久内有人说话，才值得说晚安/早安。',
  },

  // ── 说话方式 ────────────────────────────────────────────────
  splitChance: {
    group: 'style', label: '拆成两条发的概率', type: 'number', min: 0, max: 1, step: 0.01,
  },
  maxLines: {
    group: 'style', label: '一条回复最多拆几条', type: 'number', min: 1, max: 10, step: 1, unit: '条',
  },
  maxPartsLimit: {
    group: 'style', label: '长文本最多拆几条', type: 'number', min: 1, max: 20, step: 1, unit: '条', advanced: true,
  },
  splitHardMax: {
    group: 'style', label: '短文本每段硬上限', type: 'number', min: 10, max: 200, step: 5, unit: '字', advanced: true,
  },
  longBubbleMax: {
    group: 'style', label: '长回答每段放宽到', type: 'number', min: 20, max: 500, step: 10, unit: '字', advanced: true,
  },
  laterMaxMinutes: {
    group: 'style', label: '[稍后:N] 分钟上限', type: 'number', min: 0, max: 120, step: 5, unit: '分钟', advanced: true,
  },

  allowAt: {
    group: 'style', label: '允许真 @ 别人', type: 'bool',
    help: '正文写 "@群昵称" 并把 wxid 传给桥填 atlist，对方才会收到红点提醒。',
  },
  atChance: {
    group: 'style', label: '真带 @ 的概率', type: 'number', min: 0, max: 1, step: 0.05,
    help: '想 @ 别人时，真的带上 @ 的概率，别每条都 @。',
  },

  // ── 表情包 ──────────────────────────────────────────────────
  voiceImageExclusive: {
    group: 'voice', label: '语音/图片互斥', type: 'bool',
    help: '同一轮回复里不同时发语音和表情包/图片。客户端在两条媒体发送连着触发时会偶发崩溃，'
      + '默认开；关掉就恢复"发完语音再补一张表情包"。',
  },
  stickerChance: {
    group: 'sticker', label: '文字后补表情包概率', type: 'number', min: 0, max: 1, step: 0.01,
  },
  genStickerChance: {
    group: 'sticker', label: '现场生成（而非用现成图）', type: 'number', min: 0, max: 1, step: 0.01,
  },
  genActivities: {
    group: 'sticker', label: '活动题材库', type: 'csv',
    help: '生成表情包时可用的生活场景，逗号分隔。',
  },
  genEmotions: {
    group: 'sticker', label: '情绪题材库', type: 'csv',
    help: '生成表情包时可用的情绪，逗号分隔。',
  },

  // ── 识图与视频 ──────────────────────────────────────────────
  visionOnImage: {
    group: 'vision', label: '收到图片时识图', type: 'bool',
  },
  visionOnEmoticon: {
    group: 'vision', label: '表情包也识图', type: 'bool',
    help: '关掉可省视觉调用（表情包含义通常固定）。',
  },
  imageReplyProbability: {
    group: 'vision', label: '看到图后回话概率', type: 'number', min: 0, max: 1, step: 0.05,
  },
  visionProvider: {
    group: 'vision', label: '视觉模型 provider', type: 'text', advanced: true,
    help: '识图/识视频用。留空 = 与上面的主模型相同。',
  },
  visionModel: {
    group: 'vision', label: '视觉模型 id', type: 'text', advanced: true,
    help: '下拉只列「能读图」的模型（inputModalities 含 image）。留空 = 用主模型。',
  },
  visionCacheMax: {
    group: 'vision', label: '识图缓存条数', type: 'number', min: 0, max: 5000, step: 10, unit: '条', advanced: true,
  },
  visionOnVideo: {
    group: 'vision', label: '收到视频时识内容', type: 'bool',
    help: '抽帧拼联系表 + 抽音轨转文字；拿不到文件退回封面。',
  },
  videoFrames: {
    group: 'vision', label: '视频抽几帧', type: 'number', min: 1, max: 12, step: 1, unit: '帧',
  },
  videoDeleteAfterRead: {
    group: 'vision', label: '看完删视频原文件', type: 'bool',
    help: '省磁盘；下次在微信里点开会重新下载。',
  },
  videoUpgradeDelayMs: {
    group: 'vision', label: '只有封面时延迟复查', type: 'number', min: 1000, max: 600000, step: 1000, unit: 'ms', advanced: true,
  },
  videoUpgradeMaxTries: {
    group: 'vision', label: '延迟复查次数', type: 'number', min: 0, max: 5, step: 1, unit: '次', advanced: true,
  },
  videoUpgradeFollowUp: {
    group: 'vision', label: '升级后补一句', type: 'bool', advanced: true,
  },

  // ── 桌宠联动（dsh-pet：桌面上的蓝色大肥鱼）──────────────────────
  //  她才是本体，微信只是她干活的手：收消息→表情，思考/回完→动作，出错→叹气。
  petSync: {
    group: 'pet', label: '桌宠联动开关', type: 'bool',
    help: '开着时，桌面上的蓝色大肥鱼会跟着群里的事做表情/动作（需要装 dsh-pet 插件）。',
  },
  petSyncBaseUrl: {
    group: 'pet', label: '桌宠接口地址', type: 'text', advanced: true,
    help: '默认 http://127.0.0.1:3080 —— 即 DSH 网页端地址；改过端口就填新的。',
  },
  petSyncPetId: {
    group: 'pet', label: '桌宠 id', type: 'text', advanced: true,
    help: '默认 main（dsh-pet 配置里 pets[].id）',
  },
  petSyncSurface: {
    group: 'pet', label: '显示端', type: 'enum', options: ['desktop', 'web', 'both', 'any'], advanced: true,
    help: 'desktop = 桌面宠物（默认）；web = 网页里那只',
  },
  petSyncMinGapMs: {
    group: 'pet', label: '动作最短间隔', type: 'number', min: 500, max: 60000, step: 100, unit: 'ms',
    help: '防止群里连续几条消息时她疯狂抽搐',
  },
  petSyncAnimOnReceive: {
    group: 'pet', label: '收到消息时', type: 'text',
    help: '动作素材名（见 dsh-pet assets/webm），如：点击回应-害羞惊讶',
  },
  petSyncAnimOnThinking: {
    group: 'pet', label: '思考时', type: 'text',
    help: '如：工作状态-思考冒泡',
  },
  petSyncAnimOnSent: {
    group: 'pet', label: '回复后', type: 'text',
    help: '如：工作状态-雀跃庆祝',
  },
  petSyncAnimOnError: {
    group: 'pet', label: '出错时', type: 'text',
    help: '如：工作状态-垂头叹气冒汗',
  },

  // ── 链接视频 ────────────────────────────────────────────────
  linkVideo: {
    group: 'link', label: '识别群里的视频链接', type: 'bool', risk: 'warn',
    help: '抖音/B站/小红书/微博链接 → 下载 → 抽帧看懂。会耗流量。',
  },
  linkVideoProbability: {
    group: 'link', label: '处理概率', type: 'number', min: 0, max: 1, step: 0.05,
  },
  linkVideoMaxSeconds: {
    group: 'link', label: '视频时长上限', type: 'number', min: 5, max: 3600, step: 5, unit: '秒',
  },
  linkVideoMaxMB: {
    group: 'link', label: '文件大小上限', type: 'number', min: 1, max: 1024, step: 1, unit: 'MB',
  },
  linkVideoCooldownMs: {
    group: 'link', label: '同群冷却', type: 'number', min: 0, max: 3600000, step: 1000, unit: 'ms',
  },
  linkVideoTimeoutMs: {
    group: 'link', label: '下载超时', type: 'number', min: 5000, max: 600000, step: 1000, unit: 'ms', advanced: true,
  },
  linkVideoFrames: {
    group: 'link', label: '抽帧数', type: 'number', min: 0, max: 12, step: 1, unit: '帧',
  },
  linkVideoFps: {
    group: 'link', label: '每秒抽几帧（链接视频）', type: 'number', min: 0.2, max: 4, step: 0.2, unit: '帧/秒',
    help: '默认 1（每秒一帧）。每 20 帧拼一张联系表，长视频会分成多张逐张识别。调高更细但更慢更费。',
  },
  videoFps: {
    group: 'vision', label: '每秒抽几帧（微信视频）', type: 'number', min: 0.2, max: 4, step: 0.2, unit: '帧/秒',
    help: '同上，作用于微信里直接发的视频。',
  },

  // ── 抖音 ────────────────────────────────────────────────────
  douyinShare: {
    group: 'douyin', label: '自动刷抖音并分享', type: 'bool', risk: 'high',
    help: '只读（不点赞/不评论/不关注/不私信）。会启动 Playwright，耗 CPU 与流量。',
  },
  douyinShareIntervalMs: {
    group: 'douyin', label: '最短间隔', type: 'number', min: 60000, max: 86400000, step: 60000, unit: 'ms',
  },
  douyinBrushCount: {
    group: 'douyin', label: '每次刷几条候选', type: 'number', min: 1, max: 20, step: 1, unit: '条',
  },
  douyinShareMaxPerDay: {
    group: 'douyin', label: '每天最多分享', type: 'number', min: 0, max: 50, step: 1, unit: '条',
  },

  // ── 语音识别 ────────────────────────────────────────────────
  voiceOnVoice: {
    group: 'voiceIn', label: '收到语音时转文字', type: 'bool',
  },
  voiceLanguage: {
    group: 'voiceIn', label: '语言提示', type: 'enum', options: ['auto', 'zh', 'en', 'yue', 'ja', 'ko'],
  },
  voiceMaxSeconds: {
    group: 'voiceIn', label: '最长转写秒数', type: 'number', min: 1, max: 600, step: 1, unit: '秒',
  },
  voiceCacheMax: {
    group: 'voiceIn', label: '转写缓存条数', type: 'number', min: 0, max: 5000, step: 10, unit: '条', advanced: true,
  },
  voiceAutoPrepare: {
    group: 'voiceIn', label: '模型未就绪时自动准备', type: 'bool',
    help: '首次需要下载约 239MB 的本地 SenseVoice 模型。',
  },
  voicePrepareWaitMs: {
    group: 'voiceIn', label: '等模型准备上限', type: 'number', min: 1000, max: 600000, step: 1000, unit: 'ms', advanced: true,
  },
  voiceProvider: {
    group: 'voiceIn', label: '语音识别 provider', type: 'text', advanced: true,
  },

  // ── 语音发送 ────────────────────────────────────────────────
  voiceSay: {
    group: 'voiceOut', label: '可以发微信语音气泡', type: 'bool', risk: 'warn',
    help: '需要 hook 侧语音发送开关打开（面板会显示状态）。关着时自动降级发文字。',
  },
  voiceSayProbability: {
    group: 'voiceOut', label: '普通回复改语音概率', type: 'number', min: 0, max: 1, step: 0.05,
  },
  voiceSayOnVoiceProbability: {
    group: 'voiceOut', label: '收到语音时用语音回概率', type: 'number', min: 0, max: 1, step: 0.05,
  },
  voiceSayMaxChars: {
    group: 'voiceOut', label: '超过多少字改文字', type: 'number', min: 1, max: 300, step: 5, unit: '字',
  },

  // ── 记忆与检索 ──────────────────────────────────────────────
  memoryExtract: {
    group: 'memory', label: '定期提炼长期记忆', type: 'bool',
    help: '从群聊里提炼事实，本地保存，每次对话都带上。',
  },
  memoryV2: {
    group: 'memory', label: '记忆 v2（遗忘曲线）', type: 'bool',
    help: '开=按艾宾浩斯遗忘曲线管理：越用越牢、情绪强的记得久、低权重自动归档。关=退回旧的"取最后 18 条"。',
  },
  memoryCrossGroup: {
    group: 'memory', label: '跨群边界', type: 'select',
    options: [['safe', '安全（人事可跨群、事件只在本群）'], ['none', '严格（只用本群）'], ['all', '完全互通（会串群）']],
    help: '记忆库是全局的，但"别的群发生的事"不该在本群说出来。safe=关于人的认知可跨群（群名会被抹掉），事件只在本群。',
  },
  memoryBaseDays: {
    group: 'memory', label: '基准半衰天数', type: 'number', min: 0.5, max: 90, step: 0.5, unit: '天',
    help: '初始强度基准。越大越不容易忘（7 天 ≈ 第 7 天记起概率 37%，第 14 天 13%）。',
  },
  memoryForgetWeight: {
    group: 'memory', label: '遗忘权重阈值', type: 'number', min: 0.005, max: 0.3, step: 0.005,
    help: '判据是「保持率 R × 重要度」：低于这个值就归档（真正的"忘掉权重低的"）。默认 0.06。',
  },
  memoryKeepImportance: {
    group: 'memory', label: '铁律记忆阈值', type: 'number', min: 0.5, max: 1, step: 0.05,
    help: '重要度达到这个值 = 铁律记忆（身份/约定/承诺），永不自动归档、也不被容量淘汰。默认 0.85。',
  },
  memoryMinAgeDays: {
    group: 'memory', label: '最短保留天数', type: 'number', min: 0.5, max: 30, step: 0.5, unit: '天',
    help: '不到这个天数的记忆不会被归档（防止"刚记下还没用过就被判死刑"）。',
  },
  memoryArchiveGraceDays: {
    group: 'memory', label: '归档保留天数', type: 'number', min: 1, max: 365, step: 1, unit: '天',
    help: '归档后多久才真正删除（期间可恢复）。',
  },
  memoryMaxActive: {
    group: 'memory', label: '每群生效上限', type: 'number', min: 20, max: 500, step: 10, unit: '条',
    help: '超过后按 保持率×重要度 淘汰最低的进归档（不再按时间硬截）。',
  },
  memoryInjectCount: {
    group: 'memory', label: '每次注入条数', type: 'number', min: 3, max: 30, step: 1, unit: '条',
    help: '每次对话按相关度/重要度/情绪检索出这么多条带进提示词。',
  },
  memoryEmotionBoost: {
    group: 'memory', label: '情绪加成', type: 'number', min: 0, max: 3, step: 0.1,
    help: '情绪强度对初始记忆强度的放大上限（越高，情绪强烈的记忆越难忘）。',
  },
  memoryRecallGamma: {
    group: 'memory', label: '复习增益 γ', type: 'number', min: 0, max: 3, step: 0.1,
    help: '被用到一次时强度增长系数。快忘时复习收益更大（间隔效应）。',
  },
  memoryPinnedMax: {
    group: 'memory', label: '固定记忆必带条数', type: 'number', min: 0, max: 10, step: 1, unit: '条',
    help: '手动固定的记忆每次必带（上限，防止固定太多把预算吃满）。',
  },
  memoryConsolidate: {
    group: 'memory', label: '遗忘巡检频率', type: 'enum', options: ['off', 'daily', 'hourly'],
    help: 'daily=每 6 小时分散跑一次；hourly=每小时；off=不自动跑（面板仍可手动巡检）。',
  },
  historyLookup: {
    group: 'memory', label: '提起往事时查微信历史', type: 'bool',
    help: '本地查询，0 token。',
  },
  historyLimit: {
    group: 'memory', label: '最多带几条历史', type: 'number', min: 0, max: 20, step: 1, unit: '条',
  },
  historyScan: {
    group: 'memory', label: '历史最多回溯条数', type: 'number', min: 0, max: 5000, step: 100, unit: '条', advanced: true,
  },

  // ── 群与人 ──────────────────────────────────────────────────
  rooms: {
    group: 'identity', label: '群白名单', type: 'csv',
    help: '留空 = 所有群；填 roomId 则只在这些群工作。',
  },
  allowPrivate: {
    group: 'identity', label: '允许私聊回复', type: 'bool',
    help: '只在对方先说话时回，绝不主动私发。',
  },
  botName: {
    group: 'identity', label: '机器人群昵称', type: 'text', risk: 'warn',
    help: '必须与它在微信里的群昵称完全一致，否则"被@必回"识别不出来。',
  },
  aliases: {
    group: 'identity', label: '别名/简称', type: 'csv',
    help: '文本里出现任意一个就算在叫它。',
  },
  masterName: {
    group: 'identity', label: '唯一可叫"主人"的人', type: 'text',
  },
  useDbMembers: {
    group: 'identity', label: '用数据库里的真实群成员名', type: 'bool',
  },

  // ── 性格（内心）──────────────────────────────────────────
  personaEnabled: {
    group: 'persona', label: '性格系统总开关', type: 'bool',
    help: '关掉后只剩人设文案：没有心情/精力/好恶/目标/日记/自传，行为完全回到旧版。',
  },
  personaSelfNarrative: {
    group: 'persona', label: '让她自己写自传', type: 'bool',
    help: '开 = 她会根据经历重写「我是个什么样的人」。身份与底线（人设）永远锁死，她改不了。',
  },
  personaDiaryHours: {
    group: 'persona', label: '日记节奏', type: 'number', min: 0, max: 168, step: 1, unit: '小时',
    help: '多久写一篇自己的日记。默认 24（每天一篇）；0 = 不写。',
  },
  personaNarrativeHours: {
    group: 'persona', label: '自传节奏', type: 'number', min: 0, max: 168, step: 1, unit: '小时',
    help: '多久允许重写一次自传。默认 24（每天一篇）。',
  },
  personaNarrativeMinDiaries: {
    group: 'persona', label: '重写自传所需新日记', type: 'number', min: 0, max: 10, step: 1, unit: '篇',
    help: '至少攒够几篇新日记才重写。日记每天一篇时填 1。',
  },
  personaNarrativeMaxDrift: {
    group: 'persona', label: '自传最大变化', type: 'number', min: 0, max: 1, step: 0.05,
    help: '与上一版相似度低于此值就拒绝（防人格突变）。默认 0.30；被拒会自动按上一版重试一次。',
  },
  personaFeedback: {
    group: 'persona', label: '反馈驱动漂移', type: 'bool',
    help: '开 = 按真实反应（被夸/被接话/被怼/被无视）慢慢调整她的说话倾向。风险最高的一项，建议先开着看日志。',
  },
  personaEnergyBasePerMin: {
    group: 'persona', label: '精力负荷基准', type: 'number', min: 1, max: 60, step: 1, unit: '条/分',
    help: '单个群时，每分钟多少条算满负荷。群越多容量自动变大（见下一项）。',
  },
  personaEnergyRoomBonus: {
    group: 'persona', label: '每多一个群容量加成', type: 'number', min: 0, max: 2, step: 0.1,
    help: '默认 0.6 = 每多一个活跃群，每分钟可处理量 +60%（群多不等于更累）。',
  },

  // ── 人设与模型 ──────────────────────────────────────────────
  persona: {
    group: 'model', label: '人设', type: 'textarea',
    help: '每次对话都会带上。改完立即生效。',
  },
  outboxMinGapMs: {
    group: 'ops', label: '出站最小间隔（毫秒）', type: 'number', min: 0, max: 10000, step: 100,
    help: '同一个群两条消息至少隔这么久。太小容易连发（连发语音曾把客户端送走过）。',
  },
  outboxMaxPerMin: {
    group: 'ops', label: '每分钟最多发几条', type: 'number', min: 1, max: 120, step: 1,
    help: '全局上限，防止刷屏。',
  },
  outboxMaxAttempts: {
    group: 'ops', label: '失败重试次数', type: 'number', min: 1, max: 6, step: 1,
    help: '发送失败后重试几次（指数退避）。',
  },
  personaExamples: {
    group: 'model', label: '示例对话（学味道，最有效）', type: 'textarea',
    help: '格式：一行"别人：…"一行"她：…"，空行分隔。模型模仿示例比遵守形容词有效得多。',
  },
  personaLore: {
    group: 'model', label: '世界书（关键词→设定）', type: 'textarea',
    help: '一行一条：「关键词1/关键词2 | 设定内容」。只有聊天里出现关键词时才注入，省 token。',
  },
  provider: {
    group: 'model', label: '模型 provider', type: 'text',
    help: '下拉里只列 DSH 已注册（配好 key）的 provider；留空 = 跟随 DSH 当前选择。',
  },
  model: {
    group: 'model', label: '模型 id', type: 'text',
    help: '下拉会跟着上面的 provider 变；留空 = 用该 provider 的默认模型。选「自定义」可手填清单里没有的 id。',
  },
  temperature: {
    group: 'model', label: 'temperature', type: 'number', min: 0, max: 2, step: 0.05,
  },
  maxTokens: {
    group: 'model', label: '输出 token 上限', type: 'number', min: 64, max: 8192, step: 64,
    help: '太小会出现"只有推理、没有正文"的空回复。',
  },
  maxReplyChars: {
    group: 'model', label: '回复字数上限（0=不限）', type: 'number', min: 0, max: 2000, step: 10, unit: '字',
  },
  reasoningEffort: {
    group: 'model', label: '推理档位', type: 'enum', options: ['', 'low', 'medium', 'high'],
    help: '留空最稳；部分模型拒绝 off/low，会直接报错。',
  },

  // ── 健康告警 ────────────────────────────────────────────────
  healthAlert: {
    group: 'health', label: '失联时发告警', type: 'bool',
    help: '往 filehelper 发一句人话；关掉只写日志。',
  },
  healthAlertQuietMs: {
    group: 'health', label: '同类告警最小间隔', type: 'number', min: 0, max: 86400000, step: 60000, unit: 'ms',
  },
  healthCheckMs: {
    group: 'health', label: '心跳间隔', type: 'number', min: 30000, max: 3600000, step: 30000, unit: 'ms',
  },

  // ── 自愈 ────────────────────────────────────────────────────
  selfHeal: {
    group: 'selfheal', label: '启用受限自愈', type: 'bool', risk: 'critical',
    help: '仅在「hook 死锁」特征下、白天、每天最多 1 次，用安全脚本正常关/开客户端，绝不强杀。',
  },
  selfHealScript: {
    group: 'selfheal', label: '自愈脚本路径', type: 'text', risk: 'high',
  },
  selfHealBridgeDir: {
    group: 'selfheal', label: 'wx-bridge 目录', type: 'text', risk: 'high',
  },
  selfHealWeChatDir: {
    group: 'selfheal', label: '微信客户端目录', type: 'text', risk: 'high',
  },
  selfHealMaxPerDay: {
    group: 'selfheal', label: '每天最多自愈几次', type: 'number', min: 0, max: 10, step: 1, unit: '次', risk: 'high',
  },

  // ── 高级/接入 ───────────────────────────────────────────────
  bridgeUrl: {
    group: 'advanced', label: '桥 WebSocket 地址', type: 'text', restart: 'plugin',
    help: '改完保存到配置，但需要重载插件才生效。',
  },
  autoOpenPanel: {
    group: 'advanced', label: '桥连上时自动打开面板', type: 'bool', def: true,
    help: '微信登录成功（桥连上）后自动用默认浏览器打开控制面板。关掉就不弹。',
  },
  panelUrl: {
    group: 'advanced', label: '控制面板地址（留空=自动）', type: 'text',
    help: '自动打开时用这个地址。留空则用「面板自己学到的 host」，再不行用 127.0.0.1:3080/wechat-bot。',
  },
  logFile: {
    group: 'advanced', label: '插件日志文件', type: 'text', readonly: true,
    help: '默认 <DSH_HOME>/data/super-injector/wechat-bot-plugin.log。注意别和 super-injector 自己的 dsh-wechat-bot.log 搞混。',
  },
  memoryDir: {
    group: 'advanced', label: '记忆目录', type: 'text', readonly: true,
  },
  memberNames: {
    group: 'identity', label: 'wxid ↔ 昵称映射', type: 'map', hidden: true,
  },
}

/**
 * 功能开关总表：面板第一屏的卡片。
 * kind=bool 直接改布尔；kind=chance 把概率置 0 / 恢复上次值。
 */
export const FEATURES = [
  { id: 'visionImage', icon: '🖼', title: '识图', key: 'visionOnImage', kind: 'bool', desc: '群里发图 → 看懂 → 回一句', related: ['visionOnEmoticon', 'imageReplyProbability'] },
  { id: 'visionEmoticon', icon: '😶', title: '识表情包', key: 'visionOnEmoticon', kind: 'bool', desc: '表情包也识别内容', related: ['visionOnImage'] },
  { id: 'visionVideo', icon: '🎬', title: '识视频', key: 'visionOnVideo', kind: 'bool', desc: '抽帧 + 音轨转写，看懂群里视频', related: ['videoFrames', 'videoDeleteAfterRead'] },
  { id: 'linkVideo', icon: '🔗', title: '链接视频', key: 'linkVideo', kind: 'bool', desc: '抖音/B站/小红书链接下载后看懂', risk: 'warn', related: ['linkVideoProbability'] },
  { id: 'voiceIn', icon: '🎧', title: '语音识别', key: 'voiceOnVoice', kind: 'bool', desc: '群里语音转文字，当普通消息回', related: ['voiceLanguage', 'voiceAutoPrepare'] },
  { id: 'voiceOut', icon: '🎙', title: '语音发送', key: 'voiceSay', kind: 'bool', desc: '把回复合成微信语音气泡', risk: 'warn', related: ['voiceSayProbability'] },
  { id: 'sticker', icon: '😄', title: '表情包', key: 'stickerChance', kind: 'chance', defaultChance: 0.22, desc: '文字后补一张图库表情', related: ['genStickerChance'] },
  { id: 'split', icon: '✂️', title: '拆句', key: 'splitChance', kind: 'chance', defaultChance: 0.3, desc: '像真人一样分两三条发', related: ['maxLines'] },
  { id: 'canned', icon: '💤', title: '敷衍回复', key: 'cannedChance', kind: 'chance', defaultChance: 0.1, desc: '少量"哈哈/确实/6"短句', related: [] },
  { id: 'proactive', icon: '🌱', title: '主动找话题', key: 'proactive', kind: 'bool', desc: '群里安静久了主动冒泡', related: ['proactiveChance', 'proactiveHours'] },
  { id: 'sleep', icon: '🌙', title: '睡前晚安/早安', key: 'sleepAnnounce', kind: 'bool', desc: '跨作息点说一句，每群每天一次', related: [] },
  { id: 'memory', icon: '🧠', title: '长期记忆', key: 'memoryExtract', kind: 'bool', desc: '定期从群聊提炼事实并记住', related: [] },
  { id: 'history', icon: '🕰', title: '历史检索', key: 'historyLookup', kind: 'bool', desc: '提起往事时查微信历史（0 token）', related: ['historyLimit'] },
  { id: 'at', icon: '@', title: '真 @ 人', key: 'allowAt', kind: 'bool', desc: '@ 到 wxid，对方收到红点提醒', related: ['atChance'] },
  { id: 'private', icon: '💬', title: '私聊回复', key: 'allowPrivate', kind: 'bool', desc: '只在对方先说话时回', related: [] },
  { id: 'health', icon: '❤️', title: '失联告警', key: 'healthAlert', kind: 'bool', desc: '静默失联时往 filehelper 说一句', related: [] },
  { id: 'douyin', icon: '🎵', title: '抖音分享', key: 'douyinShare', kind: 'bool', desc: '只读刷推荐，挑一条发群里', risk: 'high', related: ['douyinShareIntervalMs'] },
  { id: 'selfheal', icon: '🚨', title: '受限自愈', key: 'selfHeal', kind: 'bool', desc: '仅 hook 死锁时安全重启客户端', risk: 'critical', related: [] },
  { id: 'dbMembers', icon: '👥', title: '数据库成员名', key: 'useDbMembers', kind: 'bool', desc: '用真实群昵称识别 @ 与点名', related: [] },
]

/** 给前端用的精简元数据（去掉函数等）。 */
export function publicMeta() {
  const out = {}
  for (const [k, m] of Object.entries(CONFIG_META)) {
    if (m.hidden) continue
    out[k] = { ...m }
  }
  return out
}