# 轮询硬闸修复（A/B/C）— 2026-10-25

## A. 看门狗治根

`wx-bridge/server.mjs` L368-378：
- 检测 `poller.hardStopped()`
- 硬闸时调 `bridge.restartPoller()`（resume + startPoller），10 分钟冷却
- 之前调 `init()`（不清硬闸）→ 永久失聪

## B. 自检防掩盖

`wechat-group-agent/lib/index.js` L3506：
- 检查 `br.hardStopped`（桥 status 返回）
- 硬闸 → `pollLevel = 'bad'` + 恢复命令提示
- 之前只查「库可读」→ 硬闸时全绿

## C. 自动拉起

- `data/ensure-wechat.ps1`：常驻循环，每 5 分钟检查微信进程（没进程才拉起，绝不杀）
- `启动文件夹\WeChatBotClient.lnk`：登录自启
- 守护进程：手动启动（pid 57092）

## 生效条件

- A/B 需要重启 bridge（node server.mjs）
- C 需要登录/重启才会自启（当前已手动启动守护）

## 关联文档

- `微信机器人-收不到消息-故障分析.md`（根因分析）