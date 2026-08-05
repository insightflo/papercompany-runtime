---
title: Data Storage (데이터 스토리지)
summary: 회사 공유 데이터 스토리지와 작업 산출물 스토리지
---

회사는 정규화된 소스 데이터를 위한 공유 데이터 스토리지(S3 호환 또는 로컬)와 생성된 산출물을 위한 작업 산출물 스토리지를 연결할 수 있습니다.

## 회사 데이터 스토리지

### 구성 조회

```
GET /api/companies/{companyId}/data-storage
```

회사의 데이터 스토리지 구성을 반환합니다.

### 구성 설정

```
PUT /api/companies/{companyId}/data-storage
{
  "provider": "s3",
  "bucket": "company-data",
  "region": "ap-northeast-2"
}
```

데이터 스토리지 구성을 업데이트합니다.

### 구성 테스트

```
POST /api/companies/{companyId}/data-storage/test
```

구성된 데이터 스토리지에 대한 연결을 테스트합니다.

## 데이터 객체

### 객체 목록

```
GET /api/companies/{companyId}/data/objects
```

회사 데이터 스토리지의 객체를 나열합니다.

### 객체 작성

```
PUT /api/companies/{companyId}/data/objects?key=market/2026-08-05.csv
Content-Type: text/csv

date,symbol,close
2026-08-05,AAPL,210.5
```

회사 데이터 스토리지에 객체를 씁니다. 객체 키는 `key` 쿼리 파라미터로 전달하고, raw 본문이 객체 내용입니다 (최대 50MB).

## 작업 산출물 스토리지

### 구성 조회

```
GET /api/companies/{companyId}/work-product-storage
```

작업 산출물 스토리지 구성을 반환합니다.

### 구성 설정

```
PUT /api/companies/{companyId}/work-product-storage
{
  "provider": "s3",
  "bucket": "work-products"
}
```

### 구성 테스트

```
POST /api/companies/{companyId}/work-product-storage/test
```

작업 산출물 스토리지에 대한 연결을 테스트합니다.
