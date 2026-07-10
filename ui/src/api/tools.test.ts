// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { toolDefinitionsApi, workflowToolsApi } from "./tools";

type FetchMock = ReturnType<typeof vi.fn>;

function mockResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => payload),
  } as unknown as Response;
}

function setFetchMock(impl: FetchMock) {
  Object.defineProperty(globalThis, "fetch", {
    value: impl,
    configurable: true,
  });
}

describe("tools api clients", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates company-scoped tool definitions", async () => {
    const fetchMock = vi.fn(async () => mockResponse(201, { id: "tool-1" }));
    setFetchMock(fetchMock);

    await expect(toolDefinitionsApi.create("company-1", {
      name: "daily-tech-scout",
      adapterType: "http",
      adapterConfig: { url: "https://example.test/tool" },
    })).resolves.toEqual({ id: "tool-1" });

    expect(fetchMock).toHaveBeenCalledWith("/api/companies/company-1/tools", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        name: "daily-tech-scout",
        adapterType: "http",
        adapterConfig: { url: "https://example.test/tool" },
      }),
    }));
  });

  it("patches and deletes company-scoped tool definitions", async () => {
    const fetchMock = vi.fn(async () => mockResponse(200, { ok: true }));
    setFetchMock(fetchMock);

    await toolDefinitionsApi.update("company-1", "tool-1", { enabled: false });
    await toolDefinitionsApi.remove("company-1", "tool-1");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/companies/company-1/tools/tool-1", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/companies/company-1/tools/tool-1", expect.objectContaining({
      method: "DELETE",
    }));
  });

  it("grants and revokes workflow tools through the existing catalog routes", async () => {
    const fetchMock = vi.fn(async () => mockResponse(200, { ok: true }));
    setFetchMock(fetchMock);

    await workflowToolsApi.grant("company-1", { agentId: "agent-1", toolName: "daily-tech-scout" });
    await workflowToolsApi.revoke("company-1", { agentId: "agent-1", toolName: "daily-tech-scout" });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/companies/company-1/workflows/tools/grants", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ agentId: "agent-1", toolName: "daily-tech-scout" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/companies/company-1/workflows/tools/grants", expect.objectContaining({
      method: "DELETE",
      body: JSON.stringify({ agentId: "agent-1", toolName: "daily-tech-scout" }),
    }));
  });
});
