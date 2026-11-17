// DeepSeek media tools — WAV / Ogg Opus container checks.
//
// The ASR endpoint accepts only 16-bit PCM WAV or Ogg Opus, and the TTS
// endpoint streams a WAV whose data chunk may be truncated when synthesis
// fails mid-flight. Both facts are checked locally from container headers,
// without shelling out to ffprobe or afconvert.

/** Sample rates the ASR endpoint accepts for WAV input. */
export const WAV_SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000];

/** ASR audio-length cap in milliseconds. */
export const ASR_MAX_DURATION_MS = 120_000;

/** Whether the bytes start with an Ogg container whose first codec is Opus. */
export function looksLikeOggOpus(bytes) {
  if (bytes.length < 4 || bytes.toString("ascii", 0, 4) !== "OggS") return false;
  // The Opus identification header ("OpusHead") sits in the first page
  // payload, after the 27-byte page header + 1 segment byte.
  return bytes.length >= 36 && bytes.toString("ascii", 28, 36) === "OpusHead";
}

/**
 * Parse a little-endian RIFF/WAVE header walk.
 * @returns {null | {
 *   formatCode: number, channels: number, sampleRate: number, bitsPerSample: number,
 *   dataBytes: number, declaredFileBytes: number, durationMs: number
 * }} null when the bytes are not a structurally valid WAV.
 */
export function parseWav(bytes) {
  if (bytes.length < 12) return null;
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return null;
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const dv = new DataView(view);
  const declaredFileBytes = dv.getUint32(4, true);
  let fmt = null;
  let dataBytes = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = dv.getUint32(offset + 4, true);
    if (id === "fmt " && size >= 16 && offset + 8 + 16 <= bytes.length) {
      fmt = {
        formatCode: dv.getUint16(offset + 8, true),
        channels: dv.getUint16(offset + 10, true),
        sampleRate: dv.getUint32(offset + 12, true),
        bitsPerSample: dv.getUint16(offset + 22, true)
      };
    } else if (id === "data") {
      dataBytes = size;
      break;
    }
    offset += 8 + size + (size % 2); // chunks pad to even sizes
  }
  if (fmt === null || dataBytes === null) return null;
  // Streaming WAV writers (including DeepSeek TTS) emit a "unknown size"
  // data chunk — 0xFFFFFFFF, or any value past the actual payload. Clamp to
  // the bytes that really arrived so duration math stays physical.
  const available = Math.max(bytes.length - (offset + 8), 0);
  if (dataBytes === 0xffffffff || dataBytes > available) dataBytes = available;
  const bytesPerFrame = (fmt.bitsPerSample / 8) * Math.max(fmt.channels, 1);
  const byteRate = bytesPerFrame * fmt.sampleRate;
  const durationMs = byteRate > 0 ? Math.round((dataBytes / byteRate) * 1000) : 0;
  return { ...fmt, dataBytes, declaredFileBytes, durationMs };
}

/**
 * Validate an upload against the ASR endpoint's local preconditions.
 * @returns {string | null} a user-facing rejection reason, or null when acceptable.
 */
export function asrRejectReason(bytes) {
  if (looksLikeOggOpus(bytes)) return null;
  const wav = parseWav(bytes);
  if (wav === null) {
    return "the file is neither a RIFF/WAVE file nor an Ogg Opus stream; convert it to 16-bit PCM WAV or Ogg Opus first (e.g. with ffmpeg), the plugin does not convert formats itself";
  }
  if (wav.formatCode !== 1) {
    return `the WAV is format code ${wav.formatCode}, but ASR only accepts uncompressed PCM (code 1); re-encode it as 16-bit PCM WAV`;
  }
  if (wav.bitsPerSample !== 16) {
    return `the WAV has ${wav.bitsPerSample}-bit samples, but ASR only accepts 16-bit PCM; re-encode it (e.g. ffmpeg -i in.mp3 -ar 16000 -ac 1 -sample_fmt s16 out.wav)`;
  }
  if (!WAV_SAMPLE_RATES.includes(wav.sampleRate)) {
    return `the WAV sample rate ${wav.sampleRate} Hz is not one ASR accepts (${WAV_SAMPLE_RATES.join("/")} Hz)`;
  }
  if (wav.channels < 1 || wav.channels > 2) {
    return `the WAV has ${wav.channels} channels; only mono or stereo is accepted`;
  }
  if (wav.durationMs > ASR_MAX_DURATION_MS) {
    return `the audio is ${(wav.durationMs / 1000).toFixed(1)} s long; ASR accepts at most ${ASR_MAX_DURATION_MS / 1000} s per request`;
  }
  return null;
}

/**
 * Whether a TTS response is a complete WAV. Synthesis failures surface as a
 * connection dropped mid-body, so a short or malformed body must read as a
 * failure, not as silence.
 * @returns {{ ok: true, durationMs: number } | { ok: false, reason: string }}
 */
export function checkTtsWav(bytes, expectedLength) {
  if (expectedLength !== undefined && bytes.length < expectedLength) {
    return { ok: false, reason: `the response was cut off after ${bytes.length} of ${expectedLength} bytes` };
  }
  const wav = parseWav(bytes);
  if (wav === null) return { ok: false, reason: "the response is not a valid RIFF/WAVE stream" };
  if (wav.dataBytes <= 0) return { ok: false, reason: "the WAV carries no audio frames" };
  return { ok: true, durationMs: wav.durationMs };
}
