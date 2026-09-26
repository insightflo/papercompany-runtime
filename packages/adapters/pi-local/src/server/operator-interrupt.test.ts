import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOperatorInterruptPrompt,
  operatorInterruptFilePath,
  parseOperatorInterruptPayload,
  startOperatorInterruptPolling,
  type OperatorInterruptPayload,
} from "./operator-interrupt.js";

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";

function makePayload(overrides: Partial<OperatorInterruptPayload> = {}): OperatorInterruptPayload {
  return {
    commentId: "comment-1",
    body: "stop the wide scan now",
    createdAt: "2026-09-26T10:00:00.000Z",
    issueId: ISSUE_ID,
    ...overrides,
  };
}

async function waitFor(ensure: () => boolean, timeoutMs = 2000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!ensure()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function writeInterruptFile(root: string, payload: OperatorInterruptPayload): Promise<string> {
  const filePath = operatorInterruptFilePath(root, payload.issueId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload), "utf8");
  return filePath;
}

describe("operator interrupt payload parsing", () => {
  it("accepts a well-formed payload", () => {
    expect(parseOperatorInterruptPayload(JSON.stringify(makePayload()))).toEqual(makePayload());
  });

  it("rejects malformed json and missing fields", () => {
    expect(parseOperatorInterruptPayload("not json")).toBeNull();
    expect(parseOperatorInterruptPayload(JSON.stringify({ commentId: "c" }))).toBeNull();
    expect(parseOperatorInterruptPayload(JSON.stringify({ ...makePayload(), body: "" }))).toBeNull();
  });

  it("builds the injected prompt with priority marker and scope guard", () => {
    const message = buildOperatorInterruptPrompt(makePayload());
    expect(message).toContain("[OPERATOR INTERRUPT — highest priority, act on this now]");
    expect(message).toContain("stop the wide scan now");
    expect(message).toContain("이 지시는 현재 작업 범위 내에서 우선 반영하라");
  });
});

describe("operator interrupt polling", () => {
  let root: string;
  const written: string[] = [];
  let writeStdin: (chunk: string) => boolean;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-op-interrupt-"));
    written.length = 0;
    writeStdin = (chunk: string) => {
      written.push(chunk);
      return true;
    };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("injects an interrupt file once and consumes it", async () => {
    const filePath = await writeInterruptFile(root, makePayload());
    const poller = startOperatorInterruptPolling({
      agentHome: root,
      issueIds: [ISSUE_ID],
      intervalMs: 20,
      writeStdin,
    });
    try {
      await waitFor(() => written.length === 1, 2000, "first injection");
      await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });

      // No duplicate injections after the file is gone.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(written).toHaveLength(1);
      const parsed = JSON.parse(written[0]) as { type: string; message: string };
      expect(parsed.type).toBe("prompt");
      expect(parsed.message).toContain("[OPERATOR INTERRUPT");
      expect(parsed.message).toContain("stop the wide scan now");
    } finally {
      poller.stop();
    }
  });

  it("deduplicates identical re-created files and injects new comments", async () => {
    const payload = makePayload();
    await writeInterruptFile(root, payload);
    const poller = startOperatorInterruptPolling({
      agentHome: root,
      issueIds: [ISSUE_ID],
      intervalMs: 20,
      writeStdin,
    });
    try {
      await waitFor(() => written.length === 1, 2000, "first injection");
      // Simulate a failed rm: same content reappears — key dedup must hold.
      await writeInterruptFile(root, payload);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(written).toHaveLength(1);

      // A new comment (different commentId) must inject again.
      await writeInterruptFile(root, makePayload({ commentId: "comment-2", body: "narrow it to server/" }));
      await waitFor(() => written.length === 2, 2000, "second injection");
      const second = JSON.parse(written[1]) as { message: string };
      expect(second.message).toContain("narrow it to server/");
    } finally {
      poller.stop();
    }
  });

  it("keeps the file for retry while child stdin is unavailable", async () => {
    const filePath = await writeInterruptFile(root, makePayload());
    let stdinAvailable = false;
    const poller = startOperatorInterruptPolling({
      agentHome: root,
      issueIds: [ISSUE_ID],
      intervalMs: 20,
      writeStdin: (chunk: string) => {
        if (!stdinAvailable) return false;
        written.push(chunk);
        return true;
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(written).toHaveLength(0);
      await expect(fs.access(filePath)).resolves.toBeUndefined();

      stdinAvailable = true;
      await waitFor(() => written.length === 1, 2000, "delayed injection");
      await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      poller.stop();
    }
  });

  it("warns and leaves malformed files in place", async () => {
    const filePath = await writeInterruptFile(root, makePayload());
    await fs.writeFile(filePath, "{not json", "utf8");
    const onWarn = vi.fn();
    const poller = startOperatorInterruptPolling({
      agentHome: root,
      issueIds: [ISSUE_ID],
      intervalMs: 20,
      writeStdin,
      onWarn,
    });
    try {
      await waitFor(() => onWarn.mock.calls.some(([, message]) => message.includes("ignored")), 2000, "warn");
      expect(written).toHaveLength(0);
      await expect(fs.access(filePath)).resolves.toBeUndefined();
    } finally {
      poller.stop();
    }
  });

  it("is a no-op without agent home or issue ids", async () => {
    const filePath = await writeInterruptFile(root, makePayload());
    const noHome = startOperatorInterruptPolling({ agentHome: "", issueIds: [ISSUE_ID], intervalMs: 20, writeStdin });
    const noIssues = startOperatorInterruptPolling({ agentHome: root, issueIds: [], intervalMs: 20, writeStdin });
    noHome.stop();
    noIssues.stop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(written).toHaveLength(0);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });
});
