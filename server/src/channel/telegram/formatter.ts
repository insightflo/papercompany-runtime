/**
 * Telegram Formatter
 *
 * Formats mission and issue data into human-readable Telegram messages.
 * Used by commands.ts (#27) and outbound notifier (#30).
 */

import type { TelegramMessage } from "./types.js";

/**
 * Format a mission status response for Telegram.
 */
export function formatMissionStatus(input: {
  missionId: string;
  title: string;
  status: string;
  ownerAgentId: string;
  executorCount: number;
  issueCount: number;
  startedAt?: string | null;
  completedAt?: string | null;
}): string {
  const lines: string[] = [];

  lines.push(`*Mission:* ${input.title}`);
  lines.push(`*Status:* ${input.status}`);
  lines.push(`*ID:* \`${input.missionId}\``);

  if (input.startedAt) {
    lines.push(`*Started:* ${formatDate(input.startedAt)}`);
  }
  if (input.completedAt) {
    lines.push(`*Completed:* ${formatDate(input.completedAt)}`);
  }

  lines.push("");
  lines.push(`Agents: ${input.executorCount} | Issues: ${input.issueCount}`);

  return lines.join("\n");
}

/**
 * Format an issue for Telegram display.
 */
export function formatIssue(input: {
  issueId: string;
  identifier?: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentName?: string | null;
}): string {
  const priorityEmoji = getPriorityEmoji(input.priority);
  const statusEmoji = getStatusEmoji(input.status);

  const lines: string[] = [];
  lines.push(`${priorityEmoji} ${statusEmoji} *${input.identifier ?? input.issueId}*`);
  lines.push(`   ${input.title}`);

  if (input.assigneeAgentName) {
    lines.push(`   Assignee: ${input.assigneeAgentName}`);
  }

  return lines.join("\n");
}

/**
 * Format a list of issues as a Telegram message.
 */
export function formatIssueList(issues: Array<{
  issueId: string;
  identifier?: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentName?: string | null;
}>): string {
  if (issues.length === 0) {
    return "No issues found.";
  }

  const lines = issues.map((issue) => formatIssue(issue));
  return lines.join("\n\n");
}

/**
 * Format an approval request for Telegram.
 */
export function formatApprovalRequest(input: {
  approvalId: string;
  issueTitle: string;
  requestedBy: string;
  createdAt: string;
}): string {
  const lines: string[] = [];
  lines.push("*Approval Required*");
  lines.push(`Issue: ${input.issueTitle}`);
  lines.push(`Requested by: ${input.requestedBy}`);
  lines.push(`Time: ${formatDate(input.createdAt)}`);
  lines.push("");
  lines.push("Use /approve or /reject to respond.");
  return lines.join("\n");
}

/**
 * Format a mission creation confirmation.
 */
export function formatMissionCreated(input: {
  missionId: string;
  title: string;
}): string {
  return `*Mission Created*\n\nTitle: ${input.title}\nID: \`${input.missionId}\`\n\nUse /mission ${input.missionId} to view details.`;
}

/**
 * Format a generic error message for Telegram.
 */
export function formatError(message: string): string {
  return `*Error*\n${message}`;
}

/**
 * Format a help message for available commands.
 */
export function formatHelp(): string {
  const lines: string[] = [];
  lines.push("*Available Commands*");
  lines.push("/status — View bot status");
  lines.push("/mission <id> — View mission details");
  lines.push("/mission create <title> — Create a new mission");
  lines.push("/approve <id> — Approve a request");
  lines.push("/assign <issue> <agent> — Assign issue to agent");
  return lines.join("\n");
}

/**
 * Format a success message.
 */
export function formatSuccess(message: string): string {
  return `*Success*\n${message}`;
}

/**
 * Format a date string for Telegram (local timezone friendly).
 */
export function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleString();
  } catch {
    return isoString;
  }
}

/**
 * Get emoji for priority level.
 */
function getPriorityEmoji(priority: string): string {
  switch (priority.toLowerCase()) {
    case "critical":
    case "urgent":
      return "\u{1F6A8}";
    case "high":
      return "\u{1F525}";
    case "medium":
      return "\u{1F4E0}";
    case "low":
      return "\u{1F4CB}";
    default:
      return "\u{2753}";
  }
}

/**
 * Get emoji for issue status.
 */
function getStatusEmoji(status: string): string {
  switch (status.toLowerCase()) {
    case "backlog":
      return "\u{1F4CC}";
    case "todo":
      return "\u{2610}";
    case "in_progress":
      return "\u{1F3D7}";
    case "in_review":
      return "\u{1F50D}";
    case "blocked":
      return "\u{1F6AB}";
    case "done":
    case "completed":
      return "\u{2705}";
    case "cancelled":
      return "\u{274C}";
    default:
      return "\u{2753}";
  }
}
