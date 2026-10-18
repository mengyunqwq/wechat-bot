"""微信语音（SILK）→ 16kHz 单声道 PCM16 WAV，供 DSH 的「语音输入」转写用。

为什么需要它：
  ① 微信语音（local_type=34）在磁盘上是 **SILK v3** 编码（腾讯自研，网页/通用播放器都放不了），
     文件头是 `#!SILK_V3`；腾讯系还有一种前面多一个 `\\x02` 的变体（pilk 自己认）。
  ② DSH 的 speechToText 服务（provider=sensevoice-local）**只收**
     "canonical 16 kHz mono PCM16 WAV"（服务侧会逐字段校验头部，不一致直接拒绝）。
  ③ 本机**没有 ffmpeg**，所以不依赖它：SILK 解码用纯 Python 的 `pilk`（pip install pilk），
     重采样到 16k 用纯 Python 线性插值（语音很短，不需要 numpy）。

实测结论（拿 pilk 0.2.4 真跑过，别凭猜改）：
  - pilk.decode(silk_path, pcm_path, pcm_rate=N) 是**文件路径**接口，不是字节接口；
    它**返回 0**（返回值不可信！），时长要用 pilk.get_duration(path)（单位 ms）。
  - pilk.decode 内部**会**按 pcm_rate 真重采样（24k→16k 字节数正好 2/3）。
    但我们仍自己重采样：这样不依赖 libsilk 的行为，且便于按真实源采样率兜底。
  - `\\x02` 前缀的腾讯变体 pilk 能直接解；**缺 `#!SILK_V3` 头**的裸流会报 "Wrong Header"。

用法：
  python decode-wechat-voice.py --in <语音文件> --out <输出.wav>   # 正常用法
  python decode-wechat-voice.py --probe <文件>                     # 只看容器/时长，不解码
  python decode-wechat-voice.py --selftest                         # 合成 PCM → 编码 → 解码 → 校验

成功打印 `结果: <wav路径>`，失败打印 `失败: <原因>` 并以非 0 退出。
"""
import argparse
import os
import struct
import sys
import tempfile
import wave
from array import array

# ── 配置 ──────────────────────────────────────────────────────
TARGET_RATE = 16000          # DSH speechToText 硬要求：16 kHz
TARGET_CHANNELS = 1          # 单声道
SILK_MAGIC = b'#!SILK_V3'
SILK_MAGIC_ALT = b'#!SILK'   # 早期短头
AMR_MAGIC = (b'#!AMR\n', b'#!AMR-WB\n')
# pilk/libsilk 认的采样率档位（用来把"实测采样率"归一到最近的档）
KNOWN_RATES = (8000, 12000, 16000, 24000, 32000, 44100, 48000)


def sniff(data):
    """识别容器格式：silk / amr / wav / mp3 / other"""
    if not data:
        return 'empty'
    if data[:1] == b'\x02' and data[1:10] == SILK_MAGIC:
        return 'silk'          # 腾讯系：\x02 + #!SILK_V3
    if data[:9] == SILK_MAGIC or data[:6] == SILK_MAGIC_ALT:
        return 'silk'
    if data[:4] == b'RIFF' and data[8:12] == b'WAVE':
        return 'wav'
    for m in AMR_MAGIC:
        if data[:len(m)] == m:
            return 'amr'
    if data[:3] == b'ID3' or data[:2] in (b'\xff\xfb', b'\xff\xf3', b'\xff\xf2', b'\xff\xfa'):
        return 'mp3'
    if data[:4] == b'\x1a\x45\xdf\xa3':
        return 'webm'
    return 'other'


# ── 重采样（纯 Python 线性插值）────────────────────────────────
def resample_linear(pcm, src_rate, dst_rate):
    """s16le PCM：src_rate → dst_rate（线性插值）。返回 s16le bytes。

    本机没有 numpy，也不装 —— 语音通常几秒到几十秒（最长 4MB/32KBps≈131s），
    一次线性插值在 CPython 里也就几百毫秒，不值得引依赖。
    """
    if src_rate == dst_rate or not pcm:
        return pcm
    n_src = len(pcm) // 2
    if n_src < 2:
        return pcm
    src = array('h')
    src.frombytes(pcm[:n_src * 2])
    if sys.byteorder != 'little':
        src.byteswap()
    n_dst = int(round(n_src * dst_rate / float(src_rate)))
    if n_dst < 1:
        return pcm
    step = src_rate / float(dst_rate)
    out = array('h')
    append = out.append
    last = n_src - 1
    for i in range(n_dst):
        p = i * step
        i0 = int(p)
        if i0 >= last:
            append(src[last])
            continue
        frac = p - i0
        s = src[i0] + (src[i0 + 1] - src[i0]) * frac
        v = int(s)
        if v > 32767:
            v = 32767
        elif v < -32768:
            v = -32768
        append(v)
    if sys.byteorder != 'little':
        out.byteswap()
    return out.tobytes()


def write_wav16(path, pcm):
    """写成 **canonical** 16k/mono/PCM16 WAV。

    必须与 DSH 服务侧的 validateWave 逐字段一致（RIFF/WAVE/fmt 16/PCM/1ch/16000/32000/2/16/data，
    且 RIFF size = 文件长-8、data size = 文件长-44、PCM 字节数为偶数）——
    标准库 wave 写出来正好就是这个布局（实测校验通过）。
    """
    d = os.path.dirname(os.path.abspath(path))
    if d:
        os.makedirs(d, exist_ok=True)
    if len(pcm) % 2:
        pcm = pcm[:-1]
    with wave.open(path, 'wb') as w:
        w.setnchannels(TARGET_CHANNELS)
        w.setsampwidth(2)
        w.setframerate(TARGET_RATE)
        w.writeframes(pcm)


# ── SILK 解码 ─────────────────────────────────────────────────
def _import_pilk():
    try:
        import pilk
        return pilk
    except Exception as e:
        raise RuntimeError('没装 pilk（SILK 解码库）：pip install pilk ｜ 原始错误: %s' % e)


def _normalize_silk(src, data, force_silk=False):
    """把输入规整成 pilk 能吃的文件，返回 (路径, 是否临时文件)。

    pilk 认 `#!SILK_V3` 与 `\\x02#!SILK_V3`；**裸流（无头）**会报 Wrong Header。
    裸流很可能是"缺头的老格式"，用 --force-silk 补一个头再试（不默认猜，避免静默产出垃圾）。
    """
    if data[:9] == SILK_MAGIC or (data[:1] == b'\x02' and data[1:10] == SILK_MAGIC):
        return src, False
    if data[:6] == SILK_MAGIC_ALT and data[:9] != SILK_MAGIC:
        # `#!SILK` 短头（非 V3）：pilk 只认 V3，补成 V3 头
        fd, tmp = tempfile.mkstemp(suffix='.silk', prefix='wechat-voice-hdr-')
        with os.fdopen(fd, 'wb') as fp:
            fp.write(SILK_MAGIC + data[6:])
        return tmp, True
    if force_silk:
        fd, tmp = tempfile.mkstemp(suffix='.silk', prefix='wechat-voice-raw-')
        with os.fdopen(fd, 'wb') as fp:
            fp.write(SILK_MAGIC + data)
        return tmp, True
    return src, False


def silk_to_pcm16(silk_path, data, force_silk=False, in_rate=24000, verbose=True):
    """SILK → (s16le PCM bytes, 实测源采样率, 时长秒)。失败抛 RuntimeError。"""
    pilk = _import_pilk()
    path, tmp_used = _normalize_silk(silk_path, data, force_silk)
    fd, pcm_tmp = tempfile.mkstemp(suffix='.pcm', prefix='wechat-voice-pcm-')
    os.close(fd)
    pcm = b''
    dur_ms = 0
    try:
        try:
            # 注意：返回值恒为 0，**不要**当时长用（实测踩过）
            pilk.decode(path, pcm_tmp, pcm_rate=in_rate)
        except Exception as e:
            raise RuntimeError('pilk 解码失败（可能不是 SILK，或文件损坏/未下载完）：%s' % e)
        if not os.path.exists(pcm_tmp) or os.path.getsize(pcm_tmp) < 2:
            raise RuntimeError('pilk 没产出 PCM（解码结果为空）')
        with open(pcm_tmp, 'rb') as fp:
            pcm = fp.read()
        # 时长必须在**规整后的文件**上取（裸流补头前 get_duration 会读到垃圾）
        try:
            dur_ms = int(pilk.get_duration(path))
        except Exception:
            dur_ms = 0
    finally:
        for p in (pcm_tmp, path if tmp_used else None):
            try:
                if p and os.path.exists(p):
                    os.unlink(p)
            except Exception:
                pass

    # ── 源采样率：优先用 pilk.get_duration 反推（比"假定 24k"可靠）──
    rate = in_rate
    if dur_ms > 0:
        derived = (len(pcm) // 2) / (dur_ms / 1000.0)
        near = min(KNOWN_RATES, key=lambda r: abs(r - derived))
        if abs(near - derived) / float(near) < 0.08:
            rate = near
            if verbose and rate != in_rate:
                print('提示: 实测源采样率 %dHz（与假定 %dHz 不符，已按实测重采样）' % (rate, in_rate))
        elif verbose:
            print('提示: 时长反推采样率 %.0fHz 不在常见档位，按 %dHz 处理' % (derived, rate))
    seconds = (len(pcm) // 2) / float(rate) if rate else 0.0
    return pcm, rate, seconds


# ── WAV 输入（透传/转换）───────────────────────────────────────
def wav_to_pcm16(src):
    """已是 WAV：16k/mono/PCM16 直接透传，否则转换。返回 (pcm, 源描述)。"""
    with wave.open(src, 'rb') as w:
        ch, sw, fr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if sw != 2:
        raise RuntimeError('WAV 位深是 %d 字节（只支持 16bit）；请先转成 16bit PCM' % sw)
    if ch > 1:   # 多声道 → 平均成单声道
        a = array('h')
        a.frombytes(raw[:len(raw) // 2 * 2])
        if sys.byteorder != 'little':
            a.byteswap()
        mono = array('h')
        for i in range(0, len(a) - ch + 1, ch):
            mono.append(int(sum(a[i:i + ch]) / ch))
        if sys.byteorder != 'little':
            mono.byteswap()
        raw = mono.tobytes()
    if fr != TARGET_RATE:
        raw = resample_linear(raw, fr, TARGET_RATE)
    return raw, '%dch/%dbit/%dHz' % (ch, sw * 8, fr)


# ── 主流程 ────────────────────────────────────────────────────
def convert(src, dst, force_silk=False, in_rate=24000, verbose=True):
    """任意输入 → 16k/mono/PCM16 WAV。返回 (容器, 时长秒)。失败抛 RuntimeError。"""
    if not os.path.exists(src):
        raise RuntimeError('输入文件不存在：%s' % src)
    with open(src, 'rb') as fp:
        data = fp.read()
    if not data:
        raise RuntimeError('输入文件是空的：%s' % src)
    kind = sniff(data)
    if verbose:
        print('容器: %s ｜ %d 字节' % (kind, len(data)))

    # --force-silk：把"认不出但可能是裸 SILK"的输入也走 SILK 分支（补头再解）
    treat_as_silk = kind == 'silk' or (force_silk and kind not in ('wav', 'amr', 'mp3'))
    if treat_as_silk:
        pcm, rate, seconds = silk_to_pcm16(src, data, force_silk=force_silk,
                                           in_rate=in_rate, verbose=verbose)
        if rate != TARGET_RATE:
            pcm = resample_linear(pcm, rate, TARGET_RATE)
        if verbose:
            print('SILK %dHz → %dHz ｜ 时长约 %.2fs ｜ PCM %d 字节'
                  % (rate, TARGET_RATE, seconds, len(pcm)))
        write_wav16(dst, pcm)
        return 'silk', seconds

    if kind == 'wav':
        pcm, desc = wav_to_pcm16(src)
        seconds = (len(pcm) // 2) / float(TARGET_RATE)
        if verbose:
            print('WAV %s → 16kHz/mono/PCM16 ｜ 时长约 %.2fs%s'
                  % (desc, seconds, '（原样透传）' if desc == '1ch/16bit/16000Hz' else ''))
        write_wav16(dst, pcm)
        return 'wav', seconds

    if kind == 'amr':
        raise RuntimeError('输入是 AMR（不是 SILK）。本机没有 ffmpeg，解不了 AMR —— '
                           '请确认微信语音格式，或装 ffmpeg 后自行转 WAV')
    if kind == 'mp3':
        raise RuntimeError('输入是 MP3（不是 SILK）。本机没有 ffmpeg，解不了 MP3')
    raise RuntimeError('认不出容器格式（前 8 字节 %s）。若确认是"无头 SILK"，加 --force-silk 再试'
                       % data[:8].hex())


def do_selftest():
    """自检：合成 24kHz PCM → pilk 编码成 SILK → 走完整解码链路 → 校验 WAV 头。"""
    tmpdir = tempfile.mkdtemp(prefix='wechat-voice-selftest-')
    pcm_in = os.path.join(tmpdir, 'in24.pcm')
    silk = os.path.join(tmpdir, 't.silk')
    out = os.path.join(tmpdir, 't.wav')
    ok = True
    try:
        import math
        n = 24000  # 1.0s @24kHz
        with open(pcm_in, 'wb') as fp:
            for i in range(n):
                fp.write(struct.pack('<h', int(12000 * math.sin(2 * math.pi * 440 * i / 24000.0))))
        pilk = _import_pilk()
        pilk.encode(pcm_in, silk, pcm_rate=24000)
        print('① 合成 PCM → SILK：%d 字节（pilk %s）' % (os.path.getsize(silk), getattr(pilk, '__version__', '?')))

        kind, seconds = convert(silk, out, verbose=True)
        print('② 解码 → %s ｜ 容器 %s ｜ 时长 %.2fs' % (out, kind, seconds))

        with open(out, 'rb') as fp:
            head = fp.read(44)
        size = os.path.getsize(out)
        checks = [
            ('RIFF', head[0:4] == b'RIFF'),
            ('WAVE', head[8:12] == b'WAVE'),
            ('fmt ', head[12:16] == b'fmt '),
            ('fmt=16', struct.unpack_from('<I', head, 16)[0] == 16),
            ('PCM', struct.unpack_from('<H', head, 20)[0] == 1),
            ('mono', struct.unpack_from('<H', head, 22)[0] == 1),
            ('16000Hz', struct.unpack_from('<I', head, 24)[0] == 16000),
            ('byteRate=32000', struct.unpack_from('<I', head, 28)[0] == 32000),
            ('blockAlign=2', struct.unpack_from('<H', head, 32)[0] == 2),
            ('16bit', struct.unpack_from('<H', head, 34)[0] == 16),
            ('data', head[36:40] == b'data'),
            ('riffSize=len-8', struct.unpack_from('<I', head, 4)[0] == size - 8),
            ('dataSize=len-44', struct.unpack_from('<I', head, 40)[0] == size - 44),
            ('PCM 偶数字节', (size - 44) % 2 == 0),
            ('时长≈1.0s', abs(seconds - 1.0) < 0.15),
        ]
        for name, good in checks:
            print('   %s %s' % ('✓' if good else '✗', name))
            ok = ok and good
        print('结果: %s' % ('全部通过（%d 项）' % len(checks) if ok else '有失败项'))
    except Exception as e:
        print('失败: %s' % e)
        ok = False
    finally:
        for f in (pcm_in, silk, out):
            try:
                if os.path.exists(f):
                    os.unlink(f)
            except Exception:
                pass
        try:
            os.rmdir(tmpdir)
        except Exception:
            pass
    return 0 if ok else 1


def do_probe(src):
    """只看容器/时长，不解码 —— 实测排查"微信到底把语音存成了什么"用。"""
    if not os.path.exists(src):
        print('失败: 输入文件不存在：%s' % src)
        return 1
    with open(src, 'rb') as fp:
        data = fp.read()
    kind = sniff(data)
    print('文件: %s' % src)
    print('容器: %s ｜ %d 字节 ｜ 前 12 字节 %s' % (kind, len(data), data[:12].hex()))
    if kind == 'silk':
        try:
            pilk = _import_pilk()
            ms = pilk.get_duration(src)
            print('时长: %d ms（pilk.get_duration）' % ms)
        except Exception as e:
            print('时长: 取不到（%s）' % e)
    print('结果: %s' % kind)
    return 0 if kind != 'other' else 2


def main():
    ap = argparse.ArgumentParser(description='微信语音 SILK → 16kHz 单声道 PCM16 WAV')
    ap.add_argument('--in', dest='src', help='输入语音文件（SILK / WAV）')
    ap.add_argument('--out', dest='dst', help='输出 WAV 路径')
    ap.add_argument('--in-rate', dest='in_rate', type=int, default=24000,
                    help='pilk 解码时的源采样率（默认 24000；脚本会用 get_duration 反推校正）')
    ap.add_argument('--force-silk', dest='force_silk', action='store_true',
                    help='无 #!SILK_V3 头的裸流：补一个头再解（默认不猜，直接报错）')
    ap.add_argument('--probe', help='只识别容器/时长，不解码')
    ap.add_argument('--selftest', action='store_true', help='合成 PCM → 编码 → 解码 → 校验 WAV 头')
    ap.add_argument('src_pos', nargs='?', help=argparse.SUPPRESS)
    ap.add_argument('dst_pos', nargs='?', help=argparse.SUPPRESS)
    a = ap.parse_args()

    if a.selftest:
        return do_selftest()
    if a.probe:
        return do_probe(a.probe)

    src = a.src or a.src_pos
    dst = a.dst or a.dst_pos
    if not src or not dst:
        ap.print_help()
        print('失败: 缺少 --in / --out')
        return 2
    try:
        _kind, seconds = convert(src, dst, force_silk=a.force_silk, in_rate=a.in_rate)
    except Exception as e:
        print('失败: %s' % e)
        return 1
    if not os.path.exists(dst) or os.path.getsize(dst) < 44:
        print('失败: 没写出有效的 WAV：%s' % dst)
        return 1
    print('结果: %s（%.2fs, %d 字节）' % (os.path.abspath(dst), seconds, os.path.getsize(dst)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
