# Shared Data Storage

Shared Data Storage is a per-company store for normalized, cumulative source data that external workflows and Papercompany agents use together. It is generic S3-compatible or local-disk storage; it is not tied to MinIO or Gazua.

## Data flow

### Before: local cumulative data tree

Collectors preserved normalized data in a durable local tree. A representative category used both a current snapshot and timestamped history:

```text
data/
  <category>/
    latest.json
    history/
      <timestamp>.json
```

Agents could compare `latest.json` with one or more history entries to detect changes.

### Broken interim: per-run HTTP artifact

The interim flow stored HTTP responses as workflow-run artifacts and told agents not to use the canonical cumulative tree:

```text
n8n HTTP response -> workflow-run artifact -> agent ignores canonical history
```

That made each run an isolated output. It did not provide a stable current/previous contract and could not reliably support change detection across runs.

### After: explicit store boundaries

```text
n8n raw response
  -> Incoming store (raw, n8n-owned)
  -> n8n normalization
  -> Shared Data Storage (normalized cumulative latest + history)
  -> Papercompany company data API
  -> agent analysis
  -> Work-product root (local authoring workspace)
  -> Work-product Storage (registered final-output mirror/persistence)
```

Ownership and purpose:

- **Incoming store:** raw source responses, written by n8n. It is separate from Shared Data Storage.
- **Shared Data Storage:** normalized cumulative source data and history, written by n8n and Papercompany agents and read by both through their authorized paths.
- **Work product root:** local agent authoring workspace/path. Selecting S3 storage does not remove it.
- **Work-product Storage:** persistence or mirror destination for registered final outputs, written by Papercompany after local authoring.

When an agent registers a workflow file through the official Workflow API, Papercompany keeps the local file as the working copy and uploads the same bytes to the configured Work-product Storage before accepting the registration. If that upload fails, the workProduct is not registered, so the workflow cannot silently advance with a local-only final output.

For S3-compatible storage, registered workflow files use this key layout:

```text
<key-prefix>/companies/<company-id>/workflow-runs/<workflow-run-id>/steps/<step-id>/<filename>
```

## Configuration

Company Settings exposes **Shared Data Storage** with:

- `local_disk` (default)
- `s3` (generic S3-compatible endpoint)
- endpoint, region, bucket, required key prefix, and path-style addressing
- access-key and secret-access-key references to company secrets

Secret values are never returned by the storage configuration or object APIs. The settings store secret IDs only; the server resolves the latest values for storage operations.

For S3, the configured key prefix is the required company data root. It is normalized to a non-empty slash-separated set of safe segments; traversal, encoded traversal, and empty roots are rejected. Papercompany does not silently insert a company UUID. Operators must choose a prefix that is unique to the company when companies share a bucket.

Example with `keyPrefix = gazua`:

```text
API key:      blog-insights/latest.json
S3 key:       gazua/blog-insights/latest.json
history API:  blog-insights/history/<timestamp>.json
history S3:   gazua/blog-insights/history/<timestamp>.json
```

For local disk, the server provides isolation because there is no operator-configured prefix. The route and storage service require a UUID company ID and keep the resolved root below `<instance-storage>/company-data`:

```text
<instance-storage>/company-data/<company-id>/<API key>
```

## Company data object API

Board users with company access and agent API keys for that same company can:

- list keys relative to the configured company data root
- download an object by relative key
- write or replace an object by relative key

Routes:

```text
GET /api/companies/:companyId/data/objects?prefix=<relative-prefix>&limit=<n>
GET /api/companies/:companyId/data/objects?key=<relative-key>
PUT /api/companies/:companyId/data/objects?key=<relative-key>
```

Listings return stable relative keys, size, and ETag/last-modified/content type where the provider supplies them. Downloads return content metadata in standard response headers, use `Content-Disposition: attachment` plus `X-Content-Type-Options: nosniff`, and downgrade active HTML/SVG/script MIME types to `application/octet-stream`.

The API rejects invalid or encoded-traversal company IDs, absolute object paths, `.`/`..` traversal, cross-company agent access, symlink objects, symlinked path segments, and local real paths that escape the company root.

A layout such as `<category>/latest.json` plus `<category>/history/<timestamp>.json` is an example supported by the generic relative-key API, not a hard-coded product convention.
