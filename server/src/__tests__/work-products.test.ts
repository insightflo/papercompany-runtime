import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  resolveWorkProductBrowserOpenTarget,
  resolveWorkProductLocalFilePath,
  resolveWorkProductOpenTarget,
  workProductService,
} from "../services/work-products.ts";

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
  it("resolves local file work products to their metadata path", () => {
    const target = resolveWorkProductOpenTarget(createWorkProductRow({
      type: "document",
      provider: "local",
      metadata: { path: "/tmp/report.html" },
      url: null,
    }) as any);

    expect(target).toEqual({ kind: "path", value: "/tmp/report.html" });
  });

  it("resolves URL work products to their URL", () => {
    const target = resolveWorkProductOpenTarget(createWorkProductRow({
      provider: "paperclip",
      url: "https://example.com/report.html",
      metadata: null,
    }) as any);

    expect(target).toEqual({ kind: "url", value: "https://example.com/report.html" });
  });

  it("rejects local work products without an absolute metadata path", () => {
    const target = resolveWorkProductOpenTarget(createWorkProductRow({
      type: "document",
      provider: "local",
      metadata: { path: "relative/report.html" },
      url: null,
    }) as any);

    expect(target).toBeNull();
  });

  it("resolves file URL work products to a local path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paperclip-work-product-open-"));
    const reportPath = path.join(dir, "report.html");
    writeFileSync(reportPath, "<h1>report</h1>\n", "utf8");

    try {
      const result = resolveWorkProductLocalFilePath(createWorkProductRow({
        type: "document",
        provider: "local",
        metadata: null,
        url: pathToFileURL(reportPath).toString(),
      }) as any);

      expect(result).toBe(reportPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an API content URL for local files when opening in a browser", () => {
    const target = resolveWorkProductBrowserOpenTarget(createWorkProductRow({
      id: "work-product-1",
      type: "document",
      provider: "local",
      metadata: { path: "/tmp/report.html" },
      url: null,
    }) as any);

    expect(target).toEqual({ kind: "url", value: "/api/work-products/work-product-1/content" });
  });

  it("keeps HTTP URLs as browser-open targets", () => {
    const target = resolveWorkProductBrowserOpenTarget(createWorkProductRow({
      id: "work-product-1",
      provider: "paperclip",
      metadata: null,
      url: "https://example.com/report.html",
    }) as any);

    expect(target).toEqual({ kind: "url", value: "https://example.com/report.html" });
  });

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
