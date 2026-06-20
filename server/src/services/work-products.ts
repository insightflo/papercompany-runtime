import { and, desc, eq } from "drizzle-orm";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts } from "@paperclipai/db";
import type { IssueWorkProduct } from "@paperclipai/shared";

type IssueWorkProductRow = typeof issueWorkProducts.$inferSelect;
type WorkProductOpenTarget = { kind: "path" | "url"; value: string };
type WorkProductOpener = (target: string) => Promise<void>;

export class WorkProductOpenError extends Error {
  code: "no_open_target" | "path_not_found" | "open_failed";

  constructor(code: WorkProductOpenError["code"], message: string) {
    super(message);
    this.name = "WorkProductOpenError";
    this.code = code;
  }
}

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

export function resolveWorkProductOpenTarget(product: Pick<IssueWorkProduct, "metadata" | "provider" | "url">): WorkProductOpenTarget | null {
  const localPath = metadataPath(product.metadata);
  if (localPath && path.isAbsolute(localPath)) return { kind: "path", value: localPath };

  const url = product.url?.trim();
  if (url && isOpenableUrl(url)) return { kind: "url", value: url };

  return null;
}

function defaultOsOpener(target: string): Promise<void> {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "rundll32.exe"
      : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", target] : [target];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function openWorkProductWithDefaultApp(
  product: IssueWorkProduct,
  options: { opener?: WorkProductOpener } = {},
): Promise<WorkProductOpenTarget> {
  const target = resolveWorkProductOpenTarget(product);
  if (!target) {
    throw new WorkProductOpenError("no_open_target", "Work product has no local path or openable URL");
  }
  if (target.kind === "path" && !existsSync(target.value)) {
    throw new WorkProductOpenError("path_not_found", "Work product path does not exist");
  }

  try {
    await (options.opener ?? defaultOsOpener)(target.value);
    return target;
  } catch (error) {
    throw new WorkProductOpenError(
      "open_failed",
      error instanceof Error ? error.message : "Failed to open work product",
    );
  }
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
