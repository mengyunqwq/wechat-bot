"""从当前版本的 Weixin.dll 里，为 hook 的每个偏移提取"跨版本稳定"的特征模式。

原理：
  偏移分两类，处理方式不同 ——

  ① 代码目标（函数入口）
     取函数开头的字节做特征。但**相对寻址的操作数会随版本变化**，所以要把
     "看起来像相对位移"的 4 字节窗口打上通配符（??），否则换个版本就匹配不上。

  ② 数据目标（全局变量 / vtable）
     不直接对数据本身取特征（数据内容会变），而是**找一条引用它的指令**，
     把指令形态当特征（例如 `48 8D 0D ?? ?? ?? ??` = LEA RCX,[RIP+disp]），
     运行时从找到的指令位置反算出真实地址。指令形态跨版本通常不变，稳得多。

输出：include/offset_patterns.h（C++ 头文件，供运行时解析用）
用法：python gen-offset-patterns.py <Weixin.dll> [输出头文件]
"""
import io
import os
import struct
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# ── 要处理的偏移表（来自 include/global.h + inline_weixin_dll_load.cpp）──
# 名字, RVA, 类型（code/data）
OFFSETS = [
    ("XWECHAT_MAIN_CLAZZ_OFFSET",             0xA83AB20, "data"),
    ("XWECHAT_SQLITE3_VFS_OFFSET",            0xA6C0490, "data"),
    ("XWECHAT_SQLITE3_API_ROUTINES_OFFSET",   0x8BB0D38, "data"),
    ("XWECHAT_SQLCIPHER_API_ROUTINES_OFFSET", 0x8BB1570, "data"),
    ("XWECHAT_SQLITE3_CODEC_GET_KEY_FUNC",    0x4EE64D0, "code"),
    ("dec_pic_call",                          0x493E70,  "code"),
    ("create_param2",                         0xDF40,    "code"),
    ("send_message",                          0x1677A30, "code"),
    ("param1_vtable",                         0x84EC9C8, "data"),
    ("param2",                                0xA0CE0B0, "data"),
    ("param2_1",                              0x8595F58, "data"),
    ("param2_2",                              0x8595E98, "data"),
    ("param2_3",                              0x8595DD8, "data"),
    ("txt_message_ctr",                       0x6B2C30,  "code"),
    ("txt_message_vtbl",                      0x8279358, "data"),
    ("img_msg_vtbl",                          0x84F96B8, "data"),
    ("img_msg_vtb2",                          0x84F9748, "data"),
    ("g_Patch_Revoke",                        0x22D09E7, "data"),
    ("xlog_hook_target",                      0x108678,  "code"),
]

PATTERN_LEN = 24          # 特征长度（字节）
MAX_PATTERN_LEN = 40      # 数据目标：指令特征最多这么长


# ── PE 解析：RVA → 文件偏移 ──────────────────────────────────
def parse_pe(data):
    if data[:2] != b'MZ':
        raise ValueError('不是 PE 文件')
    pe_off = struct.unpack_from('<I', data, 0x3C)[0]
    if data[pe_off:pe_off + 4] != b'PE\0\0':
        raise ValueError('PE 签名不对')
    nsec = struct.unpack_from('<H', data, pe_off + 6)[0]
    opt_size = struct.unpack_from('<H', data, pe_off + 20)[0]
    opt_off = pe_off + 24
    magic = struct.unpack_from('<H', data, opt_off)[0]
    image_base = struct.unpack_from('<Q' if magic == 0x20b else '<I', data, opt_off + 24)[0]
    sec_off = opt_off + opt_size
    sections = []
    for i in range(nsec):
        o = sec_off + i * 40
        name = data[o:o + 8].rstrip(b'\0').decode('latin1')
        vsize, vaddr, rawsize, rawptr = struct.unpack_from('<IIII', data, o + 8)
        sections.append((name, vaddr, vsize, rawptr, rawsize))
    return image_base, sections


def rva_to_off(sections, rva):
    for name, vaddr, vsize, rawptr, rawsize in sections:
        if vaddr <= rva < vaddr + max(vsize, rawsize):
            return rawptr + (rva - vaddr)
    return None


def is_exec(sections, rva):
    for name, vaddr, vsize, rawptr, rawsize in sections:
        if vaddr <= rva < vaddr + max(vsize, rawsize):
            return bool(0x20000000 & 0x20000000) and name in ('.text', 'CODE')
    return False


def section_of(sections, rva):
    for name, vaddr, vsize, rawptr, rawsize in sections:
        if vaddr <= rva < vaddr + max(vsize, rawsize):
            return name
    return '?'


# ── ① 代码目标：取开头字节 + 通配"像相对位移"的 4 字节 ────────
def code_pattern(data, sections, rva):
    off = rva_to_off(sections, rva)
    if off is None:
        return None
    raw = data[off:off + PATTERN_LEN]
    if len(raw) < PATTERN_LEN:
        return None
    pat = list(raw)
    # 启发式通配：x86-64 里 RIP 相对位移出现在 48/4C 8B/8D/89/8B 等指令的末尾 4 字节。
    # 简单做法：把每个 4 字节窗口里"看起来像小整数位移（-2GB..+2GB）"的字节打 ??。
    # 更保守：只通配紧跟在这些操作码后面的 4 字节。
    opcodes = {0x8D, 0x8B, 0x89, 0x3B, 0x39, 0x03, 0x05, 0x0D, 0x15, 0x1D, 0x25, 0x2D, 0x35, 0x3D}
    i = 0
    while i < len(pat) - 5:
        # REX.W + opcode + modrm(05/0D/15/1D/25/2D/35/3D 结尾) → 后面 4 字节是 RIP 位移
        if pat[i] in (0x48, 0x4C) and pat[i + 1] in opcodes and (pat[i + 2] & 0xC7) == 0x05:
            for k in range(4):
                pat[i + 3 + k] = None
            i += 7
            continue
        i += 1
    return pat


# ── ② 数据目标：找一条引用它的指令，用指令形态当特征 ──────────
def find_ref_instruction(data, sections, target_rva):
    """在 .text 里找引用 target_rva 的 RIP 相对指令，返回 (指令文件偏移, 指令长度, 形态)"""
    text = None
    for name, vaddr, vsize, rawptr, rawsize in sections:
        if name == '.text':
            text = (vaddr, vsize, rawptr, rawsize)
            break
    if not text:
        return None
    tvaddr, tvsize, trawptr, trawsize = text
    blob = data[trawptr:trawptr + trawsize]
    # 常见的 RIP 相对形式：REX(48/4C) + opcode(8B/8D/89/8C/3B/39) + modrm(05/0D/15/1D/25/2D/35/3D)
    cands = []
    for i in range(len(blob) - 7):
        if blob[i] not in (0x48, 0x4C):
            continue
        op = blob[i + 1]
        if op not in (0x8B, 0x8D, 0x89, 0x8C, 0x3B, 0x39, 0x03, 0x05, 0x0D, 0x15, 0x1D, 0x2D, 0x35, 0x3D):
            continue
        modrm = blob[i + 2]
        if (modrm & 0xC7) != 0x05:
            continue
        disp = struct.unpack_from('<i', blob, i + 3)[0]
        insn_end_rva = tvaddr + i + 7
        if insn_end_rva + disp == target_rva:
            # 形态：前 3 字节固定，位移 4 字节通配。
            # 关键：只有 7 字节会匹配到几千处 → 必须带上**前后上下文**才唯一。
            CTX_BEFORE, CTX_AFTER = 8, 4
            lo = max(0, i - CTX_BEFORE)
            hi = min(len(blob), i + 7 + CTX_AFTER)
            shape = []
            for k in range(lo, hi):
                if i + 3 <= k < i + 7:
                    shape.append(None)          # 位移 4 字节通配
                else:
                    shape.append(blob[k])
            cands.append((lo, hi - lo, shape, (i + 3) - lo))
    if not cands:
        return None
    # 优先选形态"最常见"的（跨版本更可能保留）
    return cands[0]


def main():
    if len(sys.argv) < 2:
        print('用法: python gen-offset-patterns.py <Weixin.dll> [输出头文件]')
        return 1
    dll = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else 'include/offset_patterns.h'
    data = open(dll, 'rb').read()
    image_base, sections = parse_pe(data)
    print(f'Weixin.dll: {len(data)} 字节  映像基址 0x{image_base:X}  节 {len(sections)} 个')
    for name, vaddr, vsize, rawptr, rawsize in sections[:8]:
        print(f'  {name:8s} RVA 0x{vaddr:X}  大小 0x{max(vsize, rawsize):X}')

    entries = []
    ok = fail = 0
    for name, rva, kind in OFFSETS:
        sec = section_of(sections, rva)
        if kind == 'code':
            pat = code_pattern(data, sections, rva)
            if pat:
                entries.append((name, rva, kind, 'abs', pat, 0, 0))
                ok += 1
                print(f'  ✓ {name:38s} 0x{rva:X} [{sec}] 代码特征 {len(pat)} 字节，通配 {pat.count(None)} 处')
            else:
                fail += 1
                print(f'  ✗ {name:38s} 0x{rva:X} 取不到字节（节 {sec}）')
        else:
            r = find_ref_instruction(data, sections, rva)
            if r:
                i, ln, shape, disp = r
                entries.append((name, rva, kind, 'rip', shape, ln, disp))
                ok += 1
                print(f'  ✓ {name:38s} 0x{rva:X} [{sec}] 引用指令特征 {ln} 字节')
            else:
                # 退化成"直接取数据地址处的字节"（不稳，但聊胜于无）
                pat = code_pattern(data, sections, rva)
                if pat:
                    entries.append((name, rva, kind, 'abs', pat, 0, 0))
                    ok += 1
                    print(f'  ~ {name:38s} 0x{rva:X} [{sec}] 没找到引用指令，退化为绝对特征')
                else:
                    fail += 1
                    print(f'  ✗ {name:38s} 0x{rva:X} 失败（节 {sec}）')

    # ── 生成 C++ 头 ──
    lines = []
    lines.append('// 自动生成，请勿手改 —— 由 scripts/gen-offset-patterns.py 从 Weixin.dll 提取')
    lines.append(f'// 来源版本：{os.path.basename(dll)}（{len(data)} 字节，映像基址 0x{image_base:X}）')
    lines.append('// 说明：每个偏移配一条"特征模式"。运行时先在 Weixin.dll 里搜模式：')
    lines.append('//   搜到 → 用新地址（跨版本自适应）；搜不到 → 回退到硬编码偏移（安全兜底）')
    lines.append('#pragma once')
    lines.append('#include <cstdint>')
    lines.append('#include <cstddef>')
    lines.append('')
    lines.append('struct OffsetPattern {')
    lines.append('    const char* name;        // 偏移名（对应 global.h 里的变量）')
    lines.append('    uint64_t    fallback;    // 硬编码兜底偏移（当前版本的值）')
    lines.append('    const uint8_t* bytes;    // 特征字节（0xFF 表示通配）')
    lines.append('    size_t      len;         // 特征长度')
    lines.append('    bool        ripRelative; // true = 数据目标，需从指令反算地址')
    lines.append('    size_t      insnLen;     // ripRelative 时的指令长度')
    lines.append('    size_t      dispOffset;  // 位移 4 字节在特征里的下标（ripRelative 用）')
    lines.append('};')
    lines.append('')

    for idx, (name, rva, kind, mode, pat, ln, disp) in enumerate(entries):
        arr = ', '.join('0xFF' if b is None else f'0x{b:02X}' for b in pat)
        lines.append(f'// {name}  (0x{rva:X}, {"代码" if kind == "code" else "数据"}, {"指令引用" if mode == "rip" else "绝对"})')
        lines.append(f'inline const uint8_t g_pat_{idx}[] = {{ {arr} }};')
    lines.append('')
    lines.append('inline const OffsetPattern g_offsetPatterns[] = {')
    for idx, (name, rva, kind, mode, pat, ln, disp) in enumerate(entries):
        lines.append(f'    {{ "{name}", 0x{rva:X}ULL, g_pat_{idx}, {len(pat)}, '
                     f'{"true" if mode == "rip" else "false"}, {ln if mode == "rip" else 0}, '
                     f'{disp if mode == "rip" else 0} }},')
    lines.append('};')
    lines.append(f'inline constexpr size_t g_offsetPatternCount = {len(entries)};')
    lines.append('')

    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    io.open(out, 'w', encoding='utf-8').write('\n'.join(lines))
    print(f'\n成功 {ok} 个，失败 {fail} 个 → 已写入 {out}')
    return 0 if fail == 0 else 2


if __name__ == '__main__':
    sys.exit(main())
