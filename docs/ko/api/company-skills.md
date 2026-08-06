---
title: Company Skills (회사 스킬)
summary: 회사 범위 에이전트 스킬, 가져오기, 프로젝트 스캔
---

회사는 에이전트가 런타임에 사용하는 자체 스킬 라이브러리를 유지 관리할 수 있습니다. 스킬은 버전 관리되며 에이전트 워크스페이스에 동기화됩니다.

## 스킬 목록

```
GET /api/companies/{companyId}/skills
```

회사에 정의된 모든 스킬을 반환합니다.

## 스킬 조회

```
GET /api/companies/{companyId}/skills/{skillId}
```

메타데이터를 포함한 단일 스킬을 반환합니다.

## 스킬 생성

```
POST /api/companies/{companyId}/skills
{
  "slug": "html-for-beginners",
  "name": "HTML for Beginners",
  "description": "Guidance for writing beginner-friendly HTML",
  "markdown": "# Skill content in markdown"
}
```

새 로컬 회사 스킬을 생성합니다. 스킬 본문은 `markdown` 필드로 제공합니다.

## 상태 업데이트

```
GET /api/companies/{companyId}/skills/{skillId}/update-status
```

스킬의 동기화/업데이트 상태를 반환합니다.

## 스킬 파일

### 파일 목록

```
GET /api/companies/{companyId}/skills/{skillId}/files
```

스킬의 파일 트리를 반환합니다.

### 파일 수정

```
PATCH /api/companies/{companyId}/skills/{skillId}/files
{
  "path": "SKILL.md",
  "content": "# Updated content"
}
```

스킬 내 단일 파일을 수정합니다.

## 설치 / 업데이트

```
POST /api/companies/{companyId}/skills/{skillId}/install-update
```

스킬을 설치하거나 보류 중인 업데이트를 에이전트 워크스페이스에 적용합니다.

## 가져오기

```
POST /api/companies/{companyId}/skills/import
{
  "source": "insightflo/papercompany-operations/company-skills/html-for-beginners"
}
```

GitHub 리포지토리 또는 로컬 경로에서 스킬을 가져옵니다. `imported`, `warnings`, 충돌 세부 정보를 반환합니다.

## 프로젝트 스캔

```
POST /api/companies/{companyId}/skills/scan-projects
{
  "projectIds": ["{projectId}"]
}
```

스킬 파일(예: `.agents/skills`, `SKILL.md`)을 프로젝트 워크스페이스에서 스캔하여 가져오거나 업데이트합니다. `discovered`, `imported`, `updated`, `conflicts`, `warnings`를 반환합니다.

## 스킬 삭제

```
DELETE /api/companies/{companyId}/skills/{skillId}
```

스킬을 삭제합니다.
