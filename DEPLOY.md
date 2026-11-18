# 部署指南

> 面向「从零把这套机器人跑起来」的人。所有命令都在 **Windows PowerShell** 里执行。
> 文中 `D:\微信deepseek` 是**参考路径**，你可以换成任何位置，但要注意有个**中文路径相关的坑**（见 §7）。

---

## 0. 你会得到什么

一台自己跑的微信机器人，具备：

| 能力 | 说明 | 依赖 |
|---|---|---|
| 群聊对话 | 人格/记忆/情绪/主动冒泡 | 必装 |
| 语音收发 | 收语音转文字、发语音气泡（云端合成，约 3 秒） | 必装 + 可选云端 key |
| **唱歌** | 群里说「唱个 X」→ 扒 B 站音频 → 分离人声 → RVC 变声成她的声线 → 发语音条 | 可选（要 GPU） |
| 梗百科 | 群里冒出不懂的梗先查词库再接话 | 可选 |
| 表情包 | 收藏/生成/挑图发表情 | 必装 |
| 朋友圈 | AI 写内容 + 配图发布 | 必装 |
| 控制面板 | `/wechat-bot` 网页调所有参数 | 必装 |
| 自愈 | 桥挂了/客户端句柄过期 自动修 | 必装 |

---

## 1. 前置条件

### 1.1 系统

| 项 | 要求 | 说明 |
|---|---|---|
| 系统 | Windows 10/11 **64 位** | hook 是 x64 DLL，32 位不行 |
| 内存 | ≥ 16 GB | 微信 + node + python 同时在跑 |
| 磁盘 | ≥ 30 GB 空闲 | 唱歌要存 RVC 环境（约 6GB）+ 训练素材 |
| 显卡 | 可选，**唱歌需要** | 8GB 显存够用（实测 RTX 2060 SUPER 8G 跑得动） |

### 1.2 软件

| 软件 | 版本 | 用途 | 检查 |
|---|---|---|---|
| **Node.js** | **≥ 22.13**（推荐 24） | 桥 + 插件；`node:sqlite` 需要 22.13+ | `node -v` |
| **Python** | **3.11** | 唱歌工具链（yt-dlp / demucs / RVC） | `python -V` |
| **ffmpeg + ffprobe** | 任意近期版本 | 音频转码、SILK 编码前置 | `ffmpeg -version` |
| **DeepSeek Harness（DSH）** | 已装并可用 | 插件宿主 + 控制面板 | 能打开 `http://127.0.0.1:3080` |
| Visual Studio Build Tools | 可选 | 只有要自己编译 hook 才需要 | `MSBuild -version` |

> **ffmpeg 必须在 PATH 里**。仓库里的脚本会先查环境变量 `FFMPEG`，再查 PATH，最后查常见安装位置。

### 1.3 微信客户端

| 项 | 要求 |
|---|---|
| 版本 | **4.1.10.27**（hook 的偏移量是按这个版本定的，别的版本会崩） |
| 账号 | **必须用小号**，不绑支付、不加重要好友 |

> ⚠️ 封号风险真实存在：hook 属非官方协议。**绝不要在日常微信上跑**。

---

## 2. 装依赖

```powershell
# ① 桥的 Node 依赖
cd D:\微信deepseek\wx-bridge
npm install

# ② 唱歌用的 Python 依赖（不唱歌可跳过）
D:\Python311\python.exe -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple `
  yt-dlp demucs pillow
```

---

## 3. 准备独立的微信客户端

**不要动你日常那个微信。** 复制一份独立副本：

```powershell
# 找到已安装的微信（4.1.10.27）
# 复制整个目录到独立位置
robocopy "D:\Program Files\Tencent\Weixin" "D:\wxhook\wx4110" /E

# 确认目录里有 Weixin.exe
Test-Path D:\wxhook\wx4110\Weixin.exe
```

---

## 4. 拿到 hook（`version.dll`）

hook 是注入到微信进程里的 DLL，负责读数据库、发消息。

### 方案 A：直接编译（推荐）

```powershell
cd <hook 源码目录>\WeChat-Hook
# 用 VS2022 BuildTools 的 MSBuild
& "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe" `
  x64_Version_dll.sln -p:Configuration=Release -p:Platform=x64 -m

# 产物：x64\Release\version.dll
```

### 方案 B：GitHub Actions 构建

推代码后去 Actions 页面下载 artifact（`.github/workflows/build-hook.yml` 已配好）。

### 部署 DLL

用仓库自带脚本（**它会等数据库写入静止再结束进程，避免 WAL 损坏**）：

```powershell
cd D:\微信deepseek
powershell -ExecutionPolicy Bypass -File scripts\deploy-hook.ps1 `
  -Dll "E:\wxhook-src\WeChat-Hook\x64\Release\version.dll"
```

脚本会依次做：停桥 → 清队列 → **等 WAL 稳定（连续 3 次采样不变）** → 结束微信 → 备份旧 DLL → 替换 → 启动客户端（带端口参数）→ 登录 → 重启桥。

> **绝不要手动 `taskkill` 微信**。库正在写的时候强杀会损坏数据库（我们踩过，连续导致 6 次崩溃）。

---

## 5. 启动客户端 + 桥

### 5.1 客户端参数（必须带，否则收不到消息）

```powershell
Start-Process 'D:\wxhook\wx4110\Weixin.exe' -ArgumentList `
  'StartPort=30001','RecvType=1','CallBackURL=http://127.0.0.1:18998' `
  -WorkingDirectory 'D:\wxhook\wx4110'
```

### 5.2 桥

```powershell
cd D:\微信deepseek\wx-bridge
node server.mjs --transport=wechat-hook --api-port=30001 --cb-port=18998 `
  --data-dir=D:\微信deepseek\data --wechat=D:\wxhook\wx4110\Weixin.exe
```

> ⚠️ 两个**必踩的坑**：
> 1. `--transport=wechat-hook` **不能省**。默认值是 `wxhelper`（另一套已废弃链路），省了就连不上。
> 2. 参数只认 `--key=value`，**不能写 `--key value`**。

### 5.3 验证

```powershell
Invoke-RestMethod http://127.0.0.1:17300/api/pollStatus | Select polls,msgs,shard,consecFail
```

正常输出形如：

```
polls : 48
msgs  : 480
shard : message_0.db
consecFail : 0
```

`polls` 要持续增长；`msgs` 在有人说话时才涨。

---

## 6. 装 DSH 插件

插件本体在 `wechat-group-agent/`，通过 **junction + profile bundles** 挂进 DSH。

```powershell
# ① 建 junction（把插件目录链进 profile 的 node_modules）
$dest = "$env:USERPROFILE\.dsh\profiles\web\node_modules\@dsh-external\dsh-wechat-bot"
New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
cmd /c mklink /J "$dest" "D:\微信deepseek\wechat-group-agent"

# ② 登记到 profile（package.json 的 dsh.profile.bundles 里加一项）
#    "dsh-wechat-bot": "link:D:\\微信deepseek\\wechat-group-agent"
```

也可以直接用 DSH 的插件管理界面注入（若装了 `dsh-super-injector`）：

```
dev_install_package dir=D:\微信deepseek\wechat-group-agent profile=web
```

装好后打开控制面板：`<你的 DSH 地址>/wechat-bot`。

---

## 7. 配置（面板里点，或改 `config.json`）

配置文件：`%USERPROFILE%\.dsh\wechat-bot\config.json`

### 7.1 必配

| 键 | 示例 | 说明 |
|---|---|---|
| `bridgeUrl` | `ws://127.0.0.1:17300` | 桥地址 |
| `botName` | `蓝色大肥鱼` | 群里显示的名字 |
| `rooms` | `12345678@chatroom` | **群白名单**，不在里面不响应 |
| `memberNames` | `{"wxid_xxx":"小明"}` | 认人（面板「群与人」页可改） |

### 7.2 语音（可选，但强烈建议）

| 键 | 示例 | 说明 |
|---|---|---|
| `voiceSay` | `true` | 允许发语音气泡 |
| `voiceBackend` | `breeze-cloud` | 云端合成（约 3 秒、不占显存） |
| `voiceCloudVoice` | `voc_xxx` | 音色 id（云端控制台里建） |
| `voiceStyle` | `用居高临下的嘲讽语气说话…` | **自然语言描述说话方式**（官方推荐的写法） |
| `voiceSpeed` | `1.05` | 语速倍率 |
| `voiceGuidanceScale` | `4` | 贴合度（越低越松散自然） |
| `voiceFillerChance` | `0.5` | 语气词概率（`[哼]`/`[笑]`/`[叹气]`） |

云端 key 放在 `D:\微信deepseek\data\.breeze-key`（**不要进仓库**）。

### 7.3 梗百科（可选）

| 键 | 说明 |
|---|---|
| `memeWiki` | 总开关 |
| `memeWikiDb` | 词库路径（SQLite，6792 条） |
| `memeWikiBlocklist` | 语义冲突的条目（如「杂鱼」在库里是健身梗，要挡掉） |

词库来源：`thawline/dsh-memewiki`（82★）。装上那个插件后，词库在它的 `data/memes.db`。

### 7.4 唱歌（可选，要 GPU）

| 键 | 示例 | 说明 |
|---|---|---|
| `singEnabled` | `true` | 总开关 |
| `singPython` | `D:/Python311/python.exe` | 跑 yt-dlp/demucs 的 python |
| `singScript` | `D:/微信deepseek/data/sing.py` | 流水线脚本 |
| `singModel` | `E:/rvc/RVC/assets/weights/her2.pth` | RVC 模型 |
| `singIndex` | `E:/rvc/RVC/logs/her2/added_*.index` | 检索索引 |
| `singHerF0` | `309` | 她的音高基准（自动移调用） |
| `singTimeoutMin` | `25` | 整条流程超时 |

---

## 8. 唱歌环境（可选）

### 8.1 装 RVC

```powershell
# ① 建 venv（复用系统 torch 可以省 2.5GB 下载）
D:\Python311\python.exe -m venv E:\rvc\venv-rvc --system-site-packages

# ② 装 RVC 依赖（用国内镜像；注意 torch 要单独装 cu124 版，否则会被装成 CPU 版）
E:\rvc\venv-rvc\Scripts\python.exe -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple `
  -r E:\rvc\RVC\requirements.txt
E:\rvc\venv-rvc\Scripts\python.exe -m pip install `
  --index-url https://mirrors.nju.edu.cn/pytorch/whl/cu124 `
  "torch==2.6.0+cu124" "torchaudio==2.6.0+cu124"
```

> 新版 RVC **不再需要 fairseq**（已改用 transformers），Windows 上装得干净。

### 8.2 下载预训练模型

国内直连 `huggingface.co` 不通，用镜像：

```powershell
$base = 'https://hf-mirror.com/lj1995/VoiceConversionWebUI/resolve/main'
$dst  = 'E:\rvc\RVC\assets'
# hubert_base 要 transformers 目录格式（不是单个 .pt）
curl.exe -L "$base/hubert_base/config.json"             -o "$dst\hubert_base\config.json"
curl.exe -L "$base/hubert_base/preprocessor_config.json" -o "$dst\hubert_base\preprocessor_config.json"
curl.exe -L "$base/hubert_base/pytorch_model.bin"        -o "$dst\hubert_base\pytorch_model.bin"
curl.exe -L "$base/rmvpe.pt"                             -o "$dst\rmvpe\rmvpe.pt"
curl.exe -L "$base/pretrained_v2/f0G40k.pth"             -o "$dst\pretrained_v2\f0G40k.pth"
curl.exe -L "$base/pretrained_v2/f0D40k.pth"             -o "$dst\pretrained_v2\f0D40k.pth"
```

### 8.3 训练她自己的模型

素材要求：**干净的单一说话人录音 ≥ 10 分钟**（RVC 建议值；我们有 4.63 分钟也训出来了，但质量打折）。

```powershell
# ① 准备素材：放到 E:\rvc\dataset-her（wav，44.1k 或 16k 都行）
#    也可以用云端 TTS 批量生成（scripts/sing/gen-voice-corpus.py），
#    ⚠️ 但 TTS 音色必须和真实录音音高一致，否则会训成另一个人（我们踩过：TTS 239Hz vs 真实 309Hz）

# ② 一条命令跑完：切分 → 抽音高 → 抽特征 → 训练 → 建索引
$env:RVC_EXP='her'; $env:RVC_EPOCHS='400'
$env:RVC_DATASETS='E:/rvc/dataset-her'
D:\Python311\python.exe scripts\sing\rvc-train.py
```

> 训练完如果报 `assets/weights 不存在`，手动 `mkdir` 一下再跑
> `scripts\sing\rvc-export-model.py` 把检查点转成推理模型。

显存参考：8GB 卡用 `bs=4`、峰值得 5.4GB；**长音频必须分块**（`sing.py` 已按 45 秒自动分块，
一次转 2 分钟人声会被系统杀掉且不留报错）。

### 8.4 验证

```powershell
D:\Python311\python.exe D:\微信deepseek\data\sing.py --query "小跳蛙" `
  --model E:/rvc/RVC/assets/weights/her2.pth `
  --index E:/rvc/RVC/logs/her2/added_IVF289_Flat_nprobe_1_her2_v2.index `
  --out E:/rvc/sing-jobs/test/her-sing.wav
```

正常会看到：搜歌 → 测速挑节点 → 下载 → demucs 分离 → 自动移调 → 分块变声 → 混伴奏 → 切 58s → 编 SILK。

---

## 9. 自愈与监控

### 9.1 看门狗

`scripts/watchdog-wechat.ps1` 由插件每 5 分钟调一次，做这些事：

| 检查 | 动作 |
|---|---|
| 微信修复弹窗 | 自动点击「开始修复」 |
| 桥存活 | 死了就用 **VBS 无窗口启动器**拉起（完整 node 路径 + 起后自检重试 3 次） |
| 桥在跑但 `polls` 不涨 | 重启桥 |
| **消息库在写但 `msgs` 10 分钟不涨** | 判定 hook 句柄过期 → `deploy-hook` 重启客户端（限频 6 小时） |
| WAL 停摆 | **只在桥/轮询真异常时告警**（群安静不打扰） |

并发锁：60 秒内已有实例在跑就直接退出，避免重复重启。

### 9.2 日志位置

```
D:\微信deepseek\data\logs\bridge-YYYY-MM-DD.log     桥
D:\微信deepseek\data\logs\watchdog.log             看门狗
D:\微信deepseek\data\logs\deploy-hook.log          DLL 部署
D:\微信deepseek\data\logs\watchdog-state.json      状态（msgs/告警/重启时间）
%USERPROFILE%\.dsh\logs\...                         插件侧（或在 DSH 面板看）
```

---

## 10. 一键脚本速查

| 脚本 | 作用 |
|---|---|
| `scripts/start-bot.ps1` | 按正确参数拉起微信 + 桥 |
| `scripts/deploy-hook.ps1 -Dll <path>` | 换 DLL / 干净重启客户端（等 WAL 静止） |
| `scripts/watchdog-wechat.ps1 -LoopSec 0` | 手动跑一次自愈检查 |
| `scripts/check-panel-ops.mjs` | 校验面板用到的操作都在白名单 |
| `wechat-group-agent/scripts/test-all.mjs` | 插件单测（25 项） |
| `wechat-group-agent/build-client.mjs` | 从 `panel/index.html` 重新生成 `lib/client.js` |
| `scripts/sing/*.py` | 唱歌工具链（见 §8） |
| `scripts/push-via-api.mjs` | **github.com:443 不通时**用 Git Data API 推送 |

---

## 11. 已知的坑（都是实测踩出来的）

1. **中文路径**：`node:sqlite` 不认反斜杠，路径要用正斜杠；WMI 创建进程带中文 cwd 有时 `rc=8`。
2. **`--transport=wechat-hook` 不能省**，否则桥去连另一套已废弃适配层，`getContactList` 全部 fetch failed。
3. **不要 `taskkill` 微信**：库在写时强杀会损坏数据库。用 `deploy-hook.ps1`。
4. **消息库会搬家**：微信有时把 `db_storage\message_0.db` 移到 `db_storage\message\message_0.db`，
   hook 的句柄会指着旧文件 → 桥读到冻结快照（`polls` 涨、`msgs` 不涨、用户发什么她都不回）。
5. **B 站下载别用 yt-dlp 默认节点**：它取第一个候选地址，而那个常是 P2P 的 `mcdn`
   （实测 25 KiB/s vs 正规 `upos` 节点 3290 KiB/s）。用 `scripts/sing/bili-download.py` 自己挑。
6. **RVC 只换音色不改音高**：`--pitch 0` 时输出音高 = 输入音高。要贴合她的音域必须先测源 F0 再算移调。
7. **PowerShell 脚本要存 BOM**：无 BOM 会被 PowerShell 5.1 按 ANSI 读，中文全乱码、语法报错。
8. **VBS 启动器不要加 `cmd /c` 重定向**：引号会让 VBS 语法错误，`wscript` 会弹一堆报错对话框。
9. **插件是 ESM**：没有全局 `require`，要用 `createRequire(import.meta.url)` 才能同步 `require('node:sqlite')`。
10. **客户端会「活着但不写消息库」**：`message_0.db` 停写数小时，而 `contact.db`/`session.db` 照常写，
    桌面微信看着一切正常，但桥读到的是冻结库 → 用户发什么她都不回。
    实测两次都紧跟微信自己的增量备份（`*.material` 更新时间吻合）。
    判定：`message_0.db` mtime > 120 分钟 **且** `contact.db` mtime < 15 分钟 → 客户端消息写入冻结。
    看门狗已内置该检测，命中就 `deploy-hook` 重启客户端（限频 6 小时）。
    **别只看 `polls`**：它只证明桥在自转，不证明在读新数据；要看 `msgs` 有没有涨。

---

## 12. 排错

- 她不回复：先看桥 `pollStatus`（`polls`/`msgs`/`consecFail`），再看插件日志有没有 `决定回`。
- 收不到消息：查 `message_0.db` 的真实路径和 mtime（可能在 `message\` 子目录），见 §11.4。
- 唱歌失败：看 `E:\rvc\sing-jobs\<时间戳>\sing.log`，里面有每一步的退出码和错误尾部。
- 语音发不出：确认 SILK 文件路径**全是 ASCII 字符**（hook 用 ANSI 读文件，中文路径会"找不到"）。

更多：[docs/常见错误与排错.md](docs/常见错误与排错.md)、[docs/安装流程.md](docs/安装流程.md)
