# Automatic producer-generation rebind

Audience: runtime maintainers and operators. Purpose: explain consumption-time authority, byte seals, and rollback boundaries.

The ordinary same-run work-product selector now repairs generation-only drift without a role, step type, or step ID allowlist. The system replaces the human approval for this case; it does not request or perform a workflow restart.

## Proof and records

Automatic issuance requires the original rebind proof: an active mission when linked, a completed producer with its original issue, one active local selected product, only generation-field mismatches, an older producer generation, the DB-linked heartbeat, and a reproducible original admission attempt. Company, mission, run, step run, step ID, retry, iteration, and creating heartbeat still must match. Failure remains `workproduct_selector_stale_producer`.

New local workflow registrations and restamps measure the file inside the existing producer write transaction. `metadata.workflowProducer` carries optional paired `sha256` and `byteSize` fields; legacy records carry neither. Automatic issuance compares a recorded seal with current disk bytes. Without a production seal, issuance-time bytes become the marker baseline, as approved for legacy records. The production reader rejects unreadable/nonregular files, final-component symlinks, and files whose observed size/timestamps change while reading; it never silently falls back to an unsealed new local record.

The issuer preserves the original producer and `sourceExecutionGeneration`. It writes `metadata.workflowProducerRebind` plus the existing `workflow_authority_transition` event atomically. Automatic markers/events identify `actorType: system`, `actorId: workproduct-selector`, and reason `automatic_producer_provenance_rebind`. The idempotency key remains `producer-provenance-rebind:<productId>:<originalGeneration>`. Every subsequent marker-based consumption rechecks disk bytes against the marker. Existing board rebind and delegated-promotion contracts remain available; the board rebind still requires a failed run.

## Transaction boundary

The selector's inner reader emits a typed `ProducerRebindRequired` containing structured scope. It never parses error messages or agent text to request authority. A root DB reader can recover directly. A Drizzle transaction or savepoint only propagates the request.

Transactional consumers wrap their outermost operation with `withAutomaticProducerRebind`. The first operation rolls back and releases its locks, then the issuer opens an independent transaction and locks mission → run → all steps in ID order → selected products. It rechecks selection cardinality and proof under those locks before writing. The consumer operation then runs again from fresh DB state. Seed admission, materialization, pinning, and agent artifact binding use this boundary; seed error translators preserve the typed request.

Recovery permits one issuance attempt per product and at most 32 distinct products per operation. Repeated requests or failed proofs block rather than loop. Because issuance commits independently, a marker/event can remain even if later consumer validation fails. Consumer writes from the failed attempt do not survive rollback.

## Compatibility and limits

- No DB migration, data backfill, or producer-generation rewriting.
- Existing unsealed records and existing promotion/rebind markers remain readable.
- Ordinary metadata patches cannot forge, replace, or remove server-issued producer authority. A genuine new registration/restamp retires obsolete markers and records a new seal.
- Late-write admission fences, terminal generation increments, and #338 role filters/claim recovery are unchanged.
- A new transactional caller must place recovery outside its outermost transaction; an unwrapped transaction fails closed instead of issuing under unknown locks.
- Legacy unsealed records cannot prove their original production bytes. Direct filesystem modification remains outside DB locking.
- Rolling back to older code with a strict producer validator requires care: that code rejects the new optional seal fields.

## Verification

Run `pnpm -r typecheck`, `pnpm test:run --maxWorkers=2 --hookTimeout=60000`, and `pnpm build`. Focused isolated-PostgreSQL coverage includes generic roles, all identity mismatches, heartbeat/admission failure, legacy/sealed bytes, cardinality/locality, concurrent idempotency, rollback boundaries, source lock waiting, seed admission/materialization, and unchanged stale-write rejection. No live runtime verification or deployment accompanies this change.
