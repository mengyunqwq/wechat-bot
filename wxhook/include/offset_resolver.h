// 偏移自动解析：启动时用"特征模式"在 Weixin.dll 里重新定位每个偏移。
//
// 为什么要它：hook 原来靠硬编码偏移（如 send_message = 0x1677A30），微信一升级就全废。
// 现在每个偏移配一条特征（由 scripts/gen-offset-patterns.py 从当前版本提取）：
//   搜到 → 用新地址（跨版本自适应）；搜不到 → 回退硬编码值（安全兜底，不会崩）。
//
// 两类目标的处理：
//   代码目标：特征就是函数开头若干字节，命中的地址即函数入口。
//   数据目标：特征是一条**引用它的指令**（形态 + 通配位移），运行时从指令反算真实地址。
#pragma once
#include <cstdint>

// 解析全部偏移（启动时调用一次）。返回成功用特征解析出来的个数。
int ResolveOffsets();

// 取某个偏移的当前值（按名字，找不到返回 0）。仅用于日志/调试。
uint64_t GetResolvedOffset(const char* name);

// 是否已解析过
bool OffsetsResolved();
