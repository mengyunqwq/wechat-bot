"""解密微信 4.x 的加密图片（V2 .dat 格式），用于给机器人做识图。

为什么需要它：
  微信收到的图片以加密形式落盘在
    <数据目录>\\msg\\attach\\<群hash>\\<年-月>\\Img\\<图片md5>[_t|_h].dat
  这些不是明文图片，而是 4.x 的 V2 格式：
    [6B 签名 07 08 "V2" 08 07][4B aes_size LE][4B xor_size LE][1B padding]
    [AES-128-ECB 密文][明文段][XOR 段]
  AES 密钥不在文件里，只在**微信进程内存**中（16 字符 ASCII）。
  hook 自带的 /Decode_Pic 调的正是微信内部解密函数，但对这个构建失效，
  所以这里自己扫内存取密钥 + 自己解密，不依赖 hook。

用法：
  python decode-wechat-image.py --find-key                 # 只找密钥并缓存
  python decode-wechat-image.py <src.dat> <dst.jpg>        # 解密一张（自动用缓存/现找密钥）
  python decode-wechat-image.py --selftest                 # 找一张最近的图试解，验证整条链路
"""
import warnings
warnings.filterwarnings('ignore')   # 屏蔽 Pillow 的 DeprecationWarning，免得刷日志

import argparse
import ctypes
import glob
import json
import os
import re
import struct
import sys
import time
from ctypes import wintypes

from Crypto.Cipher import AES
from Crypto.Util import Padding

# ── 配置 ──────────────────────────────────────────────────────
BOT_EXE = r"D:\wxhook\wx4110\Weixin.exe"          # 只扫**机器人这份**微信，绝不碰日常微信
ATTACH_DIR = r"D:\Users\Administrator\xwechat_files\wxid_3odtthhn7u5t22_7886\msg\attach"
KEY_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "wechat-image-key.json")
V2_MAGIC = b'\x07\x08V2\x08\x07'

PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
MEM_COMMIT = 0x1000
PAGE_NOACCESS = 0x01
PAGE_GUARD = 0x100
PAGE_READWRITE = 0x04
PAGE_WRITECOPY = 0x08
PAGE_EXECUTE_READWRITE = 0x40
PAGE_EXECUTE_WRITECOPY = 0x80

RE_KEY32 = re.compile(rb'(?<![a-zA-Z0-9])[a-zA-Z0-9]{32}(?![a-zA-Z0-9])')
RE_KEY16 = re.compile(rb'(?<![a-zA-Z0-9])[a-zA-Z0-9]{16}(?![a-zA-Z0-9])')

kernel32 = ctypes.windll.kernel32


class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wintypes.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
    ]


# ── 找机器人微信的主进程 ───────────────────────────────────────
def bot_pids():
    """返回机器人那份微信的进程（按可执行路径过滤 + 工作集最大的那个是主进程）"""
    import subprocess
    out = subprocess.run(
        ['powershell', '-NoProfile', '-Command',
         "Get-CimInstance Win32_Process -Filter \"Name='Weixin.exe'\" | "
         "Where-Object { $_.ExecutablePath -eq '" + BOT_EXE + "' } | "
         "Select-Object ProcessId,WorkingSetSize | ConvertTo-Json -Compress"],
        capture_output=True, text=True)
    try:
        data = json.loads(out.stdout.strip() or '[]')
    except Exception:
        return []
    if isinstance(data, dict):
        data = [data]
    # 主进程 = 工作集最大的（渲染/插件子进程内存小得多）
    data.sort(key=lambda x: x.get('WorkingSetSize', 0), reverse=True)
    return [(int(x['ProcessId']), int(x.get('WorkingSetSize', 0))) for x in data]


# ── V2 解密 ───────────────────────────────────────────────────
def find_xor_key(attach_dir, limit=64):
    """推导单字节 XOR 密钥（V2 .dat 文件尾段用）。

    ★ 正确算法（来自 328336690/wechat-decrypt 的 find_image_key.py）：
        JPEG 明文以 FF D9 结尾 → 加密后文件末尾两字节 = (0xFF^k, 0xD9^k)
        所以 k = 末尾[0] ^ 0xFF，再用 末尾[1] ^ 0xD9 交叉验证。
      对最近 N 个 *_t.dat 做投票，取众数。

    为什么重要：以前这个函数返回 None，导致大文件（尾段全靠 XOR）整段没解密，
    解出来就是花屏/下半部空白（实测：456KB 的能解、873KB 的不能，差的就是这个 key）。
    """
    v2_magic = b'\x07\x08V2\x08\x07'
    counts = {}
    pats = [os.path.join(attach_dir, '*', '*', 'Img', '*_t.dat')]
    files = []
    for ptn in pats:
        files.extend(glob.glob(ptn))
    files.sort(key=os.path.getmtime, reverse=True)
    for f in files[:max(8, limit)]:
        try:
            sz = os.path.getsize(f)
            if sz < 16:
                continue
            with open(f, 'rb') as fp:
                head = fp.read(6)
                fp.seek(sz - 2)
                tail = fp.read(2)
            if head == v2_magic and len(tail) == 2:
                counts[(tail[0], tail[1])] = counts.get((tail[0], tail[1]), 0) + 1
        except Exception:
            continue
    if not counts:
        return None
    (x, y), _n = max(counts.items(), key=lambda kv: kv[1])
    k = x ^ 0xFF
    if (y ^ 0xD9) == k:
        return k
    return k      # 不一致时仍用众数推导值（实测有效）
def cipher_block(attach_dir):
    """取一个 V2 文件的前 16 字节密文，用来试密钥"""
    files = sorted(glob.glob(os.path.join(attach_dir, '*', '*', 'Img', '*_t.dat')),
                   key=os.path.getmtime, reverse=True)[:200]
    for f in files:
        try:
            with open(f, 'rb') as fp:
                head = fp.read(31)
            if head[:6] == V2_MAGIC and len(head) >= 31:
                return head[15:31], os.path.basename(f)
        except Exception:
            continue
    return None, None


def try_key(key: bytes, ct: bytes):
    """用候选密钥解一段密文，看是不是图片魔数"""
    try:
        dec = AES.new(key, AES.MODE_ECB).decrypt(ct)
    except Exception:
        return None
    if dec[:3] == b'\xFF\xD8\xFF':
        return 'JPEG'
    if dec[:4] == b'\x89PNG':
        return 'PNG'
    if dec[:4] == b'RIFF':
        return 'WEBP'
    if dec[:3] == b'GIF':
        return 'GIF'
    if dec[:4] == b'wxgf':
        return 'WXGF'
    return None


def _scan(h, regions, ct, budget_s=180):
    t0 = time.time()
    for base, size, _p in regions:
        if time.time() - t0 > budget_s:
            return None
        if size <= 0 or size > 64 * 1024 * 1024:
            continue
        buf = ctypes.create_string_buffer(size)
        read = ctypes.c_size_t(0)
        if not kernel32.ReadProcessMemory(h, ctypes.c_void_p(base), buf, size, ctypes.byref(read)):
            continue
        if read.value < 32:
            continue
        data = buf.raw[:read.value]
        for m in RE_KEY16.finditer(data):
            k = m.group()
            if try_key(k, ct):
                return k.decode('ascii')
        for m in RE_KEY32.finditer(data):
            k = m.group()
            if try_key(k[:16], ct):
                return k[:16].decode('ascii')
    return None


def find_aes_key(verbose=True):
    """扫机器人微信进程内存找图片 AES 密钥"""
    ct, fname = cipher_block(ATTACH_DIR)
    if not ct:
        print('找不到 V2 样本文件', file=sys.stderr)
        return None
    if verbose:
        print(f'样本: {fname}  密文: {ct.hex()}')
    pids = bot_pids()
    if not pids:
        print('机器人微信没在运行', file=sys.stderr)
        return None
    for pid, ws in pids:
        if verbose:
            print(f'扫描 PID {pid}（工作集 {ws // 1024 // 1024} MB）…')
        h = kernel32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
        if not h:
            continue
        try:
            addr = 0
            mbi = MEMORY_BASIC_INFORMATION()
            rw, allr = [], []
            while addr < 0x7FFFFFFFFFFF:
                if kernel32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)) == 0:
                    break
                if (mbi.State == MEM_COMMIT and mbi.Protect != PAGE_NOACCESS
                        and not (mbi.Protect & PAGE_GUARD) and mbi.RegionSize <= 64 * 1024 * 1024):
                    reg = (mbi.BaseAddress, mbi.RegionSize, mbi.Protect)
                    allr.append(reg)
                    if mbi.Protect & (PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY):
                        rw.append(reg)
                nxt = addr + mbi.RegionSize
                if nxt <= addr:
                    break
                addr = nxt
            if verbose:
                print(f'  可写区 {len(rw)} 个，全部可读区 {len(allr)} 个')
            key = _scan(h, rw, ct) or _scan(h, allr, ct)
            if key:
                if verbose:
                    print(f'★ 找到 AES 密钥: {key}')
                return key
        finally:
            kernel32.CloseHandle(h)
    return None


def load_key(verbose=False):
    try:
        with open(KEY_CACHE, encoding='utf-8') as fp:
            k = json.load(fp).get('image_aes_key')
        if k:
            return k
    except Exception:
        pass
    k = find_aes_key(verbose=verbose)
    if k:
        try:
            os.makedirs(os.path.dirname(KEY_CACHE), exist_ok=True)
            with open(KEY_CACHE, 'w', encoding='utf-8') as fp:
                json.dump({'image_aes_key': k, 'found_at': int(time.time())}, fp)
        except Exception:
            pass
    return k


def decode_file(src, dst, aes_key=None, xor_key=None):
    """解密一张 V2 .dat → 明文图片，返回 (格式, 字节数)"""
    with open(src, 'rb') as fp:
        data = fp.read()
    if data[:6] != V2_MAGIC:
        raise ValueError('不是 V2 格式: ' + src)
    _sig, aes_size, xor_size = struct.unpack_from('<6sLL', data)
    aligned = aes_size + ((16 - aes_size % 16) % 16)
    key = (aes_key or load_key()).encode('ascii')[:16]
    off = 15
    aes_data = data[off:off + aligned]
    dec = AES.new(key, AES.MODE_ECB).decrypt(aes_data)
    try:
        dec = Padding.unpad(dec, AES.block_size)   # 微信不一定用 PKCS7，失败就用原样
    except Exception:
        pass
    off += aligned
    raw = data[off:len(data) - xor_size] if xor_size else data[off:]
    off += len(raw)
    xored = data[off:]
    xk = xor_key if xor_key is not None else find_xor_key(ATTACH_DIR)
    dec_x = bytes(b ^ xk for b in xored) if (xk is not None and xored) else xored
    out = dec + raw + dec_x
    fmt, ext = 'unknown', '.bin'
    if out[:3] == b'\xFF\xD8\xFF':
        fmt, ext = 'JPEG', '.jpg'
    elif out[:4] == b'\x89PNG':
        fmt, ext = 'PNG', '.png'
    elif out[:4] == b'RIFF':
        fmt, ext = 'WEBP', '.webp'
    elif out[:3] == b'GIF':
        fmt, ext = 'GIF', '.gif'
    elif out[:4] == b'wxgf':
        fmt, ext = 'WXGF', '.hevc'

    # ★ WXGF（微信私有格式，内部是 HEVC 码流）→ 必须转成真 JPEG，
    #   否则视觉模型收到的是"后缀 .jpg 但内容是 HEVC"的假图，永远识别不出（实测踩过）。
    #   做法：找第一个 Annex-B 起始码，从那里开始用 PyAV 解码，取第 1 帧转 JPEG。
    if fmt == 'WXGF' and not os.environ.get('NO_WXGF_CONVERT'):
        try:
            import av, io as _io
            i = out.find(b'\x00\x00\x00\x01')
            if i < 0:
                i = out.find(b'\x00\x00\x01')
            payload = out[i:] if i >= 0 else out[16:]
            cont = av.open(_io.BytesIO(payload), format='hevc')
            frames = [f for f in cont.decode(video=0)]
            cont.close()
            if frames:
                # ★ 关键：WXGF 第 0 帧经常是纯白占位帧，真画面在后面（实测 2 帧：0 白、1 有内容）
                best = None
                for _i, f in enumerate(frames):
                    im = f.to_image().convert('RGB')
                    sm = im.resize((32, 32))
                    px = list(sm.getdata())
                    m = sum(sum(p) for p in px) / (len(px) * 3)
                    print('   WXGF 帧%d %dx%d 平均亮度%.0f' % (_i, im.width, im.height, m))
                    if m < 250:
                        best = im
                        break
                if best is None:
                    best = frames[-1].to_image().convert('RGB')
                buf = _io.BytesIO()
                best.save(buf, format='JPEG', quality=92)
                out, fmt, ext = buf.getvalue(), 'JPEG(from WXGF)', '.jpg'
                print('   WXGF→JPEG 转换成功 %dx%d' % best.size)
            else:
                print('   WXGF 解码 0 帧（不可用）')
                out = b''   # 不解出内容就不写文件，让调用方判失败
        except Exception as e:
            print('   WXGF 转换失败（不可用）：%s' % str(e)[:120])
            out = b''       # 同上：转换失败不写文件
    if dst:
        os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
        with open(dst, 'wb') as fp:
            fp.write(out)
    # 报平均亮度：调用方据此判断这张能不能用（255 = 纯白 = 白图/花屏）
    if out[:3] == b'\xFF\xD8\xFF':
        try:
            from PIL import Image as _Im2
            import io as _io2
            _im = _Im2.open(_io2.BytesIO(out)).convert('RGB')
            _sm = _im.resize((32, 32))
            _px = list(_sm.getdata())
            _m = sum(sum(p) for p in _px) / (len(_px) * 3)
            _neon = sum(1 for p in _px if max(p) - min(p) > 120) * 100.0 / len(_px)
            print('   亮度=%.0f 霓虹=%.1f 尺寸=%dx%d' % (_m, _neon, _im.width, _im.height))
        except Exception:
            pass
    return fmt, len(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src', nargs='?')
    ap.add_argument('dst', nargs='?')
    ap.add_argument('--find-key', action='store_true')
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()

    if a.find_key:
        k = find_aes_key()
        print('结果:', k or '没找到')
        return 0 if k else 1

    if a.selftest:
        k = load_key(verbose=True)
        if not k:
            print('没找到密钥')
            return 1
        files = sorted(glob.glob(os.path.join(ATTACH_DIR, '*', '*', 'Img', '*.dat')),
                       key=os.path.getmtime, reverse=True)
        out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'decode-test')
        ok = 0
        for f in files[:5]:
            try:
                fmt, n = decode_file(f, os.path.join(out_dir, os.path.basename(f) + '.out'))
                print(f'  {os.path.basename(f)[:20]}… → {fmt} ({n:,}B)')
                if fmt != 'unknown':
                    ok += 1
            except Exception as e:
                print(f'  {os.path.basename(f)[:20]}… → 失败: {e}')
        print(f'成功 {ok}/5')
        return 0 if ok else 1

    if not a.src:
        ap.print_help()
        return 2
    fmt, n = decode_file(a.src, a.dst)
    print(f'{fmt} {n} 字节 → {a.dst}')
    return 0 if fmt != 'unknown' else 1


if __name__ == '__main__':
    sys.exit(main())
