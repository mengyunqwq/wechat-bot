"""在 Weixin.dll 里定位 V2 图片解密函数。

思路：解密函数必然要比较 V2 魔数（07 08 56 32 08 07），所以
  ① 在 DLL 里搜这个字节序列 → 得到文件偏移
  ② 用 PE 节表把文件偏移换算成 RVA（= 相对模块基址的偏移，正是 hook 用的 offset 形式）
  ③ 从命中点向前找函数序言（int3 填充后的第一条指令 / push rbp 等），得到函数起始 RVA
这样就能知道 hook 里那个 0x493E70 到底对不对、真正的函数在哪。
"""
import struct
import sys

DLL = r"D:\wxhook\wx4110\4.1.10.27\Weixin.dll"
MAGIC = bytes([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])


def sections(data):
    """解析 PE 节表 → [(名称, 虚拟地址RVA, 虚拟大小, 文件偏移, 文件大小, 可执行)]"""
    e_lfanew = struct.unpack_from('<I', data, 0x3C)[0]
    if data[e_lfanew:e_lfanew + 4] != b'PE\0\0':
        raise SystemExit('不是 PE 文件')
    nsec = struct.unpack_from('<H', data, e_lfanew + 6)[0]
    opt_size = struct.unpack_from('<H', data, e_lfanew + 20)[0]
    sec_off = e_lfanew + 24 + opt_size
    out = []
    for i in range(nsec):
        o = sec_off + i * 40
        name = data[o:o + 8].rstrip(b'\0').decode('ascii', 'replace')
        vsize, vaddr = struct.unpack_from('<II', data, o + 8)
        rawsize, rawptr = struct.unpack_from('<II', data, o + 16)
        chars = struct.unpack_from('<I', data, o + 36)[0]
        out.append((name, vaddr, vsize, rawptr, rawsize, bool(chars & 0x20000000)))
    return out


def file_to_rva(secs, off):
    for name, vaddr, vsize, rawptr, rawsize, _x in secs:
        if rawptr <= off < rawptr + rawsize:
            return vaddr + (off - rawptr), name
    return None, None


def find_func_start(data, secs, off, back=0x600):
    """从命中点向前找函数序言（先被 0xCC/0x90 填充隔开的边界，再找 push/mov 序言）"""
    start = max(0, off - back)
    chunk = data[start:off]
    # 常见序言：48 89 5C 24 / 40 53 / 48 83 EC / 55 48 89 E5 / 48 8B C4
    prologues = [b'\x48\x89\x5c\x24', b'\x40\x53', b'\x48\x83\xec', b'\x55\x48\x89\xe5', b'\x48\x8b\xc4', b'\x40\x55', b'\x48\x89\x4c\x24']
    best = None
    for pat in prologues:
        idx = chunk.rfind(pat)
        if idx >= 0:
            pos = start + idx
            # 前面应是填充（CC/90）或上一函数结尾
            if best is None or pos > best:
                best = pos
    return best


def main():
    with open(DLL, 'rb') as fp:
        data = fp.read()
    print(f'DLL: {DLL}  {len(data):,} 字节')
    secs = sections(data)
    print('节表:')
    for n, va, vs, rp, rs, x in secs:
        print(f'  {n:8s} RVA={va:#010x} vsize={vs:#x} raw={rp:#x} size={rs:#x} {"可执行" if x else ""}')

    hits = []
    pos = 0
    while True:
        i = data.find(MAGIC, pos)
        if i < 0:
            break
        hits.append(i)
        pos = i + 1
    print(f'\nV2 魔数命中 {len(hits)} 处')

    print('\n命中点 → RVA（这就是 hook 里 offset 的形式）:')
    for off in hits:
        rva, sec = file_to_rva(secs, off)
        if rva is None:
            print(f'  file {off:#x} → 不在任何节内')
            continue
        fs = find_func_start(data, secs, off)
        frva = None
        if fs:
            frva, _ = file_to_rva(secs, fs)
        print(f'  file {off:#010x}  节={sec:8s}  命中RVA={rva:#010x}'
              + (f'  推测函数起始RVA={frva:#010x}' if frva else '  （没找到序言）'))

    print(f'\n当前 hook 用的 dec_pic_call 偏移 = {0x493E70:#010x}')
    near = [h for h in hits if abs((file_to_rva(secs, h)[0] or 0) - 0x493E70) < 0x4000]
    if near:
        print('  → 该偏移附近**有** V2 魔数引用，说明偏移可能是对的，问题在调用签名')
    else:
        print('  → 该偏移附近**没有** V2 魔数引用，说明偏移基本可以确定是错的')
    return 0


if __name__ == '__main__':
    sys.exit(main())
