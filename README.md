# dsh-tools-deepseek-media

Agent tools for DeepSeek OCR, ASR and TTS: recognize text in PDF and image files, transcribe WAV audio, and synthesize speech to a file.

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin exposing DeepSeek's media APIs — which DSH does not ship built-in — as three agent tools, plus a settings page.

## What it adds

| Tool | What it does | Limits enforced locally before any upload |
|---|---|---|
| `deepseek_ocr` | Recognize text in PDF / DOC(X) / PPT(X) / PNG / JPEG / WebP / GIF / BMP / TIFF; returns per-page text with `finish_reason` | ≤ 100 MiB, path must stay inside the workspace |
| `deepseek_asr` | Transcribe 16-bit PCM WAV or Ogg Opus speech (language auto-detected) | ≤ 8 MiB, ≤ 120 s, container validated from headers (no shell, no conversion) |
| `deepseek_tts` | Synthesize speech (voices `stella` / `tide`) and write a 24 kHz 16-bit WAV into the workspace | ≤ 10,000 billable characters (CJK counts double), ≤ 64 KiB body |

The tools are **hidden entirely** (not registered) when no `DEEPSEEK_API_KEY` is configured, and appear as soon as one is — including through a rotated key, because the credential is resolved fresh on every call.

## Settings page

Settings → **DeepSeek media** shows whether a key is configured and where it comes from, and can store or clear it through the DSH credentials service. The value itself is never displayed, logged, or returned by any route.

## Security posture

- The API endpoint is hardcoded to `https://api.deepseek.com/v1/tools` and asserted before every request; there is no base-URL override.
- The key is only read through `ctx.credentials` (with a launch-environment fallback), never from disk, never logged, never embedded in an error message, and never returned by a tool — failure text additionally passes a `sk-…` redaction pass.
- Every file path is resolved through the host's own `fs`/`workingDirectory` services and then pinned inside the session workspace by realpath containment: `../` traversal, absolute paths outside the workspace, and symlinks escaping the workspace all fail closed.
- Size/duration/billing limits are enforced locally before any upload or request is made.
- The settings routes only ever expose key *presence*; writes reject cross-origin `Origin` headers.
- No shell, no install-time scripts, no dynamic remote imports.

## Install

```
dsh plugin --profile <name> add github:oh-wang/dsh-tools-deepseek-media
```

Requires DSH ≥ 0.2.2-rc.1. Peer packages (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-credentials`, `@deepseek-ai/dsh-launch-environment`, `@deepseek-ai/schemastery`, `@deepseek-ai/cordis`) are provided by the host and declared as `peerDependencies` — nothing from DSH is re-bundled.

## Verified against the live API

Real calls captured during development (DSH `0.2.2-rc.1`, macOS arm64):

- **OCR** — `sample.png` (invoice-style test image), `purpose: text_recognition`:
  `{"page_count":1,"pages":[{"index":0,"text":"发票金额：人民币 1,280.00 元\n订单号 DS-20261117-0042\nInvoice total: 1280.00 CNY\nDeepSeek OCR 测试","finish_reason":"stop"}]}`
- **ASR** — 6.24 s WAV synthesized by the TTS endpoint itself (streaming `data` chunk with a `0xFFFFFFFF` size, which this plugin clamps instead of misreading as 89,000 s):
  `{"text":"你好，这是DeepSeek语音合成测试。今天是2026年11月17日。","duration_ms":6240}`
- **TTS** — 42 billable characters → `tts/20261118-014134-9613d2d8.wav` (178,604 bytes, RIFF PCM 16-bit), estimated cost ¥0.01, written to the session workspace and not played automatically.

A wrong key surfaces as `DeepSeek OCR failed (HTTP 401): Authentication Fails, Your api key: ****…` — the key fragment is masked by the server and redacted locally as well.

## License

MIT — see [LICENSE](LICENSE).
