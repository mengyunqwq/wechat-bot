"""试多种密钥/模式组合，找能解开本地 .dat 的那一种。"""
import binascii
import glob
import json
import os
import struct
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

from Crypto.Cipher import AES
from Crypto.Util import Padding

ATTACH = r'D:\Users\Administrator\xwechat_files\wxid_3odtthhn7u5t22_7886\msg\attach'
V2 = b'\x07\x08V2\x08\x07'
MAGICS = [(b'\xff\xd8\xff', 'JPEG'), (b'\x89PNG', 'PNG'), (b'RIFF', 'WEBP'), (b'GIF', 'GIF'), (b'wxgf', 'WXGF')]


def looks_image(b):
    for m, n in MAGICS:
        if b.startswith(m):
            return n
    return None


def candidates(key_hex):
    """各种可能的密钥形态"""
    out = []
    try:
        raw16 = binascii.unhexlify(key_hex)
        out.append(('hex16(AES-128)', raw16))
        out.append(('hex16+pad32(AES-256)', raw16 + b'\x00' * 16))
    except Exception:
        pass
    out.append(('ascii32(AES-256)', key_hex.encode()[:32]))
    out.append(('ascii16(AES-128)', key_hex.encode()[:16]))
    out.append(('hex-reversed', binascii.unhexlify(key_hex)[::-1]))
    out.append(('ascii-upper16', key_hex.upper().encode()[:16]))
    return out


def try_all(path, key_hex):
    data = open(path, 'rb').read()
    if data[:6] != V2:
        return None
    sig, f1, f2 = struct.unpack_from('<6sLL', data)
    results = []
    for aes_size, xor_size in ((f1, f2), (f2, f1)):          # 两个字段顺序都试
        aligned = aes_size + ((16 - aes_size % 16) % 16)
        if aligned <= 0 or 15 + aligned > len(data):
            continue
        body = data[15:15 + aligned]
        for mode in ('ECB', 'CBC'):
            for label, key in candidates(key_hex):
                if len(key) not in (16, 24, 32):
                    continue
                try:
                    if mode == 'ECB':
                        dec = AES.new(key, AES.MODE_ECB).decrypt(body)
                    else:
                        dec = AES.new(key, AES.MODE_CBC, iv=b'\x00' * 16).decrypt(body)
                except Exception:
                    continue
                for candidate_bytes in (dec, dec[-32:], dec[:32]):
                    fmt = looks_image(candidate_bytes)
                    if fmt:
                        results.append((fmt, label, mode, aes_size, xor_size, dec))
                        return results
    return results or None


def main():
    # 一条已知有本地文件的图片：从资源表拿 md5，从消息表拿 key
    import re
    def sql(db, q):
        body = json.dumps({'optDbName': db, 'SQL': q}).encode()
        r = subprocess.run(['curl.exe', '-s', '-X', 'POST', 'http://127.0.0.1:30001/QueryDB/execute',
                            '-H', 'Content-Type: application/json', '--data-binary', '@-'],
                           input=body, capture_output=True)
        return json.loads(r.stdout.decode('utf-8', 'replace'))

    # 找一个本地确实存在的 .dat
    files = sorted(glob.glob(os.path.join(ATTACH, '*', '*', 'Img', '*.dat')), key=os.path.getmtime, reverse=True)
    target = None
    for f in files:
        if os.path.getsize(f) > 30 * 1024:
            target = f
            break
    print('目标文件:', os.path.basename(target), os.path.getsize(target), '字节')
    md5 = os.path.basename(target).split('_')[0].split('.')[0]
    print('文件名里的 md5:', md5)

    # 用资源表反查 message_local_id，再取消息里的 aeskey
    rows = sql('message_resource.db',
               "SELECT message_local_id, packed_info FROM MessageResourceInfo WHERE message_local_type=3").get('data', [])
    mid = None
    for r in rows:
        h = (r.get('packed_info') or '').upper()
        i = h.find('0A20')
        if i < 0 or len(h) < i + 4 + 64:
            continue
        try:
            m = binascii.unhexlify(h[i + 4:i + 4 + 64]).decode('ascii')
        except Exception:
            continue
        if m.lower() == md5.lower():
            mid = str(r.get('message_local_id'))
            break
    print('对应 message_local_id:', mid)
    if not mid:
        print('没找到对应消息')
        return 1

    # 找到它在哪个会话表里
    tables = [d['name'] for d in sql('message_0.db',
              "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").get('data', [])]
    key_hex = None
    for t in tables:
        got = sql('message_0.db', f"SELECT message_content FROM {t} WHERE local_id={mid} AND local_type=3 LIMIT 1").get('data', [])
        if not got:
            continue
        import zstandard as zstd
        raw = binascii.unhexlify(got[0]['message_content'])
        xml = zstd.ZstdDecompressor().decompress(raw, max_output_size=1 << 22).decode('utf-8', 'replace')
        mm = re.search(r'aeskey="([^"]+)"', xml)
        if mm:
            key_hex = mm.group(1)
            break
    print('消息里的 aeskey:', key_hex)
    if not key_hex:
        return 1

    res = try_all(target, key_hex)
    if not res:
        print('所有组合都解不开')
        return 1
    for fmt, label, mode, aes_size, xor_size, dec in res:
        print(f'★ 成功! {fmt}  密钥形态={label}  模式={mode}  aes_size={aes_size} xor_size={xor_size}')
        out = os.path.join(r'D:\decode-test', md5 + '.' + fmt.lower())
        os.makedirs(os.path.dirname(out), exist_ok=True)
        open(out, 'wb').write(dec)
        print('  已保存', out, os.path.getsize(out), '字节')
    return 0


if __name__ == '__main__':
    sys.exit(main())
