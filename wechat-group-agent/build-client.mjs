#!/usr/bin/env node
/**
 * build-client.mjs —— 把 panel/index.html 打包成 lib/client.js（DSH 原生 UI 模块）
 *
 * 产物格式照抄 @dsh-external/dsh-super-injector 的 injector/lib/client.js（官网同款迁移法）：
 *   window.__ModuleLoader__.load({ id, factory(require) { ...; return module.exports } })
 *   exports.apply(ctx) 里往 DSH 界面的插槽（slots）注册 React 组件。
 *
 * 迁移策略（★ 2026-10-23 定）：**不重写页面**。
 *   index.html 是纯 DOM + 单 <script>，官方升级路径就是「DOM 构建逻辑与旧版一致，
 *   仅宿主槽渲染改为 React 容器」。所以这里把三段原样搬走：
 *     · <style>    → CSS 字符串（进 document.head）
 *     · <body> DOM → HTML 字符串（进 React 容器 innerHTML）
 *     · <script>   → JS 字符串（new Function 执行，基于 document 全局查找仍然成立）
 *   等哪天要逐页 React 化，再在这个壳里逐块替换。
 *
 * 用法：node build-client.mjs（在插件根目录跑；改完 index.html 重跑即可，无需重启）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SRC = join(ROOT, 'panel', 'index.html')
const OUT = join(ROOT, 'lib', 'client.js')

const html = readFileSync(SRC, 'utf8')

// ── 切分三段 ──────────────────────────────────────────────────────────
const styleM = html.match(/<style>([\s\S]*?)<\/style>/)
if (!styleM) { console.error('✗ 没找到 <style> 段'); process.exit(1) }
const css = styleM[1]

const bodyM = html.match(/<body>([\s\S]*?)<\/body>/)
if (!bodyM) { console.error('✗ 没找到 <body> 段'); process.exit(1) }
// DOM = body 里去掉 <script>
const dom = bodyM[1].replace(/<script>[\s\S]*?<\/script>/, '')

const jsM = html.match(/<script>([\s\S]*?)<\/script>/)
if (!jsM) { console.error('✗ 没找到 <script> 段'); process.exit(1) }
let js = jsM[1]

// ★ 清理句柄：原代码 setInterval 的返回值没存，React 卸载时清不掉。
//   这里把最后那个全局 setInterval(...) 改写成存进 window.__wxpanelTimers。
//   （只动这一行，append dark magic 是 build 期行为，index.html 本体不改）
js = js.replace(
  /setInterval\(\(\)\s*=>\s*refresh\(\{ lite:\s*true \}\),\s*10000\);/,
  `if (!window.__wxpanelTimers) window.__wxpanelTimers = [];\n` +
  `window.__wxpanelTimers.push(setInterval(() => refresh({ lite: true }), 10000));`
)

// ── JSON.stringify 转义：面板代码里有大量反引号模板串和 ${}，
//    直接嵌进模板字符串必炸；JSON 字面量最稳 ─────────────────────────
const CSS_LIT = JSON.stringify(css)
const HTML_LIT = JSON.stringify(dom)
const JS_LIT = JSON.stringify(js)

const out = `window.__ModuleLoader__.load({
\tid: "@dsh-external/dsh-wechat-bot",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
\t\tlet react = require("react");
\t\t//#region 由 build-client.mjs 从 panel/index.html 生成（勿手改，改 index.html 后重跑）
\t\tconst inject = ["slots"];
\t\tconst API_BASE_REL = "/wechat-bot";
\t\tconst PANEL_CSS = ${CSS_LIT};
\t\tconst PANEL_DOM = ${HTML_LIT};
\t\tconst PANEL_JS = ${JS_LIT};
\t\t/** 鲸鱼图标（侧栏入口）；不依赖 DSH primitives，避免缺包 */
\t\tfunction WechatBotIcon() {
\t\t\treturn react.createElement("span", { style: { fontSize: 16, lineHeight: 1 } }, "🐋");
\t\t}
\t\t/** 面板整页：React 空壳 + useEffect 里挂 DOM（super-injector 同款迁移法） */
\t\tfunction WechatBotPanel(props) {
\t\t\tconst onClose = props && props.onClose;
\t\t\tconst hostRef = react.useRef(null);
\t\t\treact.useEffect(() => {
\t\t\t\tconst root = hostRef.current;
\t\t\t\tif (!root) return;
\t\t\t\t// 告诉面板 CSS：「现在是被嵌进 DSH 的，别动宿主 body 布局」
\t\t\t\tdocument.body.classList.add("wx-embed-host");
\t\t\t\tconst styleEl = document.createElement("style");
\t\t\t\tstyleEl.setAttribute("data-wxpanel", "1");
\t\t\t\tstyleEl.textContent = PANEL_CSS;
\t\t\t\tdocument.head.appendChild(styleEl);
\t\t\t\troot.innerHTML = PANEL_DOM;
\t\t\t\ttry {
\t\t\t\t\tnew Function(PANEL_JS)();
\t\t\t\t} catch (e) {
\t\t\t\t\tconsole.error("[wechat-bot client] 面板脚本执行失败:", e);
\t\t\t\t\tconst msg = root.querySelector("#view");
\t\t\t\t\tif (msg) msg.textContent = "面板脚本加载失败：" + String(e) + "（原始页面仍可用：/wechat-bot）";
\t\t\t\t}
\t\t\t\t// 关闭按钮：只有嵌进 DSH 时才显示（独立打开无需关闭）
\t\t\t\tconst closeBtn = root.querySelector("#btn-close-panel");
\t\t\t\tif (closeBtn) {
\t\t\t\t\tcloseBtn.style.display = "";
\t\t\t\t\tcloseBtn.onclick = (ev) => {
\t\t\t\t\t\ttry { ev.preventDefault(); } catch (e) { }
\t\t\t\t\t\ttry { if (onClose) onClose(); } catch (e) { console.error("[wechat-bot client] close:", e); }
\t\t\t\t\t};
\t\t\t\t}
\t\t\t\treturn () => {
\t\t\t\t\t// React 卸载：停掉面板自己的轮询 timer + 移除注入的样式 + 还宿主 body 原样
\t\t\t\t\ttry { (window.__wxpanelTimers || []).forEach(clearInterval); } catch { }
\t\t\t\t\twindow.__wxpanelTimers = [];
\t\t\t\t\ttry { if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); } catch { }
\t\t\t\t\ttry { document.body.classList.remove("wx-embed-host"); } catch { }
\t\t\t\t};
\t\t\t}, []);
\t\t\treturn react.createElement("div", { ref: hostRef, className: "wx-panel-embed" });
\t\t}
\t\t//#endregion
\t\t//#region src/client/apply.ts —— 注册进 DSH 界面
\t\tfunction apply(ctx) {
\t\t\t// 关闭面板 = 把主视图切回默认（layout.selectPanel(null) → 渲染 conversation）。
\t\t\t// 优先 ctx.layout（ui-sidebar 就是这么用的），拿不到再 ctx.get('layout') 兜底。
\t\t\tconst closePanel = () => {
\t\t\t\ttry {
\t\t\t\t\tconst layout = (ctx && ctx.layout) || (ctx.get && ctx.get("layout"));
\t\t\t\t\tif (!layout || typeof layout.selectPanel !== "function") {
\t\t\t\t\t\tconsole.warn("[wechat-bot client] 找不到 layout 服务，无法关闭面板");
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\tlayout.selectPanel(null);
\t\t\t\t} catch (e) {
\t\t\t\t\tconsole.error("[wechat-bot client] layout.selectPanel:", e);
\t\t\t\t}
\t\t\t};
\t\t\t// ① 整页主视图（schedule 面板同款：main 槽 + key）
\t\t\tctx.effect(() => ctx.slots.inject("main", () => ctx.slots.register({
\t\t\t\tname: "main",
\t\t\t\tkey: "wechatbot",
\t\t\t\tinject: () => ({})
\t\t\t}, () => react.createElement(WechatBotPanel, { onClose: closePanel }))), "wechat-bot: main page");
\t\t\t// ② 侧栏入口（sidebar.panellist = 主视图面板列表；order 越小越靠前）
\t\t\tctx.effect(() => ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
\t\t\t\tname: "sidebar.panellist",
\t\t\t\tid: "wechatbot",
\t\t\t\torder: 90,
\t\t\t\tlabel: () => "微信机器人"
\t\t\t}, WechatBotIcon)), "wechat-bot: sidebar entry");
\t\t}
\t\t//#endregion
\t\texports.apply = apply;
\t\texports.inject = inject;
\t\treturn module.exports;
\t}
});
`

writeFileSync(OUT, out, 'utf8')
const kb = (out.length / 1024).toFixed(1)
console.log(`✓ lib/client.js 已生成：${kb}KB（CSS ${(css.length/1024).toFixed(1)}KB + DOM ${(dom.length/1024).toFixed(1)}KB + JS ${(js.length/1024).toFixed(1)}KB）`)
