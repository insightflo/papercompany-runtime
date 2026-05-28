import type { PluginContext } from "@paperclipai/plugin-sdk";

type IssueUpdatePatch = Parameters<PluginContext["issues"]["update"]>[1];
type IssueRecord = Awaited<ReturnType<PluginContext["issues"]["get"]>>;

function normalizeLabelIds(labelIds?: string[]): string[] {
  return [...new Set((labelIds ?? []).map((labelId) => labelId.trim()).filter(Boolean))];
}

function sameLabelIds(left: string[] | undefined, right: string[] | undefined): boolean {
  const normalizedLeft = normalizeLabelIds(left).sort();
  const normalizedRight = normalizeLabelIds(right).sort();
  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }

  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export async function ensureIssueLabels(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  labelIds?: string[],
): Promise<void> {
  const nextLabelIds = normalizeLabelIds(labelIds);
  if (nextLabelIds.length === 0) {
    return;
  }

  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) {
    return;
  }

  const currentLabelIds = Array.isArray((issue as IssueRecord & { labelIds?: string[] }).labelIds)
    ? (issue as IssueRecord & { labelIds?: string[] }).labelIds
    : [];
  if (sameLabelIds(currentLabelIds, nextLabelIds)) {
    return;
  }

  await ctx.issues.update(issueId, { labelIds: nextLabelIds } as IssueUpdatePatch, companyId);
}
