import path from "node:path";
import type { Db } from "@paperclipai/db";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { workProductService } from "../work-products.js";

// [local title canonicalization] a local-file workProduct title is server-controlled as
//   the path basename regardless of any client-supplied title, so the stored title is an
//   exact filename for downstream matching (e.g. a work_product_json condition keyed on
//   "topic-decision.json"). preview_url keeps its friendly title and is not handled here.
export function canonicalLocalArtifactTitle(artifactPath: string): string {
  return path.basename(artifactPath.trim()) || "Workflow artifact";
}

// [same-path repair] re-registering the same path repairs a stale/wrong title to the
//   canonical basename instead of returning the old record unchanged. The existing row is
//   already company/issue-scoped and has passed the mission output-root path assertion, so
//   only the title is reconciled; authority stays with the Workflow API.
export async function reconcileExistingLocalArtifactTitle(
  db: Db,
  existing: IssueWorkProduct,
  artifactPath: string,
): Promise<IssueWorkProduct> {
  const canonicalTitle = canonicalLocalArtifactTitle(artifactPath);
  if (existing.title === canonicalTitle) return existing;
  return (await workProductService(db).update(existing.id, { title: canonicalTitle })) ?? existing;
}
