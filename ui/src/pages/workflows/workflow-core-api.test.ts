import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client.js";
import { apiBaseUrl, coreApiJson } from "./workflow-page-api.js";

afterEach(() => vi.unstubAllGlobals());

describe("workflow core API", () => {
  it("retains structured failures, status and request semantics", async () => {
    const body = { error: "Invalid workflow run input values", details: {
      version: 1, code: "invalid_workflow_run_inputs",
      fieldErrors: [{ key: "section", code: "invalid_option", message: "선택지를 확인해 주세요." }],
    } };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    const failure = await coreApiJson("/workflows/example/runs", {
      method: "POST", body: JSON.stringify({ metadata: { section: "unknown" } }),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 400, body, message: body.error });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${apiBaseUrl()}/api/workflows/example/runs`);
    expect(init.credentials).toBe("include");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"metadata":{"section":"unknown"}}');
    expect(init.headers.get("content-type")).toBe("application/json");
  });

  it.each([
    { body: { error: "Error first", message: "Message second" }, expected: "Error first" },
    { body: { message: "Message fallback" }, expected: "Message fallback" },
    { body: {}, expected: "Request failed (503)" },
    { body: null, expected: "Request failed (503)" },
  ])("preserves error/message/status fallback for $expected", async ({ body, expected }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 503 })));
    const failure = await coreApiJson("/failure").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ message: expected, status: 503, body });
  });

  it("keeps a usable status message when failure JSON cannot be parsed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Unavailable</html>", { status: 502 })));
    const failure = await coreApiJson("/failure").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ message: "Request failed (502)", status: 502, body: null });
  });

  it("returns successful JSON unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"metadata":{"enabled":false,"tags":[]}}')));
    expect(await coreApiJson("/success")).toEqual({ metadata: { enabled: false, tags: [] } });
  });

  it("preserves custom headers, credentials override, signal and body", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await coreApiJson("/custom", {
      method: "PATCH", body: "payload", credentials: "omit", signal,
      headers: { "Content-Type": "application/custom", "X-Trace": "trace" },
    });
    const init = fetch.mock.calls[0][1];
    expect(init.headers.get("content-type")).toBe("application/custom");
    expect(init.headers.get("x-trace")).toBe("trace");
    expect(init.credentials).toBe("omit");
    expect(init.signal).toBe(signal);
    expect(init.body).toBe("payload");
  });

  it("leaves FormData content type to the browser", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const body = new FormData();
    body.set("file", "content");
    await coreApiJson("/upload", { method: "POST", body });
    const init = fetch.mock.calls[0][1];
    expect(init.headers.has("content-type")).toBe(false);
    expect(init.body).toBe(body);
  });

  it("propagates network failures unchanged", async () => {
    const failure = new TypeError("Network unavailable");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
    await expect(coreApiJson("/offline")).rejects.toBe(failure);
  });

  it("uses HTTP window origin and falls back outside a browser", () => {
    vi.stubGlobal("window", { location: { origin: "https://example.test" } });
    expect(apiBaseUrl()).toBe("https://example.test");
    vi.stubGlobal("window", { location: { origin: "file://local" } });
    expect(apiBaseUrl()).toBe("http://localhost:3100");
    vi.stubGlobal("window", undefined);
    expect(apiBaseUrl()).toBe("http://localhost:3100");
  });
});
