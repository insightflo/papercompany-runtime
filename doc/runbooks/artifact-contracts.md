# Declarative artifact contracts

Audience: tool authors and board operators. This guide explains how tools submit
machine-verifiable artifacts without coupling the runtime to a company or provider.

## Authority and configuration

Store `artifactContract` in the tool definition's `adapterConfig`. Board-only
configuration is frozen at attempt start with its effective QA rules and hashes.
Changing live configuration must not change an already dispatched attempt.
A step's `toolArtifactContract` references the role, schema version and input step;
it is not a substitute for the tool's full declaration.

- `role`: `qa`, `publication`, or `publication-verify`.
- `resultFileName`: safe basename written under the runtime-owned attempt directory.
- `resultSchemaVersion`, `resultAdapter`: declared wire dialect and adapter
  (`generic`, `legacy-qa`, `legacy-publication`). No tool-name inference.
- `inputParams`: declared content, HTML, assets directory, bundle manifest and output
  argument names. `consumerParams` declares receipt and source argument names.
- `deploymentFiles`: relative script paths whose actual bytes are hashed.
- `assetDiscovery`: JSON pointers; `*` selects array elements only.
- `bundleManifest`: filename, optional schema version, and allowed ancillary roles.
- `inputEnvelopeVersion`: version passed to the producer over the byte transport.
- `defaultRules`: preset QA configuration; the workflow step can override optional
  rules through `qaConfig`.
- `readback.rejectTitlePatterns`: literal title strings, never regular expressions.
  Case and whitespace are ignored; body text does not count as a title match.
  Configured publication readback occurs before durable result acceptance. Absent
  readback configuration does not introduce a new network request.
- `previewProvider`: optional display label obtained from the current company-scoped
  frozen attempt. Unconfigured previews use `public_url`, never a hostname heuristic.

Producers receive `PAPERCOMPANY_ARTIFACT_*` environment values and a versioned stdin
byte envelope. FD4 (file descriptor 4) is the structured result channel. Stdout and
stderr remain diagnostics; neither can supply evidence, paths or execution authority.

## QA layers

`qaConfig` is `{ "rules": { "rule-id": { "enabled": true, "params": {} } } }`.
The runtime resolves mandatory rules, tool defaults, then step overrides. Unknown
rules/parameters and attempts to disable mandatory rules are rejected.
Mandatory checks cover provenance binding, result format, internal path/secret
leaks, external scripts/iframes, and HTTPS links. Optional checks include minimum
source links, tag counts, required JSON-pointer fields, template remnants, asset
existence and uploaded assets. Plugin checks are recorded separately from runtime
checks. Both must pass; plugin success cannot overrule runtime failure.

The mandatory catalog is `provenance`, `result-format`, `no-sensitive-data`,
`no-external-script`, `no-external-iframe`, and `https-links`. Optional catalog:
`min-source-links`, `links-reachable`, `uploaded-asset-required`, `tag-count`,
`required-fields`, `no-template-remnants`, and `asset-existence`.

For conservative script safety, executable inline scripts and event attributes
are rejected too; inert JSON data scripts remain allowed. All iframes are rejected.
Path/secret detection is syntactic, not a guarantee against every possible encoding.
The path rule checks runtime-owned attempt, step, mission and output roots, runtime
home/instance/data/storage roots, and the temporary directory (including real paths).
Tutorial paths outside those roots are allowed. `file://`, Windows drive and UNC
paths remain rejected even when configuration roots are unavailable; secret-key,
private-key, Bearer-token and key/value secret checks are unchanged.
`links-reachable` performs HTTPS GET checks after local rules pass: 2xx response
headers, at most 20 distinct absolute links, four concurrent requests, and a ten-second
batch limit. Relative links are not network-checked. Enabled reachability runs again
when receipts are reverified; remote availability changes can therefore reject an
otherwise unchanged artifact.

Receipt version 2 includes the frozen contract/configuration hashes. Durable version
1 receipts remain readable; they do not authorize inventing a declaration for a new
execution. Read the shared validators for the exact catalog and parameter limits.

## Publication identity and target rules

See [`../examples/artifact-contract.example.json`](../examples/artifact-contract.example.json).
The runtime independently derives the expected ID before trusting a publication:

1. A nonempty explicitly configured ID argument wins, after trimming.
2. Otherwise read the configured JSON source file inside the current run output
   directory, rejecting symlinks, traversal, oversize files and missing fields.
3. The configured field argument is a restricted dot path. Only own object
   properties are read; arrays/prototype properties are not traversal paths.
4. `literal` preserves the trimmed value. `date-prefixed-slug` requires lowercase
   kebab case, preserves an existing eight-digit date prefix, or prepends the
   configured `YYYY-MM-DD` argument without dashes.

`bindings` compares result JSON pointers to tool arguments (`optional: true` skips
only an absent argument). `publishedAt` binds a pointer to the date plus a declared
suffix. Publishers must declare identity, the actual result date binding, and the
actual publication timestamp binding using the same date argument. An optional date
binding preserves legacy omission behavior: absent date arguments use the validated
result date for the timestamp comparison. Incomplete publisher declarations are
rejected even when read from a previously frozen attempt.
`audience` selects the private/default value from a declared parameter.
`command` and `commandKeySeparator` constrain the command and positive numeric
sequence suffix. The runtime also checks scope, input/QA/asset/ancillary digests,
mode/title parity, CMS content identity and public URL consistency.

Generic results use `workflow.publication-result.v1`, `publishedAt`, and
`inputDigest: {mode, sha256, qaSha256, assetManifest, ancillaryManifest?}`. They include
`ok`, `command`, `mode`, `section`, `id`, `date`, `scope`, `title`, `publicUrl` and `cms`.
CMS evidence includes success, audience, content ID/slug/URL, HTTP 200, counts,
command key, content SHA-256 and positive byte count. This is producer evidence of
CMS state, not an independent CMS database read.

Legacy publication adapters require explicit `legacyMapping` pointers for normalized
fields and digests plus content/HTML mode values. The runtime accepts only mapped
fields and validates the normalized generic structure. It preserves the original
wire bytes and dialect when returning/storing the result. The only returned path
is server-generated under the configured basename.

## Verification limits

Public readback performs a bounded HTTPS request to a DNS-validated, pinned public
IP while retaining the original TLS identity. Credentials, private/reserved addresses,
redirects (including public-to-public), and bodies over 2 MiB are rejected. DNS is
limited to three seconds and the request to eight seconds. This is not browser
execution; title rejection alone is not semantic review.

`publication-verify` consumes the publication result path declared by
`consumerParams.receipt`, not a QA receipt or a hardcoded argument name. It checks
completed same-company/run producer evidence, frozen attempt identity and stored
bytes before forwarding the publication result in the input envelope's content.
Verification output uses the supported generic publication result or explicitly
mapped legacy dialect, a fresh verification scope, and matching original publication
identity/date/digests/URL/CMS evidence. Publisher-only identity declarations are not
required for this role. A dedicated external verifier's format must be confirmed
before deploying its contract; no operational verification schema is inferred here.
No document or example here changes operational tool definitions or migrates data.
