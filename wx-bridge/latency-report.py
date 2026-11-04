"""从插件日志拆解回复延迟：防抖 + LLM 生成 + 拟人打字延迟 + 表情包生成。"""
import re
from datetime import datetime

LOG = r"D:\dsh\data\super-injector\dsh-wechat-bot.log"

ts_re = re.compile(r"^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})Z\]")
decide_re = re.compile(r"决定回（")
model_re = re.compile(r"模型\(([^)]+)\)")
typing_re = re.compile(r"打字中… (\d+)s 后发送")
gen_re = re.compile(r"按情绪现场生成表情|随机现场生成表情")
gen_done_re = re.compile(r"表情包已发出")


def t(line):
    m = ts_re.match(line)
    return datetime.fromisoformat(m.group(1)) if m else None


lines = open(LOG, encoding="utf-8", errors="ignore").read().splitlines()

events = []
for ln in lines:
    tm = t(ln)
    if not tm:
        continue
    if decide_re.search(ln):
        events.append(("decide", tm, ln))
    elif model_re.search(ln):
        events.append(("model", tm, ln))
    elif typing_re.search(ln):
        events.append(("typing", tm, ln))
    elif gen_re.search(ln):
        events.append(("gen", tm, ln))
    elif gen_done_re.search(ln):
        events.append(("sticker_sent", tm, ln))

# 配对：decide → model → typing → (gen → sticker_sent)
samples = []
i = 0
while i < len(events):
    kind, tm, ln = events[i]
    if kind != "decide":
        i += 1
        continue
    rec = {"decide": tm, "model": None, "typing": None, "gen": None, "sticker": None, "text": ln.split(": ", 1)[-1][:30]}
    j = i + 1
    while j < len(events) and events[j][0] != "decide":
        k2, t2, _ = events[j]
        if k2 in ("model", "typing", "gen", "sticker_sent") and rec[{"sticker_sent": "sticker"}.get(k2, k2)] is None:
            rec[{"sticker_sent": "sticker"}.get(k2, k2)] = t2
        j += 1
    samples.append(rec)
    i = j

out = []
out.append(f"共解析 {len(samples)} 次「决定回」")
llm, typ, gen, total = [], [], [], []
for s in samples:
    d = s["decide"]
    if s["model"]:
        llm.append((s["model"] - d).total_seconds())
    if s["typing"]:
        m = typing_re.search([l for l in lines if typing_re.search(l) and t(l) == s["typing"]][0] if False else "")
    # 打字延迟从日志文本里取秒数
    typ_s = None
    for ln in lines:
        if t(ln) == s["typing"]:
            mm = typing_re.search(ln)
            if mm:
                typ_s = int(mm.group(1))
            break
    if typ_s is not None:
        typ.append(typ_s)
    if s["gen"] and s["sticker"]:
        gen.append((s["sticker"] - s["gen"]).total_seconds())
    end = s["sticker"] or s["typing"] or s["model"] or d
    total.append((end - d).total_seconds() + (typ_s or 0))


def stat(name, arr):
    if not arr:
        out.append(f"  {name}: 无样本")
        return
    a = sorted(arr)
    avg = sum(a) / len(a)
    out.append(f"  {name}: 平均 {avg:.1f}s ｜中位 {a[len(a)//2]:.1f}s ｜最快 {a[0]:.1f}s ｜最慢 {a[-1]:.1f}s ｜n={len(a)}")


out.append("—— 各段耗时（从「决定回」到各节点）——")
stat("LLM 生成", llm)
stat("拟人打字延迟(秒)", typ)
stat("表情包生成", gen)
stat("合计（不含防抖）", total)
out.append("另外固定成本：防抖合并窗口 2.2s（每条消息都要等）")

open(r"D:\微信deepseek\data\latency.txt", "w", encoding="utf-8").write("\n".join(out))
print("\n".join(out))
