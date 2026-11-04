# @dsh-external/dsh-wechat-bot

微信拟人化群聊机器人：连接 wx-bridge（WeChatFerry hook）实时收消息，按拟人策略（被@/提及优先、泛聊低概率插话、随机打字延迟、安静时段、限流）调用 LLM 生成口语化回复，收藏群友表情包并回发

由 dsh-super-injector dev_scaffold_plugin 生成。

## Web 控制面板

插件内置 `/wechat-bot` 控制台（挂在 DSH 已有的 webServer 上，不需要另起进程）：

- `lib/panel.mjs`：路由 + JSON API（state/config/action/logs/export/import），复用 DSH 登录栅栏
- `lib/panel-meta.mjs`：100+ 配置项的分组/标签/范围/风险元数据（面板界面与校验共用）
- `panel/index.html`：单文件前端（内联 CSS/JS，零构建）
- 动作白名单：发文字/语音/表情、拍一拍、自检、记忆、群成员、图库；高风险动作要求 confirm
- 模型接口：读写 DSH 的 pi-ai provider 设置（`settings.describe/update`）+ 凭据库（`credentials.set`），
  支持 Claude/GPT/DeepSeek/Grok/GLM/Qwen/Kimi/MiMo 等；保存即注册路由
- 图像接口：读写 `data/image-gen.json`，支持 Agnes / OpenAI 兼容两种请求格式

改完 `dev_reload_package dsh-wechat-bot` 即生效（面板模块用 `?t=` 动态 import，避免 ESM 缓存导致旧页面）。

## 构建与注入

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh
# 注入器环境内：dev_inject_plugin <本目录>
```
