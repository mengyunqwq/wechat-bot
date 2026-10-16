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
BOT_EXE = os.environ.get("WECHAT_EXE", "")            # 机器人那份微信的 exe（只扫它，绝不碰日常微信）
ATTACH_DIR = os.environ.get("WECHAT_ATTACH_DIR", "")   # 形如 <微信数据目录>\msg\attach
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
    """从最近的缩略图文件尾部反推 XOR 密钥（JPEG 结尾应是 FF D9）"""
    files = sorted(glob.glob(os.path.join(attach_dir, '*', '*', 'Img', '*_t.dat')),
                   key=os.path.getmtime, reverse=True)[:limit]
    counts = {}
    for f in files:
        try:
            sz = os.path.getsize(f)
            if sz < 8:
                continue
            with open(f, 'rb') as fp:
                if fp.read(6) != V2_MAGIC:
                    continue
                fp.seek(sz - 2)
                tail = fp.read(2)
            if len(tail) == 2:
                counts[(tail[0], tail[1])] = counts.get((tail[0], tail[1]), 0) + 1
        except Exception:
            continue
    if not counts:
        return None
    x, y = max(counts, key=counts.get)
    return x ^ 0xFF


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
    if dst:
        os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
        with open(dst, 'wb') as fp:
            fp.write(out)
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
