import type { PermissionKey } from "@paperclipai/shared";
import type { AccessGrantInput, CompanyAccessMember } from "../../api/access";

export type GrantLike = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  "agents:create": "Create agents",
  "users:invite": "Invite users",
  "users:manage_permissions": "Manage permissions",
  "tasks:assign": "Assign tasks",
  "tasks:assign_scope": "Assign scoped tasks",
  "joins:approve": "Approve joins",
};

export const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {
  "agents:create": "Can create or hire agents in this company.",
  "users:invite": "Can create human or agent invites.",
  "users:manage_permissions": "Can change user and group access grants.",
  "tasks:assign": "Can assign tasks to agents.",
  "tasks:assign_scope": "Can assign tasks with scoped routing controls.",
  "joins:approve": "Can approve pending join requests.",
};

export function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function hasGrant(grants: readonly GrantLike[] | undefined, permissionKey: PermissionKey) {
  return !!grants?.some((grant) => grant.permissionKey === permissionKey);
}

export function toggleGrant(
  grants: readonly GrantLike[] | undefined,
  permissionKey: PermissionKey,
  checked: boolean
): AccessGrantInput[] {
  const current = grants ?? [];
  const preserved = current.map((grant) => ({
    permissionKey: grant.permissionKey,
    scope: grant.scope ?? null,
  }));
  if (checked) {
    return hasGrant(current, permissionKey)
      ? preserved
      : [...preserved, { permissionKey, scope: null }];
  }
  return preserved.filter((grant) => grant.permissionKey !== permissionKey);
}

export function memberDisplayName(member: CompanyAccessMember) {
  return member.user?.name || member.user?.email || shortId(member.principalId);
}

export function shortId(value: string) {
  return value.length <= 12 ? value : `${value.slice(0, 8)}...`;
}
