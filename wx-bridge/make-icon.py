"""把参考图转成多尺寸 .ico，供桌面快捷方式使用。"""
import os
from PIL import Image

SRC = r"D:\微信deepseek\data\stickers\ref\main.jpg"
OUT_DIR = r"D:\微信deepseek\assets"
OUT = os.path.join(OUT_DIR, "bot.ico")

os.makedirs(OUT_DIR, exist_ok=True)

im = Image.open(SRC).convert("RGBA")
print("源图尺寸:", im.size)

# 居中裁成正方形（快捷方式图标是方的，直接拉伸会变形）
w, h = im.size
side = min(w, h)
left = (w - side) // 2
top = (h - side) // 2
im = im.crop((left, top, left + side, top + side))
print("裁成正方形:", im.size)

# 多尺寸打包（Windows 会按场景自动选）
sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
im.save(OUT, format="ICO", sizes=sizes)
print("已生成:", OUT, round(os.path.getsize(OUT) / 1024, 1), "KB")
print("包含尺寸:", sizes)
