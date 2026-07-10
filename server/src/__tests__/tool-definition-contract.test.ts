import { describe, expect, it } from "vitest";
import {
  createToolDefinitionSchema,
  toolDefinitionSchema,
  updateToolDefinitionSchema,
} from "@paperclipai/shared";

const toolDefinition = {
  id: "33333333-3333-4333-8333-333333333333",
  companyId: "11111111-1111-4111-8111-111111111111",
  name: "daily-tech-scout",
  description: "Collect daily AI and tech signals.",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  adapterType: "http",
  adapterConfig: { url: "https://example.test/tools/daily-tech-scout" },
  enabled: true,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T01:00:00.000Z",
};

describe("tool definition shared contracts", () => {
  it("parses the DB/service adapter shape exactly", () => {
    const parsed = toolDefinitionSchema.parse(toolDefinition);

    expect(parsed).toEqual({
      ...toolDefinition,
      createdAt: new Date("2026-07-10T00:00:00.000Z"),
      updatedAt: new Date("2026-07-10T01:00:00.000Z"),
    });
  });

  it("accepts create input with optional defaults and valid adapter types", () => {
    expect(createToolDefinitionSchema.parse({
      name: "mcp-search",
      adapterType: "mcp",
      adapterConfig: { server: "research" },
    })).toEqual({
      name: "mcp-search",
      adapterType: "mcp",
      adapterConfig: { server: "research" },
    });
  });

  it("rejects unknown adapter types", () => {
    expect(() => createToolDefinitionSchema.parse({
      name: "unsafe-shell",
      adapterType: "shell",
      adapterConfig: {},
    })).toThrow();
  });

  it("allows focused update patches without requiring create fields", () => {
    expect(updateToolDefinitionSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it("rejects blank names and empty update patches", () => {
    expect(() => createToolDefinitionSchema.parse({
      name: "   ",
      adapterType: "http",
      adapterConfig: {},
    })).toThrow();
    expect(() => updateToolDefinitionSchema.parse({})).toThrow();
  });
});
