#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
抖音「自动刷视频」采集器 —— 只读：打开推荐流、翻 N 条、读标题/点赞/截图。

设计原则（血泪换来的）：
  1. 只用【真实鼠标坐标点击】和【键盘 ArrowDown】——
     `element.click()` / `mouse.wheel` 在抖音桌面版上无效或会被判成非人类操作。
  2. JS 里【绝不用正则】（PowerShell heredoc 传过去容易坏），只用字符串方法。
  3. 有头模式（headless=False）—— headless 会被抖音直接弹验证码中间页。
  4. 登录态在独立 profile（`data/douyin-profile`），先用 `douyin-login.py` 扫码一次。
  5. 本脚本【不点赞、不评论、不关注、不发私信】—— 纯读。

用法：
  python douyin-brush.py --count 8
  python douyin-brush.py --count 8 --out D:\\...\\data\\_douyin\\batch
输出：
  <out>/item-01.png ... item-NN.png    每条视频的截图（给视觉模型看）
  <out>/items.json                      [{i, desc, like, url, shot}]
"""

import argparse
import asyncio
import glob
import shutil
import json
import os
import sys

PROF_DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "douyin-profile")
OUT_DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "_douyin")

# ★ JS 里不用正则
#  关键：页面上有【多个】video-desc 元素（相邻视频被预加载），querySelector 会取到
#  第一个（往往是预加载的上一条/下一条）→ 就会出现"文案和截图对不上"。
#  所以这里改成：收集所有 video-desc，只取【在当前视口内、可见、面积最大】的那个。
READ_JS = """
() => {
  const vh = window.innerHeight || 900;
  const vw = window.innerWidth || 1280;
  const visibles = [];
  document.querySelectorAll('[data-e2e=video-desc]').forEach((e) => {
    const r = e.getBoundingClientRect();
    const txt = String(e.innerText || '').trim();
    if (!txt) return;
    if (r.width < 40 || r.height < 10) return;
    // 必须在视口内（允许少量溢出）
    const inView = r.bottom > 40 && r.top < vh - 20 && r.right > 0 && r.left < vw;
    if (!inView) return;
    visibles.push({ txt: txt.slice(0, 400), area: r.width * r.height, top: r.top });
  });
  visibles.sort((a, b) => b.area - a.area);
  const desc = visibles.length ? visibles[0].txt : '';

  // 点赞数：同样取可见的、且离 desc 最近的那个
  const likes = [];
  document.querySelectorAll('[data-e2e=video-like-count]').forEach((e) => {
    const r = e.getBoundingClientRect();
    const txt = String(e.innerText || '').trim();
    if (!txt) return;
    if (r.bottom > 40 && r.top < vh - 20) likes.push({ txt: txt.slice(0, 20), top: r.top });
  });
  likes.sort((a, b) => a.top - b.top);

  // 视频元素：取可见面积最大的（当前播放的那个）
  let bestV = null, bestArea = 0;
  document.querySelectorAll('video').forEach((v) => {
    const r = v.getBoundingClientRect();
    const inView = r.bottom > 40 && r.top < vh - 20;
    const area = r.width * r.height;
    if (inView && area > bestArea) { bestArea = area; bestV = v; }
  });
  return {
    url: location.href,
    desc: desc,
    like: likes.length ? likes[0].txt : '',
    author: '',
    vcount: document.querySelectorAll('video').length,
    desc_count: visibles.length,
    // ★ 是否真的在播（截图前必须为 true，否则拍到黑屏/播放按钮）
    playing: !!(bestV && !bestV.paused && bestV.currentTime > 0.25 && bestV.readyState >= 2),
    vtime: bestV ? Number(bestV.currentTime || 0) : 0
  };
}
"""

FIND_TAB_JS = """
(tabText) => {
  for (const e of [...document.querySelectorAll('a,div,span,li')]) {
    if (String(e.innerText || '').trim() === tabText && e.offsetParent) {
      const b = e.getBoundingClientRect();
      if (b.width > 10 && b.height > 10) return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
  }
  return null;
}
"""

VIDEO_CENTER_JS = """
() => {
  const v = document.querySelector('video');
  if (!v) return null;
  const b = v.getBoundingClientRect();
  if (b.width < 50 || b.height < 50) return null;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
"""

# ★ 内容黑名单：命中直接跳过（不采、不分享）。
#   理由：机器人往群里发政治/时政/敏感内容是最不能犯的错。
BLOCK_WORDS = [
    "习近平", "总书记", "主席", "国家领导", "国务院", "政治局", "人大", "政协",
    "政治", "时政", "新闻联播", "外交部", "国防部", "军方", "军队", "战争",
    "选举", "总统", "首相", "白宫", "克里姆林宫", "乌克兰", "俄罗斯", "以色列",
    "台湾", "西藏", "新疆", "香港", "法轮", "维权", "抗议", "游行",
    "疫情", "封控", "核酸", "疫苗", "死亡", "去世", "杀人", "凶杀", "案件",
    "诈骗", "赌博", "毒品", "色情", "约炮", "裸", "胸", "大腿",
    "广告", "招商", "代理", "加盟", "厂家", "定制", "批发", "电话咨询",
]


def is_blocked(text: str) -> bool:
    t = (text or "")
    return any(w in t for w in BLOCK_WORDS)


# ★ 录音：把当前可见视频的声音录成 webm（base64 回传）
#   踩过的坑：
#   ① 启动参数【不能带 --mute-audio】—— 浏览器层静音会让 captureStream 拿不到音轨（实测 RMS=0）
#   ② 不能用 AudioContext.createMediaElementSource —— 抖音播放器已经接管了该元素，
#      会抛 "already connected"（实测）
#   ③ 正确姿势：video.muted=false → video.captureStream() → 取 audioTracks → MediaRecorder
#      （实测能录到真声音：转 wav 后 RMS 13000+）
#   ④ ★ 2026-10-29 用户要求「不要放声音，但要能读音轨」→ 上面前提（必须有声）做不到。
#      改成架构解法：
#        · 本脚本默认 --mute-audio（浏览器彻底静音，不再出声）
#        · 音轨不再靠录音：下游 fetchLinkVideo（yt-dlp 下载 → video-probe 抽 16k wav）
#        · 因此 args.record_audio 默认 False；需要旧行为时显式加 --record-audio
RECORD_JS = r"""
async (seconds) => {
  try {
    const vs = [...document.querySelectorAll('video')].filter((v) => {
      const r = v.getBoundingClientRect();
      return r.bottom > 40 && r.top < window.innerHeight - 20;
    });
    if (!vs.length) return {err: 'no visible video'};
    const v = vs[0];
    // ★ 2026-10-29 实测：volume=0 只是"输出增益 0"，解码管线照常 →
    //   扬声器完全没声音，但 captureStream 仍能拿到音轨（RMS 5342，甚至比 volume=1 更干净）。
    //   注意：不能改成 muted=true / --mute-audio，那才是真的把音频管线关掉（RMS=0）。
    v.muted = false;
    v.volume = 0;
    try { await v.play(); } catch (e) { }
    if (!v.captureStream) return {err: 'captureStream unsupported'};
    let stream;
    try { stream = v.captureStream(); } catch (e) { return {err: 'captureStream threw: ' + (e && e.message)}; }
    const at = stream.getAudioTracks ? stream.getAudioTracks() : [];
    if (!at.length) return {err: 'no audio track', all: [...stream.getTracks()].map(t => t.kind)};
    const rec = new MediaRecorder(new MediaStream(at), {mimeType: 'audio/webm'});
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res) => { rec.onstop = res; });
    rec.start(250);
    await new Promise(r => setTimeout(r, seconds * 1000));
    rec.stop();
    await stopped;
    const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    }
    return {b64: btoa(bin), size: buf.length};
  } catch (e) {
    return {err: String(e && e.message || e)};
  }
}
"""


COOKIE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "..", "data", "_douyin", "cookies.txt")


async def dump_cookies(ctx, path=None):
    """把当前浏览器的抖音 cookies 导成 Netscape 格式（yt-dlp --cookies 直接可用）。

    为什么要它：抖音下载**必须有新鲜 cookies**（yt-dlp 报 Fresh cookies are needed），
    而刷推荐流用的 Playwright profile 本来就是登录态 —— 顺手导出来，
    下游 fetchLinkVideo 就能"静音刷 + 下载抽音轨"，两件事同时成立。
    """
    path = path or COOKIE_FILE
    try:
        cookies = await ctx.cookies()
        rows = ["# Netscape HTTP Cookie File", "# generated by douyin-brush.py"]
        n = 0
        for c in cookies:
            dom = c.get("domain") or ""
            if "douyin" not in dom and "iesdouyin" not in dom:
                continue
            expiry = int(c.get("expires") or 0)
            if expiry <= 0:
                expiry = 2147483647          # 会话 cookie → 给个远期时间，免得 yt-dlp 当成过期
            flag = "TRUE" if str(dom).startswith(".") else "FALSE"
            secure = "TRUE" if c.get("secure") else "FALSE"
            prefix = "#HttpOnly_" if c.get("httpOnly") else ""
            rows.append("%s%s\t%s\t%s\t%s\t%d\t%s\t%s" % (
                prefix, dom, flag, c.get("path") or "/", secure, expiry,
                c.get("name") or "", c.get("value") or ""))
            n += 1
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(rows) + "\n")
        print("cookies: 已导出 %d 条 → %s" % (n, path), flush=True)
        return path if n else ""
    except Exception as e:
        print("cookies: 导出失败（不影响刷，只影响下载取音轨）: %s" % str(e)[:80], flush=True)
        return ""


# ★ 2026-10-29（路线 A）：拦截网络响应，直接拿视频 CDN 直链 + 元数据
#   为什么：yt-dlp 下抖音会报 "Fresh cookies are needed"（导出 cookies 也不认），
#   而推荐流响应里本来就有 video.play_addr.url_list（直链）、话题、BGM、作者、点赞。
AWEME_ACC = []


def _pick_play_url(v):
    """从 video 里挑一个可用的直链（优先 http，抖音 CDN 的 http 版本限制更少）"""
    try:
        cands = []
        for key in ("play_addr", "play_addr_h264", "play_addr_265", "play_addr_bytevc1"):
            lst = ((v or {}).get(key) or {}).get("url_list") or []
            if lst:
                cands += [u for u in lst if isinstance(u, str)]
        if not cands:
            for br in ((v or {}).get("bit_rate") or []):
                lst = ((br or {}).get("play_addr") or {}).get("url_list") or []
                cands += [u for u in lst if isinstance(u, str)]
        if not cands:
            return ""
        for u in cands:
            if u.startswith("http://"):
                return u
        return cands[0]
    except Exception:
        return ""


def parse_aweme_list(obj):
    out = []
    try:
        items = (obj or {}).get("aweme_list") or []
        if not isinstance(items, list):
            return out
        for it in items:
            if not isinstance(it, dict):
                continue
            vid = str(it.get("aweme_id") or "")
            play = _pick_play_url(it.get("video") or {})
            if not vid and not play:
                continue
            cha = it.get("cha_list") or []
            tags = [str((c or {}).get("cha_name") or "") for c in cha if isinstance(c, dict)]
            mus = it.get("music") or {}
            out.append({
                "aweme_id": vid,
                "desc": str(it.get("desc") or ""),
                "playUrl": play,
                "tags": [t for t in tags if t],
                "bgm": str(mus.get("title") or ""),
                "author": str((it.get("author") or {}).get("nickname") or ""),
                "like": int((it.get("statistics") or {}).get("digg_count") or 0),
                "duration": int((it.get("video") or {}).get("duration") or 0) / 1000.0,
                "shareUrl": ("https://www.douyin.com/video/" + vid) if vid else "",
            })
    except Exception as e:
        print("解析 aweme_list 失败: %s" % str(e)[:80], flush=True)
    return out


async def collect_aweme(resp):
    """网络响应钩子：只认含 aweme_list 的 JSON"""
    try:
        u = resp.url or ""
        if "aweme" not in u:
            return
        body = await resp.text()
        if "aweme_list" not in body:
            return
        import json as _json
        for x in parse_aweme_list(_json.loads(body)):
            if x["aweme_id"] and any(a["aweme_id"] == x["aweme_id"] for a in AWEME_ACC):
                continue
            AWEME_ACC.append(x)
    except Exception:
        pass


def match_aweme(desc, index):
    """把页面可见文案跟抓到的 aweme 对上（先按文案，再按顺序兜底）"""
    d = (desc or "").replace("\n", " ").strip()
    first = d[:12] if d else ""
    if first:
        for a in AWEME_ACC:
            if first and first in (a.get("desc") or ""):
                return a
    if 0 <= index < len(AWEME_ACC):
        return AWEME_ACC[index]
    return None


async def read_item(pg):
    try:
        return await pg.evaluate(READ_JS)
    except Exception:
        return {"desc": "", "like": "", "author": "", "url": "", "vcount": 0}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=8, help="刷多少条")
    ap.add_argument("--profile", default=PROF_DEFAULT)
    ap.add_argument("--out", default=OUT_DEFAULT)
    ap.add_argument("--gap", type=float, default=2.0, help="每条之间停顿秒数")
    ap.add_argument("--headless", action="store_true")
    # ★ 2026-10-29：默认「静音浏览」——不再靠"边播边录"拿音轨（那必须有声音）。
    #   音轨改由下游 fetchLinkVideo（yt-dlp 下载 → video-probe 抽音轨）提供，
    #   所以这里可以放心把浏览器整体静音。
    ap.add_argument("--mute-audio", dest="mute_audio", action="store_true", default=False,
                    help="浏览器层静音（默认关；开了会录不到音轨，静音请靠 volume=0）")
    ap.add_argument("--no-mute-audio", dest="mute_audio", action="store_false",
                    help="允许放出声音（只有调试录音时才需要）")
    ap.add_argument("--record-audio", dest="record_audio", action="store_true", default=True,
                    help="录音轨（默认开）。配合 volume=0：扬声器无声，音轨照录 ✓")
    ap.add_argument("--no-record-audio", dest="record_audio", action="store_false",
                    help="完全关掉录音（只剩画面）")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=args.profile,
            channel="msedge",
            headless=bool(args.headless),
            viewport={"width": 1280, "height": 900},
            locale="zh-CN",
            accept_downloads=True,
            permissions=["clipboard-read", "clipboard-write"],
            # ★ 有头模式（headless 会被抖音弹验证码），但把窗口【移到屏幕外】，
            #   用户看不到、也不占用桌面（--window-position 给个巨大的负坐标即可）。
            #   注意：仍然必须有头，否则推荐流/验证码过不去。
            args=["--disable-blink-features=AutomationControlled",
                  "--autoplay-policy=no-user-gesture-required",
                  "--window-position=-32000,-32000",
                  "--window-size=1280,900",
                  # ★ 2026-10-29：浏览器层静音 —— 不把抖音声音放到扬声器。
                  #   代价：captureStream 拿不到音轨（作者 129 行实测），所以录音默认关；
                  #   音轨改由下游 fetchLinkVideo（下载后抽 16k wav）提供。
                  *(["--mute-audio"] if args.mute_audio else [])],
            ignore_default_args=["--enable-automation"],
        )
        await ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined});")
        pg = ctx.pages[0] if ctx.pages else await ctx.new_page()
        print("打开抖音...", flush=True)
        await pg.goto("https://www.douyin.com/", wait_until="domcontentloaded", timeout=90000)
        # ★ 路线 A：先挂网络钩子，推荐流首屏响应里就有 playAddr（直链）
        pg.on("response", lambda r: asyncio.create_task(collect_aweme(r)))
        # ★ 顺手把登录态 cookies 导给 yt-dlp（下游"静音刷 + 下载抽音轨"必须有它）
        cookie_path = await dump_cookies(ctx)
        if cookie_path:
            try:
                import json as _json
                with open(os.path.join(args.out, "cookies-path.json"), "w", encoding="utf-8") as _f:
                    _json.dump({"cookies": cookie_path}, _f, ensure_ascii=False)
            except Exception:
                pass
        try:
            await pg.wait_for_load_state("networkidle", timeout=20000)
        except Exception:
            pass
        await pg.wait_for_timeout(6000)

        title = await pg.title()
        if "验证码" in title:
            print("FAIL: 抖音弹了验证码（%s）。请用有头模式跑，或稍后重试。" % title, flush=True)
            await ctx.close()
            return 1

        # ① 真实鼠标点「推荐」
        tab = await pg.evaluate(FIND_TAB_JS, "推荐")
        if tab:
            await pg.mouse.move(tab["x"] - 50, tab["y"] - 30, steps=12)
            await pg.wait_for_timeout(300)
            await pg.mouse.click(tab["x"], tab["y"])
            print("已点击「推荐」(%.0f,%.0f)" % (tab["x"], tab["y"]), flush=True)
        else:
            print("WARN: 没找到「推荐」标签，直接刷当前页", flush=True)
        await pg.wait_for_timeout(8000)

        # ② 点视频区拿焦点（ArrowDown 才有效）
        c = await pg.evaluate(VIDEO_CENTER_JS)
        if c:
            await pg.mouse.click(c["x"], c["y"])
            await pg.wait_for_timeout(1200)
            try:
                await pg.keyboard.press("Escape")   # 关掉可能弹出的登录/提示层
            except Exception:
                pass

        # ③ 逐条采集（翻页后【等标题真的变了】再采，避免同一条被采多次）
        items = []
        prev_desc = None
        tries = 0
        while len(items) < args.count and tries < args.count * 4:
            tries += 1
            d = await read_item(pg)
            desc = (d.get("desc") or "").strip()
            if not desc:
                await pg.keyboard.press("ArrowDown")
                await pg.wait_for_timeout(int(args.gap * 1000))
                continue
            key = desc[:30]
            if key == (prev_desc or "")[:30]:
                # 同一条还没翻过去 → 再按一次 ↓，短等
                await pg.keyboard.press("ArrowDown")
                await pg.wait_for_timeout(1200)
                continue
            # ★ 黑名单内容（政治/时政/敏感/广告…）直接跳过，不采不分享
            if is_blocked(desc):
                print("[跳过] 命中黑名单：%s" % desc[:40], flush=True)
                prev_desc = desc
                await pg.keyboard.press("ArrowDown")
                await pg.wait_for_timeout(int(args.gap * 1000))
                continue
            prev_desc = desc
            n = len(items) + 1
            # ★ 截图和文案必须对得上。实测规律（2026-10-20）：
            #   抖音切视频时【画面先换、标题晚 1~2 秒才更新】。
            #   所以只等 1.2 秒不够 —— 必须确认"标题连续 3 秒没变"再截图，
            #   否则会出现"文案是鹅头、图是今日说法"这种错位。
            shot = ""
            final_desc = desc
            like = (d.get("like") or "").strip()
            author = (d.get("author") or "").strip()
            stable = False
            for attempt in range(5):
                a = (await read_item(pg)).get("desc") or ""
                await pg.wait_for_timeout(3000)          # 等画面和标题都稳定
                b_item = await read_item(pg)
                b = b_item.get("desc") or ""
                if a[:30] != b[:30]:
                    # 标题还在变 → 继续等
                    key = b[:30]
                    prev_desc = b
                    continue
                # ★ 必须确认视频【正在播放且已播了一点】（否则会拍到黑屏/播放按钮）
                if not b_item.get("playing"):
                    # 尝试点一下画面让它播
                    try:
                        c0 = await pg.evaluate(VIDEO_CENTER_JS)
                        if c0: await pg.mouse.click(c0["x"], c0["y"])
                    except Exception:
                        pass
                    await pg.wait_for_timeout(2500)
                    if not (await read_item(pg)).get("playing"):
                        print("[%d] 视频没在播 → 跳过这条" % n, flush=True)
                        await pg.keyboard.press("ArrowDown")
                        await pg.wait_for_timeout(int(args.gap * 1000))
                        stable = False
                        break
                # 标题稳定 3 秒 + 正在播放 → 现在截图，画面与文案一致
                shot = os.path.join(args.out, "item-%02d.png" % n)
                try:
                    await pg.screenshot(path=shot)
                except Exception:
                    shot = ""
                # ★ 真要"看懂"而不只是读标题：在 20%/50%/80% 三处各截一帧，拼成一张联系表，
                #   交给视觉模型一次看完（和群里发视频的识别链路复用同一个函数）。
                sheet = ""
                frames = []
                try:
                    dur = await pg.evaluate("""() => {
                        const vs = [...document.querySelectorAll('video')].filter((v) => {
                            const r = v.getBoundingClientRect();
                            return r.bottom > 40 && r.top < window.innerHeight - 20;
                        });
                        return vs.length ? Number(vs[0].duration || 0) : 0;
                    }""")
                    # ★ 9 帧（3×3 网格）：抖音视频大多把台词烧在画面字幕里，
                    #   多取几帧 + 让视觉模型逐帧读字幕 = 真的"看懂讲了什么"，
                    #   （试过下载原视频走 yt-dlp，抖音要 fresh cookies 且详情接口在推荐流返回空，
                    #    不通；所以走"多帧 + 读字幕"这条稳的路）
                    # ★ 不靠 seek（实测 currentTime 赋值后画面不变 → 9 帧全一样），
                    #   改成【让它播着连续截】：点一下画面确保在播，然后每 700ms 截一张，
                    #   共 9 张 → 一定覆盖不同时刻。
                    try:
                        cpos = await pg.evaluate("""() => {
                            const vs = [...document.querySelectorAll('video')].filter((v) => {
                                const r = v.getBoundingClientRect();
                                return r.bottom > 40 && r.top < window.innerHeight - 20;
                            });
                            if (!vs.length) return null;
                            const b = vs[0].getBoundingClientRect();
                            return {x: b.x + b.width / 2, y: b.y + b.height / 2};
                        }""")
                        if cpos:
                            await pg.mouse.click(cpos["x"], cpos["y"])   # 确保在播放
                            await pg.wait_for_timeout(600)
                    except Exception:
                        pass
                    for k in range(6):                # 6 帧（3×2）够读字幕，比 9 帧快 1/3
                        try:
                            fp = os.path.join(args.out, "f-%02d-%d.png" % (n, k + 1))
                            await pg.screenshot(path=fp)
                            frames.append(fp)
                        except Exception:
                            pass
                        await pg.wait_for_timeout(700)
                    if frames:
                        from PIL import Image
                        # 3×3 网格：每格宽度固定，行高取该行最大
                        tw = 560
                        cols, rows = 3, 2
                        cells = []
                        for f in frames[:6]:
                            im = Image.open(f)
                            cells.append(im.resize((tw, max(1, int(im.height * tw / im.width)))))
                        while len(cells) < 6:
                            cells.append(Image.new("RGB", (tw, 320), (18, 18, 18)))
                        ch = max(c.height for c in cells)
                        canvas = Image.new("RGB", (tw * cols, ch * rows), (18, 18, 18))
                        for idx, c in enumerate(cells[:6]):
                            canvas.paste(c, ((idx % cols) * tw, (idx // cols) * ch))
                        sp = os.path.join(args.out, "sheet-%02d.png" % n)
                        canvas.save(sp, quality=82)
                        sheet = sp
                except Exception as e:
                    print("[%d] 抽帧失败（不影响分享）：%s" % (n, str(e)[:60]), flush=True)

                # ★★ 录视频里的声音（WebAudio：AudioContext + MediaStreamDestination + MediaRecorder）
                #   为什么：光看帧只能"看到画面"，抖音的内容一半在台词里。
                #   实测这条路能拿到真声音（转 wav 后 RMS 5000+），
                #   再交给本地语音识别（SenseVoice）就真的"听懂"了。
                audio = ""
                # ★ 2026-10-29：默认不录音 —— 录音必须 muted=false（会真的出声），
                #   和"不想听到声音"冲突。音轨改由下游 fetchLinkVideo（下载后抽 wav）提供，
                #   质量更稳（不受播放进度/缓冲影响）。需要旧行为时加 --record-audio。
                try:
                    rec = await pg.evaluate(RECORD_JS, 4)        # 4 秒够听出在说什么
                    if rec and rec.get("b64"):
                        import base64 as _b64
                        webm = os.path.join(args.out, "a-%02d.webm" % n)
                        with open(webm, "wb") as f:
                            f.write(_b64.b64decode(rec["b64"]))
                        wav = os.path.join(args.out, "a-%02d.wav" % n)
                        try:
                            import imageio_ffmpeg, subprocess
                            ff = imageio_ffmpeg.get_ffmpeg_exe()
                            # ★ 必须加 -fflags +bitexact 等参数：
                            #   ffmpeg 默认会往 wav 里塞一个 LIST 块，导致 data 不在第 44 字节，
                            #   DSH 的语音识别会直接报 "Invalid speech WAV"（实测踩过 8 次全是这个）。
                            subprocess.run([ff, "-y", "-i", webm,
                                            "-ac", "1", "-ar", "16000",
                                            "-fflags", "+bitexact", "-flags", "+bitexact",
                                            "-map_metadata", "-1", "-write_bext", "0",
                                            "-f", "wav", wav],
                                           capture_output=True, timeout=60)
                            if os.path.exists(wav) and os.path.getsize(wav) > 2000:
                                audio = wav
                                print("      录音: %d KB" % (os.path.getsize(wav) // 1024), flush=True)
                            else:
                                print("      录音转 wav 失败/太小", flush=True)
                        except Exception as e:
                            print("      转 wav 失败: %s" % str(e)[:60], flush=True)
                    else:
                        print("      录音失败: %s" % str((rec or {}).get("err"))[:60], flush=True)
                except Exception as e:
                    if '__skip__' not in str(e):
                        print("      录音异常（不影响画面理解）: %s" % str(e)[:60], flush=True)
                # 截完再确认一次标题没变
                c = (await read_item(pg)).get("desc") or ""
                if c[:30] != b[:30]:
                    key = c[:30]
                    prev_desc = c
                    continue
                final_desc = c
                d3 = await read_item(pg)
                like = (d3.get("like") or like).strip()
                author = (d3.get("author") or author).strip()
                stable = True
                break
            if not stable:
                # 实在不稳定就跳过这条（宁缺毋滥，绝不发错位的图）
                print("[%d] 画面不稳定 → 跳过" % n, flush=True)
                await pg.keyboard.press("ArrowDown")
                await pg.wait_for_timeout(int(args.gap * 1000))
                continue
            # ★ 路线 A：把网络响应里抓到的元数据合进来（直链/话题/BGM/作者/点赞）
            meta = match_aweme(final_desc, n - 1) or {}
            if meta.get("playUrl"):
                print("      直链: %s…" % meta["playUrl"][:70], flush=True)
            items.append({
                "i": n,
                "desc": final_desc,
                "like": like or (str(meta.get("like")) if meta.get("like") else ""),
                "author": author or str(meta.get("author") or ""),
                "url": (d.get("url") or "").strip(),
                "shot": shot,
                "sheet": sheet,
                "audio": audio,
                "playUrl": str(meta.get("playUrl") or ""),
                "awemeId": str(meta.get("aweme_id") or ""),
                "tags": meta.get("tags") or [],
                "bgm": str(meta.get("bgm") or ""),
            })
            print("[%d/%d] %s | 赞 %s" % (n, args.count, final_desc[:60], like[:12]), flush=True)

            # ★ 取这条视频的分享链接（点分享 → 复制链接 → 读剪贴板）
            #   有了它，群里的人点开就能看；比"下载原视频"稳（抖音对下载限制很多，
            #   yt-dlp 又卡在 fresh cookies 上，实测都走不通）。
            try:
                # ★ 用坐标点（element.click 会被遮挡超时 ✗ 实测）
                shpos = await pg.evaluate("""() => {
                    const es = [...document.querySelectorAll('[data-e2e="video-player-share"]')];
                    for (const e of es) {
                        const b = e.getBoundingClientRect();
                        if (b.width > 8 && b.height > 8 && b.top > 0 && b.top < window.innerHeight) {
                            return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
                        }
                    }
                    return null;
                }""")
                if shpos:
                    await pg.mouse.move(shpos["x"] - 30, shpos["y"] - 20, steps=8)
                    await pg.wait_for_timeout(300)
                    await pg.mouse.click(shpos["x"], shpos["y"])
                    await pg.wait_for_timeout(1800)
                    pos = await pg.evaluate("""() => {
                        for (const e of document.querySelectorAll('div,span,button,li,a')) {
                            const t = String(e.innerText || '').trim();
                            if (t === '复制链接') {
                                const b = e.getBoundingClientRect();
                                if (b.width > 8 && b.height > 8) return {x: b.x + b.width / 2, y: b.y + b.height / 2};
                            }
                        }
                        return null;
                    }""")
                    if pos:
                        await pg.mouse.click(pos["x"], pos["y"])
                        await pg.wait_for_timeout(1200)
                        try:
                            clip = await pg.evaluate("() => navigator.clipboard.readText()")
                            import re as _re
                            m = _re.search(r"https://v\.douyin\.com/[A-Za-z0-9]+/?", str(clip or ""))
                            if m:
                                items[-1]["shareUrl"] = m.group(0)
                                print("      链接: %s" % m.group(0), flush=True)
                        except Exception as e:
                            print("      读剪贴板失败: %s" % str(e)[:50], flush=True)
                    # 关掉分享面板
                    try:
                        await pg.keyboard.press("Escape")
                    except Exception:
                        pass
                    await pg.wait_for_timeout(600)
            except Exception as e:
                print("      取链接失败（不影响其它）: %s" % str(e)[:60], flush=True)
            await pg.keyboard.press("ArrowDown")
            await pg.wait_for_timeout(int(args.gap * 1000))

        with open(os.path.join(args.out, "items.json"), "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=1)

        # ★ 自动清理旧批次：每次刷产出 ~30MB（帧+截图+录音+网格），
        #   不清理的话一天 360MB、一周 2.5GB（实测堆到过 202MB）。
        #   只保留最近 2 批（当前这批 + 上一批），更早的整目录删掉。
        try:
            base = os.path.dirname(os.path.abspath(args.out))
            dirs = [d for d in glob.glob(os.path.join(base, "batch-*")) if os.path.isdir(d)]
            dirs.sort(key=os.path.getmtime, reverse=True)
            cur = os.path.abspath(args.out)
            keep = set([cur] + dirs[:2])
            removed = 0
            for d in dirs:
                if os.path.abspath(d) not in keep:
                    shutil.rmtree(d, ignore_errors=True)
                    removed += 1
            if removed:
                print("清理旧批次：删了 %d 个目录（保留最近 2 批）" % removed, flush=True)
        except Exception as e:
            print("清理旧批次失败（不影响本次）:", str(e)[:60], flush=True)
        # 去重统计（按标题前 30 字）
        uniq = {x["desc"][:30] for x in items if x["desc"]}
        print("DONE: %d 条，不同标题 %d 个 → %s" % (len(items), len(uniq), os.path.join(args.out, "items.json")), flush=True)
        await ctx.close()
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
