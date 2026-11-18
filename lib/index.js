// dsh-tools-deepseek-media — host half.
//
// Registers three agent tools over DeepSeek's media APIs (OCR / ASR / TTS),
// which DSH does not ship built-in, plus a small HTTP surface the settings
// page uses to show key status and store/clear the key through the
// credentials service.
//
// Registration is conditional on a configured key: without one the three
// tools are entirely absent from the tool list rather than present-but-failing.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import z from "@deepseek-ai/schemastery";
import {
  API_BASE,
  ASR_MAX_BYTES,
  OCR_MAX_BYTES,
  TTS_MAX_BILLABLE_CHARS,
  TTS_MAX_BODY_BYTES,
  callAsr,
  callOcr,
  callTts,
  hasApiKey,
  resolveApiKey
} from "./api.js";
import { billableChars, estimatedTtsCostCny, ttsFileStem } from "./billing.js";
import { asrRejectReason, checkTtsWav } from "./wav.js";
import { ensureWorkspaceDir, resolveWorkspaceFile } from "./paths.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export const name = "dsh-tools-deepseek-media";

// Services this plugin needs from the host. `fs` and `workingDirectory` are
// the same seams the built-in read/write tools use, so path semantics match.
export const inject = ["tools", "credentials", "fs", "workingDirectory"];

// The single mutable setting is the TTS output folder (workspace-relative).
// `.volatile()` lets edits apply live via config.field.get() without restarts.
export const Config = z.object({
  ttsDir: z.string().default("tts").volatile()
});

const KEY_REF = credentialRef("DEEPSEEK_API_KEY");

/** Whether the three tools can run right now; checked fresh each step. */
function keyReady(ctx) {
  return () => hasApiKey(ctx, KEY_REF);
}

/** Build the content blocks a tool's output.render returns for the model. */
function textBlock(text) {
  return [{ type: "text", text }];
}

export function apply(ctx, config) {
  const credentials = ctx.get("credentials");

  // -- deepseek_ocr ---------------------------------------------------------
  ctx.tools.register(defineTool({
    name: "deepseek_ocr",
    description:
      "Recognize text in a document or image with DeepSeek OCR: PDF, DOC/DOCX, PPT/PPTX, PNG, JPEG, WebP, GIF, BMP or TIFF, up to 100 MiB and 1000 pages. " +
      "Pass the workspace-relative file path; returns per-page recognized text (layout markers and coordinates preserved as the model emits them). " +
      "Billed per successful page.",
    parameters: {
      file: { type: "string", required: true, description: "Workspace-relative path of the document or image to recognize" },
      purpose: {
        type: "string",
        enum: ["text_recognition", "rich_layout_recognition"],
        description: "text_recognition (default) extracts text and keeps native text layers; rich_layout_recognition renders every page as an image for layout-sensitive reading"
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          page_count: { type: "number", required: true },
          pages: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                index: { type: "number", required: true },
                text: { type: "string", required: true },
                finish_reason: { type: "string", required: true }
              }
            }
          }
        }
      },
      render: (args, value) => {
        const parts = value.pages.map((page) => {
          const truncated = page.finish_reason === "length" ? "  [page text truncated by the API]" : "";
          return `--- page ${page.index + 1} ---\n${page.text}${truncated}`;
        });
        return textBlock(`OCR result for ${args.file} (${value.page_count} page(s)):\n\n${parts.join("\n\n")}`);
      }
    },
    timeoutMs: 200_000, // the API itself allows up to 180 s per document
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const file = await resolveWorkspaceFile(ctx, exec, args.file);
      if (file.size !== undefined && file.size > OCR_MAX_BYTES) {
        throw new Error(`"${args.file}" is ${file.size} bytes; OCR accepts at most ${OCR_MAX_BYTES} bytes — split the document first`);
      }
      const apiKey = await resolveApiKey(ctx, KEY_REF);
      if (apiKey === undefined) throw new Error("no DeepSeek API key is configured; set one on the DeepSeek media tools settings page");
      const bytes = await file.read();
      const result = await callOcr(apiKey, bytes, path.basename(file.displayPath), args.purpose ?? "text_recognition", exec.signal);
      return { page_count: result.page_count, pages: result.pages };
    }
  }), { when: keyReady(ctx) });

  // -- deepseek_asr ---------------------------------------------------------
  ctx.tools.register(defineTool({
    name: "deepseek_asr",
    description:
      "Transcribe speech to text with DeepSeek ASR: 16-bit PCM WAV or Ogg Opus, mono/stereo, at most 8 MiB and 120 seconds of audio. " +
      "Language is detected automatically (zh/yue/en/ja/ko and 15 more). " +
      "Pass the workspace-relative file path; returns the transcript and audio duration.",
    parameters: {
      file: { type: "string", required: true, description: "Workspace-relative path of the audio file to transcribe" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", required: true },
          duration_ms: { type: "number", required: true }
        }
      },
      render: (args, value) => textBlock(
        `Transcript of ${args.file} (${(value.duration_ms / 1000).toFixed(1)} s):\n${value.text}`
      )
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const file = await resolveWorkspaceFile(ctx, exec, args.file);
      if (file.size !== undefined && file.size > ASR_MAX_BYTES) {
        throw new Error(`"${args.file}" is ${file.size} bytes; ASR accepts at most ${ASR_MAX_BYTES} bytes (${Math.round(ASR_MAX_BYTES / 1024 / 1024)} MiB) — trim or re-encode the audio first`);
      }
      const bytes = await file.read();
      const reject = asrRejectReason(bytes);
      if (reject !== null) throw new Error(`"${args.file}" is not usable for ASR: ${reject}`);
      const apiKey = await resolveApiKey(ctx, KEY_REF);
      if (apiKey === undefined) throw new Error("no DeepSeek API key is configured; set one on the DeepSeek media tools settings page");
      const result = await callAsr(apiKey, bytes, path.basename(file.displayPath), exec.signal);
      return {
        text: result.text,
        duration_ms: result.duration_ms ?? 0
      };
    }
  }), { when: keyReady(ctx) });

  // -- deepseek_tts ---------------------------------------------------------
  ctx.tools.register(defineTool({
    name: "deepseek_tts",
    description:
      "Synthesize speech from text with DeepSeek TTS and write the result to a workspace file. " +
      "At most 10,000 billable characters per call (CJK characters count as 2); produces up to 30 minutes of 24 kHz 16-bit mono WAV. " +
      "Voices: stella (female, default) and tide (male). Returns the written file path, billable character count and estimated cost. " +
      "Does not play audio and does not charge anything beyond synthesis.",
    parameters: {
      text: { type: "string", required: true, description: "Text to synthesize; Markdown is stripped for reading by default" },
      voice_id: {
        type: "string",
        enum: ["stella", "tide"],
        description: "stella (default) or tide"
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
          chars: { type: "number", required: true },
          estimated_cost_cny: { type: "number", required: true }
        }
      },
      render: (args, value) => textBlock(
        `Speech synthesized to ${value.path} (${value.chars} billable characters, estimated ¥${value.estimated_cost_cny.toFixed(2)}). ` +
        "The file was written to the workspace; play or share it as needed — it is not played automatically."
      )
    },
    timeoutMs: 300_000, // long texts legitimately synthesize for minutes
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const chars = billableChars(args.text);
      if (chars === 0) throw new Error("the text contains nothing pronounceable");
      if (chars > TTS_MAX_BILLABLE_CHARS) {
        throw new Error(`the text is ${chars} billable characters; TTS accepts at most ${TTS_MAX_BILLABLE_CHARS} per call — split the text and call again for each part`);
      }
      const body = {
        text: args.text,
        ...(args.voice_id !== undefined ? { voice_id: args.voice_id } : {})
      };
      const bodyBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
      if (bodyBytes > TTS_MAX_BODY_BYTES) {
        throw new Error(`the request body is ${bodyBytes} bytes; TTS accepts at most ${TTS_MAX_BODY_BYTES} — split the text and call again for each part`);
      }
      const apiKey = await resolveApiKey(ctx, KEY_REF);
      if (apiKey === undefined) throw new Error("no DeepSeek API key is configured; set one on the DeepSeek media tools settings page");
      const { bytes, declaredLength } = await callTts(apiKey, body, exec.signal);
      const wav = checkTtsWav(bytes, declaredLength);
      if (!wav.ok) throw new Error(`DeepSeek TTS audio is incomplete (${wav.reason}); nothing was written — try again`);

      const out = await ensureWorkspaceDir(ctx, exec, config.ttsDir.get());
      const filename = `${ttsFileStem(args.text, args.voice_id ?? "stella")}.wav`;
      const outPath = path.join(out.dir, filename);
      await writeFile(outPath, bytes);
      return {
        path: `${out.relName}/${filename}`,
        chars,
        estimated_cost_cny: estimatedTtsCostCny(chars)
      };
    }
  }), { when: keyReady(ctx) });

  // -- settings-page HTTP surface -------------------------------------------
  // Two routes for the client settings panel. They only ever expose key
  // *presence* (describe() never returns values) and accept a key to store.
  //
  // These go through `ctx.connection.fetch` rather than `ctx.webServer`
  // directly. That registry is the Host's authenticated surface: it applies
  // the Host/Origin fence *and* requires the launch-token browser cookie, so a
  // bare `curl` on the loopback port cannot reach the handler at all. An
  // earlier version registered on `webServer` and did its own Origin check,
  // which let a request with no `Origin` header (i.e. any local process)
  // rewrite the stored key. Using the Host's own fence removes that class of
  // mistake instead of re-deriving it.
  ctx.inject(["connection"], (conn) => {
    const noStore = { "cache-control": "no-store" };
    const json = (body, status = 200) => Response.json(body, { status, headers: noStore });
    const status = async () => {
      let configured = false;
      let source;
      let writable = false;
      if (credentials !== undefined) {
        try {
          const described = await credentials.describe(KEY_REF);
          configured = described?.configured === true;
          source = described?.source;
          writable = described?.writable === true;
        } catch { /* describe failures read as unconfigured */ }
      }
      if (!configured) {
        const ambient = launchEnvironmentApiKey(ctx);
        configured = ambient !== undefined;
        if (configured) source = "environment";
      }
      return { configured, source, writable, hasApiKey: configured };
    };

    /** Register one authenticated route, logging (never echoing) handler failures. */
    const route = (pathname, methods, fetchHandler) => conn.effect(() => conn.connection.fetch.register({
      path: pathname,
      methods,
      requestBody: "buffered",
      fetch: async (request) => {
        try {
          return await fetchHandler(request);
        } catch (error) {
          // Failure text is plugin-owned and already redacted; never echo bodies.
          ctx.logger.warn("deepseek-media: settings route failed: %s", error instanceof Error ? error.message : String(error));
          return json({ error: "internal error handling the settings request" }, 500);
        }
      }
    }));

    route("/dsh-deepseek-media/status", ["GET"], async () => json(await status()));

    route("/dsh-deepseek-media/credentials", ["POST"], async (request) => {
      if (credentials === undefined) {
        return json({ error: "the credentials service is unavailable in this deployment" }, 503);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "request body must be JSON" }, 400);
      }
      const apiKey = body?.apiKey;
      if (typeof apiKey !== "string") {
        return json({ error: "apiKey must be a string" }, 400);
      }
      const trimmed = apiKey.trim();
      if (trimmed === "") {
        await credentials.unset(KEY_REF);
      } else {
        // Empty values are rejected by the service itself; store only here.
        await credentials.set(KEY_REF, trimmed);
      }
      return json(await status());
    });
  });
}

/** Environment fallback read for status display only; never returns the value. */
function launchEnvironmentApiKey(ctx) {
  try {
    const ambient = launchEnvironmentOf(ctx).get(KEY_REF);
    return ambient !== undefined && ambient.value?.length > 0 ? ambient.value : undefined;
  } catch {
    return undefined;
  }
}
