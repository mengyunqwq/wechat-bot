#include "offset_resolver.h"
#include "offset_patterns.h"
#include "global.h"

#include <windows.h>
#include <psapi.h>
#include <cstring>
#include <cstdio>
#include <string>

// ── 解析结果表（名字 → 当前值），供日志查询 ──────────────────
namespace {
    constexpr int MAX_RESOLVED = 64;
    struct ResolvedEntry { const char* name; uint64_t value; bool fromPattern; };
    ResolvedEntry g_resolved[MAX_RESOLVED];
    int g_resolvedCount = 0;
    bool g_done = false;

    void AddResolved(const char* name, uint64_t value, bool fromPattern) {
        if (g_resolvedCount >= MAX_RESOLVED) return;
        g_resolved[g_resolvedCount++] = { name, value, fromPattern };
    }

    // 通配匹配：模式里 0xFF 表示"任意字节"
    inline bool MatchAt(const uint8_t* p, const uint8_t* pat, size_t len) {
        for (size_t i = 0; i < len; i++) {
            if (pat[i] != 0xFF && p[i] != pat[i]) return false;
        }
        return true;
    }

    // 在 Weixin.dll 映像里扫描特征。用第一个"全非通配的 4 字节窗口"做锚点加速
    // （否则 174MB 逐字节比对太慢）。返回首个命中地址（绝对），并回填命中数。
    uint64_t ScanModule(const uint8_t* pat, size_t len, size_t* outCount) {
        if (outCount) *outCount = 0;
        if (!g_hWeixinDll || len == 0 || len > 256) return 0;

        HMODULE mod = (HMODULE)g_hWeixinDll;
        MODULEINFO mi{};
        if (!GetModuleInformation(GetCurrentProcess(), mod, &mi, sizeof(mi))) return 0;
        const uint8_t* base = (const uint8_t*)mi.lpBaseOfDll;
        const size_t size = mi.SizeOfImage;
        if (!base || size <= len) return 0;

        // 找锚点
        size_t anchor = SIZE_MAX;
        for (size_t i = 0; i + 4 <= len; i++) {
            if (pat[i] != 0xFF && pat[i + 1] != 0xFF && pat[i + 2] != 0xFF && pat[i + 3] != 0xFF) {
                anchor = i;
                break;
            }
        }
        if (anchor == SIZE_MAX) return 0;

        const uint8_t a0 = pat[anchor];
        const uint8_t a1 = pat[anchor + 1];
        const uint8_t a2 = pat[anchor + 2];
        const uint8_t a3 = pat[anchor + 3];

        size_t count = 0;
        uint64_t first = 0;
        for (size_t off = 0; off + len <= size; ) {
            // memchr 找第一个字节
            const uint8_t* start = base + off + anchor;
            size_t remain = size - (off + anchor);
            if (remain < 4) break;
            const uint8_t* hit = (const uint8_t*)memchr(start, a0, remain - 3);
            if (!hit) break;
            size_t pos = (size_t)(hit - base) - anchor;
            if (pos + len > size) break;
            // 快速校验锚点后 3 字节，再全量比对
            if (hit[1] == a1 && hit[2] == a2 && hit[3] == a3 && MatchAt(base + pos, pat, len)) {
                count++;
                if (!first) first = (uint64_t)(base + pos);
                if (count > 64) break;      // 命中太多说明特征不够独特，早点退出
            }
            off = pos + 1;
        }
        if (outCount) *outCount = count;
        return first;
    }

    // 名字 → 全局变量：解析成功后直接写回 global.h 里的变量
    // （这些变量已从 constexpr 改成 inline，可运行时赋值）
    void ApplyOffset(const char* name, uint64_t value) {
        std::string n(name);
        if (n == "XWECHAT_SQLITE3_VFS_OFFSET")           { XWECHAT_SQLITE3_VFS_OFFSET = (size_t)value; return; }
        if (n == "XWECHAT_SQLITE3_API_ROUTINES_OFFSET")  { XWECHAT_SQLITE3_API_ROUTINES_OFFSET = (size_t)value; return; }
        if (n == "XWECHAT_SQLCIPHER_API_ROUTINES_OFFSET"){ XWECHAT_SQLCIPHER_API_ROUTINES_OFFSET = (size_t)value; return; }
        if (n == "XWECHAT_SQLITE3_CODEC_GET_KEY_FUNC")   { XWECHAT_SQLITE3_CODEC_GET_KEY_FUNC = (size_t)value; return; }
        if (n == "dec_pic_call")                         { offset::dec_pic_call = value; return; }
        if (n == "create_param2")                        { offset::create_param2 = value; return; }
        if (n == "send_message")                         { offset::send_message = value; return; }
        if (n == "param1_vtable")                        { offset::param1_vtable = value; return; }
        if (n == "param2")                               { offset::param2 = value; return; }
        if (n == "param2_1")                             { offset::param2_1 = value; return; }
        if (n == "param2_2")                             { offset::param2_2 = value; return; }
        if (n == "param2_3")                             { offset::param2_3 = value; return; }
        if (n == "txt_message_ctr")                      { offset::txt_message_ctr = value; return; }
        if (n == "txt_message_vtbl")                     { offset::txt_message_vtbl = value; return; }
        if (n == "img_msg_vtbl")                         { offset::img_msg_vtbl = value; return; }
        if (n == "img_msg_vtb2")                         { offset::img_msg_vtb2 = value; return; }
        if (n == "g_Patch_Revoke")                       { g_Patch_Revoke = value; return; }
        if (n == "xlog_hook_target")                     { g_xlogHookTarget = value; return; }
        if (n == "voice_msg_ctr")                        { offset::voice_msg_ctr = value; return; }
        if (n == "XWECHAT_MAIN_CLAZZ_OFFSET")            { g_xwechatMainClazz = value; return; }
    }
}

int ResolveOffsets() {
    if (g_done) return g_resolvedCount;
    g_done = true;
    if (!g_hWeixinDll) {
        OutputDebugStringA("[offset] Weixin.dll 未加载，跳过偏移解析（全部用硬编码值）\n");
        return 0;
    }

    int fromPattern = 0;
    char buf[256];
    for (size_t i = 0; i < g_offsetPatternCount; i++) {
        const OffsetPattern& p = g_offsetPatterns[i];
        size_t matches = 0;
        uint64_t hit = ScanModule(p.bytes, p.len, &matches);
        uint64_t value = 0;
        bool ok = false;

        if (hit) {
            if (p.ripRelative && p.dispOffset + 4 <= p.len) {
                // 特征含上下文 → 命中点要换算回指令位置：指令 = hit + (dispOffset-3)，长 7 字节
                // 指令末尾 = hit + dispOffset + 4；目标 = 指令末尾 + disp
                int32_t disp = 0;
                memcpy(&disp, (const void*)(hit + p.dispOffset), 4);
                value = hit + p.dispOffset + 4 + (int64_t)disp;
            } else {
                value = hit - (uint64_t)g_hWeixinDll;   // 代码目标：转成模块偏移
            }
            ok = true;
            fromPattern++;
        }

        // 数据目标（vtable/VFS 等）用"引用指令 + 反算地址"，风险较高：
        // 反算错了会把好端端的偏移改坏（实测把 SQLITE3_VFS 改错 → 数据库扫描全废）。
        // 所以**只对代码目标应用**特征结果；数据目标一律保留硬编码值（等以后有更可靠的校验再加）。
        if (ok && p.ripRelative) {
            ok = false;
        }

        if (ok) {
            ApplyOffset(p.name, value);
            AddResolved(p.name, value, true);
            sprintf_s(buf, "[offset] %-38s 特征命中 %2zu 处 → 0x%llX（硬编码 0x%llX）\n",
                      p.name, matches, (unsigned long long)value, (unsigned long long)p.fallback);
        } else {
            ApplyOffset(p.name, p.fallback);
            AddResolved(p.name, p.fallback, false);
            sprintf_s(buf, "[offset] %-38s 特征未命中 → 回退硬编码 0x%llX\n",
                      p.name, (unsigned long long)p.fallback);
        }
        OutputDebugStringA(buf);
    }

    sprintf_s(buf, "[offset] 偏移解析完成：%d/%zu 个用特征定位成功（其余回退硬编码）\n",
              fromPattern, g_offsetPatternCount);
    OutputDebugStringA(buf);
    return fromPattern;
}

uint64_t GetResolvedOffset(const char* name) {
    for (int i = 0; i < g_resolvedCount; i++) {
        if (strcmp(g_resolved[i].name, name) == 0) return g_resolved[i].value;
    }
    return 0;
}

bool OffsetsResolved() { return g_done; }
