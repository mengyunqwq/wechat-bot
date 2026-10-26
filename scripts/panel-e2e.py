"""面板 E2E：用 DSH 的 browser-session secret 现签 cookie，headless Edge 打开 /wechat-bot，
逐页点一遍，收集 JS 错误并截图。仅本机自测用。"""
import asyncio, base64, hashlib, hmac, json, re, sys, time
from pathlib import Path
from playwright.async_api import async_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOME = Path(r"D:\dsh\data")
OUT = Path(r"D:\微信deepseek\scripts")

def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

def load_secret() -> str:
    text = (HOME / ".credentials.yaml").read_text(encoding="utf-8")
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if re.match(r"^\s*client-connection/browser-session:\s*$", line):
            for j in range(i + 1, min(i + 8, len(lines))):
                m = re.match(r"^\s*secret:\s*(\S+)\s*$", lines[j])
                if m:
                    return m.group(1)
    raise RuntimeError("secret not found")

secret = load_secret()
authority = "127.0.0.1:3080"
name = "dsh-auth-" + b64u(hashlib.sha256(authority.encode()).digest())
now = int(time.time() * 1000)
payload = {"version": 1, "authority": authority, "issuedAt": now, "expiresAt": now + 3600_000}
body = b64u(json.dumps(payload, separators=(",", ":")).encode())
key = base64.urlsafe_b64decode(secret + "=" * (-len(secret) % 4))
sig = b64u(hmac.new(key, body.encode(), hashlib.sha256).digest())
cookie = f"v1.{body}.{sig}"

TABS = ["overview", "features", "providers", "reply", "proactive", "style", "sticker", "senses", "voice", "memory", "identity", "model", "ops", "manual"]

async def main():
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        ctx = await browser.new_context(viewport={"width": 1280, "height": 960})
        await ctx.add_cookies([{"name": name, "value": cookie, "domain": "127.0.0.1", "path": "/"}])
        page = await ctx.new_page()
        page.on("console", lambda m: errors.append(f"console[{m.type}]: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        await page.goto("http://127.0.0.1:3080/wechat-bot", wait_until="networkidle")
        await page.wait_for_timeout(1200)
        print("title:", await page.title())
        print("h2:", await page.inner_text("h2"))
        print("banner:", (await page.inner_text("#banner")).strip()[:120])
        tables = page.locator("table")
        if await tables.count():
            print("overview rooms:", (await tables.first.inner_text())[:200].replace("\n", " | "))
        await page.screenshot(path=str(OUT / "panel-01-overview.png"), full_page=True)

        for tab in TABS[1:]:
            await page.click(f'a[data-tab="{tab}"]')
            await page.wait_for_timeout(500)
            h2 = await page.inner_text("h2")
            n_fields = await page.locator(".field").count()
            n_cards = await page.locator(".card").count()
            print(f"tab={tab} h2={h2!r} fields={n_fields} cards={n_cards}")
            if tab in ("features", "reply", "senses", "voice", "identity", "ops"):
                await page.screenshot(path=str(OUT / f"panel-{tab}.png"), full_page=True)

        # 模型接口页：卡片渲染 + 真实测试 deepseek 路由        await page.click('a[data-tab="providers"]')
        await page.wait_for_timeout(1800)
        print("providers cards:", await page.locator('.card').count())
        await page.screenshot(path=str(OUT / "panel-providers.png"), full_page=True)
        try:
            await page.select_option('#test-provider', 'deepseek')
            await page.fill('#test-model', 'deepseek-chat')
            await page.click('#btn-provider-test')
            await page.wait_for_timeout(4000)
            print("provider test:", (await page.inner_text('#test-out'))[:160].replace("\n", " | "))
        except Exception as e:
            print("provider test skipped:", e)

        # 功能开关 UI：识表情包 关 → 开
        await page.click('a[data-tab="features"]')
        await page.wait_for_timeout(300)
        await page.locator('.fcard[data-f="visionEmoticon"] .sw').click()
        await page.wait_for_timeout(900)
        st = await page.evaluate("fetch('/wechat-bot/api/state').then(r => r.json())")
        print("toggle off -> visionOnEmoticon:", st["config"]["visionOnEmoticon"])
        await page.locator('.fcard[data-f="visionEmoticon"] .sw').click()
        await page.wait_for_timeout(900)
        st = await page.evaluate("fetch('/wechat-bot/api/state').then(r => r.json())")
        print("toggle on  -> visionOnEmoticon:", st["config"]["visionOnEmoticon"])

        # 数值框：replyProbability 0.8 → 0.75 → 0.8
        await page.click('a[data-tab="reply"]')
        await page.wait_for_timeout(300)
        num = page.locator('input.num[data-k="replyProbability"]')
        await num.fill('0.75')
        await page.wait_for_timeout(1200)
        st = await page.evaluate("fetch('/wechat-bot/api/state').then(r => r.json())")
        rng = await page.locator('input[type=range][data-range="replyProbability"]').input_value()
        print("num 0.75 -> config:", st["config"]["replyProbability"], "range:", rng)
        await num.fill('0.8')
        await page.wait_for_timeout(1200)
        st = await page.evaluate("fetch('/wechat-bot/api/state').then(r => r.json())")
        print("num restore -> config:", st["config"]["replyProbability"])

        # 运维页：导出下载 + 日志读取（只读）
        await page.click('a[data-tab="ops"]')
        await page.wait_for_timeout(500)
        async with page.expect_download() as dl_info:
            await page.click('#btn-export')
        dl = await dl_info.value
        print("export download:", dl.suggested_filename)
        await page.click('#btn-log')
        await page.wait_for_timeout(1200)
        print("logs:", (await page.inner_text('#logbox'))[:100].replace("\n", " | "))

        # 记忆页：只读读取一次某个群的长期记忆
        await page.click('a[data-tab="memory"]')
        await page.wait_for_timeout(1500)
        await page.click('#btn-mem-load')
        await page.wait_for_timeout(1500)
        print("memory:", (await page.inner_text('#mem-list'))[:160].replace("\n", " | "))
        st = await page.evaluate("fetch('/wechat-bot/api/state?lite=1').then(r => r.json())")
        print("rooms after memory view:", len(st.get("rooms") or []))

        # 表情包页：只读加载图库
        await page.click('a[data-tab="sticker"]')
        await page.wait_for_timeout(400)
        await page.click('#btn-stickers')
        await page.wait_for_timeout(1500)
        print("stickers:", (await page.inner_text('#sticker-list'))[:120].replace("\n", " | "))

        # 布局体检：桌面 + 手机宽度都不应该横向溢出
        for w, h, tag in [(1280, 960, "desktop"), (390, 844, "mobile")]:
            await page.set_viewport_size({"width": w, "height": h})
            await page.click('a[data-tab="overview"]')
            await page.wait_for_timeout(400)
            m = await page.evaluate("({sw:document.documentElement.scrollWidth, iw:window.innerWidth, bw:document.body.scrollWidth})")
            print(f"layout {tag}: scrollWidth={m['sw']} innerWidth={m['iw']} body={m['bw']}")
            if tag == "mobile":
                await page.screenshot(path=str(OUT / "panel-mobile.png"), full_page=True)

        # 手动操作页：搜索结果里应显示人名，而不是 wxid
        await page.click('a[data-tab="manual"]')
        await page.wait_for_timeout(1200)
        try:
            await page.select_option('#q-room', '47390425951@chatroom')
            await page.click('#btn-search')
            await page.wait_for_timeout(3000)
            print("search result:", (await page.inner_text('#q-result'))[:220].replace("\n", " | "))
        except Exception as e:
            print("search skipped:", e)

        # 回到总览，测一次自检（真实只读检查）
        await page.set_viewport_size({"width": 1280, "height": 960})
        await page.click('a[data-tab="overview"]')
        await page.wait_for_timeout(300)
        await page.click("#btn-check")
        await page.wait_for_timeout(9000)
        health = await page.inner_text("#health-list")
        print("selfcheck:", health[:200].replace("\n", " | "))

        print("ERRORS:", json.dumps(errors, ensure_ascii=False, indent=1) if errors else "none")
        await browser.close()

asyncio.run(main())
