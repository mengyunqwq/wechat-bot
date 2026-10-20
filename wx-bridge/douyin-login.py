#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
抖音扫码登录（只需跑一次）。

为什么需要独立 profile：
  · 抖音会检测"受控浏览器"，headless 直接给验证码中间页 → 必须有头模式
  · 用独立 profile（data/douyin-profile）就不必占用你日常用的 Edge，
    两个浏览器互不干扰，你关不关自己的 Edge 都行
  · 登录一次后，douyin-brush.py 直接复用这个登录态

用法：
  python douyin-login.py
  python douyin-login.py --profile D:\\path\\to\\profile

流程：
  1. 打开一个可见的 Edge 窗口，进 douyin.com
  2. 你用手机抖音 App 扫码
  3. 本脚本检测到登录 cookie（sessionid / sid_tt）就提示成功，并保持 30 秒让 profile 落盘
  4. 之后可以直接跑 douyin-brush.py
"""

import argparse
import asyncio
import os
import sys

PROF_DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "douyin-profile")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default=PROF_DEFAULT)
    ap.add_argument("--timeout", type=int, default=600, help="最多等多少秒（默认 600）")
    args = ap.parse_args()

    os.makedirs(args.profile, exist_ok=True)
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=args.profile,
            channel="msedge",            # ★ 用系统 Edge，不用 playwright install chromium
            headless=False,              # ★ 必须有头，否则抖音给验证码页
            viewport={"width": 1280, "height": 900},
            locale="zh-CN",
            args=["--disable-blink-features=AutomationControlled", "--mute-audio"],
            ignore_default_args=["--enable-automation"],
        )
        await ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined});")
        pg = ctx.pages[0] if ctx.pages else await ctx.new_page()

        # 已经登录过就直接说
        ck = await ctx.cookies()
        names = {c.get("name") for c in ck}
        if {"sessionid", "sid_tt"} & names:
            print("这个 profile 已经登录过了 ✓（不用重扫）")
            print("  如果抖音上显示未登录，删掉 profile 重跑本脚本")
            await ctx.close()
            return 0

        print("打开抖音...", flush=True)
        await pg.goto("https://www.douyin.com/", wait_until="domcontentloaded", timeout=90000)
        await pg.wait_for_timeout(6000)
        print("★ 窗口已打开，请用手机抖音 App 扫码登录（右上角「扫一扫」）", flush=True)
        print("  最多等 %d 秒；登录成功后会自动提示" % args.timeout, flush=True)

        waited = 0
        while waited < args.timeout:
            await asyncio.sleep(10)
            waited += 10
            try:
                ck = await ctx.cookies()
                names = {c.get("name") for c in ck}
                hit = {"sessionid", "sessionid_ss", "sid_tt"} & names
                if hit:
                    print("✓ 登录成功！检测到 cookie：%s" % ", ".join(sorted(hit)), flush=True)
                    print("  保持 30 秒让 profile 落盘…", flush=True)
                    await asyncio.sleep(30)
                    print("✓ 已保存到：%s" % args.profile, flush=True)
                    await ctx.close()
                    return 0
                if waited % 60 == 0:
                    print("  ...已等 %d 秒，还没登录" % waited, flush=True)
            except Exception as e:
                print("  轮询异常：%s" % str(e)[:80], flush=True)

        print("✗ 超时没等到登录（窗口保持打开也可以继续扫，或重跑本脚本）", flush=True)
        await ctx.close()
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
