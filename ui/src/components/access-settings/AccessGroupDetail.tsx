import type { PermissionKey } from "@paperclipai/shared";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CompanyAccessMember, PermissionGroup, PermissionGroupDetail } from "../../api/access";
import { PermissionChecklist } from "./PermissionChecklist";
import { getErrorMessage, memberDisplayName, shortId } from "./utils";

export function AccessGroupDetail({
  group,
  detail,
  detailLoading,
  detailError,
  members,
  editingName,
  editingDescription,
  disabled,
  onEditingNameChange,
  onEditingDescriptionChange,
  onSaveGroup,
  onToggleStatus,
  onDeleteGroup,
  onToggleMember,
  onToggleGrant,
}: {
  group: PermissionGroup | null;
  detail: PermissionGroupDetail | null;
  detailLoading: boolean;
  detailError: unknown;
  members: CompanyAccessMember[];
  editingName: string;
  editingDescription: string;
  disabled: boolean;
  onEditingNameChange: (value: string) => void;
  onEditingDescriptionChange: (value: string) => void;
  onSaveGroup: () => void;
  onToggleStatus: (status: "active" | "suspended") => void;
  onDeleteGroup: () => void;
  onToggleMember: (userId: string, checked: boolean) => void;
  onToggleGrant: (permissionKey: PermissionKey, checked: boolean) => void;
}) {
  if (!group) {
    return (
      <div className="text-sm text-muted-foreground">
        Select a group to manage members and inherited permissions.
      </div>
    );
  }

  const memberIds = new Set(detail?.members.map((member) => member.userId) ?? []);
  const groupDirty =
    editingName.trim() !== group.name ||
    editingDescription.trim() !== (group.description ?? "");

  return (
    <div className="space-y-4 lg:border-l lg:border-border lg:pl-4" data-testid="access-group-detail">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <input
          className="min-w-0 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
          type="text"
          value={editingName}
          onChange={(event) => onEditingNameChange(event.target.value)}
        />
        <input
          className="min-w-0 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
          type="text"
          value={editingDescription}
          placeholder="Description"
          onChange={(event) => onEditingDescriptionChange(event.target.value)}
        />
        <Button
          size="sm"
          onClick={onSaveGroup}
          disabled={disabled || !editingName.trim() || !groupDirty}
        >
          Save
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={group.status === "active"}
            disabled={disabled}
            onChange={(event) => onToggleStatus(event.target.checked ? "active" : "suspended")}
          />
          Active group
        </label>
        <Button size="sm" variant="outline" onClick={onDeleteGroup} disabled={disabled}>
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      </div>

      {detailLoading && (
        <div className="text-sm text-muted-foreground">Loading group details...</div>
      )}
      {Boolean(detailError) && (
        <div className="text-sm text-destructive">
          {getErrorMessage(detailError, "Failed to load group details.")}
        </div>
      )}
      {!detailLoading && !detailError && (
        <div className="grid gap-4">
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Members
            </div>
            {members.length === 0 ? (
              <div className="text-sm text-muted-foreground">No users can be added yet.</div>
            ) : (
              <div className="divide-y divide-border">
                {members.map((member) => (
                  <label
                    key={member.id}
                    className="flex min-h-10 items-center justify-between gap-3 py-2 text-sm"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{memberDisplayName(member)}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {member.user?.email ?? shortId(member.principalId)}
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={memberIds.has(member.principalId)}
                      disabled={disabled}
                      onChange={(event) => onToggleMember(member.principalId, event.target.checked)}
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Group permissions
            </div>
            <PermissionChecklist
              grants={detail?.grants ?? []}
              disabled={disabled || !detail}
              onToggle={onToggleGrant}
            />
          </div>
        </div>
      )}
    </div>
  );
}
