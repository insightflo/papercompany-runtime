---
title: Access & Members (접근 및 멤버)
summary: 보드 클레임, CLI 인증, 초대, 가입 요청, 멤버, 권한 그룹
---

접근 엔드포인트는 누가 제어 플레인에 도달할 수 있는지 관리합니다: 보드 운영자 클레임, CLI 인증 챌린지, 초대, 가입 요청, 멤버, 권한 그룹.

## 보드 클레임

### 클레임 조회

```
GET /api/board-claim/{token}
```

토큰에 대한 보드 클레임 세부 정보를 반환합니다.

### 보드 클레임

```
POST /api/board-claim/{token}/claim
{
  "name": "Founder"
}
```

토큰을 사용하여 보드 자리를 클레임합니다.

## CLI 인증

### 챌린지 조회

```
GET /api/cli-auth/challenges/{challengeId}
```

대화형 로그인 흐름을 위한 CLI 인증 챌린지를 반환합니다.

### Who Am I

```
GET /api/cli-auth/me
```

현재 인증된 CLI 신원을 반환합니다.

### 현재 세션 폐기

```
POST /api/cli-auth/revoke-current
```

현재 CLI 세션을 폐기합니다.

## 스킬

### 사용 가능한 스킬

```
GET /api/skills/available
```

설치 가능한 스킬을 나열합니다.

### 스킬 인덱스

```
GET /api/skills/index
```

스킬 인덱스를 반환합니다.

### 스킬 조회

```
GET /api/skills/{skillName}
```

스킬의 메타데이터와 콘텐츠를 반환합니다.

## 초대

### 초대 조회

```
GET /api/invites/{token}
```

### 초대 온보딩

```
GET /api/invites/{token}/onboarding
```

### 초대 온보딩 텍스트

```
GET /api/invites/{token}/onboarding.txt
```

### 초대 해석 테스트

```
GET /api/invites/{token}/test-resolution
```

초대 토큰이 현재 액터에 대해 해석되는지 테스트합니다.

### 초대 폐기

```
POST /api/invites/{inviteId}/revoke
```

초대를 폐기합니다.

## 가입 요청

### 가입 요청 목록

```
GET /api/companies/{companyId}/join-requests
```

회사의 보류 중인 가입 요청을 나열합니다.

## 멤버

### 멤버 목록

```
GET /api/companies/{companyId}/members
```

회사 멤버를 나열합니다.

### 사용자 검색

```
GET /api/companies/{companyId}/users/search?q=founder
```

이름 또는 이메일로 사용자를 검색합니다.

## 관리자

### 사용자 회사 접근

```
GET /api/admin/users/{userId}/company-access
```

사용자가 접근할 수 있는 회사를 반환합니다(인스턴스 관리자만).

## 권한 그룹

### 권한 그룹 목록

```
GET /api/companies/{companyId}/permission-groups
```

### 권한 그룹 조회

```
GET /api/companies/{companyId}/permission-groups/{groupId}
```

### 권한 그룹 삭제

```
DELETE /api/companies/{companyId}/permission-groups/{groupId}
```
