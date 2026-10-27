"""文字 → edge-tts 合成 → ffmpeg 转 24kHz 单声道 PCM16 → pilk 编码 **微信 SILK 语音**。

为什么需要它：
  微信语音（type 34）的本地/网络格式是 **SILK v3**（文件头 `#!SILK_V3`），不是 mp3/wav。
  想发一条"机器人自己说话"的语音，就必须自己合成出 SILK。

链路（2026-10 实测跑通，别自己另找方案）：
  ① edge-tts（微软在线合成，免费，**不需要 key**；Python API `Communicate.save()`，不 shell 出去调 CLI）
  ② ffmpeg 走 `imageio-ffmpeg` 自带的静态 ffmpeg 7.1（**本机没有系统 ffmpeg，不要依赖 PATH**）
     → **24kHz / 单声道 / PCM16 裸流**（`-f s16le`）
  ③ `pilk.encode(pcm路径, silk路径, pcm_rate=24000)` —— 注意**两个参数都是路径字符串**（不是字节！）
  ④ 校验 `#!SILK_V3` 头 + `pilk.get_duration()` 时长，再落 `--out`

⚠️ 三个实测坑（踩过，别改）：
  1. `pilk.encode` **假定输入是 24kHz**（没有重采样参数，`pcm_rate` 只是告诉它源是什么）→
     ffmpeg 必须出 **24kHz**，否则发出去的语音会**变速**。所以下面用"PCM 字节数 ÷ (24000×2)"
     反算秒数，与 mp3 时长对比，差太多就报错（防采样率写错）。
  2. `pilk.decode()` **返回值不可信（它返回 0）**，时长一律用 `pilk.get_duration(path)`（毫秒）。
  3. `pilk.encode` 的 `pcm_rate` 关键字在某些版本/构建里可能不存在 → 用 try/except TypeError 退化到
     无参调用（无参就是 24kHz，正好是我们要的）。
  4. ⚠️ **负数值会被 argparse 当成选项**：`--rate -6%` 直接报 "expected one argument"
     （sweet/-6%、angry/-4Hz 必挂，实测踩到）→ 见 `normalize_argv()`；Node 侧统一用 `--rate=` 形式传参。

用法：
  python tts-silk.py --text "你好呀" --out D:\\tmp\\a.silk [--voice zh-CN-XiaoyiNeural]
                     [--rate +8%] [--pitch +18Hz] [--keep-pcm] [--verify-wav D:\\tmp\\a16.wav]
  python tts-silk.py --selftest

输出：先打人看的诊断行，**最后一行**是给桥/Node 解析的 `JSON: {...}`（与 video-probe.py 一致）：
  {"ok":true,"silk":"<路径>","bytes":16743,"durationMs":6700,"voice":"...","rate":"...","pitch":"..."}
失败：`失败: <原因>` + `JSON: {"ok":false,"error":"...","stage":"..."}` + 非 0 退出（Node 侧好降级）。

临时文件：默认放 `data\\tts-tmp\\`（不存在就退回系统临时目录），跑完只留 `--out`（+ 显式要的
`--keep-pcm` / `--verify-wav`），陈年残留（>1 小时）顺手清掉。
"""
import argparse
import asyncio
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time

# ── 配置 ──────────────────────────────────────────────────────
PCM_RATE = 24000           # pilk.encode 硬要求：24kHz（它不会重采样）
PCM_CHANNELS = 1
PCM_WIDTH = 2              # PCM16
MAX_TEXT_CHARS = 200       # 硬上限（Node 侧另有 120 的更严限制；语音太长很怪）
SYNTH_TIMEOUT = 60         # edge-tts 单次合成超时（秒）
FFMPEG_TIMEOUT = 120
SILK_MAGIC = b'#!SILK_V3'
DEFAULT_VOICE = 'zh-CN-XiaoyiNeural'
DEFAULT_RATE = '+8%'
DEFAULT_PITCH = '+18Hz'
TMP_KEEP_SEC = 3600        # 陈年临时文件阈值
BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TMP_DIR = os.path.join(os.path.dirname(BRIDGE_DIR), 'data', 'tts-tmp')

RATE_RE = re.compile(r'^[+-]\d{1,3}%$')
PITCH_RE = re.compile(r'^[+-]\d{1,3}Hz$')

# 需要"值"的选项（用于把 `--rate -6%` 规整成 `--rate=-6%`，见 normalize_argv）
VALUE_OPTS = ('--text', '--text-file', '--out', '--voice', '--rate', '--pitch', '--verify-wav')


def normalize_argv(argv):
    """⚠️ 实测坑：argparse 会把 `--rate -6%` 里的 `-6%` 当成**选项**，直接报
    "argument --rate: expected one argument" —— 于是 sweet(-6%) 和 angry(-4Hz) **必挂**。
    修法：遇到"选项 + 负数样值（`^-\\d`）"就合成 `--rate=-6%` 再交给 argparse。
    （Node 侧另有一层保险：它统一用 `--rate=` 形式传参。）"""
    out = []
    i = 0
    while i < len(argv):
        cur = argv[i]
        if cur in VALUE_OPTS and i + 1 < len(argv) and re.match(r'^-\d', argv[i + 1]):
            out.append(cur + '=' + argv[i + 1])
            i += 2
            continue
        out.append(cur)
        i += 1
    return out


class JsonArgumentParser(argparse.ArgumentParser):
    """参数错误也要打一行 `JSON: {...}`（Node 侧才能从 stderr/stdout 里读到原因，而不是一堆 usage）"""

    def error(self, message):
        self.print_usage(sys.stderr)
        print('失败: %s' % message)
        print('JSON: %s' % json.dumps({'ok': False, 'error': message, 'stage': 'input'}, ensure_ascii=False))
        raise SystemExit(2)


class StageError(RuntimeError):
    """带阶段名的失败（好让 Node 侧日志看得出是网络、edge-tts、ffmpeg 还是 pilk 挂了）"""

    def __init__(self, stage, msg):
        super().__init__(msg)
        self.stage = stage
        self.msg = msg


# ── 基础工具 ──────────────────────────────────────────────────
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
    raise StageError('ffmpeg', '找不到 ffmpeg：请 pip install imageio-ffmpeg（本机没有系统 ffmpeg）')


def run(cmd, timeout=FFMPEG_TIMEOUT):
    """跑一条命令，返回 (rc, stdout+stderr)"""
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
        out = (r.stdout or b'') + (r.stderr or b'')
        return r.returncode, out.decode('utf-8', 'replace')
    except subprocess.TimeoutExpired:
        return -9, 'timeout(%ss)' % timeout
    except Exception as e:
        return -1, str(e)


def tmp_dir():
    """临时目录：优先 data\\tts-tmp（好排查），不可写就退回系统临时目录"""
    for d in (DEFAULT_TMP_DIR,):
        try:
            os.makedirs(d, exist_ok=True)
            probe = os.path.join(d, '.w')
            with open(probe, 'wb') as fp:
                fp.write(b'1')
            os.unlink(probe)
            return d
        except Exception:
            pass
    d = tempfile.mkdtemp(prefix='tts-silk-')
    print('提示: data\\tts-tmp 不可写，改用系统临时目录 %s' % d)
    return d


def prune_tmp(d, keep_sec=TMP_KEEP_SEC):
    """清掉陈年临时产物（脚本崩了留下的兜底）"""
    n = 0
    try:
        for f in os.listdir(d):
            p = os.path.join(d, f)
            try:
                if time.time() - os.path.getmtime(p) > keep_sec:
                    os.unlink(p)
                    n += 1
            except Exception:
                pass
    except Exception:
        pass
    return n


def rm(path):
    try:
        if path and os.path.exists(path):
            os.unlink(path)
    except Exception:
        pass


def esc(s):
    """把 `%` 转义成 `%%`：argparse 会对 help 串做 `% params` 展开，不转义连 `--help` 都会崩"""
    return str(s).replace('%', '%%')


# ── ① edge-tts 合成 ───────────────────────────────────────────
def _edge_hint(err):
    """把 edge-tts / aiohttp 的异常翻译成人能看懂的"网络还是参数"结论"""
    s = '%s' % err
    low = s.lower()
    if any(k in low for k in ('clientconnectorerror', 'cannot connect', 'getaddrinfo', 'name or service',
                              'connection refused', 'connection reset', 'timed out', 'timeout',
                              'serverdisconnected', 'ssl')):
        return '网络不通（连不上 speech.platform.bing.com）——检查代理/防火墙/DNS'
    if 'invalid' in low and ('rate' in low or 'pitch' in low or 'voice' in low):
        return '音色/语速/音调参数不合法：%s' % s
    return s


LAST_VOICE = {}


def _with_voice(r):
    """输出前把'这次用的参考音'塞进结果 —— 换音色会在日志里立刻暴露（踩过：被换成御姐没人发现）"""
    try:
        if LAST_VOICE and isinstance(r, dict) and r.get('ok'):
            r.setdefault('voiceRef', dict(LAST_VOICE))
    except Exception:
        pass
    return r

def synth_mp3(text, voice, rate, pitch, out_mp3, timeout=SYNTH_TIMEOUT):
    """GPT-SoVITS 合成（替换 edge-tts）。输出 wav（ffmpeg 可处理）"""
    import urllib.request
    import json as _json
    api = os.environ.get('GPT_SOVITS_API', 'http://127.0.0.1:9880/tts')
    # ★ 2026-10-27 还原：此前被改成"御姐"参考音（data\voice\yujie-ref.wav + 威廉…句子），
    #   大肥鱼的声音变成别人了。这里改回"雌小鬼"原始参考音。
    #   要换音色请改这两个默认值（或设环境变量 GPT_SOVITS_REF / GPT_SOVITS_PROMPT），
    #   别再直接改 api_v2 的模型配置 —— 那会连样本外音色一起变。
    ref = os.environ.get('GPT_SOVITS_REF',
        r'D:\微信deepseek\data\sexy-loli-cn\separated\htdemucs\【中文音声】许久未见的雌小鬼，向你表达爱意\cn-a.wav')
    prompt = os.environ.get('GPT_SOVITS_PROMPT',
        '就像是一根被流酸泡过的麻辣秋衣一样这么久不见，大哥哥有没有想我呀')
    # 记下来给 JSON 输出用：音色改没改，一眼可见（实测踩过：被别人把参考音换成"御姐"，没人发现）
    global LAST_VOICE
    LAST_VOICE = {'ref': ref, 'refName': os.path.basename(ref), 'prompt': prompt[:24],
                  'refFrom': ('env' if os.environ.get('GPT_SOVITS_REF') else 'default')}
    body = {
        'text': text,
        'text_lang': 'zh',
        'ref_audio_path': ref,
        'prompt_lang': 'zh',
        'prompt_text': prompt,
        'text_split_method': 'cut5',
        'batch_size': 1,
        'media_type': 'wav',
    }
    try:
        req = urllib.request.Request(api, data=_json.dumps(body).encode('utf-8'),
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
    except Exception as e:
        raise StageError('tts', 'GPT-SoVITS API 失败: %s' % e)
    if not data or data[:4] != b'RIFF':
        raise StageError('tts', 'GPT-SoVITS 返回非 wav: %r' % data[:200])
    with open(out_mp3, 'wb') as f:
        f.write(data)
    return len(data)


def probe_duration(ff, src):
    """从 ffmpeg 探测输出取时长（秒）；取不到返回 0"""
    rc, out = run([ff, '-hide_banner', '-i', src], timeout=60)
    m = re.search(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', out)
    if not m:
        return 0.0
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def to_pcm24(ff, src, out_pcm):
    """mp3 → **24kHz/单声道/PCM16 裸流**（`-f s16le`，不给 ffmpeg 写 wav，避免它加 LIST 块）"""
    rc, log = run([ff, '-hide_banner', '-loglevel', 'error', '-i', src, '-vn',
                   '-ac', str(PCM_CHANNELS), '-ar', str(PCM_RATE), '-acodec', 'pcm_s16le',
                   '-f', 's16le', '-y', out_pcm], timeout=FFMPEG_TIMEOUT)
    if rc != 0 or not os.path.exists(out_pcm):
        raise StageError('ffmpeg', 'mp3→PCM 失败（rc=%s）：%s' % (rc, log.strip()[:200]))
    size = os.path.getsize(out_pcm)
    if size < PCM_RATE * PCM_WIDTH // 10:
        raise StageError('ffmpeg', 'PCM 太小（%d 字节），音频像是空的' % size)
    if size % 2:
        raise StageError('ffmpeg', 'PCM 字节数不是偶数（%d），PCM16 流不完整' % size)
    return size


# ── ③ pilk 编码 SILK ──────────────────────────────────────────
def _import_pilk():
    try:
        import pilk
        return pilk
    except Exception as e:
        raise StageError('pilk', '没装 pilk（SILK 编解码库）：pip install pilk ｜ 原始错误: %s' % e)


def encode_silk(pcm_path, silk_path):
    """24kHz PCM → SILK v3。返回 silk 字节数"""
    pilk = _import_pilk()
    try:
        try:
            pilk.encode(pcm_path, silk_path, pcm_rate=PCM_RATE)
        except TypeError:
            # 某些构建没有 pcm_rate 关键字；无参调用默认就是 24kHz（正是我们要的）
            pilk.encode(pcm_path, silk_path)
    except StageError:
        raise
    except Exception as e:
        raise StageError('pilk', 'pilk 编码失败：%s' % e)
    if not os.path.exists(silk_path):
        raise StageError('pilk', 'pilk 没产出 SILK 文件')
    size = os.path.getsize(silk_path)
    if size < 100:
        raise StageError('pilk', 'SILK 太小（%d 字节），编码结果不可用' % size)
    with open(silk_path, 'rb') as fp:
        head = fp.read(9)
    if head != SILK_MAGIC:
        raise StageError('pilk', '产物不是 SILK v3（头是 %s，期望 %s）' % (head[:9].hex(), SILK_MAGIC.decode()))
    return size


def silk_duration_ms(silk_path):
    """时长（毫秒）。pilk.decode 返回值不可信，一律用 get_duration。
    ⚠️ 先校验头：`pilk.get_duration` 对**非 SILK** 文件**不报错**（把垃圾当帧长读，返回 0 或乱值），
    所以不能只靠它来判断文件好不好（实测：喂垃圾文件它不抛错）。"""
    try:
        with open(silk_path, 'rb') as fp:
            head = fp.read(9)
    except Exception as e:
        raise StageError('pilk', '读不到 SILK 文件：%s' % e)
    if head != SILK_MAGIC:
        raise StageError('pilk', '不是 SILK v3 文件（头 %s，期望 %s）' % (head.hex(), SILK_MAGIC.decode()))
    pilk = _import_pilk()
    try:
        return int(pilk.get_duration(silk_path))
    except Exception as e:
        raise StageError('pilk', 'pilk.get_duration 失败：%s' % e)


def silk_to_wav16(silk_path, wav_path, rate=16000):
    """SILK → 16kHz/mono/PCM16 WAV（给 DSH speechToText 用；也用来证明"能听清"）。
    返回 WAV 头部字段 dict（调用方可校验 canonical 44 字节头）。"""
    pilk = _import_pilk()
    try:
        pilk.silk_to_wav(silk_path, wav_path, rate)
    except Exception as e:
        raise StageError('pilk', 'SILK→WAV 失败：%s' % e)
    size = os.path.getsize(wav_path)
    with open(wav_path, 'rb') as fp:
        head = fp.read(44)
    if len(head) < 44:
        raise StageError('pilk', '解出来的 WAV 太短（%d 字节）' % size)
    return {
        'bytes': size,
        'riff': head[0:4].decode('latin1'),
        'wave': head[8:12].decode('latin1'),
        'fmtSize': struct.unpack_from('<I', head, 16)[0],
        'format': struct.unpack_from('<H', head, 20)[0],
        'channels': struct.unpack_from('<H', head, 22)[0],
        'rate': struct.unpack_from('<I', head, 24)[0],
        'bits': struct.unpack_from('<H', head, 34)[0],
        'riffSizeOk': struct.unpack_from('<I', head, 4)[0] == size - 8,
        'dataSizeOk': struct.unpack_from('<I', head, 40)[0] == size - 44,
        'seconds': round((size - 44) / float(rate * PCM_WIDTH), 3),
    }


# ── 主流程 ────────────────────────────────────────────────────
def synthesize(text, out_path, voice=DEFAULT_VOICE, rate=DEFAULT_RATE, pitch=DEFAULT_PITCH,
               keep_pcm=False, verify_wav='', quiet=False, keep_mp3=''):
    """文字 → SILK。成功返回给桥的 dict；失败抛 StageError。"""
    def say(msg):
        if not quiet:
            print(msg)

    text = (text or '').strip()
    if not text:
        raise StageError('input', '文本为空')
    # 单字语气词后面紧跟标点会被 cut5 切成独立段，GPT-SoVITS 对"哼"/"啊"这种超短段
    # 会合成出近静音（实测 0.42s、rms 2e-4）。去掉词尾标点让它并入下一句。
    text = re.sub(r'([哈呵嘿嗨哼嗯啊哦哎唉喂呀诶欸])\s*[，,。.!！？?、]\s*', r'\1', text)
    if len(text) > MAX_TEXT_CHARS:
        raise StageError('input', '文本太长（%d 字 > 上限 %d 字）——语音太长很怪，请先裁短'
                         % (len(text), MAX_TEXT_CHARS))
    if not RATE_RE.match(rate or ''):
        raise StageError('input', 'rate 格式不对（%r），要像 +8%% / -6%%' % rate)
    if not PITCH_RE.match(pitch or ''):
        raise StageError('input', 'pitch 格式不对（%r），要像 +18Hz / -4Hz' % pitch)

    out_path = os.path.abspath(out_path)
    out_dir = os.path.dirname(out_path)
    if out_dir:
        try:
            os.makedirs(out_dir, exist_ok=True)
        except Exception as e:
            raise StageError('output', '输出目录建不了（%s）：%s' % (out_dir, e))

    d = tmp_dir()
    n = prune_tmp(d)
    if n:
        say('临时目录: 清掉 %d 个陈年产物' % n)
    tag = 'tts-%d-%s' % (os.getpid(), os.urandom(3).hex())
    mp3 = os.path.join(d, tag + '.mp3')
    pcm = os.path.join(d, tag + '.pcm')
    silk = os.path.join(d, tag + '.silk')
    ff = ffmpeg_exe()

    try:
        t0 = time.time()
        say('① edge-tts: %s ｜ rate=%s pitch=%s ｜ %d 字' % (voice, rate, pitch, len(text)))
        mp3_bytes = synth_mp3(text, voice, rate, pitch, mp3)
        say('   mp3 %d 字节（%.1fs）' % (mp3_bytes, time.time() - t0))

        mp3_sec = probe_duration(ff, mp3)
        say('② ffmpeg: %s' % os.path.basename(ff))
        pcm_bytes = to_pcm24(ff, mp3, pcm)
        pcm_sec = pcm_bytes / float(PCM_RATE * PCM_WIDTH)
        say('   24kHz/mono/PCM16 %d 字节 → %.2fs' % (pcm_bytes, pcm_sec))
        # 采样率自检：PCM 秒数必须与 mp3 时长吻合，否则就是采样率写错（发出去会变速）
        if mp3_sec > 0 and abs(pcm_sec - mp3_sec) / mp3_sec > 0.15:
            raise StageError('ffmpeg', '采样率可疑：PCM %.2fs vs mp3 %.2fs（差 %.0f%%）——'
                                       '24kHz 没生效，发出去会变速'
                             % (pcm_sec, mp3_sec, abs(pcm_sec - mp3_sec) / mp3_sec * 100))

        say('③ pilk: 编码 SILK v3')
        silk_bytes = encode_silk(pcm, silk)
        dur_ms = silk_duration_ms(silk)
        say('   SILK %d 字节 ｜ get_duration %d ms（%.2fs）' % (silk_bytes, dur_ms, dur_ms / 1000.0))
        if dur_ms <= 0:
            raise StageError('pilk', 'SILK 时长为 0（编码结果不可用）')
        if mp3_sec > 0 and abs(dur_ms / 1000.0 - mp3_sec) / mp3_sec > 0.25:
            say('   警告: SILK 时长与 mp3 时长偏差 %.0f%%（SILK 是 20ms 一帧，边界会有零点几秒误差）'
                % (abs(dur_ms / 1000.0 - mp3_sec) / mp3_sec * 100))

        # 落 --out（先校验再落地，避免留下半个坏文件）
        if os.path.abspath(silk) != out_path:
            shutil.copyfile(silk, out_path)
        if not os.path.exists(out_path) or os.path.getsize(out_path) != silk_bytes:
            raise StageError('output', '写出 --out 失败或字节数不符（%s）' % out_path)
        say('④ 落盘: %s（%d 字节）' % (out_path, silk_bytes))

        wav_info = None
        if verify_wav:
            verify_wav = os.path.abspath(verify_wav)
            if os.path.dirname(verify_wav):
                os.makedirs(os.path.dirname(verify_wav), exist_ok=True)
            wav_info = silk_to_wav16(out_path, verify_wav)
            say('⑤ 回解 16k WAV: %s（%d 字节，%.2fs，%dHz/%dch/%dbit）'
                % (verify_wav, wav_info['bytes'], wav_info['seconds'], wav_info['rate'],
                   wav_info['channels'], wav_info['bits']))
            if not (wav_info['riff'] == 'RIFF' and wav_info['wave'] == 'WAVE' and wav_info['format'] == 1
                    and wav_info['channels'] == 1 and wav_info['rate'] == 16000 and wav_info['bits'] == 16
                    and wav_info['riffSizeOk'] and wav_info['dataSizeOk']):
                raise StageError('pilk', '回解的 WAV 头不是 canonical 16k/mono/PCM16：%s' % wav_info)

        pcm_out = ''
        if keep_pcm:
            pcm_out = os.path.splitext(out_path)[0] + '.pcm'
            shutil.copyfile(pcm, pcm_out)
            say('   保留 PCM: %s（%d 字节）' % (pcm_out, pcm_bytes))

        # ── 保留 MP3（发给微信"文件"用：MP3 通用性最好，点开就能播；语音气泡那条路走不通）──
        # 默认不保留（老行为不变）；给了 --keep-mp3 才拷出去，并在 JSON 里多给一个 mp3 字段。
        mp3_out = ''
        if keep_mp3:
            mp3_out = os.path.abspath(keep_mp3)
            if os.path.dirname(mp3_out):
                os.makedirs(os.path.dirname(mp3_out), exist_ok=True)
            shutil.copyfile(mp3, mp3_out)
            if not os.path.exists(mp3_out) or os.path.getsize(mp3_out) != mp3_bytes:
                raise StageError('output', '写出 --keep-mp3 失败或字节数不符（%s）' % mp3_out)
            say('   保留 MP3: %s（%d 字节，%.2fs）' % (mp3_out, mp3_bytes, mp3_sec))

        return {
            'ok': True,
            'silk': out_path,
            'bytes': silk_bytes,
            'durationMs': dur_ms,
            'voice': voice,
            'rate': rate,
            'pitch': pitch,
            'textChars': len(text),
            'mp3Bytes': mp3_bytes,
            'mp3Seconds': round(mp3_sec, 3),
            'mp3': mp3_out,
            'pcmBytes': pcm_bytes,
            'pcmSeconds': round(pcm_sec, 3),
            'pcmRate': PCM_RATE,
            'verifyWav': verify_wav if verify_wav else '',
            'verifyWavSeconds': wav_info['seconds'] if wav_info else 0,
            'keepPcm': pcm_out,
            'ffmpeg': os.path.basename(ff),
            'elapsedSec': round(time.time() - t0, 2),
        }
    finally:
        # 临时文件一律清掉（只留 --out 与显式要的 --keep-pcm / --keep-mp3 / --verify-wav）
        rm(mp3)
        rm(pcm)
        rm(silk)


# ── 自检 ──────────────────────────────────────────────────────
def do_selftest():
    """自检：真跑一条完整链路（联网 edge-tts）→ 校验 SILK 头/时长/回解 WAV 头。"""
    text = '哼，主人你终于来啦。本鱼刚才在群里潜水呢，才不是偷懒哦。'
    tmp = tempfile.mkdtemp(prefix='tts-silk-selftest-')
    out = os.path.join(tmp, 'selftest.silk')
    wav = os.path.join(tmp, 'selftest16k.wav')
    ok = True
    try:
        print('测试文本: %s（%d 字）' % (text, len(text)))
        r = synthesize(text, out, verify_wav=wav)
        print('⑥ 校验：')
        with open(out, 'rb') as fp:
            head = fp.read(9)
        checks = [
            ('SILK 头是 #!SILK_V3', head == SILK_MAGIC),
            ('SILK 够大（>2KB）', r['bytes'] > 2048),
            ('get_duration > 0', r['durationMs'] > 0),
            ('时长与 mp3 吻合（±25%）',
             r['mp3Seconds'] > 0 and abs(r['durationMs'] / 1000.0 - r['mp3Seconds']) / r['mp3Seconds'] <= 0.25),
            ('时长落在 3~15s（合理范围）', 3000 <= r['durationMs'] <= 15000),
            ('PCM 是 24kHz（字节数 = 秒数×48000）',
             abs(r['pcmBytes'] / 48000.0 - r['pcmSeconds']) < 0.01),
            ('回解 WAV 存在', os.path.exists(wav)),
        ]
        with open(wav, 'rb') as fp:
            wh = fp.read(44)
        wsize = os.path.getsize(wav)
        checks += [
            ('回解 WAV 是 canonical 16k/mono/PCM16',
             wh[0:4] == b'RIFF' and wh[8:12] == b'WAVE' and wh[12:16] == b'fmt '
             and struct.unpack_from('<I', wh, 16)[0] == 16
             and struct.unpack_from('<H', wh, 20)[0] == 1
             and struct.unpack_from('<H', wh, 22)[0] == 1
             and struct.unpack_from('<I', wh, 24)[0] == 16000
             and struct.unpack_from('<H', wh, 34)[0] == 16
             and struct.unpack_from('<I', wh, 4)[0] == wsize - 8
             and struct.unpack_from('<I', wh, 40)[0] == wsize - 44),
            ('回解 WAV 时长 ≈ SILK 时长（±0.3s）',
             abs((wsize - 44) / 32000.0 - r['durationMs'] / 1000.0) < 0.3),
        ]
        for name, good in checks:
            print('   %s %s' % ('✓' if good else '✗', name))
            ok = ok and good
        print('   中间文件已清理: %s' % ('✓' if not [f for f in os.listdir(tmp)
                                                    if f.endswith(('.mp3', '.pcm'))] else '✗'))
        # 把"这次用的参考音"一并输出：换音色会立刻在日志里暴露
        print('JSON: %s' % json.dumps(_with_voice(r), ensure_ascii=False))
        print('结果: %s' % ('全部通过（%d 项）' % len(checks) if ok else '有失败项'))
    except StageError as e:
        print('失败: [%s] %s' % (e.stage, e.msg))
        ok = False
    except Exception as e:
        print('失败: %s' % e)
        ok = False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return 0 if ok else 1


# ── CLI ───────────────────────────────────────────────────────
def main():
    ap = JsonArgumentParser(description='文字 → edge-tts → ffmpeg(24k PCM) → pilk → 微信 SILK 语音')
    ap.add_argument('--text', help='要合成的文本')
    ap.add_argument('--text-file', dest='text_file', help='从文件读文本（编码 UTF-8；避免命令行转义问题）')
    ap.add_argument('--out', help='输出 .silk 路径')
    # ⚠️ argparse 会对 help 串做 `% params` 展开 → help 里**所有** `%` 都必须写成 `%%`，
    #    否则连 `--help` 都会崩（实测：ValueError: unsupported format character）。
    #    所以这里不用 `%` 格式化，改用拼接 + esc()。
    ap.add_argument('--voice', default=DEFAULT_VOICE, help='edge-tts 音色（默认 ' + esc(DEFAULT_VOICE) + '）')
    ap.add_argument('--rate', default=DEFAULT_RATE, help='语速，如 +8%%（默认 ' + esc(DEFAULT_RATE) + '）')
    ap.add_argument('--pitch', default=DEFAULT_PITCH, help='音调，如 +18Hz（默认 ' + esc(DEFAULT_PITCH) + '）')
    ap.add_argument('--keep-pcm', dest='keep_pcm', action='store_true',
                    help='保留 24kHz PCM（写到 <out>.pcm，排查用）')
    ap.add_argument('--verify-wav', dest='verify_wav', default='',
                    help='额外把 SILK 回解成 16kHz/mono/PCM16 WAV 写到这里（给 speechToText 转写验证用）')
    ap.add_argument('--selftest', action='store_true', help='跑一条完整链路自检（需要联网）')
    a = ap.parse_args(normalize_argv(sys.argv[1:]))

    if a.selftest:
        return do_selftest()

    text = a.text
    if a.text_file:
        try:
            with open(a.text_file, 'r', encoding='utf-8') as fp:
                text = fp.read()
        except Exception as e:
            print('失败: 读 --text-file 失败：%s' % e)
            print('JSON: %s' % json.dumps({'ok': False, 'error': '读文本文件失败：%s' % e, 'stage': 'input'},
                                          ensure_ascii=False))
            return 2
    if not text or not a.out:
        ap.print_help()
        err = '缺少 --text（或 --text-file）/ --out'
        print('失败: %s' % err)
        print('JSON: %s' % json.dumps({'ok': False, 'error': err, 'stage': 'input'}, ensure_ascii=False))
        return 2

    try:
        r = synthesize(text, a.out, voice=a.voice, rate=a.rate, pitch=a.pitch,
                       keep_pcm=a.keep_pcm, verify_wav=a.verify_wav)
    except StageError as e:
        print('失败: [%s] %s' % (e.stage, e.msg))
        print('JSON: %s' % json.dumps({'ok': False, 'error': e.msg, 'stage': e.stage}, ensure_ascii=False))
        return 1
    except Exception as e:
        print('失败: %s' % e)
        print('JSON: %s' % json.dumps({'ok': False, 'error': str(e), 'stage': 'unknown'}, ensure_ascii=False))
        return 1
    print('JSON: %s' % json.dumps(_with_voice(r), ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
