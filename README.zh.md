# dsh-tools-deepseek-media

把 DeepSeek 的 OCR、语音识别与语音合成做成 agent 工具：识别 PDF 与图片文字、转写 WAV 音频、把文本合成为音频文件。

一个 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件，把 DSH 未内置的 DeepSeek 媒体 API 封装成三个 agent 工具，并附带设置页。

## 新增的工具

| 工具 | 功能 | 上传前本地强制的限制 |
|---|---|---|
| `deepseek_ocr` | 识别 PDF / DOC(X) / PPT(X) / PNG / JPEG / WebP / GIF / BMP / TIFF 的文字，逐页返回并带 `finish_reason` | ≤ 100 MiB，路径必须在工作区内 |
| `deepseek_asr` | 转写 16 位 PCM WAV 或 Ogg Opus 语音（语种自动检测） | ≤ 8 MiB、≤ 120 秒，直接从容器头校验（不 shell、不代转格式） |
| `deepseek_tts` | 语音合成（音色 `stella` / `tide`），把 24 kHz 16 位 WAV 写进工作区 | ≤ 10,000 计费字符（汉字按 2 计）、请求体 ≤ 64 KiB |

未配置 `DEEPSEEK_API_KEY` 时三个工具**完全不出现**（不注册）；配置后立即出现。凭据每次调用现解析，轮换 key 无需重启。

## 设置页

设置 → **DeepSeek 媒体**：显示 key 是否已配置及其来源，可通过 DSH 凭据服务保存或清除。key 的值从不显示、不进日志、不会被任何路由返回。

## 安全设计

- API 端点硬编码为 `https://api.deepseek.com/v1/tools`，每次请求前断言；没有 baseURL 覆盖入口。
- key 只经 `ctx.credentials` 读取（带启动环境兜底），绝不读凭据文件、不进日志、不进错误消息、不进工具返回值——失败文本额外做一层 `sk-…` 打码。
- 所有文件路径先走宿主自己的 `fs` / `workingDirectory` 服务，再用 realpath 包含性校验钉在工作区内：`../` 穿越、工作区外的绝对路径、逃逸出工作区的符号链接全部拒绝。
- 体积/时长/计费上限在发起上传或请求前本地拦截。
- 设置路由只暴露 key 的*存在性*；写操作拒绝跨站 `Origin`。
- 不 shell、无安装期脚本、不动态加载远程代码。

## 安装

```
dsh plugin --profile <name> add github:oh-wang/dsh-tools-deepseek-media
```

需要 DSH ≥ 0.2.2-rc.1。peer 包（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-launch-environment`、`@deepseek-ai/schemastery`、`@deepseek-ai/cordis`）由宿主提供，全部声明为 `peerDependencies`，不重复打包。

## 真实 API 实测记录

开发期间的真实调用（DSH `0.2.2-rc.1`，macOS arm64）：

- **OCR** — `sample.png`（发票样式测试图），`purpose: text_recognition`：
  `{"page_count":1,"pages":[{"index":0,"text":"发票金额：人民币 1,280.00 元\n订单号 DS-20261117-0042\nInvoice total: 1280.00 CNY\nDeepSeek OCR 测试","finish_reason":"stop"}]}`
- **ASR** — 6.24 秒 WAV（由 TTS 端点自己合成，data chunk 的 size 是流式的 `0xFFFFFFFF`，本插件按实际字节截断而不是误算成 89,000 秒）：
  `{"text":"你好，这是DeepSeek语音合成测试。今天是2026年11月17日。","duration_ms":6240}`
- **TTS** — 42 计费字符 → `tts/20261118-014134-9613d2d8.wav`（178,604 字节，RIFF PCM 16 位），估算费用 ¥0.01，写入会话工作区、不自动播放。

错 key 时错误形如 `DeepSeek OCR failed (HTTP 401): Authentication Fails, Your api key: ****…` —— key 片段由服务端打码，本地再打一层。

## 许可

MIT，见 [LICENSE](LICENSE)。
