import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("node:https", () => ({ request: network.request }));
import { readbackPublicUrl, setPublicUrlReadbackFetcher } from "../services/public-url-readback.js";
import { evaluateQaRules } from "../services/workflow/qa-rules.js";

let status = 200, body = "<title>Article</title>", hold = false;
beforeEach(() => {
  status = 200; body = "<title>Article</title>"; hold = false;
  network.lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  network.request.mockReset().mockImplementation((options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      if (hold) return;
      const response = Readable.from([Buffer.from(body)]);
      Object.assign(response, { statusCode: status, headers: status === 302 ? { location: "https://[::1]/" } : {} });
      callback(response);
    });
    options.signal?.addEventListener("abort", () => req.emit("error", new Error("aborted")), { once: true });
    return req;
  });
  // Legacy fetch follows the redirect; new transport must never use this unpinned boundary.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
});
afterEach(() => { setPublicUrlReadbackFetcher(null); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("public readback network fencing", () => {
  it.each(["https://[fd00::1]/", "https://[fe80::1]/", "https://[::ffff:7f00:1]/", "https://[ff02::1]/", "http://example.org/", "https://user:pass@example.org/"])("rejects unsafe URL %s before opening a connection", async url => {
    expect((await readbackPublicUrl(url)).ok).toBe(false);
    expect(network.request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects public-to-private redirects without contacting the destination", async () => {
    status = 302;
    expect((await readbackPublicUrl("https://example.org/article")).ok).toBe(false);
    expect(network.request).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("pins the validated DNS address but keeps Host and TLS identity", async () => {
    expect(await readbackPublicUrl("https://example.org/article?q=1")).toMatchObject({ ok: true, status: 200, text: body });
    expect(network.lookup).toHaveBeenCalledTimes(1);
    expect(network.request.mock.calls[0][0]).toMatchObject({ hostname: "93.184.216.34", servername: "example.org", path: "/article?q=1", headers: { Host: "example.org" } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects DNS with any private answer", async () => {
    network.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }, { address: "fd00::1", family: 6 }]);
    expect((await readbackPublicUrl("https://example.org/")).ok).toBe(false);
    expect(network.request).not.toHaveBeenCalled();
  });
  it("bounds stalled DNS before any socket opens", async () => {
    vi.useFakeTimers(); network.lookup.mockImplementation(() => new Promise(() => {}));
    const pending = readbackPublicUrl("https://example.org/");
    await vi.advanceTimersByTimeAsync(3001);
    expect((await pending).ok).toBe(false);
    expect(network.request).not.toHaveBeenCalled();
  });
  it("bounds response bytes and does not return partial content", async () => {
    body = "x".repeat(2 * 1024 * 1024 + 1);
    expect(await readbackPublicUrl("https://example.org/")).toMatchObject({ ok: false, text: "" });
  });
  it("bounds stalled requests including response wait", async () => {
    vi.useFakeTimers(); hold = true;
    const pending = readbackPublicUrl("https://example.org/");
    await vi.advanceTimersByTimeAsync(8001);
    expect((await pending).ok).toBe(false);
  });
});

describe("optional link reachability", () => {
  const base = { provenanceValid: true, resultValid: true, config: { rules: { "links-reachable": {} } } };
  it("checks a reachable HTTPS source rather than always returning unavailable", async () => {
    expect((await evaluateQaRules({ ...base, json: { source: "https://example.org/article" } })).ok).toBe(true);
    expect(network.request).toHaveBeenCalledTimes(1);
  });
  it("rejects unreachable HTTP status and private destinations", async () => {
    status = 404;
    expect((await evaluateQaRules({ ...base, json: { source: "https://example.org/missing" } })).ok).toBe(false);
    expect(network.request).toHaveBeenCalledTimes(1);
    network.request.mockClear();
    expect((await evaluateQaRules({ ...base, json: { source: "https://[::1]/" } })).ok).toBe(false);
    expect(network.request).not.toHaveBeenCalled();
  });
  it("deduplicates URLs and bounds total link count before fetching", async () => {
    const source = "https://example.org/article";
    expect((await evaluateQaRules({ ...base, json: { sources: [source, source] } })).ok).toBe(true);
    expect(network.request).toHaveBeenCalledTimes(1);
    network.request.mockClear();
    expect((await evaluateQaRules({ ...base, json: { sources: Array.from({ length: 21 }, (_, i) => `https://example.org/${i}`) } })).ok).toBe(false);
    expect(network.request).not.toHaveBeenCalled();
  });
  it("limits concurrent requests and the total network time", async () => {
    vi.useFakeTimers();
    network.request.mockImplementation((options, callback) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () => {
        const timer = setTimeout(() => callback(Object.assign(Readable.from([]), { statusCode: 200, headers: {} })), 6000);
        options.signal.addEventListener("abort", () => { clearTimeout(timer); req.emit("error", new Error("aborted")); }, { once: true });
      };
      return req;
    });
    const pending = evaluateQaRules({ ...base, json: { sources: Array.from({ length: 20 }, (_, i) => `https://example.org/${i}`) } });
    await vi.advanceTimersByTimeAsync(1);
    expect(network.request).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(10000);
    expect((await pending).ok).toBe(false);
    expect(network.request).toHaveBeenCalledTimes(8);
  });
  it("does not fetch when mandatory safety already failed or rule disabled", async () => {
    expect((await evaluateQaRules({ ...base, html: '<script src="https://example.org/x.js"></script>' })).ok).toBe(false);
    expect((await evaluateQaRules({ ...base, config: { rules: { "links-reachable": { enabled: false } } }, json: { source: "https://example.org/" } })).ok).toBe(true);
    expect(network.request).not.toHaveBeenCalled();
  });
});
