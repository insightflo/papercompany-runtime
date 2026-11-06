# Runtime metrics and alerts

The existing `/api/metrics` and `/api/metrics/json` endpoints expose instance-wide
aggregates. On A1 the metrics endpoint was publicly reachable without authentication
at the time of inspection. This change does not alter access controls; protect the
endpoint at the ingress if these totals must remain private. Labels are restricted
to known statuses and severities; other values are combined as `other`. Company,
mission, issue, and route identifiers are not used as DB metric labels.

Every 60 seconds the runtime reads mission sessions, missions, workflow runs,
heartbeat runs, worktree rules, and SRB deliveries in a read-only transaction.
`paperclip_active_mission_sessions` counts rows whose status is `active`; it can
include expired sessions and is not a count of currently usable sessions.

Check `paperclip_db_metrics_collection_up` and
`paperclip_db_metrics_last_success_timestamp_seconds` before using the DB gauges.
On a collection failure, `up` becomes 0 and the last successful values and time
remain visible. A changed DB binding clears the previous values. The SQL statement
has a five-second limit; an outer ten-second limit reports a stalled acquisition
without starting overlapping DB queries. A timed-out result is discarded; once
the old query finishes, only a new successful sample marks collection recovered.

The monitor sends an alert when HTTP 5xx errors reach five since the previous
successful sample, when HTTP or DB sampling fails, and when those conditions
recover. The existing backup alert's private file is the default:
`/srv/papercompany/projects/research-company/tools/notifications/.env`. The
runtime user must be able to read this regular file, with no group or other
permissions. `PAPERCOMPANY_METRICS_ALERT_ENV_FILE` overrides the path for another
installation or an isolated test. The file supplies `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID`; their values are not logged. A delivery counts as successful
only when Telegram returns HTTP success and `ok: true`.

Failed deliveries are retried on later samples. The queues are in memory and
hold at most 32 messages each; a full queue logs a warning and drops new messages,
and a process restart loses pending messages. A stopped process cannot send its
own alert, so this is not a substitute for an independent process monitor.

Local verification uses an isolated temporary PostgreSQL database and a fake
Telegram transport:

```sh
pnpm exec vitest run server/src/__tests__/runtime-db-metrics.test.ts server/src/__tests__/runtime-metrics-monitor.test.ts server/src/__tests__/runtime-http-metrics.test.ts server/src/__tests__/runtime-http-metrics-scrape.test.ts --maxWorkers=1
```
