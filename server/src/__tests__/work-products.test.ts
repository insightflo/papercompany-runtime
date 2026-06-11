import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { workProductService } from "../services/work-products.ts";

function createWorkProductRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-03-17T00:00:00.000Z");
  return {
    id: "work-product-1",
    companyId: "company-1",
    projectId: "project-1",
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: null,
    title: "PR 1",
    url: "https://example.com/pr/1",
    status: "open",
    reviewState: "draft",
    isPrimary: true,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("workProductService", () => {
  it("uses a transaction when creating a new primary work product", async () => {
    const updatedWhere = vi.fn(async () => undefined);
    const updateSet = vi.fn(() => ({ where: updatedWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const insertedRow = createWorkProductRow();
    const insertReturning = vi.fn(async () => [insertedRow]);
    const insertValues = vi.fn(() => ({ returning: insertReturning }));
    const txInsert = vi.fn(() => ({ values: insertValues }));

    const tx = {
      update: txUpdate,
      insert: txInsert,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.createForIssue("issue-1", "company-1", {
      type: "pull_request",
      provider: "github",
      title: "PR 1",
      status: "open",
      reviewState: "draft",
      isPrimary: true,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txInsert).toHaveBeenCalledTimes(1);
    expect(result?.id).toBe("work-product-1");
  });

  it("rejects local document work products whose metadata path does not exist", async () => {
    const transaction = vi.fn();
    const svc = workProductService({ transaction } as any);

    const result = await svc.createForIssue("issue-1", "company-1", {
      type: "document",
      provider: "local",
      title: "Missing report",
      status: "active",
      reviewState: "none",
      isPrimary: true,
      metadata: { path: "/tmp/paperclip-missing-report.md" },
    });

    expect(result).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("accepts local document work products when metadata path exists", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paperclip-work-product-"));
    const reportPath = path.join(dir, "report.md");
    writeFileSync(reportPath, "# report\n", "utf8");

    try {
      const updatedWhere = vi.fn(async () => undefined);
      const updateSet = vi.fn(() => ({ where: updatedWhere }));
      const txUpdate = vi.fn(() => ({ set: updateSet }));

      const insertedRow = createWorkProductRow({
        type: "document",
        provider: "local",
        metadata: { path: reportPath },
      });
      const insertReturning = vi.fn(async () => [insertedRow]);
      const insertValues = vi.fn(() => ({ returning: insertReturning }));
      const txInsert = vi.fn(() => ({ values: insertValues }));

      const tx = {
        update: txUpdate,
        insert: txInsert,
      };
      const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));
      const svc = workProductService({ transaction } as any);

      const result = await svc.createForIssue("issue-1", "company-1", {
        type: "document",
        provider: "local",
        title: "Report",
        status: "active",
        reviewState: "none",
        isPrimary: true,
        metadata: { path: reportPath },
      });

      expect(result?.metadata).toEqual({ path: reportPath });
      expect(transaction).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses a transaction when promoting an existing work product to primary", async () => {
    const existingRow = createWorkProductRow({ isPrimary: false });

    const selectWhere = vi.fn(async () => [existingRow]);
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const txSelect = vi.fn(() => ({ from: selectFrom }));

    const updateReturning = vi
      .fn()
      .mockResolvedValue([createWorkProductRow({ reviewState: "ready_for_review" })]);
    const updateWhere = vi.fn(() => ({ returning: updateReturning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const tx = {
      select: txSelect,
      update: txUpdate,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.update("work-product-1", {
      isPrimary: true,
      reviewState: "ready_for_review",
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txSelect).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(2);
    expect(result?.reviewState).toBe("ready_for_review");
  });
});
