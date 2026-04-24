import type { Db } from "@paperclipai/db";
import { createSrbPairSync } from "./pair-sync.js";

export async function syncSrbSourceIssueStatus(input: {
  db: Db;
  issueId: string;
  status: string | null | undefined;
}) {
  if (!input.status) return [];
  return await createSrbPairSync(input.db).syncSourceStatus({
    sourceIssueId: input.issueId,
    sourceStatus: input.status,
  });
}
