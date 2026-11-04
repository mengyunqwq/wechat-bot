#pragma once
// CrashLog —— 崩溃现场记录器（见 CrashLog.cpp 顶部说明）
namespace crashlog
{
    void Install();                                  // 装 VEH（幂等）
    void Note(const char* fmt, ...);                 // 记一条"最近操作"（无锁、不分配）
}
