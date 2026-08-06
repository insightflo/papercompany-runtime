---
title: Data Storage
summary: Company shared data storage and work-product storage
---

Companies can attach shared data storage (S3-compatible or local) for normalized source data, and work-product storage for generated artifacts.

## Company Data Storage

### Get Configuration

```
GET /api/companies/{companyId}/data-storage
```

Returns the data storage configuration for the company.

### Set Configuration

```
PUT /api/companies/{companyId}/data-storage
{
  "provider": "s3",
  "bucket": "company-data",
  "region": "ap-northeast-2"
}
```

Updates the data storage configuration.

### Test Configuration

```
POST /api/companies/{companyId}/data-storage/test
```

Tests connectivity to the configured data storage.

## Data Objects

### List Objects

```
GET /api/companies/{companyId}/data/objects
```

Lists objects in the company data storage.

### Write Object

```
PUT /api/companies/{companyId}/data/objects?key=market/2026-08-05.csv
Content-Type: text/csv

date,symbol,close
2026-08-05,AAPL,210.5
```

Writes an object to the company data storage. The object key is passed via the `key` query parameter and the raw body is the object content (up to 50 MB).

## Work-Product Storage

### Get Configuration

```
GET /api/companies/{companyId}/work-product-storage
```

Returns the work-product storage configuration.

### Set Configuration

```
PUT /api/companies/{companyId}/work-product-storage
{
  "provider": "s3",
  "bucket": "work-products"
}
```

### Test Configuration

```
POST /api/companies/{companyId}/work-product-storage/test
```

Tests connectivity to the work-product storage.
