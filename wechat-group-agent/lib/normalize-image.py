#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把任意图片归一化成微信能发的 JPEG。
用法：python normalize-image.py <src> <dst> [maxSide] [quality]
退出码 0 = 成功。
"""
import sys
import os
from PIL import Image

def main():
    if len(sys.argv) < 3:
        print('usage: normalize-image.py <src> <dst> [maxSide] [quality]')
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    max_side = int(sys.argv[3]) if len(sys.argv) > 3 else 1600
    quality = int(sys.argv[4]) if len(sys.argv) > 4 else 88

    im = Image.open(src)
    # 动图取第一帧
    try:
        im.seek(0)
    except Exception:
        pass
    im = im.convert('RGB')
    w, h = im.size
    if max(w, h) > max_side:
        r = max_side / float(max(w, h))
        im = im.resize((max(1, int(w * r)), max(1, int(h * r))), Image.LANCZOS)
    im.save(dst, 'JPEG', quality=quality, optimize=True)
    print('%dx%d %dKB' % (im.size[0], im.size[1], os.path.getsize(dst) // 1024))
    return 0

if __name__ == '__main__':
    sys.exit(main())
