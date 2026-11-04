#pragma once
// ─────────────────────────────────────────────────────────────────────────────
// VoiceUploadProbe — READ-ONLY instrumentation for the WeChat voice UPLOAD path
// (4.1.10.27).  Default OFF: while the marker file is absent NO hook is
// installed at all (zero footprint).  When ON it only *reads* arguments /
// return values and writes a log file.  It never modifies arguments, return
// values, or control flow.
//
// Marker file : <Weixin.exe dir>\hook-vuprobe.on
// Log file    : <Weixin.exe dir>\voice-upload-probe.log
// HTTP        : GET/POST /Debug/VuProbe
// ─────────────────────────────────────────────────────────────────────────────
#include <string>

// ── 公开版构建（/DPUBLIC_BUILD）──────────────────────────────────────────────
//   公开版**不含**探针与 CDN 重放：那部分是本项目自己加的、且上游项目刻意移除的
//   能力。这里给出空实现，调用点不需要任何条件编译，链接也不会断。
#ifdef PUBLIC_BUILD
namespace VuProbe
{
    inline void StartThread() {}
    inline void SetEnabled(bool) {}
    inline bool IsEnabled() { return false; }
    inline std::string ReportJson() { return "{\"publicBuild\":true,\"note\":\"probe stripped\"}"; }
}
#else

namespace VuProbe
{
    // Spawn the watcher thread (called from inline_weixin_dll_load.cpp).
    void StartThread();

    // Runtime switch (same effect as creating/removing the marker file).
    void SetEnabled(bool on);
    bool IsEnabled();

    // JSON status report for the HTTP debug route.
    std::string ReportJson();
}
#endif // PUBLIC_BUILD
