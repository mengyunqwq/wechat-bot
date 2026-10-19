/**
 * 拟人策略回归测试 —— 零依赖，直接 `node lib/test-policy.mjs`。
 * 策略是最常调参的部分，改动后跑一遍保证没把"拟人"调成"复读机"或"话痨"。
 */
import {
  parseQuietWindows, isQuiet, detectTrigger, humanDelayMs,
  splitMessage, gapMs, RoomPolicy, cleanReply,
  CANNED_AMBIENT, CANNED_AT, pickCanned,
  PROACTIVE_FALLBACK, pickProactive, inActiveHours,
  parseStickerDirective, stripStickerDirective, isLowContent,
} from './policy.mjs'

let pass = 0
const fails = []
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS  ' + label) } else { fails.push(label); console.log('  FAIL  ' + label) }
}

console.log('\n=== 拟人策略回归 ===')

// ── 安静时段 ───────────────────────────────────────────────
const w1 = parseQuietWindows('01:00-07:30')
ok(w1.length === 1 && w1[0].start === 60 && w1[0].end === 450, '解析安静时段 01:00-07:30')
ok(isQuiet(w1, new Date('2026-01-01T03:00:00')), '03:00 属于安静时段')
ok(!isQuiet(w1, new Date('2026-01-01T12:00:00')), '12:00 不属于安静时段')
const w2 = parseQuietWindows('23:30-06:00')
ok(isQuiet(w2, new Date('2026-01-01T00:30:00')) && isQuiet(w2, new Date('2026-01-01T23:45:00')), '跨零点时段（23:30-06:00）正确')
ok(!isQuiet(w2, new Date('2026-01-01T12:00:00')), '跨零点时段 12:00 不安静')
ok(parseQuietWindows('off').length === 0, "'off' = 不设安静时段")
ok(parseQuietWindows('08:00-09:00,12:00-13:00').length === 2, '多段安静时段')

// ── 触发识别 ───────────────────────────────────────────────
ok(detectTrigger({ isAtMe: true, text: '在吗' }) === 'at', '被@ → at')
ok(detectTrigger({ text: '小柚你觉得呢', isAtMe: false }, { aliases: ['小柚'] }) === 'name', '含别名 → name')
ok(detectTrigger({ text: '今晚吃什么？' }) === 'question', '问号结尾 → question')
ok(detectTrigger({ text: '这游戏好玩吗' }) === 'question', '“吗”结尾 → question')
ok(detectTrigger({ text: '今天天气不错' }) === 'ambient', '陈述句 → ambient')
ok(detectTrigger({ text: '大家看一下', atAll: true }) === 'question', '@所有人 → question')

// ── 打字延迟 ───────────────────────────────────────────────
const dShort = humanDelayMs('嗯', 'ambient', 0.5)
const dLong = humanDelayMs('这句话稍微长一点点用来测试打字延迟是不是随字数增长', 'ambient', 0.5)
ok(dShort >= 700 && dShort <= 14_000, `短回复延迟在范围内（${dShort}ms）`)
ok(dLong > dShort, `长回复更慢（${dLong}ms > ${dShort}ms）`)
ok(humanDelayMs('好的', 'at', 0.5) < humanDelayMs('好的', 'ambient', 0.5), '被@时回得更快')
ok(humanDelayMs('啊'.repeat(200), 'ambient', 0.9) <= 20_000, '超长文本延迟有上限')
ok(humanDelayMs('嗯', 'ambient', 0.99) > humanDelayMs('嗯', 'ambient', 0.3), '偶尔"走神"会明显更慢')

// ── 拆句 ───────────────────────────────────────────────────
ok(splitMessage('就这样吧', { chance: 0.15, rand: 0.9 }).length === 1, '未命中概率不拆句')
const sp = splitMessage('今天真累啊。先睡了。明天再聊', { chance: 0.15, rand: 0.0 })
ok(sp.length === 2, `命中概率拆成两条（${sp.length}）`)
ok(splitMessage('嗯。', { chance: 1, rand: 0 }).length === 1, '太短不拆')
ok(gapMs(0.5) > 700 && gapMs(0.5) < 2100, '两条之间的间隔合理')

// ── 节流决策 ───────────────────────────────────────────────
const cfg = { replyProbability: 0.2, minReplyGapMs: 20_000, maxRepliesPer10Min: 3 }
const mk = () => new RoomPolicy(cfg)
// 对话延续/轮数上限用宽松配置（避免撞 10 分钟上限，单独验证轮数逻辑）
const cfg2 = { replyProbability: 0.2, minReplyGapMs: 20_000, maxRepliesPer10Min: 15, continuationChance: 0.7, maxConsecutiveTurns: 4 }
const mk2 = () => new RoomPolicy(cfg2)

ok(mk().decide({ priority: 'at', rand: 0.99 }).reply, '被@ 必回（哪怕概率为 0）')
// 睡觉时段：不主动插话，但被叫到还是要回（用户要求）
const cfgSleep = { replyProbability: 0.2, minReplyGapMs: 20_000, maxRepliesPer10Min: 3, quietHours: '23:00-08:00', quietAllow: ['at', 'name'] }
const mkSleep = () => new RoomPolicy(cfgSleep)
ok(!mkSleep().decide({ priority: 'ambient', quiet: true, rand: 0.0 }).reply, '睡觉时段不主动插话（闲聊不回）')
ok(!mkSleep().decide({ priority: 'question', quiet: true, rand: 0.0 }).reply, '睡觉时段问句也不插话')
ok(mkSleep().decide({ priority: 'at', quiet: true, rand: 0.99 }).reply, '睡觉时段被@ 依旧回复（用户要求）')
ok(mkSleep().decide({ priority: 'name', quiet: true, rand: 0.99 }).reply, '睡觉时段被点名依旧回复')
const cfgMute = { replyProbability: 0.2, minReplyGapMs: 20_000, maxRepliesPer10Min: 3, quietAllow: [] }
ok(!new RoomPolicy(cfgMute).decide({ priority: 'at', quiet: true, rand: 0.99 }).reply, 'quietAllow=[] 时彻底静音（可配置）')
// 作息时段解析
const wNight = parseQuietWindows('23:00-08:00')
ok(isQuiet(wNight, new Date('2026-01-01T23:30:00')), '23:30 在睡觉时段内')
ok(isQuiet(wNight, new Date('2026-01-01T03:00:00')), '凌晨 3 点在睡觉时段内（跨零点）')
ok(!isQuiet(wNight, new Date('2026-01-01T08:30:00')), '08:30 已经醒了')
ok(!isQuiet(wNight, new Date('2026-01-01T12:00:00')), '中午当然醒着')

const p1 = mk()
ok(p1.decide({ priority: 'ambient', rand: 0.0 }).reply, '闲聊命中概率就回')
ok(!p1.decide({ priority: 'ambient', rand: 0.99 }).reply, '闲聊未命中就不回')
ok(p1.decide({ priority: 'question', rand: 0.3 }).reply, '问句概率更高（p=0.44，rand 0.3 命中）')

const p2 = mk()
p2.noteReplied(Date.now())
const cooldown = p2.decide({ priority: 'ambient', rand: 0.0 })
ok(!cooldown.reply && cooldown.reason.includes('冷却'), '刚回过 → 冷却期内不回')
ok(p2.decide({ priority: 'name', rand: 0.0 }).reply === false, '冷却期内被点名也压住（半冷却未到）')
const p2b = mk()
p2b.noteReplied(Date.now() - 11_000)   // name 半冷却 = 10s，已过
ok(p2b.decide({ priority: 'name', rand: 0.0 }).reply, '半冷却过后被点名会回')

const p3 = mk()
for (let i = 0; i < 3; i++) p3.noteReplied(Date.now())
const limited = p3.decide({ priority: 'ambient', rand: 0.0 })
ok(!limited.reply && limited.reason.includes('上限'), '10 分钟上限生效')
ok(p3.decide({ priority: 'at', rand: 0.99 }).reply, '上限也拦不住被@（急事优先）')

const p4 = mk()
p4.noteSelf(); p4.noteSelf()
ok(!p4.decide({ priority: 'ambient', rand: 0.0 }).reply, '连续自说自话两条后闭嘴')
p4.noteOther()
ok(p4.decide({ priority: 'ambient', rand: 0.0 }).reply, '别人说话后恢复')

// ── 对话延续（关键：不能"回一句就哑"，也不能"每句都回"）──────
const p5 = mk2()
p5.noteReplied(Date.now() - 5000, 'u1')
ok(p5.decide({ priority: 'continuation', rand: 0.5 }).reply, '对话延续：命中概率就接话')
const p5b = mk2()
p5b.noteReplied(Date.now() - 5000, 'u1')
ok(!p5b.decide({ priority: 'continuation', rand: 0.95 }).reply, '对话延续：也有不接的时候（不是每句都回）')
const p6 = mk2()
p6.noteReplied(Date.now() - 500, 'u1')
ok(!p6.decide({ priority: 'continuation', rand: 0.1 }).reply, '对话延续：太快（<2s）仍然压一下')
const p7 = mk()
for (let i = 0; i < 3; i++) p7.noteReplied(Date.now(), 'u1')
ok(!p7.decide({ priority: 'continuation', rand: 0.0 }).reply, '10 分钟上限对对话延续同样生效（防刷屏）')

// 连续对聊轮数上限
const p7b = mk2()
for (let i = 0; i < 4; i++) p7b.noteReplied(Date.now() - 5000, 'u1')
const capRes = p7b.decide({ priority: 'continuation', rand: 0.1 })
ok(!capRes.reply && capRes.reason.includes('连续对聊'), '连续对聊到上限就停（不再句句接）')
ok(p7b.decide({ priority: 'at', rand: 0.99 }).reply, '但被@仍然必回')

// ── 低信息量消息不值得回 ─────────────────────────────────
ok(isLowContent('嗯') && isLowContent('哈哈哈') && isLowContent('6'), '识别低信息量消息')
ok(!isLowContent('今晚谁打游戏'), '正常内容不算低信息量')
const p7c = mk2()
ok(!p7c.decide({ priority: 'ambient', rand: 0.0, text: '嗯' }).reply, '对"嗯"这种不回话（真人也不会句句接）')
ok(p7c.decide({ priority: 'at', rand: 0.99, text: '嗯' }).reply, '但被@时说"嗯"也要回')

// ── 敷衍短句（去人机味的关键）──────────────────────────────
ok(CANNED_AMBIENT.includes(pickCanned('ambient', 0)), '敷衍模式：闲聊取到短句')
ok(CANNED_AT.includes(pickCanned('at', 0)), '敷衍模式：被@取到短句')
ok(CANNED_AT.includes(pickCanned('at', 0.999)), '敷衍模式：随机到边界也不越界')

// ── 被点名/提到 → 一定要回（跳过冷却与上限）──────────────────
const p8 = mk()
p8.noteReplied(Date.now() - 5000)             // 5 秒前回过：过了 2s 防抖，但仍在冷却期内
for (let i = 0; i < 2; i++) p8.noteReplied(Date.now() - 5000)  // 凑满 10 分钟上限
ok(p8.decide({ priority: 'name', rand: 0.99 }).reply, '被点名：冷却+上限都拦不住（必回）')
const p9 = mk()
p9.noteReplied(Date.now())
ok(!p9.decide({ priority: 'name', rand: 0.0 }).reply, '被点名：2s 内防抖仍生效')

// ── 主动找话题 ─────────────────────────────────────────────
ok(PROACTIVE_FALLBACK.includes(pickProactive(0)), '主动话题：能取到兜底台词')
ok(PROACTIVE_FALLBACK.includes(pickProactive(0.999)), '主动话题：边界不越界')
ok(inActiveHours('09:00-23:30', new Date('2026-01-01T14:00:00')), '主动时段：下午允许')
ok(!inActiveHours('09:00-23:30', new Date('2026-01-01T03:00:00')), '主动时段：凌晨不允许')

// ── 表情指令解析（群里出现 "[表情:得意]" 括号文字的 bug 回归）──────
{
  const a = parseStickerDirective('[表情]')
  ok(a.hasSticker && a.stickerOnly && a.text === '', '指令：[表情] → 只发图')
  const b = parseStickerDirective('那个能画，理想中的我嘛……\n[表情:得意]')
  ok(b.hasSticker && !b.stickerOnly && b.emotion === '得意', '指令：文字+换行指令 → 识别到情绪')
  ok(b.text === '那个能画，理想中的我嘛……', '指令：换行指令必须从正文里抠掉（关键回归）')
  const c = parseStickerDirective('那可能是我这边的问题…我再发一次试试 [表情:得意]')
  ok(c.emotion === '得意' && c.text === '那可能是我这边的问题…我再发一次试试', '指令：行内指令也要抠掉')
  const d = parseStickerDirective('[表情:无语]\n喏，现画的')
  ok(d.emotion === '无语' && d.text === '喏，现画的', '指令：指令在前、文字在后')
  const e = parseStickerDirective('[表情:大笑|抱着奶茶笑得直不起腰]')
  ok(e.emotion === '大笑' && e.scene === '抱着奶茶笑得直不起腰', '指令：带场景描述')
  const g = parseStickerDirective('[表情:无语|翻着白眼|我谢谢您]')
  ok(g.emotion === '无语' && g.scene === '翻着白眼' && g.bubble === '我谢谢您', '指令：第三个字段 = 气泡文字')
  const h = parseStickerDirective('[表情:委屈|缩成一团|不给就不给]\n就这样吧')
  ok(h.bubble === '不给就不给' && h.text === '就这样吧', '指令：带气泡的指令也能从正文里抠掉')
  const f = parseStickerDirective('就这样吧')
  ok(!f.hasSticker && f.text === '就这样吧', '指令：没有指令时原样返回')
  ok(stripStickerDirective('哈哈 [表情:大笑] 真行').replace(/\s+/g, '') === '哈哈真行', '兜底：stripStickerDirective 抠掉指令')
  ok(!/表情/.test(stripStickerDirective('[表情:困|趴键盘]')), '兜底：抠完不留指令字样')
}

// ── 输出清洗 ───────────────────────────────────────────────
ok(cleanReply('“哈哈哈”') === '哈哈哈', '去掉中文引号')
ok(cleanReply('我：这也太离谱了') === '这也太离谱了', '去掉“我：”前缀')
ok(cleanReply('回复: 好的没问题') === '好的没问题', '去掉“回复:”前缀')
ok(cleanReply('```\n哈哈哈\n```') === '哈哈哈', '去掉代码块')
ok(cleanReply('第一行\n第二行解释') === '第一行', '默认只取第一行（避免把解释发出去）')
ok(cleanReply('哈哈哈哈\n笑死我了\n真的', { maxLines: 3 }) === '哈哈哈哈\n笑死我了\n真的', '多行=多条消息：maxLines=3 时保留三行')
ok(cleanReply('哈哈哈哈\n笑死我了\n真的\n第四行', { maxLines: 3 }) === '哈哈哈哈\n笑死我了\n真的', '多行：超出 maxLines 截断')
ok(cleanReply('（笑）') === '笑', '去括号舞台提示')
const long = cleanReply('这是一句特别长的话。'.repeat(10), { maxLen: 20 })
ok([...long].length <= 20 && long.endsWith('。'), `超长按句截断（${[...long].length} 字：${long}）`)
ok(cleanReply('') === '', '空输入返回空')

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`)
if (fails.length) {
  console.log('失败项：\n' + fails.map((f) => '  - ' + f).join('\n'))
  process.exit(1)
}
console.log('策略回归全部通过 ✅\n')
