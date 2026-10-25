"""最后一轮穷举：本地 .dat 的 V2 解密参数。

已排除：aeskey 的 hex16/ascii32/ascii16 + ECB/CBC(zero IV) + 两种字段顺序。
这轮再穷举：AES 起始偏移、IV 取法（零 IV / 密文首块 / 密钥块）、密钥取法（aeskey / md5 / 组合）。
"""
import binascii
import glob
import itertools
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

ATTACH = r'D:\Users\Administrator\xwechat_files\wxid_3odtthhn7u5t22_7886\msg\attach'
V2 = b'\x07\x08V2\x08\x07'
SIGS = [(b'\xff\xd8\xff', 'JPEG'), (b'\x89PNG', 'PNG'), (b'RIFF', 'WEBP'), (b'GIF8', 'GIF'), (b'wxgf', 'WXGF')]


def is_img(b):
    for s, n in SIGS:
        if b.startswith(s):
            return n
    return None


def sql(db, q):
    body = json.dumps({'optDbName': db, 'SQL': q}).encode()
    r = subprocess.run(['curl.exe', '-s', '-X', 'POST', 'http://127.0.0.1:30001/QueryDB/execute',
                        '-H', 'Content-Type: application/json', '--data-binary', '@-'],
                       input=body, capture_output=True)
    return json.loads(r.stdout.decode('utf-8', 'replace'))


def key_forms(aeskey, md5):
    out = {}
    try:
        out['aes_hex16'] = binascii.unhexlify(aeskey)
    except Exception:
        pass
    out['aes_ascii32'] = aeskey.encode()[:32]
    out['aes_ascii16'] = aeskey.encode()[:16]
    out['md5_ascii32'] = md5.encode()[:32]
    out['md5_ascii16'] = md5.encode()[:16]
    try:
        out['md5_hex16'] = binascii.unhexlify(md5)
    except Exception:
        pass
    try:
        a = binascii.unhexlify(aeskey)
        m = binascii.unhexlify(md5)
        out['aes_xor_md5'] = bytes(x ^ y for x, y in zip(a, m))
    except Exception:
        pass
    return {k: v for k, v in out.items() if len(v) in (16, 24, 32)}


def main():
    files = sorted(glob.glob(os.path.join(ATTACH, '*', '*', 'Img', '*.dat')),
                   key=os.path.getmtime, reverse=True)
    target = next((f for f in files if os.path.getsize(f) > 20 * 1024), None)
    if not target:
        print('没找到测试文件')
        return 1
    md5 = os.path.basename(target).split('_')[0].split('.')[0]
    print('目标:', os.path.basename(target), os.path.getsize(target), '字节  md5=', md5)

    # 找 aeskey
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
    if not mid:
        print('找不到对应消息')
        return 1
    import zstandard as zstd
    import re
    aeskey = None
    for t in [d['name'] for d in sql('message_0.db',
              "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").get('data', [])]:
        got = sql('message_0.db', f"SELECT message_content FROM {t} WHERE local_id={mid} AND local_type=3 LIMIT 1").get('data', [])
        if not got:
            continue
        raw = binascii.unhexlify(got[0]['message_content'])
        xml = zstd.ZstdDecompressor().decompress(raw, max_output_size=1 << 22).decode('utf-8', 'replace')
        mm = re.search(r'aeskey="([^"]+)"', xml)
        if mm:
            aeskey = mm.group(1)
            break
    print('aeskey =', aeskey)
    if not aeskey:
        return 1

    data = open(target, 'rb').read()
    keys = key_forms(aeskey, md5)
    print('密钥候选:', list(keys.keys()))

    hits = 0
    for name, key in keys.items():
        for off in range(0, 33):
            body = data[off:]
            if len(body) < 32:
                continue
            for mode in ('ECB', 'CBC'):
                ivs = [('zero', b'\x00' * 16)]
                if mode == 'CBC':
                    ivs.append(('ctfirst', body[:16]))
                    ivs.append(('keyblk', key[:16].ljust(16, b'\x00')))
                for ivname, iv in ivs:
                    try:
                        if mode == 'ECB':
                            dec = AES.new(key, AES.MODE_ECB).decrypt(body[:64])
                        else:
                            dec = AES.new(key, AES.MODE_CBC, iv=iv).decrypt(body[:64])
                    except Exception:
                        continue
                    fmt = is_img(dec)
                    if fmt:
                        print(f'★ 命中! key={name} 偏移={off} 模式={mode} IV={ivname} → {fmt}')
                        hits += 1
    print('命中数:', hits)
    return 0 if hits else 1


if __name__ == '__main__':
    sys.exit(main())
