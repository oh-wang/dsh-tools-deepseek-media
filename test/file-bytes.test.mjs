// Regression guard for the empty-transcript bug.
//
// `ctx.fs.readBytes` resolves to a workspace-byte *handle*
// (`{ data, offset, eof, ... }`), not a Buffer. Passing that handle straight
// into `new Blob([...])` stringifies it to "[object Object]" and uploads
// nothing useful, which the API answers with a successful, empty transcript.
// resolveWorkspaceFile must unwrap `data`.

import assert from "node:assert/strict";
import { resolveWorkspaceFile } from "../lib/paths.js";

const cwd = process.cwd();
const FILE = "deepseek-api-check/placeholder.txt";

function ctxWith(readBytesResult) {
  return {
    workingDirectory: { ensure: async () => cwd },
    fs: {
      // `resolve` returns a realpath-derived targetKey, which the containment
      // check compares against the workspace root.
      resolve: async () => ({
        displayPath: `${cwd}/deepseek-api-check/sample.png`,
        targetKey: `${cwd}/deepseek-api-check/sample.png`,
      }),
      stat: async () => ({ type: "file", size: 32454 }),
      readBytes: async () => readBytesResult,
    },
  };
}

const exec = { agent: {}, signal: new AbortController().signal };

// -- handle shape: unwraps to the payload --------------------------------
{
  const payload = new Uint8Array([1, 2, 3, 4]);
  const file = await resolveWorkspaceFile(ctxWith({ data: payload, offset: 0, eof: true }), exec, FILE);
  const bytes = await file.read();
  assert.ok(bytes instanceof Uint8Array, "read() must return bytes, not a wrapper object");
  assert.deepEqual(Array.from(bytes), [1, 2, 3, 4], "read() must return the payload, not the handle");
}

// -- raw bytes: a service that already returns bytes still works ----------
{
  const payload = new Uint8Array([9, 9]);
  const file = await resolveWorkspaceFile(ctxWith(payload), exec, FILE);
  assert.deepEqual(Array.from(await file.read()), [9, 9], "raw-byte services must pass through unchanged");
}

// -- a service answering with neither shape fails loudly -----------------
{
  const file = await resolveWorkspaceFile(ctxWith(undefined), exec, FILE);
  await assert.rejects(() => file.read(), /returned no byte data/, "an unusable read must throw, never upload nothing");
}

// -- the exact failure this guards: never hand a handle to a Blob --------
{
  const payload = new Uint8Array([42]);
  const file = await resolveWorkspaceFile(ctxWith({ data: payload, offset: 0, eof: true }), exec, FILE);
  const blob = new Blob([await file.read()]);
  assert.equal(blob.size, 1, `Blob must carry the 1 payload byte, got ${blob.size}`);
  assert.notEqual(blob.size, new Blob([{ data: payload }]).size - 0, "guard against re-introducing the stringified handle");
}

console.log("PASS: fs byte handles unwrap to payloads; unusable reads throw; Blob size correct");
