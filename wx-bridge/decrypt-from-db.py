"""用数据库里的 aeskey 解密本地 .dat —— 验证"不需要扫内存、不需要看图"这条路。

发现：微信把每条图片消息的 XML 存在 message_content 里（zstd 压缩），
XML 内含 aeskey 与 md5：
  <img aeskey="5609d7ffe4688174b72528be43907d2e" md5="acdc9a1d..." encryver="1"/>
而本地 .dat 文件名就是那个 md5。所以：DB 取 key → 找到同名 .dat → AES-128-ECB 解密。
"""
import binascii
import glob
import json
import os
import struct
import subprocess
import sys

import zstandard as zstd

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')   # 控制台是 GBK，避免中文/符号炸掉
except Exception:
    pass
from Crypto.Cipher import AES
from Crypto.Util import Padding

HOOK = 'http://127.0.0.1:30001/QueryDB/execute'
ATTACH = r'D:\Users\Administrator\xwechat_files\wxid_3odtthhn7u5t22_7886\msg\attach'
OUT = r'D:\decode-test'
V2_MAGIC = b'\x07\x08V2\x08\x07'


def sql(db, q):
    body = json.dumps({'optDbName': db, 'SQL': q}).encode()
    out = subprocess.run(['curl.exe', '-s', '-X', 'POST', HOOK,
                          '-H', 'Content-Type: application/json', '--data-binary', '@-'],
                         input=body, capture_output=True)
    try:
        return json.loads(out.stdout.decode('utf-8', 'replace'))
    except Exception:
        return {'data': []}


def decompress(hexstr):
    try:
        raw = binascii.unhexlify(hexstr)
    except Exception:
        return ''
    if raw[:4] != b'\x28\xb5\x2f\xfd':      # zstd
        return raw.decode('utf-8', 'replace')
    try:
        return zstd.ZstdDecompressor().decompress(raw, max_output_size=1 << 22).decode('utf-8', 'replace')
    except Exception:
        return ''


def xml_attr(xml, name):
    import re
    m = re.search(name + r'="([^"]*)"', xml)
    return m.group(1) if m else ''


def local_dat(md5):
    """按 md5 找本地 .dat（原图 / 高清 / 缩略图）"""
    hits = []
    for pat in (md5 + '.dat', md5 + '_h.dat', md5 + '_t.dat', md5 + '_b.dat'):
        hits += glob.glob(os.path.join(ATTACH, '*', '*', 'Img', pat))
        hits += glob.glob(os.path.join(ATTACH, '*', '*', '*', pat))
    return hits


def decrypt(path, key_hex, dst):
    data = open(path, 'rb').read()
    if data[:6] != V2_MAGIC:
        return None, 'not-v2'
    sig, aes_size, xor_size = struct.unpack_from('<6sLL', data)
    aligned = aes_size + ((16 - aes_size % 16) % 16)
    for label, kb in (('hex16', binascii.unhexlify(key_hex)), ('ascii16', key_hex.encode()[:16])):
        if len(kb) != 16:
            continue
        try:
            dec = AES.new(kb, AES.MODE_ECB).decrypt(data[15:15 + aligned])
            try:
                dec = Padding.unpad(dec, 16)
            except Exception:
                pass
        except Exception:
            continue
        if dec[:3] == b'\xff\xd8\xff' or dec[:4] == b'\x89PNG' or dec[:4] == b'RIFF':
            body = data[15 + aligned:len(data) - xor_size] if xor_size else data[15 + aligned:]
            out = dec + body
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            open(dst, 'wb').write(out)
            return out[:4], label
    return None, 'key-failed(前16字节=' + (AES.new(binascii.unhexlify(key_hex), AES.MODE_ECB).decrypt(data[15:31]).hex() if len(key_hex)==32 else '?') + ')'


def resource_md5_map():
    """message_local_id → 本地文件名用的 md5

    本地 .dat 的文件名**不是** message_content 里那个 md5，而是 message_resource.db
    的 MessageResourceInfo.packed_info（protobuf：12 22 0A 20 <32字节 ASCII md5>）里的那个。
    """
    import re
    rows = sql('message_resource.db',
               "SELECT message_local_id, packed_info FROM MessageResourceInfo WHERE message_local_type=3"
               ).get('data', [])
    out = {}
    for r in rows:
        h = (r.get('packed_info') or '').upper()
        i = h.find('0A20')
        # 注意：md5 是 32 个 ASCII 字符 → 在 hex 里占 **64** 个字符
        if i < 0 or len(h) < i + 4 + 64:
            continue
        try:
            md5 = binascii.unhexlify(h[i + 4:i + 4 + 64]).decode('ascii')
        except Exception:
            continue
        if re.fullmatch(r'[0-9a-f]{32}', md5):
            out[str(r.get('message_local_id'))] = md5
    return out


def main():
    # 找图片消息（message_0.db 里每张表对应一个会话）
    tables = [d['name'] for d in sql('message_0.db',
              "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").get('data', [])]
    print('消息表:', len(tables))
    res_map = resource_md5_map()
    print('资源 md5 映射:', len(res_map), '条')
    tried = ok = 0
    n_rows = n_xml = n_key = n_file = 0
    for t in tables:
        rows = sql('message_0.db',
                   f"SELECT local_id, message_content FROM {t} WHERE local_type=3 ORDER BY local_id DESC LIMIT 40").get('data', [])
        for row in rows:
            n_rows += 1
            xml = decompress(row.get('message_content', ''))
            if '<img' not in xml:
                continue
            n_xml += 1
            key = xml_attr(xml, 'aeskey') or xml_attr(xml, 'cdnthumbaeskey')
            if not key:
                continue
            n_key += 1
            # 本地文件名用的 md5：优先用资源表里的，退回 message_content 里的
            md5 = res_map.get(str(row.get('local_id'))) or xml_attr(xml, 'md5')
            files = local_dat(md5)
            if not files:
                continue
            n_file += 1
            tried += 1
            dst = os.path.join(OUT, md5 + '.jpg')
            fmt, how = decrypt(files[0], key, dst)
            if fmt:
                ok += 1
                print(f'  ★ {md5}  {how}  → {fmt.hex()}  {dst}  ({os.path.getsize(dst):,}B)  源={os.path.basename(files[0])}')
                if ok >= 5:
                    print(f'\n成功 {ok}/{tried}（够验证了）')
                    return 0
            else:
                print(f'  ✗ {md5}  {how}  文件={os.path.basename(files[0])}')
    print(f'\n漏斗: 消息行 {n_rows} → 含<img> {n_xml} → 有key {n_key} → 本地有文件 {n_file} → 尝试 {tried} → 成功 {ok}')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
