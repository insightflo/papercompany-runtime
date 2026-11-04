# Paperwork T12a: bounded decisions

## R2 shutdown responsibility

The top-level shutdown handler in `server/src/index.ts` coordinates scheduler stop, child termination, existing `markRunsShutdownInterrupted` flush and database stop. The durable flush responsibility is already delegated to the heartbeat/shutdown-flush services; no additional extraction is justified by a new contract or observed defect in this scope. This decision does not prove graceful drain under all races: the observed live recovery followed process loss and remains distinct from a controlled drain test.

## R3 metrics response

The metrics route serves registry text and JSON, while HTTP measurement and sampling live in separate middleware and monitor services. No concrete need for further response extraction was established, so that extraction is outside this iteration. Database gauge population and actual alert delivery/recovery remain separate unfinished requirements.
