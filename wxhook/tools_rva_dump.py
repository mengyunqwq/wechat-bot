# -*- coding: utf-8 -*-
# 只读工具：把 Weixin.dll 里某个 RVA 处的原始字节取出来（用于手工加特征码）
# 用法: python tools_rva_dump.py <dll> <rva_hex> [len]
import sys, struct

def main():
    path = sys.argv[1]
    rva = int(sys.argv[2], 16)
    ln = int(sys.argv[3]) if len(sys.argv) > 3 else 32
    data = open(path, 'rb').read()
    e_lfanew = struct.unpack_from('<I', data, 0x3C)[0]
    assert data[e_lfanew:e_lfanew+4] == b'PE\0\0'
    nsec = struct.unpack_from('<H', data, e_lfanew + 6)[0]
    opt_size = struct.unpack_from('<H', data, e_lfanew + 20)[0]
    opt_off = e_lfanew + 24
    magic = struct.unpack_from('<H', data, opt_off)[0]
    img_base = struct.unpack_from('<Q', data, opt_off + 24)[0] if magic == 0x20b else struct.unpack_from('<I', data, opt_off + 28)[0]
    sec_off = opt_off + opt_size
    print('image_base=0x%X sections=%d' % (img_base, nsec))
    secs = []
    for i in range(nsec):
        o = sec_off + i * 40
        name = data[o:o+8].rstrip(b'\0').decode('latin1')
        vsize, vaddr, rawsize, rawptr = struct.unpack_from('<IIII', data, o + 8)
        secs.append((name, vaddr, vsize, rawptr, rawsize))
        print('  %-8s RVA=%08X VS=%08X RAW=%08X..%08X' % (name, vaddr, vsize, rawptr, rawptr + rawsize))
    for (name, vaddr, vsize, rawptr, rawsize) in secs:
        if vaddr <= rva < vaddr + max(vsize, rawsize):
            off = rawptr + (rva - vaddr)
            b = data[off:off+ln]
            print('\nRVA %08X -> file 0x%X (section %s)' % (rva, off, name))
            for i in range(0, len(b), 16):
                chunk = b[i:i+16]
                print('  +%02X  %s  | %s' % (i, ' '.join('%02X' % c for c in chunk),
                                             ''.join(chr(c) if 32 <= c < 127 else '.' for c in chunk)))
            print('\nC array:')
            print('  ' + ', '.join('0x%02X' % c for c in b))
            return
    print('RVA %08X not found in any section' % rva)

main()
