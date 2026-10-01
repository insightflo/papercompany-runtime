import { describe, expect, it, vi } from "vitest";
import { planToolEnvSecrets, transformToolEnvSecrets } from "../../../scripts/lib/tool-env-secrets.js";

const tool = { id: "12345678-rest", adapterConfig: { command: "node", env: {
  CLOUDFLARE_API_KEY: "synthetic", PASSWORD: { type: "plain", value: "synthetic" },
  NORMAL: "ordinary", AUTH_EMPTY: "  ", API_KEY_REF: { type: "secret_ref", secretId: "existing" },
} } };
describe("tool env migration core", () => {
  it("selects only nonempty sensitive plain bindings with deterministic names", () => {
    const plan = planToolEnvSecrets(tool);
    expect(plan.map(({ key, name }) => ({ key, name }))).toEqual([
      { key: "CLOUDFLARE_API_KEY", name: "tool_12345678_cloudflare_api_key" },
      { key: "PASSWORD", name: "tool_12345678_password" },
    ]);
  });
  it("dry run performs no writes or mutation", async () => {
    const write = vi.fn();
    const before = JSON.stringify(tool);
    const result = await transformToolEnvSecrets(tool, false, write);
    expect(write).not.toHaveBeenCalled();
    expect(JSON.stringify(tool) === before).toBe(true);
    expect(result.keys).toEqual(["CLOUDFLARE_API_KEY", "PASSWORD"]);
    expect(result.adapterConfig).toBeNull();
  });
  it("apply keeps unrelated bindings and returns references only after successful writes", async () => {
    const write = vi.fn(async () => "created-id");
    const result = await transformToolEnvSecrets(tool, true, write);
    expect(write).toHaveBeenCalledTimes(2);
    expect(result.adapterConfig?.env).toEqual({
      ...tool.adapterConfig.env,
      CLOUDFLARE_API_KEY: { type: "secret_ref", secretId: "created-id", version: "latest" },
      PASSWORD: { type: "secret_ref", secretId: "created-id", version: "latest" },
    });
  });
  it("failed secret write never returns a partially transformed config", async () => {
    const before = JSON.stringify(tool);
    const write = vi.fn().mockResolvedValueOnce("created-id").mockRejectedValueOnce(new Error("write failed"));
    await expect(transformToolEnvSecrets(tool, true, write)).rejects.toThrow("write failed");
    expect(JSON.stringify(tool) === before).toBe(true);
  });
});
