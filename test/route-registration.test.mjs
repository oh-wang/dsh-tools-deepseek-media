// Proves the settings routes register on the Host's authenticated
// `connection.fetch` surface — not on the unauthenticated `webServer` seam —
// and that the write handler refuses a non-JSON body. No DSH instance needed:
// the plugin is instantiated against a recording mock context.

import assert from "node:assert/strict";
import { apply, inject } from "../lib/index.js";

const calls = { fetchRoutes: [], webServerRoutes: [], toolRegistrations: [] };

function mockContext() {
  const registered = [];
  const ctx = {
    logger: { warn() {}, info() {}, debug() {} },
    get(service) {
      if (service === "credentials") {
        return {
          describe: async () => ({ configured: true, source: "file", writable: true }),
          resolve: async () => ({ value: "sk-not-a-real-key", source: "file" }),
          set: async () => {},
          unset: async () => {},
        };
      }
      if (service === "webServer") {
        // If the plugin ever reaches for the unauthenticated seam, record it.
        return { webServer: { register(r) { calls.webServerRoutes.push(r); return () => {}; } } };
      }
      return undefined;
    },
    inject(services, callback) {
      if (services.includes("connection")) {
        callback({
          effect: (fn) => fn(),
          connection: {
            fetch: {
              register(route) {
                registered.push(route);
                calls.fetchRoutes.push(route);
                return () => {};
              },
            },
          },
        });
      }
    },
    effect(fn) { return fn(); },
    tools: {
      register(tool) { calls.toolRegistrations.push(tool); return () => {}; },
    },
    fs: {},
    workingDirectory: {},
  };
  return { ctx, registered };
}

const { ctx, registered } = mockContext();
apply(ctx, { ttsDir: "tts" });

// -- the retired seam must not be touched ------------------------------------
assert.deepEqual(
  calls.webServerRoutes, [],
  "plugin must not register on ctx.webServer (it bypasses Host authentication)",
);

// -- the authenticated seam must carry both settings routes ------------------
const paths = registered.map((r) => `${r.methods.join(",")} ${r.path}`).sort();
assert.deepEqual(paths, [
  "GET /dsh-deepseek-media/status",
  "POST /dsh-deepseek-media/credentials",
], `unexpected routes: ${JSON.stringify(paths)}`);

for (const route of registered) {
  assert.equal(route.requestBody, "buffered", `${route.path} must declare a buffered body`);
  assert.equal(typeof route.fetch, "function", `${route.path} must ship a fetch handler`);
}

// -- the write handler rejects malformed and missing fields ------------------
const credentialsRoute = registered.find((r) => r.path === "/dsh-deepseek-media/credentials");

const badJson = await credentialsRoute.fetch(new Request("http://127.0.0.1/dsh-deepseek-media/credentials", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "not-json",
}));
assert.equal(badJson.status, 400, "non-JSON body must be rejected");

const missingField = await credentialsRoute.fetch(new Request("http://127.0.0.1/dsh-deepseek-media/credentials", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ nope: 1 }),
}));
assert.equal(missingField.status, 400, "a body without apiKey must be rejected");

// -- a well-formed body still works ----------------------------------------
const ok = await credentialsRoute.fetch(new Request("http://127.0.0.1/dsh-deepseek-media/credentials", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ apiKey: "sk-a-well-formed-key" }),
}));
assert.equal(ok.status, 200, "a well-formed body must succeed");
const payload = await ok.json();
assert.equal(payload.hasApiKey, true);
assert.ok(!JSON.stringify(payload).includes("sk-a-well-formed-key"), "the response must never echo the key");

// -- three tools registered, none of them exposing the key -----------------
assert.equal(calls.toolRegistrations.length, 3, "expected exactly three tools");
const names = calls.toolRegistrations.map((t) => t.name).sort();
assert.deepEqual(names, ["deepseek_asr", "deepseek_ocr", "deepseek_tts"]);

console.log("PASS: routes on connection.fetch only; 3 tools; write handler validated");
