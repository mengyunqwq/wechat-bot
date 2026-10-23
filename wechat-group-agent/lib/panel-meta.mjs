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
  partTargetLen: {
    group: 'style', label: '每段目标字数', type: 'number', min: 10, max: 500, step: 5, unit: '字', advanced: true,
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
  patChance: {
    group: 'style', label: '被@时拍一拍概率', type: 'number', min: 0, max: 1, step: 0.01,
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
  },
  visionModel: {
    group: 'vision', label: '视觉模型 id', type: 'text', advanced: true,
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
  voiceSayEmotion: {
    group: 'voiceOut', label: '音色预设', type: 'enum', options: ['main', 'sweet', 'angry', 'serious'],
  },

  // ── 记忆与检索 ──────────────────────────────────────────────
  memoryExtract: {
    group: 'memory', label: '定期提炼长期记忆', type: 'bool',
    help: '从群聊里提炼事实，本地保存，每次对话都带上。',
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

  // ── 人设与模型 ──────────────────────────────────────────────
  persona: {
    group: 'model', label: '人设', type: 'textarea',
    help: '每次对话都会带上。改完立即生效。',
  },
  provider: {
    group: 'model', label: '模型 provider', type: 'text',
    help: '留空 = 用 DSH 当前默认模型。',
  },
  model: {
    group: 'model', label: '模型 id', type: 'text',
    help: '留空 = 用 DSH 当前默认模型。',
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
  { id: 'voiceOut', icon: '🎙', title: '语音发送', key: 'voiceSay', kind: 'bool', desc: '把回复合成微信语音气泡', risk: 'warn', related: ['voiceSayProbability', 'voiceSayEmotion'] },
  { id: 'sticker', icon: '😄', title: '表情包', key: 'stickerChance', kind: 'chance', defaultChance: 0.22, desc: '文字后补一张图库表情', related: ['genStickerChance'] },
  { id: 'split', icon: '✂️', title: '拆句', key: 'splitChance', kind: 'chance', defaultChance: 0.3, desc: '像真人一样分两三条发', related: ['maxLines'] },
  { id: 'pat', icon: '👉', title: '拍一拍', key: 'patChance', kind: 'chance', defaultChance: 0.03, desc: '被@时偶尔拍一拍对方', related: [] },
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
