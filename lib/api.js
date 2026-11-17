// DeepSeek media tools — the three `/v1/tools/*` API clients.
//
// Security posture (market hard requirements):
// - the endpoint host is hardcoded; there is no baseURL override anywhere;
// - the API key is resolved fresh for every call and is never logged, never
//   embedded in an error message, and never returned by a tool (error text
//   additionally runs through redactSecrets as belt-and-braces);
// - responses are validated, including the OCR quirk that recognition can
//   fail *after* the HTTP 200 by shipping an `error` object.

import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";

export const API_BASE = "https://api.deepseek.com/v1/tools";
const USER_AGENT = "dsh-tools-deepseek-media/0.1.0";
/** OCR caps the upload at 100 MiB; enforced locally before any upload. */
export const OCR_MAX_BYTES = 100 * 1024 * 1024;
/** ASR caps the upload at 8 MiB. */
export const ASR_MAX_BYTES = 8 * 1024 * 1024;
/** TTS caps the request body at 64 KiB. */
export const TTS_MAX_BODY_BYTES = 64 * 1024;
/** TTS bills at most 10,000 billable characters per request. */
export const TTS_MAX_BILLABLE_CHARS = 10000;

/**
 * Resolve the API key for exactly one call: credential store first, launch
 * environment second. Nothing is memoized, so a rotated key takes effect on
 * the next call without a restart.
 */
export async function resolveApiKey(ctx, ref) {
  const credentials = ctx.get("credentials");
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref);
    if (hit?.value) return hit.value;
  }
  const ambient = launchEnvironmentOf(ctx).get(ref);
  return ambient !== undefined && ambient.value?.length > 0 ? ambient.value : undefined;
}

/**
 * Whether a key is present (never returns the value). Used by the tools'
 * registration condition and the settings route.
 */
export async function hasApiKey(ctx, ref) {
  const credentials = ctx.get("credentials");
  if (credentials !== undefined) {
    try {
      if ((await credentials.describe(ref)).configured === true) return true;
    } catch { /* unreadable store: fall back to the launch environment */ }
  }
  const ambient = launchEnvironmentOf(ctx).get(ref);
  return ambient !== undefined && ambient.value?.length > 0;
}

/** Defense in depth: strip anything shaped like a key out of failure text. */
function redactSecrets(text) {
  return String(text).replace(/sk-[A-Za-z0-9_-]{4,}/g, "[redacted]");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build one failure Error carrying only status + server message. */
async function httpError(response, what) {
  let detail = "";
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      if (isRecord(parsed)) {
        const message = isRecord(parsed.error) ? parsed.error.message : parsed.message;
        if (typeof message === "string" && message.length > 0) detail = `: ${message}`;
      }
    } catch {
      if (text.length > 0) detail = `: ${text.slice(0, 200).trim()}`;
    }
  } catch { /* body already consumed or unreadable; status is enough */ }
  return new Error(redactSecrets(`DeepSeek ${what} failed (HTTP ${response.status})${detail}`));
}

/** Attach auth + UA headers and a hard-coded host assertion to every call. */
function requestInit(apiKey, headers, signal) {
  const url = new URL(API_BASE);
  if (url.protocol !== "https:" || url.hostname !== "api.deepseek.com") {
    throw new Error("refusing to send: the API endpoint is not the hardcoded api.deepseek.com host");
  }
  return {
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "user-agent": USER_AGENT,
      ...headers
    },
    signal
  };
}

/**
 * OCR one document. `bytes` and `filename` come from a workspace-resolved
 * file; the server sniffs the format from content, so no MIME guessing here.
 */
export async function callOcr(apiKey, bytes, filename, purpose, signal) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), filename);
  form.append("purpose", purpose);
  const response = await fetch(`${API_BASE}/ocr`, {
    ...requestInit(apiKey, { accept: "application/json" }, signal),
    method: "POST",
    body: form
  });
  if (!response.ok) throw await httpError(response, "OCR");
  // A 200 can still carry a failure: recognition errors arrive as JSON with
  // an `error` object after the upload phase completed.
  const payload = await response.json();
  if (isRecord(payload) && isRecord(payload.error)) {
    const message = typeof payload.error.message === "string" ? payload.error.message : "unrecognized document";
    throw new Error(redactSecrets(`DeepSeek OCR failed: ${message}`));
  }
  if (!isRecord(payload) || !Array.isArray(payload.pages)) {
    throw new Error("DeepSeek OCR returned an unrecognized response body");
  }
  return {
    page_count: typeof payload.page_count === "number" ? payload.page_count : payload.pages.length,
    pages: payload.pages.map((page) => ({
      index: typeof page?.index === "number" ? page.index : 0,
      text: typeof page?.text === "string" ? page.text : "",
      finish_reason: typeof page?.finish_reason === "string" ? page.finish_reason : "unknown"
    })),
    usage: isRecord(payload.usage) ? payload.usage : undefined
  };
}

/** Synthesize speech; resolves with the raw WAV bytes. `body` is the request object. */
export async function callTts(apiKey, body, signal) {
  const response = await fetch(`${API_BASE}/tts`, {
    ...requestInit(apiKey, { "content-type": "application/json", accept: "audio/wav" }, signal),
    method: "POST",
    // Serialize here exactly once: the caller passes the request object, so a
    // second stringify upstream can never double-encode the JSON body.
    body: JSON.stringify(body)
  });
  if (!response.ok) throw await httpError(response, "TTS");
  const declared = response.headers.get("content-length");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("DeepSeek TTS returned an empty audio body; treat this as a failed synthesis");
  }
  return { bytes, declaredLength: declared === null ? undefined : Number(declared) };
}

/** Transcribe one audio file. */
export async function callAsr(apiKey, bytes, filename, signal) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), filename);
  const response = await fetch(`${API_BASE}/asr`, {
    ...requestInit(apiKey, { accept: "application/json" }, signal),
    method: "POST",
    body: form
  });
  if (!response.ok) throw await httpError(response, "ASR");
  const payload = await response.json();
  if (!isRecord(payload) || typeof payload.text !== "string") {
    throw new Error("DeepSeek ASR returned an unrecognized response body");
  }
  return {
    text: payload.text,
    duration_ms: typeof payload.duration_ms === "number" ? payload.duration_ms : undefined,
    request_id: typeof payload.request_id === "string" ? payload.request_id : undefined
  };
}
