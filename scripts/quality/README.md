# Quality evidence CLI

For agents submitting durable evidence through the server API. CLI output is display only;
the server never reads stdout as approval, retry or completion authority.

Required environment: `PAPERCLIP_API_URL` (server origin), `PAPERCLIP_API_KEY`,
`PAPERCLIP_RUN_ID`. Never place keys in arguments, files or logs.

## PLAN-QA

Run these commands from the runtime repository:

```sh
node scripts/quality/evidence.mjs plan-qa-input --issue ISSUE_ID
node scripts/quality/evidence.mjs plan-qa-read --issue ISSUE_ID --check CHECK_ID --pointer /missionId
node scripts/quality/evidence.mjs plan-qa-submit --issue ISSUE_ID --file submission.json
```

`plan-qa-input` returns the pinned manifest and server-built current-attempt scope.
`plan-qa-read` returns actual selected values plus a durable `readRef`. Repeat `--pointer`
for multiple fields in the same check; a check's first pointer selection is immutable
within one attempt. Use paths from the returned manifest, not arbitrary local files.

`submission.json` is the complete version 2 body (replace the reference with the real
`plan-qa-read` result):

```json
{
  "schemaVersion": 2,
  "verdict": "pass",
  "diagnostics": [],
  "checks": [
    {
      "checkId": "CHECK_ID",
      "status": "satisfied",
      "readRef": { "attachmentId": "READ_ATTACHMENT_UUID", "sha256": "READ_SHA256" },
      "evidence": []
    }
  ]
}
```

The top-level verdict is the base review verdict. Every pinned additional check must
have its own supported evidence. The final verdict can be `request_changes` even when
the base is `pass`. Do not send a client-created scope or use another attempt's reads.

These commands require the checked-out, currently running agent with a real execution
epoch. Board context cannot submit version 2 evidence. Strict additional-check reviews
reject the old versionless verdict API body; unmarked legacy review behavior is retained.
Generic workflow verdict submission cannot substitute for this dedicated API.

Exit codes: `0` submitted/read successfully (not necessarily plan approval), `1` usage or
HTTP error, `2` structured `missing_evidence`. Missing evidence returns the exact submission
path/version and remaining allowance. **The CLI does not retry or dispatch automatically.**
Server-side bounded redispatch integration is not implemented by this API/CLI slice.

Client contract tests: `node --test scripts/quality/evidence.test.mjs`. Real router/DB/CLI
integration tests live in `server/src/__tests__/plan-qa-agent-api*.test.ts` and must run
with an owned isolated database, temporary `PAPERCLIP_HOME` and local storage directory.
