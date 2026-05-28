import assert from "node:assert/strict";
import test from "node:test";

import {
  getPaperclipApiUrl,
  resolveHostForUrl,
} from "../dist/paperclip-api-url.js";

const ENV_KEYS = [
  "PAPERCLIP_API_URL",
  "PAPERCLIP_LISTEN_HOST",
  "PAPERCLIP_LISTEN_PORT",
  "HOST",
  "PORT",
];

function withEnv(env, fn) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("getPaperclipApiUrl trims explicit PAPERCLIP_API_URL trailing slash", () => {
  withEnv({ PAPERCLIP_API_URL: "http://127.0.0.1:3200/" }, () => {
    assert.equal(getPaperclipApiUrl(), "http://127.0.0.1:3200");
  });
});

test("getPaperclipApiUrl derives from Paperclip listen host and port", () => {
  withEnv({ PAPERCLIP_LISTEN_HOST: "127.0.0.1", PAPERCLIP_LISTEN_PORT: "3200" }, () => {
    assert.equal(getPaperclipApiUrl(), "http://127.0.0.1:3200");
  });
});

test("getPaperclipApiUrl normalizes wildcard host to localhost", () => {
  withEnv({ HOST: "0.0.0.0", PORT: "3200" }, () => {
    assert.equal(getPaperclipApiUrl(), "http://localhost:3200");
  });
});

test("resolveHostForUrl brackets IPv6 literals", () => {
  assert.equal(resolveHostForUrl("::1"), "[::1]");
  assert.equal(resolveHostForUrl("2001:db8::1"), "[2001:db8::1]");
  assert.equal(resolveHostForUrl("[::1]"), "[::1]");
});
