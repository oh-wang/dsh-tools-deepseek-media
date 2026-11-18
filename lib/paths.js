// DeepSeek media tools — workspace path resolution and containment checks.
//
// Every filesystem touch goes through the host's own `fs` and
// `workingDirectory` services (the same seam the built-in read/write tools
// use), then through a realpath containment check. `fs.resolve` already
// returns a realpath-derived targetKey, which is what defeats `../` and
// symlink escapes; the containment check pins that target inside the
// session's workspace so a model-supplied path can never read or write
// outside it.

import path from "node:path";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";

/** Narrow a value to a plain object, mirroring the provider's own guard. */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Human-readable absolute path of an fs-resolve target. */
function targetPath(target) {
  const display = isRecord(target) ? target.displayPath : undefined;
  if (typeof display !== "string" || display.length === 0) {
    throw new Error("the filesystem service returned no usable path for this request");
  }
  return display;
}

/**
 * Resolve one model-supplied path inside the session workspace and require a
 * regular file. Rejects anything that escapes the workspace after symlink
 * resolution, so both `../../etc/passwd` and a symlink pointing out of the
 * workspace fail closed.
 * @param {object} ctx plugin context carrying the `fs` and `workingDirectory` services
 * @param {object} exec tool execution (agent + signal)
 * @param {string} requestedPath raw `file` argument from the model
 * @returns {Promise<{ displayPath: string, size: number | undefined, read: () => Promise<Buffer> }>}
 */
export async function resolveWorkspaceFile(ctx, exec, requestedPath) {
  const cwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
  if (cwd === undefined || cwd === "") {
    throw new Error("no workspace directory is associated with this session, so no file can be located");
  }
  const target = await ctx.fs.resolve(requestedPath, { cwd, signal: exec.signal });
  const displayPath = targetPath(target);
  const info = await ctx.fs.stat(target, exec.signal);
  if (info === undefined) throw new Error(`"${requestedPath}": file not found`);
  if (info.type !== "file") throw new Error(`"${requestedPath}" is not a regular file`);

  // Containment: the resolved target (realpath) must sit inside the
  // workspace root (also realpath'd, since the workspace itself may be a link).
  const realFile = path.resolve(String(target.targetKey));
  const realRoot = path.resolve(realpathSync(cwd));
  const rel = path.relative(realRoot, realFile);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`"${requestedPath}" resolves outside the workspace; only files inside the workspace can be used`);
  }
  return {
    displayPath,
    size: info.size,
    // Lazy read: callers that only need the size check never hold the bytes.
    //
    // `fs.readBytes` resolves to a *workspace-byte handle* — `{ data, offset,
    // eof, ... }` — not a Buffer. Handing that object straight to
    // `new Blob([...])` stringified it to "[object Object]", which uploaded a
    // body of zero useful bytes and came back as a silently empty transcript.
    // Only the `data` member is the file.
    read: async () => {
      const handle = await ctx.fs.readBytes(target, exec.signal, Number.MAX_SAFE_INTEGER);
      const bytes = handle instanceof Uint8Array ? handle : handle?.data;
      if (!(bytes instanceof Uint8Array)) {
        throw new Error(`could not read the bytes of "${requestedPath}": the filesystem service returned no byte data`);
      }
      return bytes;
    }
  };
}

/**
 * Ensure a workspace-relative output directory exists and is contained.
 * The directory name comes from configuration, so it gets the same escape
 * treatment as model paths before anything is written.
 * @returns the absolute output directory.
 */
export async function ensureWorkspaceDir(ctx, exec, configuredDir) {
  const cwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
  if (cwd === undefined || cwd === "") {
    throw new Error("no workspace directory is associated with this session, so nothing can be written");
  }
  const root = path.resolve(realpathSync(cwd));
  // Trailing slash or "." would resolve oddly; normalize to a real subpath.
  const dirName = String(configuredDir ?? "").replace(/^\/+|\/+$/g, "");
  if (dirName === "" || dirName === ".") {
    throw new Error("the output directory must be a non-empty workspace-relative folder name");
  }
  const target = path.resolve(root, dirName);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") {
    throw new Error(`output directory "${configuredDir}" must stay inside the workspace`);
  }
  await mkdir(target, { recursive: true });
  return { dir: target, relName: rel };
}
