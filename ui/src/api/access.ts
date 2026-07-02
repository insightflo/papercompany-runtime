import type {
  AgentAdapterType,
  CompanyMembership,
  JoinRequest,
  PermissionKey,
  PrincipalPermissionGrant,
} from "@paperclipai/shared";
import { api } from "./client";

type InviteSummary = {
  id: string;
  companyId: string | null;
  inviteType: "company_join" | "bootstrap_ceo";
  allowedJoinTypes: "human" | "agent" | "both";
  expiresAt: string;
  onboardingPath?: string;
  onboardingUrl?: string;
  onboardingTextPath?: string;
  onboardingTextUrl?: string;
  skillIndexPath?: string;
  skillIndexUrl?: string;
  inviteMessage?: string | null;
};

type AcceptInviteInput =
  | { requestType: "human" }
  | {
    requestType: "agent";
    agentName: string;
    adapterType?: AgentAdapterType;
    capabilities?: string | null;
    agentDefaultsPayload?: Record<string, unknown> | null;
  };

type AgentJoinRequestAccepted = JoinRequest & {
  claimSecret: string;
  claimApiKeyPath: string;
  onboarding?: Record<string, unknown>;
  diagnostics?: Array<{
    code: string;
    level: "info" | "warn";
    message: string;
    hint?: string;
  }>;
};

type InviteOnboardingManifest = {
  invite: InviteSummary;
  onboarding: {
    inviteMessage?: string | null;
    connectivity?: {
      guidance?: string;
      connectionCandidates?: string[];
      testResolutionEndpoint?: {
        method?: string;
        path?: string;
        url?: string;
      };
    };
    textInstructions?: {
      url?: string;
    };
  };
};

type BoardClaimStatus = {
  status: "available" | "claimed" | "expired";
  requiresSignIn: boolean;
  expiresAt: string | null;
  claimedByUserId: string | null;
};

type CliAuthChallengeStatus = {
  id: string;
  status: "pending" | "approved" | "cancelled" | "expired";
  command: string;
  clientName: string | null;
  requestedAccess: "board" | "instance_admin_required";
  requestedCompanyId: string | null;
  requestedCompanyName: string | null;
  approvedAt: string | null;
  cancelledAt: string | null;
  expiresAt: string;
  approvedByUser: { id: string; name: string; email: string } | null;
  requiresSignIn: boolean;
  canApprove: boolean;
  currentUserId: string | null;
};

type CompanyInviteCreated = {
  id: string;
  token: string;
  inviteUrl: string;
  expiresAt: string;
  allowedJoinTypes: "human" | "agent" | "both";
  onboardingTextPath?: string;
  onboardingTextUrl?: string;
  inviteMessage?: string | null;
};

export type AccessGrantInput = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

export type PermissionGroup = {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  status: "active" | "suspended";
  createdAt: string;
  updatedAt: string;
};

export type PermissionGroupMember = {
  id: string;
  companyId: string;
  groupId: string;
  userId: string;
  status: "active" | "suspended";
  createdAt: string;
  updatedAt: string;
};

export type CompanyAccessMember = CompanyMembership & {
  grants: PrincipalPermissionGrant[];
  groupMemberships: Array<{ groupId: string; status: string }>;
  user?: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
};

export type PermissionGroupDetail = PermissionGroup & {
  members: PermissionGroupMember[];
  grants: PrincipalPermissionGrant[];
};

export const accessApi = {
  createCompanyInvite: (
    companyId: string,
    input: {
      allowedJoinTypes?: "human" | "agent" | "both";
      defaultsPayload?: Record<string, unknown> | null;
      agentMessage?: string | null;
    } = {},
  ) =>
    api.post<CompanyInviteCreated>(`/companies/${companyId}/invites`, input),

  createOpenClawInvitePrompt: (
    companyId: string,
    input: {
      agentMessage?: string | null;
    } = {},
  ) =>
    api.post<CompanyInviteCreated>(
      `/companies/${companyId}/openclaw/invite-prompt`,
      input,
    ),

  getInvite: (token: string) => api.get<InviteSummary>(`/invites/${token}`),
  getInviteOnboarding: (token: string) =>
    api.get<InviteOnboardingManifest>(`/invites/${token}/onboarding`),

  acceptInvite: (token: string, input: AcceptInviteInput) =>
    api.post<AgentJoinRequestAccepted | JoinRequest | { bootstrapAccepted: true; userId: string }>(
      `/invites/${token}/accept`,
      input,
    ),

  listJoinRequests: (companyId: string, status: "pending_approval" | "approved" | "rejected" = "pending_approval") =>
    api.get<JoinRequest[]>(`/companies/${companyId}/join-requests?status=${status}`),

  listMembers: (companyId: string) =>
    api.get<CompanyAccessMember[]>(`/companies/${companyId}/members`),

  updateMemberPermissions: (
    companyId: string,
    memberId: string,
    grants: AccessGrantInput[],
  ) =>
    api.patch<CompanyMembership>(`/companies/${companyId}/members/${memberId}/permissions`, {
      grants,
    }),

  listPermissionGroups: (companyId: string) =>
    api.get<PermissionGroup[]>(`/companies/${companyId}/permission-groups`),

  createPermissionGroup: (
    companyId: string,
    input: { name: string; description?: string | null; status?: "active" | "suspended" },
  ) => api.post<PermissionGroup>(`/companies/${companyId}/permission-groups`, input),

  getPermissionGroup: (companyId: string, groupId: string) =>
    api.get<PermissionGroupDetail>(`/companies/${companyId}/permission-groups/${groupId}`),

  updatePermissionGroup: (
    companyId: string,
    groupId: string,
    input: { name?: string; description?: string | null; status?: "active" | "suspended" },
  ) => api.patch<PermissionGroup>(`/companies/${companyId}/permission-groups/${groupId}`, input),

  deletePermissionGroup: (companyId: string, groupId: string) =>
    api.delete<void>(`/companies/${companyId}/permission-groups/${groupId}`),

  updatePermissionGroupMembers: (
    companyId: string,
    groupId: string,
    input: { addUserIds?: string[]; removeUserIds?: string[] },
  ) =>
    api.put<PermissionGroupMember[]>(
      `/companies/${companyId}/permission-groups/${groupId}/members`,
      input,
    ),

  updatePermissionGroupPermissions: (
    companyId: string,
    groupId: string,
    grants: AccessGrantInput[],
  ) =>
    api.patch<PrincipalPermissionGrant[]>(
      `/companies/${companyId}/permission-groups/${groupId}/permissions`,
      { grants },
    ),

  approveJoinRequest: (companyId: string, requestId: string) =>
    api.post<JoinRequest>(`/companies/${companyId}/join-requests/${requestId}/approve`, {}),

  rejectJoinRequest: (companyId: string, requestId: string) =>
    api.post<JoinRequest>(`/companies/${companyId}/join-requests/${requestId}/reject`, {}),

  claimJoinRequestApiKey: (requestId: string, claimSecret: string) =>
    api.post<{ keyId: string; token: string; agentId: string; createdAt: string }>(
      `/join-requests/${requestId}/claim-api-key`,
      { claimSecret },
    ),

  getBoardClaimStatus: (token: string, code: string) =>
    api.get<BoardClaimStatus>(`/board-claim/${token}?code=${encodeURIComponent(code)}`),

  claimBoard: (token: string, code: string) =>
    api.post<{ claimed: true; userId: string }>(`/board-claim/${token}/claim`, { code }),

  getCliAuthChallenge: (id: string, token: string) =>
    api.get<CliAuthChallengeStatus>(`/cli-auth/challenges/${id}?token=${encodeURIComponent(token)}`),

  approveCliAuthChallenge: (id: string, token: string) =>
    api.post<{ approved: boolean; status: string; userId: string; keyId: string | null; expiresAt: string }>(
      `/cli-auth/challenges/${id}/approve`,
      { token },
    ),

  cancelCliAuthChallenge: (id: string, token: string) =>
    api.post<{ cancelled: boolean; status: string }>(`/cli-auth/challenges/${id}/cancel`, { token }),
};
