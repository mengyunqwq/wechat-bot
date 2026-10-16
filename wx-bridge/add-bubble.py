"""给表情包加文字气泡（在图片上后画，保证中文字一定清晰正确）。

为什么不在生成时让 AI 画字：AI 画中文经常糊成一团/写错字，
所以让 AI 只画角色和场景，气泡和文字由我们用 Pillow 精确绘制。

用法:
  python add-bubble.py <输入图> <输出图> "文字" [--pos top|bottom] [--scale 1.0]
"""
import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONTS = [
    r"C:\Windows\Fonts\msyhbd.ttc",   # 微软雅黑 粗
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]


def load_font(size):
    for p in FONTS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def draw_bubble(im, text, pos="top", scale=1.0):
    """在图上画一个白色圆角气泡 + 黑字（带小尾巴），返回新图。"""
    W, H = im.size
    im = im.convert("RGBA")
    layer = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # 字号自适应：先按图宽估一个，再按需要缩小到能放进气泡
    max_w = int(W * 0.86)
    size = max(18, int(W * 0.085 * scale))
    font = load_font(size)
    while size > 14:
        box = d.textbbox((0, 0), text, font=font)
        if (box[2] - box[0]) <= max_w - 28:
            break
        size -= 2
        font = load_font(size)

    box = d.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    pad_x, pad_y = 20, 12
    bw, bh = tw + pad_x * 2, th + pad_y * 2
    bx = (W - bw) // 2
    by = int(H * 0.045) if pos == "top" else int(H - bh - H * 0.045)

    # 气泡本体：白底 + 深色描边
    d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=int(bh * 0.42),
                        fill=(255, 255, 255, 245), outline=(40, 40, 45, 255), width=max(2, int(W * 0.006)))
    # 小尾巴（朝角色方向）
    tail_w = max(10, int(W * 0.035))
    cx = W // 2
    if pos == "top":
        ty = by + bh
        d.polygon([(cx - tail_w, ty - 2), (cx + tail_w, ty - 2), (cx, ty + tail_w)], fill=(255, 255, 255, 245))
        d.line([(cx - tail_w, ty), (cx, ty + tail_w)], fill=(40, 40, 45, 255), width=max(2, int(W * 0.006)))
        d.line([(cx + tail_w, ty), (cx, ty + tail_w)], fill=(40, 40, 45, 255), width=max(2, int(W * 0.006)))
    else:
        ty = by
        d.polygon([(cx - tail_w, ty + 2), (cx + tail_w, ty + 2), (cx, ty - tail_w)], fill=(255, 255, 255, 245))
        d.line([(cx - tail_w, ty), (cx, ty - tail_w)], fill=(40, 40, 45, 255), width=max(2, int(W * 0.006)))
        d.line([(cx + tail_w, ty), (cx, ty - tail_w)], fill=(40, 40, 45, 255), width=max(2, int(W * 0.006)))

    # 文字（居中）
    d.text((bx + pad_x - box[0], by + pad_y - box[1]), text, font=font, fill=(25, 25, 30, 255))

    return Image.alpha_composite(im, layer)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("text")
    ap.add_argument("--pos", default="top", choices=["top", "bottom"])
    ap.add_argument("--scale", type=float, default=1.0)
    a = ap.parse_args()

    im = Image.open(a.src)
    out = draw_bubble(im, a.text, a.pos, a.scale)
    if a.dst.lower().endswith((".jpg", ".jpeg")):
        out.convert("RGB").save(a.dst, "JPEG", quality=90)
    else:
        out.save(a.dst, "PNG")
    print(f"OK {a.dst} ({out.size[0]}x{out.size[1]}, 文字「{a.text}」)")


if __name__ == "__main__":
    sys.exit(main())
