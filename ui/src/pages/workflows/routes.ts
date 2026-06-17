const BOARD_ROUTE_ROOTS = new Set([
  "missions",
  "dashboard",
  "companies",
  "company",
  "skills",
  "org",
  "agents",
  "projects",
  "issues",
  "routines",
  "goals",
  "approvals",
  "costs",
  "usage",
  "activity",
  "inbox",
  "design-guide",
]);

const GLOBAL_ROUTE_ROOTS = new Set([
  "auth",
  "invite",
  "board-claim",
  "cli-auth",
  "docs",
  "instance",
  "channels",
  "scheduler",
  "worktree",
]);

function extractIssuePrefix(issueIdentifier?: string): string | null {
  const value = issueIdentifier?.trim();
  if (!value) return null;
  const match = value.match(/^([A-Za-z][A-Za-z0-9]*)-/);
  return match ? match[1]!.toUpperCase() : null;
}

function extractCompanyPrefixFromPath(pathname?: string): string | null {
  const path = pathname?.trim();
  if (!path) return null;
  const first = path.split(/[?#]/)[0]!.split("/").filter(Boolean)[0];
  if (!first) return null;
  const lower = first.toLowerCase();
  if (BOARD_ROUTE_ROOTS.has(lower) || GLOBAL_ROUTE_ROOTS.has(lower)) return null;
  if (first.includes("-")) return null;
  return first.toUpperCase();
}

export function buildIssueHref(input: {
  issueId: string;
  issueIdentifier?: string;
  currentPathname?: string;
}): string {
  const issueId = input.issueId.trim();
  const companyPrefix = extractIssuePrefix(input.issueIdentifier) ?? extractCompanyPrefixFromPath(input.currentPathname);
  if (companyPrefix) return `/${companyPrefix}/issues/${encodeURIComponent(issueId)}`;
  return `/issues/${encodeURIComponent(issueId)}`;
}

export function buildMissionHref(input: {
  missionId: string;
  currentPathname?: string;
}): string {
  const missionId = input.missionId.trim();
  const companyPrefix = extractCompanyPrefixFromPath(input.currentPathname);
  if (companyPrefix) return `/${companyPrefix}/missions/${encodeURIComponent(missionId)}`;
  return `/missions/${encodeURIComponent(missionId)}`;
}
