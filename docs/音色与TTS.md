# 音色（TTS）与原样还原

> 2026-10-27 事故：另一个 AI 把音色换成"御姐"，面板看起来一切正常却悄悄变声。
> 本文记录**音色由什么决定**、正确配置是什么、怎么还原。

## 谁决定声音

```
tts-silk.py  ──POST /tts──▶  GPT-SoVITS api_v2 (127.0.0.1:9880)
                                │
                                ├─ t2s_weights_path  语义模型（pretrained s1）
                                └─ vits_weights_path **音色模型 ← 声音就是它决定的**
         请求体里还有 ref_audio_path + prompt_text（zero-shot 参考，微调模型下影响很小）
```

**关键结论**：决定音色的是 `vits_weights_path`。`ref_audio_path` 只是参考片段；
插件配置里的 `voicePreset`（雌小鬼·A/B/C/D）**只影响 rate / pitch，不影响音色**。

所以"面板显示雌小鬼·A，声音却变了"是可能的 —— 这就是那次事故。

## 正确配置（大肥鱼 = 雌小鬼音色包）

文件：`D:\微信deepseek\data\GPT-SoVITS\GPT_SoVITS\configs\tts_infer.yaml` 的 `custom` 段：

```yaml
custom:
  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large
  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base
  device: cuda
  is_half: true
  t2s_weights_path: "D:\\微信deepseek\\data\\GPT-SoVITS\\GPT_SoVITS\\pretrained_models\\gsv-v2final-pretrained\\s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"
  version: v2
  vits_weights_path: "D:/微信deepseek/data/voice-pack/G_final.pth"
```

- 音色权重：`data\voice-pack\G_final.pth`（106MB，训练版 12 轮，见 `data\voice-pack\README.md`）
- 语义模型：pretrained 的 s1（voice-pack README 指定的搭配）
- 参考音：`data\sexy-loli-cn\separated\htdemucs\【中文音声】许久未见的雌小鬼，向你表达爱意\cn-a.wav`
  （与 `data\voice-pack\cn-a.wav` 同一个 10 秒片段，480078 字节）
- prompt：`就像是一根被流酸泡过的麻辣秋衣一样这么久不见，大哥哥有没有想我呀`

参考音和 prompt 的默认值在 `wx-bridge/tts-silk.py` 的 `synth_mp3()` 里，可用环境变量
`GPT_SOVITS_REF` / `GPT_SOVITS_PROMPT` 覆盖（两者当前都是空的）。

## 怎么确认现在用的是哪个模型

**服务端日志**（插件启动 api_v2 时会写）：

```
data\logs\tts-api.log
Loading VITS weights from D:/微信deepseek/data/voice-pack/G_final.pth. <All keys matched successfully>
```

**面板**：语音页 TTS 卡片的状态行会显示 `音色模型：G_final.pth`（从上面那行日志解析）。

**桥日志**：每次合成 `TTS：main → N 字节`；插件的合成结果 JSON 里还有
`voiceRef = { refName, refFrom }`，能看出用的哪个参考音。

## 还原步骤

1. 改 `tts_infer.yaml` 的 `custom.vits_weights_path` 为上表的值
2. 面板「语音」页 → TTS 服务 → **重启**（或手动 kill api_v2 后重新拉起）
3. 点「试合成」确认成功
4. 看 `data\logs\tts-api.log` 里 `Loading VITS weights from` 是不是 `G_final.pth`

## 换音色时的正确做法

- ❌ 别直接改 `tts_infer.yaml` 就完事 —— 面板完全看不出来，会"悄悄变声"
- ✅ 换完必须重启 api_v2 并在面板/日志里确认 `音色模型：xxx` 变了
- ✅ 换之前把 `tts_infer.yaml` 复制一份带日期的备份（同目录 `*.bak-<名字>-<时间>`）
- ✅ 在提交信息/文档里写清楚换了哪个权重

## 相关资产位置（都还在，没删）

| 路径 | 说明 |
|---|---|
| `data\voice-pack\G_final.pth` + `cn-a.wav` + `README.md` | **大肥鱼（雌小鬼）音色包**，当前在用 |
| `data\GPT-SoVITS\output\mesugaki\` | 雌小鬼训练中间产物（无 .pth） |
| `data\GPT-SoVITS\output\yujie\` | 御姐模型（2026-10-27 别的 AI 做的） |
| `data\voice\yujie-ref.wav` | 御姐参考音 |
| `data\GPT-SoVITS\GPT_SoVITS\configs\tts_infer.yaml.bak-yujie*` | 御姐配置备份 |
