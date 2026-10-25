"""把早期用代码生成的占位表情标记为 seed（不参与挑图）。

识别方式（不猜文件名）：图库里 source=import 的条目，看它的本地文件 ——
我生成的占位图是 240x240、体积只有 2~4KB；用户的真实表情包都 >=50KB。
两个条件都满足才标记，避免误伤。
"""
import json
import os

from PIL import Image

INDEX = r"D:\微信deepseek\data\stickers\index.json"

store = json.load(open(INDEX, encoding="utf-8"))
items = store["items"]

marked = []
for it in items:
    if it.get("source") != "import":
        continue
    f = it.get("file") or ""
    if not f or not os.path.exists(f):
        continue
    size = os.path.getsize(f)
    if size > 8 * 1024:
        continue
    try:
        w, h = Image.open(f).size
    except Exception:
        continue
    if (w, h) == (240, 240):
        it["source"] = "seed"
        marked.append((it["id"], f"{w}x{h}", f"{size}B", (it.get("tags") or [])[:3]))

json.dump(store, open(INDEX, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

from collections import Counter
print("标记为 seed:", len(marked))
for m in marked:
    print("  ", m)
print("来源分布:", dict(Counter(i.get("source") for i in items)))
pickable = [i for i in items if i.get("source") in ("gen", "import") and i.get("file")]
print("可挑张数:", len(pickable))
