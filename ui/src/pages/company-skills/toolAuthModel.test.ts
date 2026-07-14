import { describe, expect, it } from "vitest";
import { readAdapterAuth, writeAdapterAuth } from "./toolAdminModel";

describe("adapter auth serialization", () => {
  describe("readAdapterAuth", () => {
    it("reports invalid when the adapter config JSON is malformed", () => {
      expect(readAdapterAuth("{ not json")).toEqual({ kind: "invalid" });
    });

    it("reports no-auth when the config has no auth block", () => {
      expect(readAdapterAuth(JSON.stringify({ url: "https://x.test" }))).toEqual({
        kind: "no-auth",
      });
    });

    it("reads a complete header auth block with version latest", () => {
      const json = JSON.stringify({
        url: "https://x.test",
        auth: { type: "header", headerName: "X-Key", secretId: "sec-1", version: "latest" },
      });
      expect(readAdapterAuth(json)).toEqual({
        kind: "ok",
        headerName: "X-Key",
        secretId: "sec-1",
        version: "latest",
      });
    });

    it("reads a numeric auth version", () => {
      const json = JSON.stringify({
        auth: { type: "header", headerName: "Authorization", secretId: "sec-2", version: 3 },
      });
      expect(readAdapterAuth(json)).toEqual({
        kind: "ok",
        headerName: "Authorization",
        secretId: "sec-2",
        version: 3,
      });
    });

    it("treats an empty secretId as no selection", () => {
      const json = JSON.stringify({
        auth: { type: "header", headerName: "Authorization", secretId: "", version: "latest" },
      });
      expect(readAdapterAuth(json)).toEqual({
        kind: "ok",
        headerName: "Authorization",
        secretId: null,
        version: "latest",
      });
    });
  });

  describe("writeAdapterAuth", () => {
    it("selects a secret with version latest and preserves other adapterConfig fields", () => {
      const base = JSON.stringify({
        url: "https://x.test",
        method: "POST",
        response: { resultField: "result", artifactField: "artifact", artifactFileName: "a.json", artifactPathResultField: "p" },
        auth: { type: "header", headerName: "X-Key", secretId: "", version: "latest" },
      });
      const next = JSON.parse(writeAdapterAuth(base, { secretId: "sec-9" }));
      expect(next.url).toBe("https://x.test");
      expect(next.method).toBe("POST");
      expect(next.response.resultField).toBe("result");
      expect(next.auth).toEqual({
        type: "header",
        headerName: "X-Key",
        secretId: "sec-9",
        version: "latest",
      });
    });

    it("changes the header name without losing the selected secret", () => {
      const base = JSON.stringify({
        url: "https://x.test",
        auth: { type: "header", headerName: "X-Key", secretId: "sec-1", version: "latest" },
      });
      const next = JSON.parse(writeAdapterAuth(base, { headerName: "Authorization" }));
      expect(next.auth.headerName).toBe("Authorization");
      expect(next.auth.secretId).toBe("sec-1");
      expect(next.auth.version).toBe("latest");
    });

    it("creates an auth block defaulting the header name to Authorization when none exists", () => {
      const base = JSON.stringify({ url: "https://x.test" });
      const next = JSON.parse(writeAdapterAuth(base, { secretId: "sec-1" }));
      expect(next.auth).toEqual({
        type: "header",
        headerName: "Authorization",
        secretId: "sec-1",
        version: "latest",
      });
      expect(next.url).toBe("https://x.test");
    });

    it("clearing the secret writes an empty secretId", () => {
      const base = JSON.stringify({
        auth: { type: "header", headerName: "Authorization", secretId: "sec-1", version: "latest" },
      });
      const next = JSON.parse(writeAdapterAuth(base, { secretId: null }));
      expect(next.auth.secretId).toBeNull();
    });

    it("throws on invalid JSON so the caller can guard with readAdapterAuth", () => {
      expect(() => writeAdapterAuth("{ broken", { secretId: "sec-1" })).toThrow();
    });
  });
});
