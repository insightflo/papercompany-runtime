export const CREATE_PARENT_ISSUE_POLICIES = ["never", "when_multiple_steps", "always"] as const;

export type CreateParentIssuePolicy = typeof CREATE_PARENT_ISSUE_POLICIES[number];

export function normalizeCreateParentIssuePolicy(value: unknown): CreateParentIssuePolicy {
  if (value === "never" || value === "always" || value === "when_multiple_steps") {
    return value;
  }
  return "when_multiple_steps";
}

export function shouldCreateParentIssueForRun(input: {
  explicitCreateParentIssue?: boolean;
  policy: unknown;
  stepCount: number;
}): boolean {
  if (typeof input.explicitCreateParentIssue === "boolean") {
    return input.explicitCreateParentIssue;
  }

  const policy = normalizeCreateParentIssuePolicy(input.policy);
  if (policy === "always") {
    return true;
  }
  if (policy === "never") {
    return false;
  }

  return input.stepCount > 1;
}
