# Human Operator Interactive Card Design

**Date:** 2026-07-29
**Status:** Approved visual and interaction direction; implementation pending
**Product surface:** Human Operator

## 1. Problem

Papercompany can surface mission escalations and binary approvals, but it cannot currently ask the board operator to choose among structured alternatives inside Papercompany. A workflow therefore has to collect the decision in an external chat or encode it in prose. Neither path is a durable execution authority.

The Human Operator page needs a reusable Interactive Card that lets an operator make a bounded decision and immediately return that structured result to the waiting work.

## 2. Approved Product Decisions

The operator approved the following V1 behavior:

- Interactive Cards appear at the top of the existing **Human Operator** page.
- The domain entity is separate from `approvals`; its product-facing name is **Interactive Card** and its server-side name is **Operator Decision**.
- V1 is decision-focused, not a general form builder.
- V1 supports single choice, multiple choice, approve, reject, hold, and an optional or required comment.
- Pressing a decision action resolves the card immediately and requests continuation of linked work.
- A resolved card disappears from Human Operator immediately.
- Resolved decisions remain visible through Activity only.
- A resolved decision is immutable. Reconsideration requires a new card.
- V1 does not allow custom React renderers or arbitrary callback URLs.

## 3. Goals

1. Let agents and workflows request bounded human decisions using a versioned, schema-validated contract.
2. Show all pending decisions in one operator-focused page with enough evidence to decide safely.
3. Store the selected option IDs, action ID, comment, actor, and time as durable structured data.
4. Wake the current assignee of the linked work item after resolution so the existing issue-backed workflow can continue.
5. Preserve company isolation, idempotency, auditability, and failure visibility.
6. Prove the feature with the Inflo opportunity-selection case without hard-coding that business case into core code.

## 4. Non-goals

- General text, number, date, file, or arbitrary field forms
- Business-specific custom card components
- Replacing governed approvals for hiring, budget, strategy, or external automation
- Parsing comments or other natural language to select an execution branch
- Calling arbitrary external URLs after a decision
- A workflow-editor control node in the first slice
- Editing or undoing resolved decisions
- A completed-decisions tab in Human Operator

## 5. User Experience

### 5.1 Page layout

The existing sidebar item and `/human-operator` route remain. The page order is:

1. Page title, explanation, pending count, and refresh
2. Pending Interactive Cards
3. Existing external automation approval surface
4. Existing mission escalation and input-request rows

The sidebar badge counts pending Interactive Cards plus existing open Human Operator requests. A future unified actionable-count endpoint may absorb other Human Operator surfaces, but V1 must not silently drop existing counts.

### 5.2 Card header

Every card shows:

- priority and optional due-time indicator
- request title and concise explanation
- requesting agent or system source
- source workflow or issue when available
- request age
- links to bounded evidence or related Papercompany entities

### 5.3 Interaction types

`single_select`

- renders radio-like option cards
- requires exactly one selected option for actions that require selection

`multi_select`

- renders checkbox-like option cards
- enforces declared minimum and maximum selections

`action`

- renders no options
- supports bounded actions such as approve, reject, or hold

All types may include a comment field. The card definition controls whether the comment is disabled, optional, or required.

### 5.4 Option presentation

An option may contain:

- stable machine ID
- label and short description
- small typed facts such as duration, price state, fit, and risk
- bounded evidence references

Strings are plain text and are escaped by the UI. Facts and references are display data only; they are never interpreted as execution instructions.

### 5.5 Resolution behavior

When the operator presses an action:

1. The UI validates the local selection and required comment.
2. The API atomically accepts the first valid resolution only.
3. Controls become disabled while the request is running.
4. On success, the card is removed from the pending list and counts are refreshed.
5. Activity receives the immutable decision record.
6. Linked work continuation is queued using the structured decision ID.

An API error remains inline on the card and preserves the operator's current selection. A concurrent second resolution receives `409` and refreshes to the already-resolved state.

## 6. Domain Model

Add `operator_decisions` as a company-scoped table.

Core columns:

- `id` UUID primary key
- `company_id` UUID not null
- `request_key` text not null; unique within a company for idempotent creation
- `schema_version` integer not null, initially `1`
- `status` text: `pending | resolved | cancelled`
- `priority` text: `critical | high | medium | low`
- `interaction_type` text: `single_select | multi_select | action`
- `title` text not null
- `description` text not null
- `definition` JSONB not null
- `result` JSONB nullable
- `requested_by_agent_id` UUID nullable
- `requested_by_user_id` text nullable
- `issue_id` UUID nullable
- `mission_id` UUID nullable
- `workflow_run_id` UUID nullable
- `workflow_step_run_id` UUID nullable
- `continuation_type` text: `none | issue_assignee`
- `continuation_status` text: `not_required | pending | dispatched | failed`
- `continuation_error` text nullable and redacted
- `decided_by_user_id` text nullable
- `decided_at`, `cancelled_at`, `created_at`, `updated_at` timestamps

Required indexes:

- `(company_id, status, priority, created_at)` for Human Operator
- unique `(company_id, request_key)`
- `(issue_id, status)`
- `(workflow_step_run_id, status)`
- `(continuation_status, updated_at)` for retry/reconciliation

### 6.1 Definition contract

`definition` contains only versioned display and validation data:

- `options`: stable IDs, labels, descriptions, facts, and evidence references
- `actions`: stable IDs, labels, semantic outcome, visual tone, and whether selection is required
- `selection`: minimum and maximum cardinality
- `comment`: `disabled | optional | required` plus placeholder

Allowed semantic outcomes are `submit | approve | reject | hold`. Custom labels are allowed; custom executable behavior is not.

Option and action IDs must be unique within the card. Payload sizes, option counts, string lengths, fact counts, and reference counts are bounded by shared validators.

### 6.2 Result contract

`result` contains:

- `actionId`
- `outcome`
- `selectedOptionIds`
- `comment` when supplied

The server verifies that all IDs belong to the stored definition, selection cardinality is valid, the action allows the submitted selection, and the comment policy is satisfied. Consumers branch on stable IDs or semantic outcomes, never labels or prose.

## 7. API

Add the following company-scoped REST endpoints:

- `GET /companies/:companyId/operator-decisions?status=pending`
- `POST /companies/:companyId/operator-decisions`
- `GET /operator-decisions/:decisionId`
- `POST /operator-decisions/:decisionId/resolve`
- `POST /operator-decisions/:decisionId/cancel`

Board and same-company agents may create requests. Only the board may resolve a request. Cancellation is allowed to the board and to the same requesting agent while the request is pending.

Creation is idempotent by `(companyId, requestKey)`. Reusing a key with a different normalized definition returns `409` rather than mutating the existing request.

Resolution is an atomic compare-and-set from `pending` to `resolved`. Resolved and cancelled records cannot be edited.

## 8. Continuation and Workflow Integration

V1 reuses the existing issue-backed execution path instead of adding a second workflow engine.

A request with `continuationType = issue_assignee` must reference a same-company issue. Mission and workflow IDs are derived or validated by the server rather than trusted from arbitrary client input.

After a decision is stored:

1. The continuation service resolves the linked issue's current assignee.
2. It requests a normal heartbeat wakeup with reason `operator_decision_resolved`.
3. The wakeup payload contains only the decision ID and typed issue/mission/workflow references.
4. The assignee reads the structured decision through the API and continues the existing issue-backed workflow step.
5. The native workflow engine remains authoritative for step completion and downstream materialization.

The decision's idempotency key also drives a stable wakeup idempotency key. Duplicate resolution or retry must not enqueue duplicate effective work.

Continuation dispatch is observable separately from decision resolution. A dispatcher or reconciliation pass retries `pending` continuations. Exhausted delivery becomes `failed`, writes Activity, and creates a new operator-visible exception; the original resolved decision remains immutable and does not reappear as an editable card.

## 9. Activity and Evidence

Creation writes `operator_decision.created`. Resolution writes `operator_decision.resolved`. Cancellation writes `operator_decision.cancelled`. Continuation dispatch and terminal failure write separate actions.

Activity details contain:

- decision and request keys
- linked issue, mission, workflow run, and step-run IDs
- selected option IDs and semantic outcome
- comment only when supplied
- continuation status and wakeup request ID when available

Activity must not contain raw secrets, adapter credentials, unrestricted source payloads, or executable callback data.

## 10. Security and Failure Rules

- Every route enforces company access.
- Only board actors can resolve decisions.
- All linked entities must belong to the same company.
- The UI renders plain text, not supplied HTML.
- External evidence links must be `https` or `http` and open with safe link attributes.
- Internal references use known Papercompany entity types and IDs.
- No natural-language field is execution authority.
- The server rejects unknown action IDs, option IDs, duplicate IDs, invalid cardinality, and oversized payloads.
- The first resolution wins; later attempts return `409` with current state.
- A cancelled or terminal linked issue cannot be silently resumed.
- Continuation failures are visible and retryable; they are not reported as successful execution.

## 11. Initial Inflo Use Case

The opportunity workflow creates one `single_select` card after shortlist production.

The card contains the shortlisted opportunities with stable candidate IDs, verified and unverified facts clearly distinguished, and references to the original collection artifacts. Actions are:

- `prepare_internal_proposal` with outcome `submit` and required selection
- `hold_all` with outcome `hold` and no required selection
- `reject_shortlist` with outcome `reject` and no required selection

Selecting `prepare_internal_proposal` wakes the linked Opportunity Lead issue. The agent reads the selected candidate ID, creates or updates the proposal-intake work item, and starts only the internal-draft path. External contact, submission, price commitment, and contract commitment remain separate governed approvals.

## 12. Test and Acceptance Contract

Implementation follows RED-GREEN-REFACTOR and includes:

- shared validator tests for each interaction type and malformed definitions/results
- DB migration and schema export checks
- service tests for idempotent creation, company isolation, immutable resolution, cardinality, and concurrent first-writer-wins behavior
- route tests for board-only resolution and same-company agent creation/cancellation
- integration proof that resolution queues exactly one linked-issue wakeup with typed decision context
- continuation-failure visibility test
- UI tests for single select, multi select, action-only, required comment, hold/reject, inline error, and removal after success
- sidebar count test that preserves existing Human Operator request counts
- browser QA in a worktree-local Papercompany instance
- one end-to-end Inflo opportunity card from creation through Activity and linked-work wakeup

Completion requires focused tests, full typecheck, full test suite, build, browser verification, and `git diff --check`.

## 13. Rollout Boundary

The implementation branch may add schema, API, service, UI, tests, migration, and product-contract documentation. It must not deploy, merge, alter production data, trigger the Inflo proposal workflow, contact external parties, or change existing approval records without separate authorization.
