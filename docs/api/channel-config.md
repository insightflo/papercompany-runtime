---
title: Channel Configuration
summary: Company channel configuration and connectivity tests
---

Channels connect the control plane to external messaging or event systems.

## Get Channel Config

```
GET /api/companies/{companyId}/channel/config
```

Returns the channel configuration for the company.

## Set Channel Config

```
PUT /api/companies/{companyId}/channel/config
{
  "type": "slack",
  "settings": {
    "token": "{encrypted-token}",
    "channel": "#ops"
  }
}
```

Updates the channel configuration.

## Test Channel

```
POST /api/companies/{companyId}/channel/test
```

Tests connectivity to the configured channel and returns the result.
