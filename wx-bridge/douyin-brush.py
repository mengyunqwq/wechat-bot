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
    ap.add_argument("--gap", type=float, default=3.5, help="每条之间停顿秒数")
    ap.add_argument("--headless", action="store_true")
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
            args=["--disable-blink-features=AutomationControlled", "--mute-audio"],
            ignore_default_args=["--enable-automation"],
        )
        await ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined});")
        pg = ctx.pages[0] if ctx.pages else await ctx.new_page()
        print("打开抖音...", flush=True)
        await pg.goto("https://www.douyin.com/", wait_until="domcontentloaded", timeout=90000)
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
            items.append({
                "i": n,
                "desc": final_desc,
                "like": like,
                "author": author,
                "url": (d.get("url") or "").strip(),
                "shot": shot,
            })
            print("[%d/%d] %s | 赞 %s" % (n, args.count, final_desc[:60], like[:12]), flush=True)
            await pg.keyboard.press("ArrowDown")
            await pg.wait_for_timeout(int(args.gap * 1000))

        with open(os.path.join(args.out, "items.json"), "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=1)
        # 去重统计（按标题前 30 字）
        uniq = {x["desc"][:30] for x in items if x["desc"]}
        print("DONE: %d 条，不同标题 %d 个 → %s" % (len(items), len(uniq), os.path.join(args.out, "items.json")), flush=True)
        await ctx.close()
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
