---
title: Company Instructions (회사 지침)
summary: 에이전트 워크스페이스에 주입되는 회사 전역 지침 파일
---

회사는 런타임에 에이전트 워크스페이스에 주입되는 지침 파일(예: `AGENTS.md`)을 유지 관리할 수 있습니다.

## 지침 조회

```
GET /api/companies/{companyId}/instructions
```

회사 지침 매니페스트(파일 목록)를 반환합니다.

## 지침 파일 조회

```
GET /api/companies/{companyId}/instructions/file?path=AGENTS.md
```

단일 지침 파일의 내용을 반환합니다.

## 지침 파일 작성

```
PUT /api/companies/{companyId}/instructions/file
{
  "path": "AGENTS.md",
  "content": "# Company instructions\n..."
}
```

단일 지침 파일을 생성하거나 업데이트합니다. 파일 경로와 크기를 반환합니다.

## 지침 파일 삭제

```
DELETE /api/companies/{companyId}/instructions/file?path=AGENTS.md
```

단일 지침 파일을 삭제합니다. `path` 쿼리 파라미터는 필수입니다.
