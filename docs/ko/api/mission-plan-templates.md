---
title: Mission Plan Templates (미션 플랜 템플릿)
summary: 미션 플랜을 위한 재사용 가능한 템플릿
---

미션 플랜 템플릿은 증거 게이트(evidence-gated) 실행 슬라이스로 미션을 계획하기 위한 재사용 가능한 구조를 정의합니다.

## 템플릿 목록

```
GET /api/companies/{companyId}/mission-plan-templates
```

## 템플릿 조회

```
GET /api/companies/{companyId}/mission-plan-templates/{templateId}
```

## 템플릿 생성

```
POST /api/companies/{companyId}/mission-plan-templates
{
  "name": "Standard research mission",
  "description": "Default structure for research missions",
  "phases": []
}
```

## 템플릿 수정

```
PATCH /api/companies/{companyId}/mission-plan-templates/{templateId}
{
  "name": "Standard research mission v2"
}
```

## 템플릿 복제

```
POST /api/companies/{companyId}/mission-plan-templates/{templateId}/duplicate
{
  "name": "Research mission (copy)"
}
```

템플릿의 사본을 생성합니다.

## 템플릿 삭제

```
DELETE /api/companies/{companyId}/mission-plan-templates/{templateId}
```
