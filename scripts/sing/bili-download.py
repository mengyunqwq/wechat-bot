# -*- coding: utf-8 -*-
"""
B 站音频下载（挑最快 CDN 节点）

为什么不用 yt-dlp 直接下（2026-11-17 实测）：
  B 站 playurl 对匿名请求返回 3 个候选地址，把 **P2P 的 mcdn 排在第一个**，
  而 mcdn 是"点对点分发"节点，直连只有 25 KiB/s（这机器实测），
  正规 upos CDN 节点同一首歌 3290 KiB/s —— 差 128 倍。
  yt-dlp 老老实实取第一个 → 一首歌要下 10 分钟，常常中途超时失败。

本模块：自己拿 playurl → 对候选地址并行测速 → 用最快的那个下 → 转 wav。
"""
import hashlib
import json
import os
import subprocess

# Windows 下不弹控制台窗口（2026-11-17：唱歌一次会起 yt-dlp/demucs/ffmpeg/RVC 多个子进程，
# 不加这个标志就会连续闪好几个黑窗）
if os.name == 'nt':
    _NO_WIN = subprocess.CREATE_NO_WINDOW
else:
    _NO_WIN = 0

import threading
import time
import urllib.parse
import urllib.request

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
         33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
         61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62,
         11, 36, 20, 34, 44, 52]


def _req(url, cookie='', timeout=25):
    hdr = {'User-Agent': UA, 'Referer': 'https://www.bilibili.com',
           'Accept': '*/*'}
    if cookie:
        hdr['Cookie'] = cookie
    req = urllib.request.Request(url, headers=hdr)
    return urllib.request.urlopen(req, timeout=timeout)


def _cookie():
    try:
        with _req('https://www.bilibili.com') as r:
            scs = r.headers.get_all('Set-Cookie') or []
        jar = {}
        for sc in scs:
            k, _, v = sc.split(';')[0].partition('=')
            jar[k.strip()] = v.strip()
        return '; '.join('%s=%s' % (k, v) for k, v in jar.items())
    except Exception:
        return ''


def _json(url, cookie=''):
    with _req(url, cookie) as r:
        return json.loads(r.read().decode('utf-8'))


def _mixin_key(img, sub):
    return ''.join((img + sub)[i] for i in MIXIN)[:32]


def playurl(bvid, cookie):
    """拿 playurl，返回候选音频地址列表（按 id 优先 30216）"""
    try:
        nav = _json('https://api.bilibili.com/x/web-interface/nav', cookie)
        wbi = (nav.get('data') or {}).get('wbi_img') or {}
        img = (wbi.get('img_url') or '').rsplit('/', 1)[-1].split('.')[0]
        sub = (wbi.get('sub_url') or '').rsplit('/', 1)[-1].split('.')[0]
        mixin = _mixin_key(img, sub)
    except Exception:
        mixin = ''

    view = _json('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, cookie)
    cid = ((view.get('data') or {}).get('cid')) or 0
    if not cid:
        return []

    params = {'bvid': bvid, 'cid': cid, 'fnval': 16, 'fourk': 1, 'wts': int(time.time())}
    if mixin:
        q = urllib.parse.urlencode({k: str(v) for k, v in sorted(params.items())},
                                   quote_via=urllib.parse.quote)
        url = ('https://api.bilibili.com/x/player/wbi/playurl?' + q
               + '&w_rid=' + hashlib.md5((q + mixin).encode()).hexdigest())
    else:
        url = 'https://api.bilibili.com/x/player/playurl?' + urllib.parse.urlencode(params)

    d = _json(url, cookie)
    if d.get('code') != 0:
        return []
    dash = (d.get('data') or {}).get('dash') or {}
    audios = dash.get('audio') or []
    # 优先 30216（53k，最小）；没有就按带宽升序
    audios.sort(key=lambda a: (0 if a.get('id') == 30216 else 1, a.get('bandwidth') or 0))
    out = []
    for a in audios:
        for u in [a.get('baseUrl') or a.get('base_url')] + list(a.get('backupUrl') or a.get('backup_url') or []):
            if u:
                out.append(u)
        if out:
            break
    return out


def probe_speed(url, seconds=2.0):
    """拉 2 秒，返回 KiB/s（失败返回 -1）"""
    t0 = time.time()
    got = 0
    try:
        with _req(url, timeout=12) as r:
            while time.time() - t0 < seconds:
                chunk = r.read(65536)
                if not chunk:
                    break
                got += len(chunk)
    except Exception:
        return -1.0
    dt = max(time.time() - t0, 0.01)
    return got / 1024.0 / dt


def pick_fastest(urls):
    """并行测速，返回 (最快地址, 速度)"""
    best = [None, -1.0]
    lock = threading.Lock()

    def work(u):
        s = probe_speed(u)
        with lock:
            if s > best[1]:
                best[0], best[1] = u, s

    ts = [threading.Thread(target=work, args=(u,), daemon=True) for u in urls[:4]]
    for t in ts:
        t.start()
    for t in ts:
        t.join(timeout=15)
    return best[0], best[1]


def download(url, dst, log=print, retries=3):
    """断点续传下载"""
    for i in range(1, retries + 1):
        have = os.path.getsize(dst) if os.path.exists(dst) else 0
        hdr = {'User-Agent': UA, 'Referer': 'https://www.bilibili.com', 'Accept': '*/*'}
        if have:
            hdr['Range'] = 'bytes=%d-' % have
        try:
            with _req(url, timeout=30) as r:
                total = int(r.headers.get('Content-Length') or 0) + have
                mode = 'ab' if have and r.status == 206 else 'wb'
                if mode == 'wb':
                    have = 0
                with open(dst, mode) as f:
                    while True:
                        chunk = r.read(262144)
                        if not chunk:
                            break
                        f.write(chunk)
                        have += len(chunk)
            size = os.path.getsize(dst) if os.path.exists(dst) else 0
            if total and size < total * 0.98 and i < retries:
                log('    下载不完整（%d/%d），重试 %d' % (size, total, i))
                continue
            return dst
        except Exception as e:
            log('    下载中断（第 %d 次）：%s' % (i, str(e)[:60]))
            time.sleep(1.5)
    raise RuntimeError('下载失败')


def fetch_audio(bvid, work_dir, ffmpeg, log=print):
    """完整流程：拿候选 → 测速挑快 → 下载 → 转 wav"""
    cookie = _cookie()
    urls = playurl(bvid, cookie)
    if not urls:
        raise RuntimeError('playurl 没有返回音频地址')
    log('    候选节点 %d 个，并行测速…' % len(urls))
    best, speed = pick_fastest(urls)
    if not best:
        best, speed = urls[0], 0
        log('    测速都失败，退回第一个节点')
    host = best.split('/')[2]
    log('    选中节点 %s（%.0f KiB/s）' % (host, speed))

    m4a = os.path.join(work_dir, 'src.m4a')
    download(best, m4a, log=log)
    wav = os.path.join(work_dir, 'src.wav')
    subprocess.run([ffmpeg, '-y', '-loglevel', 'error', '-i', m4a,
                    '-ar', '44100', '-ac', '1', wav], check=True, creationflags=_NO_WIN)
    try:
        os.remove(m4a)
    except Exception:
        pass
    return wav


if __name__ == '__main__':
    import sys
    bv = sys.argv[1] if len(sys.argv) > 1 else 'BV1ad4y1V7wb'
    out = sys.argv[2] if len(sys.argv) > 2 else '.'
    ff = os.environ.get('FFMPEG') or 'ffmpeg'
    print(fetch_audio(bv, out, ff))
