---
title: Secrets
summary: Secrets CRUD
---

Manage encrypted secrets that agents reference in their environment configuration.

## List Secrets

```
GET /api/companies/{companyId}/secrets
```

Returns secret metadata (not decrypted values).

## Create Secret

```
POST /api/companies/{companyId}/secrets
{
  "name": "anthropic-api-key",
  "value": "sk-ant-..."
}
```

The value is encrypted at rest. Only the secret ID and metadata are returned.

## Update Secret

```
PATCH /api/secrets/{secretId}
{
  "value": "sk-ant-new-value..."
}
```

Creates a new version of the secret. Agents referencing `"version": "latest"` automatically get the new value on next heartbeat.

## Rotate Secret

```
POST /api/secrets/{secretId}/rotate
```

Rotates the secret, generating a new version while keeping historical versions resolvable by pinned version IDs.

## Delete Secret

```
DELETE /api/secrets/{secretId}
```

Deletes the secret.

## Secret Providers

```
GET /api/companies/{companyId}/secret-providers
```

Lists the secret providers available to the company (e.g. `local-encrypted`, external vault integrations).

## Using Secrets in Agent Config

Reference secrets in agent adapter config instead of inline values:

```json
{
  "env": {
    "ANTHROPIC_API_KEY": {
      "type": "secret_ref",
      "secretId": "{secretId}",
      "version": "latest"
    }
  }
}
```

The server resolves and decrypts secret references at runtime, injecting the real value into the agent process environment.
