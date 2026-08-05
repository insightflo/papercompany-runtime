---
title: Access & Members
summary: Board claim, CLI auth, invites, join requests, members, and permission groups
---

Access endpoints manage who can reach the control plane: board operator claims, CLI authentication challenges, invites, join requests, members, and permission groups.

## Board Claim

### Get Claim

```
GET /api/board-claim/{token}
```

Returns board claim details for a token.

### Claim Board

```
POST /api/board-claim/{token}/claim
{
  "name": "Founder"
}
```

Claims the board seat using a token.

## CLI Auth

### Get Challenge

```
GET /api/cli-auth/challenges/{challengeId}
```

Returns a CLI authentication challenge for the interactive login flow.

### Who Am I

```
GET /api/cli-auth/me
```

Returns the currently authenticated CLI identity.

### Revoke Current Session

```
POST /api/cli-auth/revoke-current
```

Revokes the current CLI session.

## Skills

### Available Skills

```
GET /api/skills/available
```

Lists skills available for install.

### Skill Index

```
GET /api/skills/index
```

Returns the skill index.

### Get Skill

```
GET /api/skills/{skillName}
```

Returns a skill's metadata and content.

## Invites

### Get Invite

```
GET /api/invites/{token}
```

### Get Invite Onboarding

```
GET /api/invites/{token}/onboarding
```

### Get Invite Onboarding Text

```
GET /api/invites/{token}/onboarding.txt
```

### Test Invite Resolution

```
GET /api/invites/{token}/test-resolution
```

Tests whether an invite token resolves for the current actor.

### Revoke Invite

```
POST /api/invites/{inviteId}/revoke
```

Revokes an invite.

## Join Requests

### List Join Requests

```
GET /api/companies/{companyId}/join-requests
```

Lists pending join requests for the company.

## Members

### List Members

```
GET /api/companies/{companyId}/members
```

Lists company members.

### Search Users

```
GET /api/companies/{companyId}/users/search?q=founder
```

Searches users by name or email.

## Admin

### User Company Access

```
GET /api/admin/users/{userId}/company-access
```

Returns the companies a user can access (instance admin only).

## Permission Groups

### List Permission Groups

```
GET /api/companies/{companyId}/permission-groups
```

### Get Permission Group

```
GET /api/companies/{companyId}/permission-groups/{groupId}
```

### Delete Permission Group

```
DELETE /api/companies/{companyId}/permission-groups/{groupId}
```
