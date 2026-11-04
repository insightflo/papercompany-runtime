# Paperwork T12a: bounded decisions

## R2 shutdown responsibility

The top-level shutdown handler in `server/src/index.ts` coordinates scheduler stop, child termination, existing `markRunsShutdownInterrupted` flush and database stop. The durable flush responsibility is already delegated to the heartbeat/shutdown-flush services; no additional extraction is justified by a new contract or observed defect in this scope. This decision does not prove graceful drain under all races: the observed live recovery followed process loss and remains distinct from a controlled drain test.

## R3 metrics response

The metrics route serves registry text and JSON, while HTTP measurement and sampling live in separate middleware and monitor services. No concrete need for further response extraction was established, so that extraction is outside this iteration. Database gauge population and actual alert delivery/recovery remain separate unfinished requirements.

## B2b reservation wiring

The earlier reservation-only candidate lacked runtime publication and completion wiring. Current source connects `qa-remediation-prepare.ts` and `qa-remediation-quality-root.ts` to the preparation writer; `qa-correction-followup-reconcile.ts` invokes `qa-remediation-reconcile.ts`, which calls the publisher and completion path. This is source linkage only: exact identity, owner, preserved bytes, wake behavior, failure/cancellation and same-mission completion still need the appropriate existing acceptance evidence; no replacement patch is inferred from the old snapshot.
