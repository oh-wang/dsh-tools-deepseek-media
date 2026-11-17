// DeepSeek media tools — billing arithmetic.
//
// The TTS "billable character" rule is the API's own pricing unit: a CJK
// ideograph (and CJK punctuation/fullwidth forms, which the docs fold into
// "汉字") counts as 2, every other code point as 1. Keeping the estimator in
// one place lets the tool report what it charged without the model having to
// guess.

import { createHash } from "node:crypto";

/** TTS list price per 10k billable characters, in CNY. */
export const TTS_CNY_PER_10K = 1.5;

/** Whether a code point bills as a "汉字" (2) under the TTS pricing rule. */
function isDoubleWidth(codePoint) {
  return (
    // CJK unified ideographs and extensions A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    // CJK punctuation, fullwidth forms
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef)
  );
}

/** Count billable characters the way DeepSeek TTS prices them. */
export function billableChars(text) {
  let total = 0;
  for (const ch of text) total += isDoubleWidth(ch.codePointAt(0)) ? 2 : 1;
  return total;
}

/** Estimated TTS cost in CNY for a billable-character count. */
export function estimatedTtsCostCny(chars) {
  return Math.round((chars / 10000) * TTS_CNY_PER_10K * 100) / 100;
}

/**
 * Deterministic short file stem for a synthesis job, so identical
 * text+voice repeats are recognizable and the name stays filesystem-safe.
 */
export function ttsFileStem(text, voiceId) {
  const hash = createHash("sha256").update(`${voiceId}\u0000${text}`).digest("hex").slice(0, 8);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${hash}`;
}
