# -*- coding: utf-8 -*-
"""
「大肥鱼唱歌」流水线：扒音频 → 分离人声 → RVC 变声成她的声线

三个阶段全部**进程级冷启动**：
  · 每一步都是独立子进程，跑完就退出，显存立刻归还
  · RVC 推理进程结束后 torch 释放 → nvidia-smi 立即回到基线
  · 所以她不唱歌时完全不吃显存（和云端 TTS 的设计一致）

用法：
  python sing.py --url "https://www.bilibili.com/video/BVxxxx"     # 从链接扒
  python sing.py --file "D:\\songs\\xxx.mp3"                        # 用本地文件
  python sing.py --file xxx.mp3 --pitch 3 --out D:\\out.mp3

输出：转换后的 wav/mp3（她的声线），以及中间产物目录
"""
import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

PY311 = r'D:\Python311\python.exe'          # yt-dlp / demucs 在这个环境
RVC_PY = r'E:\rvc\venv-rvc\Scripts\python.exe'
RVC_ROOT = r'E:\rvc\RVC'
WORK = r'E:\rvc\sing-work'
SILK_TOOL = r'D:\微信deepseek\wx-bridge\audio-to-silk.py'   # 音频→SILK（语音条）
SILK_MAX_SEC = 58          # 微信语音条上限 60 秒，留 2 秒余量
MODEL = os.path.join(RVC_ROOT, 'assets', 'weights', 'her2.pth')   # 纯真实素材训练（400 轮）
INDEX_GLOB = os.path.join(RVC_ROOT, 'logs', 'her2', 'added_*.index')


def log(msg):
    print('  ' + msg, flush=True)


def run(cmd, cwd=None, timeout=3600, env_extra=None, capture=True):
    """跑一条命令；capture=True 时收集输出，失败时把尾部打进日志。

    为什么必须捕获（2026-11-17 踩到）：RVC 转长歌被系统杀掉（显存不足）时，
    原来子进程直接继承 stdout，崩溃前什么都没留下，日志里只剩「退出码 1」，
    完全无法定位。捕获后能立刻看到 CUDA OOM / 段错误的真实信息。
    """
    log('$ ' + ' '.join(str(c) for c in cmd)[:140])
    env = dict(os.environ)
    env['PYTHONIOENCODING'] = 'utf-8'
    if env_extra:
        env.update(env_extra)
    t0 = time.time()
    if capture:
        # 子进程继承了 PYTHONIOENCODING=utf-8，所以这里也要按 utf-8 解码，
        # 否则日志里全是乱码（实测："銆愬崟娆℃帹鐞嗐€"）
        p = subprocess.run(cmd, cwd=cwd, timeout=timeout, env=env,
                           capture_output=True, text=True,
                           encoding='utf-8', errors='replace')
        merged = ((p.stdout or '') + chr(10) + (p.stderr or '')).strip().split(chr(10))
        for ln in [x for x in merged if x.strip()][-8:]:
            log('    | ' + ln.strip()[:150])
    else:
        p = subprocess.run(cmd, cwd=cwd, timeout=timeout, env=env)
    log('  → 退出码 %d（%.1f 分钟）' % (p.returncode, (time.time() - t0) / 60))
    if p.returncode != 0:
        raise SystemExit('阶段失败（退出码 %d）' % p.returncode)
    return p.returncode



def bili_pick(query):
    """搜 B 站，取播放量最高的视频，返回 (bvid, title, duration)"""
    import importlib.util as u
    spec = u.spec_from_file_location('bs', os.path.join(r'D:\微信deepseek\data', 'bili-search.py'))
    mod = u.module_from_spec(spec)
    spec.loader.exec_module(mod)
    rows = mod.search(query, limit=8)
    if not rows:
        raise SystemExit('B 站搜不到：' + query)
    # 播放量高的优先，但跳过超过 8 分钟的长视频（多半是循环合集）
    def score(r):
        secs = 0
        dur = str(r.get('duration') or '')
        if ':' in dur:
            parts = [int(x) for x in dur.split(':') if x.isdigit()]
            secs = parts[0] * 60 + parts[1] if len(parts) == 2 else 0
        elif dur.isdigit():
            secs = int(dur)
        return (0 if secs and secs > 480 else 1, int(r.get('play') or 0))
    rows.sort(key=score, reverse=True)
    # ★ 标题必须对得上歌名，否则宁可不唱（曾经把「猫尾巴科普」当成歌转了一遍）
    keys = [k for k in re.split(r'[\s，。,.!！?？、\-—_]', query) if len(k) >= 2]
    def matches(r):
        t = str(r.get('title') or '')
        return all(k in t for k in keys) if keys else True
    hit = next((r for r in rows if matches(r)), None)
    if not hit:
        raise SystemExit('搜到的视频标题都对不上「%s」，不唱了（避免转错视频）' % query)
    log('  选中：%s ｜ %s ｜ %s ｜ 播放 %s'
        % (hit['bvid'], hit['title'][:36], hit['duration'], hit['play']))
    return hit['bvid']


def stage_download(url, work):
    """yt-dlp 扒音频（只取音频流，转 wav）"""
    log('═══ 阶段 1：扒音频 ═══')
    out_tpl = os.path.join(work, 'src.%(ext)s')
    run([PY311, '-m', 'yt_dlp', '-x', '--audio-format', 'wav',
         '--audio-quality', '0', '-o', out_tpl, '--no-playlist', url])
    cands = glob.glob(os.path.join(work, 'src.*'))
    if not cands:
        raise SystemExit('没扒到音频文件')
    return cands[0]


def stage_separate(src, work):
    """demucs 分离人声（两轨：vocals / no_vocals）"""
    log('═══ 阶段 2：分离人声 ═══')
    run([PY311, '-m', 'demucs', '-n', 'htdemucs', '--two-stems=vocals',
         '-o', os.path.join(work, 'separated'), src])
    hits = glob.glob(os.path.join(work, 'separated', '**', 'vocals.wav'), recursive=True)
    if not hits:
        raise SystemExit('demucs 没产出 vocals.wav')
    return hits[0]


HER_F0 = 309.0      # 她的真实音高中位（从 cn-a.wav 测得）


def measure_f0(path, dur=45):
    """测一段音频的基频中位（用来算移调量）"""
    try:
        import librosa
        import numpy as np
        y, sr = librosa.load(path, sr=16000, mono=True, duration=dur)
        f0, _, _ = librosa.pyin(y, fmin=60, fmax=900, sr=sr)
        f0 = f0[~np.isnan(f0)]
        return float(np.median(f0)) if len(f0) else 0.0
    except Exception:
        return 0.0


def auto_pitch(vocals):
    """自动算移调半音数（让输出音高贴近她）

    RVC 只变音色、不改音高：--pitch 0 时输出音高 = 输入音高。
    所以必须先测源人声的平均音高，再算到 309Hz 差几个半音。
    """
    src = measure_f0(vocals)
    if src <= 0:
        log('  测不到源音高 → 用 0 半音')
        return 0, src
    import math
    semis = int(round(12 * math.log2(HER_F0 / src)))
    semis = max(-12, min(12, semis))     # 限制在 ±12，避免怪声
    log('  源人声 F0 %.0f Hz ｜ 她的 F0 %.0f Hz → 自动移调 %+d 半音' % (src, HER_F0, semis))
    return semis, src


def free_vram_mb():
    """空闲显存（MB）"""
    try:
        r = subprocess.run(['nvidia-smi', '--query-gpu=memory.free',
                            '--format=csv,noheader,nounits'],
                           capture_output=True, text=True, timeout=20)
        return int(r.stdout.strip().split()[0])
    except Exception:
        return -1


def wait_vram(need_mb=6000, tries=10, gap=6):
    """等显存空出来；等不到就报错（而不是让 RVC 被系统杀掉）"""
    for i in range(tries):
        free = free_vram_mb()
        if free < 0 or free >= need_mb:
            return True
        log('  显存只剩 %d MB（需要 %d MB），等 %d 秒…' % (free, need_mb, gap))
        time.sleep(gap)
    free = free_vram_mb()
    if free >= 0 and free < need_mb:
        raise SystemExit('显存不足：空闲 %d MB，需要 %d MB（关掉别的程序再试）' % (free, need_mb))
    return True


def probe_secs(path):
    """音频时长（秒）"""
    try:
        FF = _ffmpeg().replace('ffmpeg.exe', 'ffprobe.exe')
        r = subprocess.run([FF, '-v', 'error', '-show_entries', 'format=duration',
                            '-of', 'csv=p=0', path], capture_output=True, text=True, timeout=30)
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def convert_one(src, dst, pitch, model, index_rate, index):
    """转一块"""
    idx = [index] if (index and os.path.exists(index)) else sorted(glob.glob(INDEX_GLOB))
    cmd = [RVC_PY, '-m', 'infer.cli', '--model', model,
           '--input', src, '--output', dst,
           '--pitch', str(pitch), '--f0-method', 'rmvpe',
           '--index-rate', str(index_rate), '--protect', '0.33']
    if idx:
        cmd += ['--index', idx[-1]]
    run(cmd, cwd=RVC_ROOT, env_extra={'PYTHONPATH': RVC_ROOT})


def stage_convert(vocals, out_path, pitch, model, index_rate, index=None, chunk_sec=45):
    """RVC 变声（独立进程 → 跑完显存自动释放 = 冷启动）"""
    log('═══ 阶段 3：变成她的声线（冷启动，跑完即释放显存）═══')
    if not os.path.exists(model):
        raise SystemExit('模型不存在：%s（还没训练完？）' % model)
    idx = [index] if (index and os.path.exists(index)) else sorted(glob.glob(INDEX_GLOB))
    if idx:
        log('  使用检索索引：' + os.path.basename(idx[-1]))

    total = probe_secs(vocals)
    if total <= 0:
        raise SystemExit('读不到人声时长：' + vocals)

    # ★ 长歌必须分块：8GB 显存一次转 2 分钟人声会被系统杀掉（实测退出码 1、无任何报错）。
    #   块长 45 秒，单块显存占用约 5~6GB，留出余量。
    if total <= chunk_sec * 1.2:
        wait_vram(6000)
        convert_one(vocals, out_path, pitch, model, index_rate, index)
        return out_path

    n = int(total // chunk_sec) + (1 if total % chunk_sec else 0)
    log('  人声 %.0f 秒 → 分成 %d 块（每块 %.0f 秒）转换' % (total, n, chunk_sec))
    FF = _ffmpeg()
    base = os.path.splitext(out_path)[0]
    parts = []
    for i in range(n):
        st = i * chunk_sec
        seg_in = '%s_in%02d.wav' % (base, i)
        seg_out = '%s_out%02d.wav' % (base, i)
        subprocess.run([FF, '-y', '-loglevel', 'error', '-ss', str(st),
                        '-t', str(chunk_sec), '-i', vocals, seg_in], check=True)
        wait_vram(6000)
        convert_one(seg_in, seg_out, pitch, model, index_rate, index)
        parts.append(seg_out)
        log('  第 %d/%d 块完成' % (i + 1, n))
        try:
            os.remove(seg_in)
        except Exception:
            pass

    # 拼回整首
    listfile = base + '_parts.txt'
    with open(listfile, 'w', encoding='utf-8') as f:
        for pth in parts:
            f.write("file '%s'\n" % pth.replace('\\', '/'))
    subprocess.run([FF, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
                    '-i', listfile, '-ar', '40000', '-ac', '1', out_path], check=True)
    for pth in parts + [listfile]:
        try:
            os.remove(pth)
        except Exception:
            pass
    log('  分块转换完成，已拼回整首')
    return out_path


def mix_with_inst(vocals, work, out_mp3):
    """把她的歌声和伴奏混起来（伴奏取 demucs 的 no_vocals）"""
    inst = os.path.join(os.path.dirname(os.path.dirname(vocals)), 'no_vocals.wav')
    if not os.path.exists(inst):
        inst = os.path.join(work, 'separated', 'htdemucs', 'src', 'no_vocals.wav')
    if not os.path.exists(inst):
        log('  ⚠️ 找不到伴奏，只用干声')
        shutil.copy2(vocals, out_mp3.replace('.mp3', '.wav'))
        return out_mp3.replace('.mp3', '.wav')
    FF = _ffmpeg()
    subprocess.run([FF, '-y', '-loglevel', 'error', '-i', inst, '-i', vocals,
                    '-filter_complex',
                    '[1:a]volume=0.95[v];[0:a][v]amix=inputs=2:duration=longest:dropout_transition=0[a]',
                    '-map', '[a]', '-b:a', '192k', out_mp3], check=True)
    return out_mp3


def make_silk(audio, out_silk, start=0.0, duration=SILK_MAX_SEC):
    """切一段出来编成 SILK（微信语音条）。路径必须是纯 ASCII。"""
    if not os.path.exists(SILK_TOOL):
        return None, 0
    if not all(ord(c) < 128 for c in out_silk):
        log('  ⚠️ SILK 输出路径含非 ASCII，hook 读不到 → 跳过语音条')
        return None, 0
    r = subprocess.run([PY311, SILK_TOOL, '--in', audio, '--out', out_silk,
                        '--start', str(start), '--duration', str(duration)],
                       capture_output=True, text=True, timeout=300)
    try:
        j = json.loads((r.stdout or '').strip().split('\n')[-1])
        return j.get('silk'), int(j.get('durationMs') or 0)
    except Exception:
        log('  ⚠️ SILK 编码失败：' + (r.stdout or r.stderr or '')[-120:])
        return None, 0


def _ffmpeg():
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



def probe_duration(path):
    try:
        FF = _ffmpeg().replace('ffmpeg.exe', 'ffprobe.exe')
        r = subprocess.run([FF, '-v', 'error', '-show_entries', 'format=duration',
                            '-of', 'csv=p=0', path], capture_output=True, text=True, timeout=30)
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def report_vram(tag):
    try:
        r = subprocess.run(['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits'],
                           capture_output=True, text=True)
        log('  显存（%s）：%s MiB' % (tag, r.stdout.strip()))
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--query', help='歌名关键词：自动搜 B 站、取播放最高的一条')
    ap.add_argument('--url')
    ap.add_argument('--file')
    ap.add_argument('--pitch', type=int, default=None,
                    help='半音移调。不给就自动测源音高、算到她的 309Hz；给了就强制用')
    ap.add_argument('--index-rate', type=float, default=0.75)
    ap.add_argument('--index', help='RVC 检索索引路径（不给就自动找 EXP 的）')
    ap.add_argument('--model', default=MODEL)
    ap.add_argument('--out', help='输出路径（默认 E:\\rvc\\sing-work\\her-<时间>.wav）')
    ap.add_argument('--keep-work', action='store_true')
    args = ap.parse_args()

    if not args.url and not args.file and not args.query:
        raise SystemExit('给 --query（歌名）或 --url 或 --file')
    if args.query and not args.url and not args.file:
        log('═══ 自动搜索：%s ═══' % args.query)
        bvid = bili_pick(args.query)
        args.url = 'https://www.bilibili.com/video/' + bvid

    stamp = time.strftime('%m%d-%H%M%S')
    work = os.path.join(WORK, stamp)
    os.makedirs(work, exist_ok=True)
    out = args.out or os.path.join(WORK, 'her-%s.wav' % stamp)

    report_vram('开始前')
    t0 = time.time()

    if args.url:
        src = stage_download(args.url, work)
    else:
        src = args.file
        if not os.path.exists(src):
            raise SystemExit('文件不存在：' + src)
        log('═══ 跳过下载，用本地文件 ═══')

    vocals = stage_separate(src, work)
    if args.pitch is None:
        pitch_val, _ = auto_pitch(vocals)
    else:
        pitch_val = args.pitch
        log('  使用指定移调 %+d 半音' % pitch_val)
    stage_convert(vocals, out, pitch_val, args.model, args.index_rate, args.index)

    # ── 混伴奏 → 切段 → 编 SILK（供插件直接发语音条）──────────────────
    mp3 = os.path.join(work, 'her-sing-mixed.mp3')
    try:
        mix_with_inst(out, work, mp3)
        total = probe_duration(mp3)
        log('═══ 混伴奏完成 %.1f 秒 ═══' % total)
    except Exception as e:
        log('  ⚠️ 混伴奏失败：' + str(e)[:80])
        mp3, total = out, probe_duration(out)

    # 切一段副歌：从 25% 处开始（避开前奏），最长 58 秒
    start = max(0.0, total * 0.25)
    clip_len = min(SILK_MAX_SEC, max(10.0, total - start))
    silk, silk_ms = make_silk(mp3, os.path.join(work, 'clip.silk'), start, clip_len)
    if silk:
        log('  语音条片段：%.0fs 起，%.0f 秒（%d ms）' % (start, clip_len, silk_ms))

    result = {'ok': True, 'src': src, 'vocals': vocals, 'raw': out,
              'mixed': mp3, 'totalSec': round(total, 1),
              'silk': silk or '', 'silkMs': silk_ms, 'clipStart': round(start, 1)}
    # result.json 要写在两处：
    #   · work：留档
    #   · --out 所在目录：插件（dsh-wechat-bot）从那里读，它只知道成品路径
    for _d in {work, os.path.dirname(os.path.abspath(out))}:
        try:
            with open(os.path.join(_d, 'result.json'), 'w', encoding='utf-8') as f:
                json.dump(result, f, ensure_ascii=False, indent=1)
        except Exception as e:
            log('  ⚠️ result.json 写入失败（%s）：%s' % (_d, str(e)[:60]))

    report_vram('结束后')
    log('')
    log('═══ 完成（总用时 %.1f 分钟）═══' % ((time.time() - t0) / 60))
    log('  原曲:   ' + src)
    log('  人声:   ' + vocals)
    log('  她的版本: ' + out)
    if not args.keep_work:
        log('  中间文件保留在 ' + work + '（用 --keep-work 可显式保留，默认也留）')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
