"""生成几张开箱可用的中文表情包（Pillow + 微软雅黑），直接投递到导入目录。
文件名即语境标签，方便机器人按话题挑图。"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = r"D:\微信deepseek\data\stickers\import"
os.makedirs(OUT, exist_ok=True)

SPECS = [
    ("哈哈哈", "哈哈 笑死 好笑 逗", (255, 214, 102), (60, 50, 20)),
    ("无语", "无语 服了 麻了 沉默", (206, 212, 218), (40, 45, 55)),
    ("晚安", "晚安 睡了 困了 拜拜", (140, 170, 255), (250, 250, 255)),
    ("牛", "牛 厉害 佩服 强", (255, 150, 150), (70, 20, 20)),
    ("离谱", "离谱 草 真的假的 笑死", (170, 230, 180), (25, 55, 35)),
    ("开黑吗", "开黑 打游戏 上号 来", (255, 190, 120), (70, 40, 10)),
    ("在忙", "在忙 忙 稍等 等下", (200, 180, 255), (45, 30, 70)),
    ("摸鱼", "摸鱼 划水 偷懒 闲", (150, 225, 235), (20, 55, 60)),
]

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]

def load_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()

def make(text, tags, bg, fg, path):
    W = H = 240
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    # 圆角边框
    d.rounded_rectangle([8, 8, W - 8, H - 8], radius=28, outline=fg, width=4)
    font = load_font(46 if len(text) <= 3 else 38)
    # 居中
    box = d.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    d.text(((W - tw) / 2 - box[0], (H - th) / 2 - box[1]), text, font=font, fill=fg)
    img.save(path, "PNG")

for text, tags, bg, fg in SPECS:
    name = tags.split()[0] + "_" + tags.replace(" ", "-") + ".png"
    make(text, tags, bg, fg, os.path.join(OUT, name))
    print("生成:", name)

print("\n目录内容:")
for f in sorted(os.listdir(OUT)):
    print("  ", f)
