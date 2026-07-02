import { ShieldCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccessGroupsView } from "./AccessGroupsView";
import { AccessUsersView } from "./AccessUsersView";
import { getErrorMessage } from "./utils";
import { useAccessSettingsController } from "./useAccessSettingsController";

export function AccessSettingsSection({ selectedCompanyId }: { selectedCompanyId: string | null }) {
  const access = useAccessSettingsController(selectedCompanyId);
  const {
    accessError,
    accessLoading,
    createGroup,
    createGroupPending,
    deleteSelectedGroup,
    editingGroupDescription,
    editingGroupName,
    groupById,
    groupMutationPending,
    newGroupDescription,
    newGroupName,
    permissionGroups,
    retryAccess,
    saveSelectedGroup,
    selectedGroup,
    selectedGroupDetail,
    selectedGroupDetailQuery,
    selectedGroupId,
    setEditingGroupDescription,
    setEditingGroupName,
    setNewGroupDescription,
    setNewGroupName,
    setSelectedGroupId,
    toggleGroupGrant,
    toggleGroupMember,
    toggleGroupStatus,
    toggleUserGrant,
    updateMemberPermissionsPending,
    userMembers,
  } = access;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        <ShieldCheck className="h-3.5 w-3.5" />
        Access
      </div>
      <div className="rounded-md border border-border px-4 py-4" data-testid="access-settings">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">User and group permissions</div>
            <div className="text-xs text-muted-foreground">
              Manage direct user grants and inherited group grants for this company.
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{userMembers.length} users</span>
            <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
            <span>{permissionGroups.length} groups</span>
          </div>
        </div>

        {accessLoading && (
          <div className="mt-4 text-sm text-muted-foreground">Loading access settings...</div>
        )}
        {accessError && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 px-3 py-2 text-sm">
            <span className="text-destructive">
              Access settings failed to load:{" "}
              {getErrorMessage(accessError, "Request failed.")}
            </span>
            <Button size="sm" variant="outline" onClick={retryAccess}>
              Retry
            </Button>
          </div>
        )}

        {!accessLoading && !accessError && (
          <Tabs defaultValue="users" className="mt-4">
            <TabsList variant="line" className="justify-start">
              <TabsTrigger value="users" className="gap-1.5">
                <Users className="h-3.5 w-3.5" />
                Users
              </TabsTrigger>
              <TabsTrigger value="groups" className="gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5" />
                Groups
              </TabsTrigger>
            </TabsList>

            <TabsContent value="users" className="mt-4">
              <AccessUsersView
                members={userMembers}
                groupById={groupById}
                disabled={updateMemberPermissionsPending}
                onToggleGrant={toggleUserGrant}
              />
            </TabsContent>

            <TabsContent value="groups" className="mt-4">
              <AccessGroupsView
                permissionGroups={permissionGroups}
                userMembers={userMembers}
                selectedGroupId={selectedGroupId}
                selectedGroup={selectedGroup}
                selectedGroupDetail={selectedGroupDetail}
                selectedGroupDetailLoading={selectedGroupDetailQuery.isLoading}
                selectedGroupDetailError={selectedGroupDetailQuery.error}
                newGroupName={newGroupName}
                newGroupDescription={newGroupDescription}
                editingGroupName={editingGroupName}
                editingGroupDescription={editingGroupDescription}
                creating={createGroupPending}
                disabled={groupMutationPending}
                onSelectGroup={setSelectedGroupId}
                onNewGroupNameChange={setNewGroupName}
                onNewGroupDescriptionChange={setNewGroupDescription}
                onEditingGroupNameChange={setEditingGroupName}
                onEditingGroupDescriptionChange={setEditingGroupDescription}
                onCreateGroup={createGroup}
                onSaveGroup={saveSelectedGroup}
                onToggleStatus={toggleGroupStatus}
                onDeleteGroup={deleteSelectedGroup}
                onToggleMember={toggleGroupMember}
                onToggleGrant={toggleGroupGrant}
              />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
