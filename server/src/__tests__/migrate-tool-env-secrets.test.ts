import { describe, expect, it, vi } from "vitest";
import { planToolEnvSecrets, transformToolEnvSecrets } from "../../../scripts/lib/tool-env-secrets.js";

const tool = { id: "12345678-rest", adapterConfig: { command: "node", env: {
  CLOUDFLARE_API_KEY: "synthetic", PASSWORD: { type: "plain", value: "synthetic" },
  NORMAL: "ordinary", AUTH_EMPTY: "  ", API_KEY_REF: { type: "secret_ref", secretId: "existing" },
} } };
describe("tool env migration core", () => {
  it.each(["synthetic", { type: "plain", value: "synthetic" }])("selects token segments without selecting tokenizer or ordinary env names (%j)", (binding) => {
    const plan = planToolEnvSecrets({ id: tool.id, adapterConfig: { env: {
      CLOUDFLARE_API_TOKEN: binding, GITHUB_TOKEN: "synthetic", TOKEN: "synthetic",
      BOT_TOKEN_V2: "synthetic", SLACK_BOT_TOKEN: "synthetic", INPUT_TOKENS_LIMIT: "10",
      CLOUDFLARE_ACCOUNT_ID: "account", MANUAL_ONBOARDING_SITE_ROOT: "/site",
      TOKENIZER_PATH: "/tokenizer", MAX_TOKENIZER: "10",
    } } });
    expect(plan.map(({ key }) => key)).toEqual([
      "CLOUDFLARE_API_TOKEN", "GITHUB_TOKEN", "TOKEN", "BOT_TOKEN_V2", "SLACK_BOT_TOKEN", "INPUT_TOKENS_LIMIT",
    ]);
  });
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
