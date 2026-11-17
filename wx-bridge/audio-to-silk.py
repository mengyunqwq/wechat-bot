# -*- coding: utf-8 -*-
"""
音频 → 微信语音气泡（SILK）

为什么需要：微信这边能发的音频只有两种——
  · 语音条（type 34，SILK）：微信里点开就播，但**最长 60 秒**
  · 图片接口（/SendImgMsg）：不吃 mp3，不是通用文件发送
所以唱歌要能落地成"语音条"，必须先切出 ≤58 秒的一段再编码成 SILK。

用法：
  python audio-to-silk.py --in song.mp3 --out clip.silk --start 30 --duration 55
"""
import argparse
import json
import os
import shutil
import subprocess

# Windows 下不弹控制台窗口（2026-11-17：唱歌一次会起 yt-dlp/demucs/ffmpeg/RVC 多个子进程，
# 不加这个标志就会连续闪好几个黑窗）
if os.name == 'nt':
    _NO_WIN = subprocess.CREATE_NO_WINDOW
else:
    _NO_WIN = 0

import sys

def find_ffmpeg():
    """ffmpeg 路径：环境变量 FFMPEG > PATH > 常见安装位置"""
    e = os.environ.get('FFMPEG')
    if e and os.path.exists(e):
        return e
    w = shutil.which('ffmpeg')
    if w:
        return w
    for c in ('C:/ffmpeg/bin/ffmpeg.exe', 'C:/Program Files/ffmpeg/bin/ffmpeg.exe'):
        if os.path.exists(c):
            return c
    return 'ffmpeg'

FFMPEG = find_ffmpeg()

PCM_RATE = 24000          # pilk.encode 硬要求 24kHz（它不做重采样）


def to_pcm(src, dst_pcm, start=0.0, duration=None):
    cmd = [FFMPEG, '-y', '-loglevel', 'error']
    if start:
        cmd += ['-ss', str(start)]
    cmd += ['-i', src]
    if duration:
        cmd += ['-t', str(duration)]
    cmd += ['-ar', str(PCM_RATE), '-ac', '1', '-f', 's16le', dst_pcm]
    subprocess.run(cmd, check=True, creationflags=_NO_WIN)
    return dst_pcm


def encode_silk(pcm, silk):
    import pilk
    try:
        pilk.encode(pcm, silk, pcm_rate=PCM_RATE)
    except TypeError:
        pilk.encode(pcm, silk)
    with open(silk, 'rb') as f:
        head = f.read(10)
    if not head.startswith(b'#!SILK'):
        raise SystemExit('SILK 头不对：%r' % head)
    try:
        ms = pilk.get_duration(silk)
    except Exception:
        ms = 0
    return silk, int(ms or 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--start', type=float, default=0.0)
    ap.add_argument('--duration', type=float, default=55.0)
    args = ap.parse_args()

    if not os.path.exists(args.src):
        raise SystemExit('输入不存在：' + args.src)
    pcm = args.out.replace('.silk', '.pcm')
    to_pcm(args.src, pcm, args.start, args.duration)
    silk, ms = encode_silk(pcm, args.out)
    try:
        os.remove(pcm)
    except Exception:
        pass
    print(json.dumps({'ok': True, 'silk': silk, 'durationMs': ms,
                      'bytes': os.path.getsize(silk)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
