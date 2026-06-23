import { and, desc, eq } from "drizzle-orm";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts } from "@paperclipai/db";
import type { IssueWorkProduct } from "@paperclipai/shared";

type IssueWorkProductRow = typeof issueWorkProducts.$inferSelect;
type WorkProductOpenTarget = { kind: "path" | "url"; value: string };
type WorkProductBrowserOpenTarget = { kind: "url"; value: string };

function toIssueWorkProduct(row: IssueWorkProductRow): IssueWorkProduct {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    issueId: row.issueId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    runtimeServiceId: row.runtimeServiceId ?? null,
    type: row.type as IssueWorkProduct["type"],
    provider: row.provider,
    externalId: row.externalId ?? null,
    title: row.title,
    url: row.url ?? null,
    status: row.status,
    reviewState: row.reviewState as IssueWorkProduct["reviewState"],
    isPrimary: row.isPrimary,
    healthStatus: row.healthStatus as IssueWorkProduct["healthStatus"],
    summary: row.summary ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isLocalFileProvider(provider: string) {
  return provider === "local" || provider === "local_file";
}

function metadataPath(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).path;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isOpenableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:";
  } catch {
    return false;
  }
}

function isBrowserOpenableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function resolveWorkProductLocalFilePath(product: Pick<IssueWorkProduct, "metadata" | "url">): string | null {
  const localPath = metadataPath(product.metadata);
  if (localPath && path.isAbsolute(localPath)) return localPath;

  const url = product.url?.trim();
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return null;
    return fileURLToPath(parsed);
  } catch {
    return null;
  }
}

export function resolveWorkProductOpenTarget(product: Pick<IssueWorkProduct, "metadata" | "provider" | "url">): WorkProductOpenTarget | null {
  const localPath = resolveWorkProductLocalFilePath(product);
  if (localPath) return { kind: "path", value: localPath };

  const url = product.url?.trim();
  if (url && isOpenableUrl(url)) return { kind: "url", value: url };

  return null;
}

export function resolveWorkProductBrowserOpenTarget(
  product: Pick<IssueWorkProduct, "id" | "metadata" | "url">,
): WorkProductBrowserOpenTarget | null {
  const url = product.url?.trim();
  if (url && isBrowserOpenableUrl(url)) return { kind: "url", value: url };

  if (resolveWorkProductLocalFilePath(product)) {
    return { kind: "url", value: `/api/work-products/${encodeURIComponent(product.id)}/content` };
  }

  return null;
}

function hasValidLocalFilePath(data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">) {
  if (!isLocalFileProvider(data.provider)) return true;
  if (data.type !== "artifact" && data.type !== "document") return true;

  const localPath = metadataPath(data.metadata);
  if (!localPath || !path.isAbsolute(localPath)) return false;
  return existsSync(localPath);
}

export function workProductService(db: Db) {
  return {
    listForIssue: async (issueId: string) => {
      const rows = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId))
        .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt));
      return rows.map(toIssueWorkProduct);
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },

    createForIssue: async (issueId: string, companyId: string, data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">) => {
      if (!hasValidLocalFilePath(data)) return null;
      const row = await db.transaction(async (tx) => {
        if (data.isPrimary) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, companyId),
                eq(issueWorkProducts.issueId, issueId),
                eq(issueWorkProducts.type, data.type),
              ),
            );
        }
        return await tx
          .insert(issueWorkProducts)
          .values({
            ...data,
            companyId,
            issueId,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    update: async (id: string, patch: Partial<typeof issueWorkProducts.$inferInsert>) => {
      const row = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        if (patch.isPrimary === true) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, existing.companyId),
                eq(issueWorkProducts.issueId, existing.issueId),
                eq(issueWorkProducts.type, existing.type),
              ),
            );
        }

        return await tx
          .update(issueWorkProducts)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(issueWorkProducts.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    remove: async (id: string) => {
      const row = await db
        .delete(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },
  };
}

export { toIssueWorkProduct };
