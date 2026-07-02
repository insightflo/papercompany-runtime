import type { PermissionKey } from "@paperclipai/shared";
import type { CompanyAccessMember } from "../../api/access";
import { PermissionChecklist } from "./PermissionChecklist";
import { memberDisplayName, shortId } from "./utils";

export function AccessUsersView({
  members,
  groupById,
  disabled,
  onToggleGrant,
}: {
  members: CompanyAccessMember[];
  groupById: Map<string, { id: string; name: string }>;
  disabled: boolean;
  onToggleGrant: (member: CompanyAccessMember, permissionKey: PermissionKey, checked: boolean) => void;
}) {
  if (members.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No human users have access to this company yet.
      </div>
    );
  }

  return (
    <div className="divide-y divide-border" data-testid="access-users-view">
      {members.map((member) => (
        <div
          key={member.id}
          className="grid gap-3 py-3 md:grid-cols-[minmax(180px,240px)_minmax(0,1fr)]"
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{memberDisplayName(member)}</div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {member.user?.email ?? shortId(member.principalId)}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {member.membershipRole ?? "member"}
              </span>
              <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {member.status}
              </span>
              {member.groupMemberships.length === 0 ? (
                <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  no groups
                </span>
              ) : (
                member.groupMemberships.map((membership) => (
                  <span
                    key={membership.groupId}
                    className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {groupById.get(membership.groupId)?.name ?? shortId(membership.groupId)}
                  </span>
                ))
              )}
            </div>
          </div>
          <PermissionChecklist
            grants={member.grants}
            disabled={disabled}
            onToggle={(permissionKey, checked) => onToggleGrant(member, permissionKey, checked)}
          />
        </div>
      ))}
    </div>
  );
}
