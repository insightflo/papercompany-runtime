import type { PermissionKey } from "@paperclipai/shared";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CompanyAccessMember, PermissionGroup, PermissionGroupDetail } from "../../api/access";
import { cn } from "../../lib/utils";
import { AccessGroupDetail } from "./AccessGroupDetail";

export function AccessGroupsView({
  permissionGroups,
  userMembers,
  selectedGroupId,
  selectedGroup,
  selectedGroupDetail,
  selectedGroupDetailLoading,
  selectedGroupDetailError,
  newGroupName,
  newGroupDescription,
  editingGroupName,
  editingGroupDescription,
  creating,
  disabled,
  onSelectGroup,
  onNewGroupNameChange,
  onNewGroupDescriptionChange,
  onEditingGroupNameChange,
  onEditingGroupDescriptionChange,
  onCreateGroup,
  onSaveGroup,
  onToggleStatus,
  onDeleteGroup,
  onToggleMember,
  onToggleGrant,
}: {
  permissionGroups: PermissionGroup[];
  userMembers: CompanyAccessMember[];
  selectedGroupId: string | null;
  selectedGroup: PermissionGroup | null;
  selectedGroupDetail: PermissionGroupDetail | null;
  selectedGroupDetailLoading: boolean;
  selectedGroupDetailError: unknown;
  newGroupName: string;
  newGroupDescription: string;
  editingGroupName: string;
  editingGroupDescription: string;
  creating: boolean;
  disabled: boolean;
  onSelectGroup: (groupId: string) => void;
  onNewGroupNameChange: (value: string) => void;
  onNewGroupDescriptionChange: (value: string) => void;
  onEditingGroupNameChange: (value: string) => void;
  onEditingGroupDescriptionChange: (value: string) => void;
  onCreateGroup: () => void;
  onSaveGroup: () => void;
  onToggleStatus: (status: "active" | "suspended") => void;
  onDeleteGroup: () => void;
  onToggleMember: (userId: string, checked: boolean) => void;
  onToggleGrant: (permissionKey: PermissionKey, checked: boolean) => void;
}) {
  return (
    <div className="space-y-4" data-testid="access-groups-view">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <input
          className="min-w-0 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
          type="text"
          value={newGroupName}
          placeholder="New group name"
          onChange={(event) => onNewGroupNameChange(event.target.value)}
        />
        <input
          className="min-w-0 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
          type="text"
          value={newGroupDescription}
          placeholder="Description"
          onChange={(event) => onNewGroupDescriptionChange(event.target.value)}
        />
        <Button size="sm" onClick={onCreateGroup} disabled={creating || !newGroupName.trim()}>
          <Plus className="h-3.5 w-3.5" />
          {creating ? "Creating..." : "Create"}
        </Button>
      </div>

      {permissionGroups.length === 0 ? (
        <div className="border-t border-border pt-4 text-sm text-muted-foreground">
          No permission groups yet. Create a group to manage inherited access.
        </div>
      ) : (
        <div className="grid gap-4 border-t border-border pt-4 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="space-y-2">
            {permissionGroups.map((group) => {
              const memberCount = userMembers.filter((member) =>
                member.groupMemberships.some((membership) => membership.groupId === group.id)
              ).length;
              return (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => onSelectGroup(group.id)}
                  className={cn(
                    "w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                    selectedGroupId === group.id
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{group.name}</span>
                    <span className="shrink-0 text-[11px] tabular-nums">{memberCount}</span>
                  </div>
                  <div className="mt-1 truncate text-[11px]">
                    {group.status === "active" ? "Active" : "Suspended"}
                  </div>
                </button>
              );
            })}
          </div>

          <AccessGroupDetail
            group={selectedGroup}
            detail={selectedGroupDetail}
            detailLoading={selectedGroupDetailLoading}
            detailError={selectedGroupDetailError}
            members={userMembers}
            editingName={editingGroupName}
            editingDescription={editingGroupDescription}
            onEditingNameChange={onEditingGroupNameChange}
            onEditingDescriptionChange={onEditingGroupDescriptionChange}
            onSaveGroup={onSaveGroup}
            onToggleStatus={onToggleStatus}
            onDeleteGroup={onDeleteGroup}
            onToggleMember={onToggleMember}
            onToggleGrant={onToggleGrant}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}
