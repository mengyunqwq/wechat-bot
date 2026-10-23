# @dsh-external/dsh-wechat-bot

微信拟人化群聊机器人：连接 wx-bridge（WeChatFerry hook）实时收消息，按拟人策略（被@/提及优先、泛聊低概率插话、随机打字延迟、安静时段、限流）调用 LLM 生成口语化回复，收藏群友表情包并回发

由 dsh-super-injector dev_scaffold_plugin 生成。

## 构建与注入

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh
# 注入器环境内：dev_inject_plugin <本目录>
```
