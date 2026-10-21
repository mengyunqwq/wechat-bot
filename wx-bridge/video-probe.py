"""微信视频（type 43）→ 抽帧拼联系表 + 抽音轨成 16k 单声道 PCM16 WAV。

为什么需要它：
  ① 微信视频**按需下载**，落盘后是普通 mp4（明文，不用解密）——所以视频"全部内容"是可以拿到的：
     均匀抽 N 帧拼成一张【联系表】交给视觉模型（**一次调用**，省钱），音轨转写成文字交给
     DSH 的 speechToText（provider=sensevoice-local）。
  ② 本机**没有系统 ffmpeg**，但装了 `imageio-ffmpeg`（自带静态 ffmpeg 7.1）→ 从这里取可执行文件，
     **不依赖 PATH** ✓。Pillow 用来拼联系表 ✓。不引入 cv2/av。
  ③ 服务侧（speechToText）只收 **canonical 16kHz/mono/PCM16 WAV**（逐字段校验头部），
     所以音轨先让 ffmpeg 出**裸 PCM**（`-f s16le`），再用标准库 `wave` 写成规范 WAV
     —— 不让 ffmpeg 自己写 WAV（它会加 LIST 块，头就不是 44 字节了，会被服务侧拒 ✗）。

用法：
  python video-probe.py --in <视频> --out-dir <目录> [--frames 6] [--tag t]
  python video-probe.py --selftest          # 自己用 ffmpeg 造一段测试视频跑通全链路

输出：先打人看的诊断行，最后一行是给桥解析的 `JSON: {...}`：
  {"ok":true,"sheet":"<联系表.jpg>","wav":"<音轨.wav>","durationSec":5.0,"frames":6,...}
失败：`失败: <原因>` + 非 0 退出（桥侧只记日志并降级）。
"""
import math
import argparse
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import wave

# ── 配置 ──────────────────────────────────────────────────────
TARGET_RATE = 16000        # speechToText 硬要求
MAX_FRAMES = 60            # 上限（每秒 1 帧，60 秒内按实际时长；超长视频截断到 60 帧）
PER_SHEET = 20             # 每张联系表最多几格（60 帧 → 3 张）
CELL_W = 360               # 联系表每格宽度（像素）
JPEG_Q = 85


def ffmpeg_exe():
    """取 ffmpeg：优先 imageio-ffmpeg 自带的静态版（本机没有系统 ffmpeg）"""
    try:
        import imageio_ffmpeg
        p = imageio_ffmpeg.get_ffmpeg_exe()
        if p and os.path.exists(p):
            return p
    except Exception:
        pass
    p = os.environ.get('FFMPEG_EXE') or shutil.which('ffmpeg')
    if p and os.path.exists(p):
        return p
    raise RuntimeError('找不到 ffmpeg：请 pip install imageio-ffmpeg（本机没有系统 ffmpeg）')


def run(cmd, timeout=180):
    """跑一条命令，返回 (rc, stdout+stderr)"""
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
        out = (r.stdout or b'') + (r.stderr or b'')
        return r.returncode, out.decode('utf-8', 'replace')
    except subprocess.TimeoutExpired:
        return -9, 'timeout'
    except Exception as e:
        return -1, str(e)


def probe_duration(ff, src):
    """从 ffmpeg 的探测输出里取时长（秒）。取不到返回 0（后面按"少抽几帧"处理）"""
    rc, out = run([ff, '-hide_banner', '-i', src], timeout=60)
    m = re.search(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', out)
    if not m:
        return 0.0
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def pick_frame_times(duration, frames, fps=1.0):
    """按【每秒 fps 帧】取时间点（用户要求：每秒 1 帧）。
    - 已知时长：帧数 = ceil(时长 × fps)，上限 MAX_FRAMES
    - 未知时长：退回按 frames 参数（默认 6）等间隔
    """
    try: fps = float(fps)
    except Exception: fps = 1.0
    if fps <= 0: fps = 1.0
    if duration and duration > 0:
        want = int(math.ceil(duration * fps))
        n = max(1, min(want, MAX_FRAMES))
        # 取每帧的代表时间点：第 i 帧取 (i + 0.5) / fps 秒
        out = []
        for i in range(n):
            t = (i + 0.5) / fps
            if t >= duration: t = max(0.0, duration - 0.05)
            out.append(t)
        return out, n
    n = max(1, min(int(frames or 6), MAX_FRAMES))
    return [float(i) for i in range(n)], n

def extract_frames(ff, src, out_dir, times, tag):
    """抽帧 → 返回 [jpg 路径]（失败/空则少几个）"""
    out = []
    for i, t in enumerate(times):
        p = os.path.join(out_dir, '%s-f%02d.jpg' % (tag, i))
        rc, log = run([ff, '-hide_banner', '-loglevel', 'error', '-ss', '%.3f' % t,
                       '-i', src, '-frames:v', '1', '-q:v', '3', '-y', p], timeout=120)
        if rc == 0 and os.path.exists(p) and os.path.getsize(p) > 512:
            out.append((t, p))
        else:
            print('提示: 第 %d 帧抽取失败（t=%.2fs）：%s' % (i, t, log.strip()[:120]))
    return out


def build_contact_sheet(frames, out_path):
    """把若干帧拼成一张联系表（每格左上角标时间戳，纯 ASCII 用默认字体即可）"""
    from PIL import Image, ImageDraw
    if not frames:
        return None
    imgs = []
    for t, p in frames:
        try:
            im = Image.open(p).convert('RGB')
        except Exception as e:
            print('提示: 打开帧失败 %s：%s' % (os.path.basename(p), e))
            continue
        w, h = im.size
        if w > CELL_W:
            im = im.resize((CELL_W, max(1, int(h * CELL_W / w))), Image.LANCZOS)
        imgs.append((t, im))
    if not imgs:
        return None
    cols = 3 if len(imgs) >= 3 else len(imgs)
    rows = (len(imgs) + cols - 1) // cols
    cw = max(im.size[0] for _, im in imgs)
    ch = max(im.size[1] for _, im in imgs)
    pad, label_h = 6, 16
    W = cols * cw + (cols + 1) * pad
    H = rows * (ch + label_h) + (rows + 1) * pad
    sheet = Image.new('RGB', (W, H), (24, 24, 28))
    d = ImageDraw.Draw(sheet)
    for k, (t, im) in enumerate(imgs):
        r, c = divmod(k, cols)
        x = pad + c * (cw + pad)
        y = pad + r * (ch + label_h + pad)
        sheet.paste(im, (x, y))
        d.text((x + 2, y + ch + 1), '%.1fs' % t, fill=(235, 235, 235))
    sheet.save(out_path, 'JPEG', quality=JPEG_Q)
    return out_path


def extract_audio_wav(ff, src, out_dir, tag):
    """抽音轨 → 裸 PCM → 规范 16k/mono/PCM16 WAV。没有音轨返回 ''（不是错误）"""
    pcm = os.path.join(out_dir, '%s-audio.pcm' % tag)
    rc, log = run([ff, '-hide_banner', '-loglevel', 'error', '-i', src, '-vn',
                   '-ac', '1', '-ar', str(TARGET_RATE), '-acodec', 'pcm_s16le',
                   '-f', 's16le', '-y', pcm], timeout=300)
    if rc != 0 or not os.path.exists(pcm) or os.path.getsize(pcm) < 2:
        print('提示: 这条视频没有可用音轨（或抽取失败）：%s' % log.strip()[:120])
        try:
            if os.path.exists(pcm):
                os.unlink(pcm)
        except Exception:
            pass
        return '', 0.0
    with open(pcm, 'rb') as fp:
        raw = fp.read()
    if len(raw) % 2:
        raw = raw[:-1]
    wav = os.path.join(out_dir, '%s-audio.wav' % tag)
    # 规范头：标准库 wave 写出来正好是服务侧要的 44 字节 canonical 布局（实测通过）
    with wave.open(wav, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TARGET_RATE)
        w.writeframes(raw)
    try:
        os.unlink(pcm)
    except Exception:
        pass
    return wav, (len(raw) // 2) / float(TARGET_RATE)


def probe(src, out_dir, frames=6, tag='video', fps=1.0):
    """主流程：抽帧 → 联系表 → 音轨 WAV。返回给桥的 dict。"""
    if not os.path.exists(src):
        raise RuntimeError('输入视频不存在：%s' % src)
    if os.path.getsize(src) < 1024:
        raise RuntimeError('输入视频太小（%d 字节），可能没下载完' % os.path.getsize(src))
    os.makedirs(out_dir, exist_ok=True)
    ff = ffmpeg_exe()
    duration = probe_duration(ff, src)
    times, n = pick_frame_times(duration, frames, fps)
    print('视频: %s（%.1fMB）｜时长 %.2fs｜计划抽 %d 帧' % (os.path.basename(src), os.path.getsize(src) / 1048576, duration, n))

    frames_out = extract_frames(ff, src, out_dir, times, tag)
    print('抽帧: 成功 %d/%d' % (len(frames_out), n))
    sheets = []
    if frames_out:
        # ★ 每张联系表最多 PER_SHEET 格（用户要求：60 帧分成 2~3 张，每格更大更清楚）
        for idx in range(0, len(frames_out), PER_SHEET):
            chunk = frames_out[idx:idx + PER_SHEET]
            name = ('%s-sheet.jpg' % tag) if len(frames_out) <= PER_SHEET else ('%s-sheet%d.jpg' % (tag, len(sheets) + 1))
            p = build_contact_sheet(chunk, os.path.join(out_dir, name)) or ''
            if p:
                sheets.append(p)
                print('联系表%d: %s（%d 帧，%dKB）' % (len(sheets), p, len(chunk), os.path.getsize(p) // 1024))
    sheet = sheets[0] if sheets else ''
    # 抽帧的中间文件用完即删（只留联系表）
    for _t, p in frames_out:
        try:
            os.unlink(p)
        except Exception:
            pass

    wav, wav_sec = extract_audio_wav(ff, src, out_dir, tag)
    if wav:
        print('音轨: %s（%.2fs @16kHz/mono/PCM16）' % (wav, wav_sec))

    return {
        'ok': bool(sheet or wav),
        'sheet': sheet,
        'sheets': sheets,
        'wav': wav,
        'durationSec': round(duration, 3),
        'frames': len(frames_out),
        'frameTimes': [round(t, 2) for t, _ in frames_out],
        'sheetBytes': os.path.getsize(sheet) if sheet else 0,
        'wavSeconds': round(wav_sec, 2),
        'ffmpeg': os.path.basename(ff),
    }


def do_selftest():
    """自检：用 ffmpeg 造一段 5s 测试视频（testsrc 画面 + 440Hz 正弦）→ 跑通全链路 → 校验产物"""
    import tempfile
    tmp = tempfile.mkdtemp(prefix='video-probe-selftest-')
    src = os.path.join(tmp, 'test.mp4')
    ok = True
    try:
        ff = ffmpeg_exe()
        print('① 造测试视频（testsrc 5s + 440Hz）…')
        rc, log = run([ff, '-hide_banner', '-loglevel', 'error',
                       '-f', 'lavfi', '-i', 'testsrc=duration=5:size=640x360:rate=15',
                       '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
                       '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', src], timeout=180)
        if rc != 0 or not os.path.exists(src):
            print('失败: 造测试视频失败：%s' % log[:200])
            return 1
        print('   视频: %d 字节' % os.path.getsize(src))

        print('② 抽帧 + 联系表 + 音轨 …')
        r = probe(src, tmp, frames=6, tag='selftest')
        print('③ 校验产物：')
        checks = []
        if r['sheet']:
            from PIL import Image
            im = Image.open(r['sheet'])
            checks.append(('联系表是合法 JPEG', im.format == 'JPEG'))
            checks.append(('联系表够大（>10KB）', r['sheetBytes'] > 10 * 1024))
            checks.append(('抽到 >=2 帧', r['frames'] >= 2))
            print('   联系表尺寸 %dx%d，%d 帧' % (im.size[0], im.size[1], r['frames']))
        else:
            checks.append(('有联系表', False))
        if r['wav']:
            with open(r['wav'], 'rb') as fp:
                head = fp.read(44)
            size = os.path.getsize(r['wav'])
            checks += [
                ('音轨是 canonical 16k/mono/PCM16 WAV',
                 head[0:4] == b'RIFF' and head[8:12] == b'WAVE' and head[12:16] == b'fmt '
                 and struct.unpack_from('<I', head, 16)[0] == 16
                 and struct.unpack_from('<H', head, 20)[0] == 1
                 and struct.unpack_from('<H', head, 22)[0] == 1
                 and struct.unpack_from('<I', head, 24)[0] == 16000
                 and struct.unpack_from('<H', head, 34)[0] == 16
                 and struct.unpack_from('<I', head, 4)[0] == size - 8
                 and struct.unpack_from('<I', head, 40)[0] == size - 44),
                ('音轨时长≈5s', abs(r['wavSeconds'] - 5.0) < 1.0),
            ]
        else:
            checks.append(('有音轨 WAV', False))
        checks.append(('时长≈5s', abs(r['durationSec'] - 5.0) < 1.0))
        for name, good in checks:
            print('   %s %s' % ('✓' if good else '✗', name))
            ok = ok and good
        # 中间帧应该已经删掉（只留联系表 + 音轨）
        left = sorted(os.listdir(tmp))
        frames_left = [f for f in left if '-f0' in f]
        print('   目录剩余: %s' % ', '.join(left))
        print('   中间帧已清理: %s' % ('✓' if not frames_left else '✗ ' + ','.join(frames_left)))
        ok = ok and not frames_left
        print('JSON: %s' % json.dumps(r, ensure_ascii=False))
        print('结果: %s' % ('全部通过（%d 项）' % len(checks) if ok else '有失败项'))
    except Exception as e:
        print('失败: %s' % e)
        ok = False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description='微信视频抽帧拼联系表 + 抽音轨成 16k WAV')
    ap.add_argument('--in', dest='src', help='输入视频文件')
    ap.add_argument('--out-dir', dest='out_dir', help='输出目录（临时目录）')
    ap.add_argument('--frames', dest='frames', type=int, default=6, help='抽几帧（默认 6，上限 %d）' % MAX_FRAMES)
    ap.add_argument('--fps', dest='fps', type=float, default=1.0, help='每秒抽几帧（默认 1，用户要求每秒 1 帧）')
    ap.add_argument('--tag', dest='tag', default='video', help='输出文件名前缀（带消息 id 防冲突）')
    ap.add_argument('--selftest', action='store_true', help='自己造测试视频跑通全链路')
    a = ap.parse_args()

    if a.selftest:
        return do_selftest()
    if not a.src or not a.out_dir:
        ap.print_help()
        print('失败: 缺少 --in / --out-dir')
        return 2
    try:
        r = probe(a.src, a.out_dir, frames=a.frames, fps=a.fps, tag=re.sub(r'[^\w.-]', '_', str(a.tag))[:40])
    except Exception as e:
        print('失败: %s' % e)
        return 1
    if not r['ok']:
        print('失败: 既没抽到画面也没抽到音轨')
        return 1
    print('JSON: %s' % json.dumps(r, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
