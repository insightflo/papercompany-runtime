import type { CompanyUserSearchResult, PermissionKey } from "@paperclipai/shared";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CompanyAccessMember } from "../../api/access";
import { PermissionChecklist } from "./PermissionChecklist";
import { getErrorMessage, memberDisplayName, shortId } from "./utils";

export function AccessUsersView({
  members,
  groupById,
  disabled,
  onToggleGrant,
  memberSearchQuery,
  onMemberSearchQueryChange,
  searchResults,
  searchLoading,
  searchError,
  selectedUserId,
  onSelectUser,
  addUserPending,
  onAddSelectedUser,
}: {
  members: CompanyAccessMember[];
  groupById: Map<string, { id: string; name: string }>;
  disabled: boolean;
  onToggleGrant: (member: CompanyAccessMember, permissionKey: PermissionKey, checked: boolean) => void;
  memberSearchQuery: string;
  onMemberSearchQueryChange: (value: string) => void;
  searchResults: CompanyUserSearchResult[];
  searchLoading: boolean;
  searchError: unknown;
  selectedUserId: string | null;
  onSelectUser: (userId: string) => void;
  addUserPending: boolean;
  onAddSelectedUser: () => void;
}) {
  return (
    <div className="space-y-4" data-testid="access-users-view">
      <div className="space-y-2 border-b border-border pb-4">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-sm">
            <span className="mb-1 block font-medium">Add user</span>
            <Input
              className="h-8 min-w-0"
              type="search"
              value={memberSearchQuery}
              placeholder="Search active users by name or email"
              onChange={(event) => onMemberSearchQueryChange(event.target.value)}
            />
          </label>
          <Button
            size="sm"
            onClick={onAddSelectedUser}
            disabled={disabled || addUserPending || !selectedUserId}
          >
            <UserPlus className="h-3.5 w-3.5" />
            {addUserPending ? "Adding..." : "Add"}
          </Button>
        </div>

        {memberSearchQuery.trim().length === 0 ? null : searchLoading ? (
          <div className="text-sm text-muted-foreground">Searching users...</div>
        ) : searchError ? (
          <div className="text-sm text-destructive">
            {getErrorMessage(searchError, "User search failed.")}
          </div>
        ) : searchResults.length === 0 ? (
          <div className="text-sm text-muted-foreground">No matching users available.</div>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {searchResults.map((user) => (
              <button
                key={user.id}
                type="button"
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                aria-pressed={selectedUserId === user.id}
                onClick={() => onSelectUser(user.id)}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {user.name || user.email || shortId(user.id)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {user.email ?? shortId(user.id)}
                  </span>
                </span>
                {selectedUserId === user.id && (
                  <span className="shrink-0 text-xs text-muted-foreground">Selected</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {members.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          No human users have access to this company yet.
        </div>
      ) : (
        <div className="divide-y divide-border">
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
      )}
    </div>
  );
}
