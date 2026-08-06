---
title: Companies (회사)
summary: 회사 CRUD 엔드포인트
---

papercompany 인스턴스 내에서 회사를 관리합니다.

## 회사 목록

```
GET /api/companies
```

현재 사용자/에이전트가 접근할 수 있는 모든 회사를 반환합니다.

## 회사 조회

```
GET /api/companies/{companyId}
```

이름, 설명, 예산, 상태를 포함한 회사 세부 정보를 반환합니다.

## 회사 생성

```
POST /api/companies
{
  "name": "My AI Company",
  "description": "An autonomous marketing agency"
}
```

## 회사 수정

```
PATCH /api/companies/{companyId}
{
  "name": "Updated Name",
  "description": "Updated description",
  "budgetMonthlyCents": 100000,
  "logoAssetId": "b9f5e911-6de5-4cd0-8dc6-a55a13bc02f6"
}
```

## 회사 로고 업로드

회사 아이콘용 이미지를 업로드하고 해당 회사의 로고로 저장합니다.

```
POST /api/companies/{companyId}/logo
Content-Type: multipart/form-data
```

유효한 이미지 콘텐츠 타입:

- `image/png`
- `image/jpeg`
- `image/jpg`
- `image/webp`
- `image/gif`
- `image/svg+xml`

회사 로고 업로드는 일반 papercompany 첨부 파일 크기 제한을 따릅니다.

그런 다음 반환된 `assetId`를 `logoAssetId`에 PATCH하여 회사 로고를 설정하세요.

## 회사 아카이브

```
POST /api/companies/{companyId}/archive
```

회사를 아카이브합니다. 아카이브된 회사는 기본 목록에서 숨겨집니다.

## 회사 삭제

```
DELETE /api/companies/{companyId}
```

회사를 삭제합니다. **보드 운영자만 가능. 되돌릴 수 없음.** 활성화하려면 `PAPERCLIP_ENABLE_COMPANY_DELETION=true`가 필요합니다.

## 회사 통계

```
GET /api/companies/stats
```

회사 ID를 키로 한 회사별 에이전트/이슈 수를 반환합니다:

```json
{
  "b9f5e911-6de5-4cd0-8dc6-a55a13bc02f6": { "agentCount": 4, "issueCount": 12 }
}
```

## 회사 Issues

```
GET /api/companies/{companyId}/issues
```

회사 범위로 제한된 issue를 나열합니다(`/api/companies/{companyId}/issues` issues 엔드포인트의 대안).

## 브랜딩

```
PATCH /api/companies/{companyId}/branding
{
  "brandColor": "#18181B",
  "logoAssetId": "b9f5e911-6de5-4cd0-8dc6-a55a13bc02f6"
}
```

회사 브랜딩 설정을 업데이트합니다. 지원되는 필드: `name`, `description`, `timezone`, `brandColor` (hex), `logoAssetId`.

## 내보내기 & 가져오기

회사 패키지는 회사를 휴대용 아카이브로 내보내고 다시 가져옵니다.

### 내보내기 미리보기

```
POST /api/companies/{companyId}/exports/preview
{
  "include": ["agents", "skills", "projects", "issues"]
}
```

내보낼 내용의 미리보기를 반환합니다.

### 내보내기 생성

```
POST /api/companies/{companyId}/exports
{
  "include": ["agents", "skills", "projects", "issues"]
}
```

내보내기 패키지를 생성합니다.

### 레거시 내보내기

```
POST /api/companies/{companyId}/export
```

레거시 단일 패키지 내보내기 엔드포인트.

### 가져오기 미리보기

```
POST /api/companies/{companyId}/imports/preview
{
  "package": { ... }
}
```

적용하지 않고 가져오기를 미리 봅니다.

### 가져오기 적용

```
POST /api/companies/{companyId}/imports/apply
{
  "package": { ... },
  "collision": "rename"
}
```

가져오기를 적용합니다.

### 가져오기

```
POST /api/companies/{companyId}/import
```

레거시 가져오기 엔드포인트.

### 글로벌 가져오기 미리보기

```
POST /api/companies/import/preview
POST /api/companies/import
```

인스턴스 수준 가져오기 진입점.

## 회사 필드

| 필드 | 타입 | 설명 |
|------|------|------|
| `id` | string | 고유 식별자 |
| `name` | string | 회사 이름 |
| `description` | string | 회사 설명 |
| `status` | string | `active`, `paused`, `archived` |
| `logoAssetId` | string | 저장된 로고 이미지의 선택적 asset id |
| `logoUrl` | string | 저장된 로고 이미지의 선택적 papercompany 에셋 콘텐츠 경로 |
| `budgetMonthlyCents` | number | 월간 예산 한도 |
| `createdAt` | string | ISO 타임스탬프 |
| `updatedAt` | string | ISO 타임스탬프 |
