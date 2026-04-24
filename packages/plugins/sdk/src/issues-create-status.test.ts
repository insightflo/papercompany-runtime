import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createTestHarness } from "./testing.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.sdk-status-test",
  apiVersion: 1,
  version: "0.0.0-test",
  displayName: "SDK Status Test",
  description: "Exercises issue creation status forwarding in the SDK test harness.",
  author: "Paperclip",
  categories: ["connector"],
  capabilities: ["issues.create"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

describe("plugin SDK issues.create status", () => {
  it("preserves the requested issue status", async () => {
    const harness = createTestHarness({ manifest });

    const issue = await harness.ctx.issues.create({
      companyId: "company-1",
      title: "Mirror maintenance request",
      status: "blocked",
    });

    expect(issue.status).toBe("blocked");
  });

  it("defaults to todo when status is omitted", async () => {
    const harness = createTestHarness({ manifest });

    const issue = await harness.ctx.issues.create({
      companyId: "company-1",
      title: "Default queue item",
    });

    expect(issue.status).toBe("todo");
  });
});
