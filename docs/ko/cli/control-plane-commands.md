---
title: 컨트롤 플레인 명령
summary: Issue, agent, approval, dashboard 명령
---

이슈, 에이전트, 승인 등을 관리하는 클라이언트 측 명령입니다. 회사 범위 명령에는 `-C, --company-id <id>`(또는 컨텍스트 기본값)가 필요합니다.

## 이슈 명령

```sh
# List issues
pnpm paperclipai issue list -C <company-id> [--status todo,in_progress] [--assignee-agent-id <id>] [--project-id <id>] [--match text]

# Get issue details
pnpm paperclipai issue get <issue-id-or-identifier>

# Create issue
pnpm paperclipai issue create -C <company-id> --title "..." \
  [--description "..."] [--status todo] [--priority high] \
  [--assignee-agent-id <id>] [--project-id <id>] [--goal-id <id>] [--parent-id <id>] \
  [--request-depth <n>] [--billing-code <code>]

# Update issue
pnpm paperclipai issue update <issue-id> [--status in_progress] [--comment "..."] \
  [--title "..."] [--description "..."] [--priority high] [--hidden-at <timestamp>]

# Add comment
pnpm paperclipai issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm paperclipai issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm paperclipai issue release <issue-id>
```

## 회사 명령

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm paperclipai company export <company-id> --out ./exports/acme --include company,agents \
  [--skills] [--projects] [--issues] [--project-issues] [--expand-referenced-skills]

# Preview import (no writes)
pnpm paperclipai company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm paperclipai company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents

# Delete company
pnpm paperclipai company delete <company-id> \
  [--by id] [--yes] [--confirm]
```

`company delete`는 `--by auto|id|prefix`를 지원하여 대상 회사를 해석합니다. `--yes`와 `--confirm`은 대화형 확인을 건너뜁니다.

## 에이전트 명령

```sh
pnpm paperclipai agent list -C <company-id>
pnpm paperclipai agent get <agent-id>

# Configure an agent to run a local CLI runtime (Claude Code etc.)
pnpm paperclipai agent local-cli <agent-id> \
  [--key-name default] [--no-install-skills]
```

`agent local-cli`는 API 키를 생성하고(`--no-install-skills`가 아니면) CLI 워크스페이스에 paperclip 스킬을 설치하여 로컬 CLI 기반 에이전트 런타임을 준비합니다.

## 승인 명령

```sh
# List approvals
pnpm paperclipai approval list -C <company-id> [--status pending]

# Get approval
pnpm paperclipai approval get <approval-id>

# Create approval
pnpm paperclipai approval create -C <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm paperclipai approval approve <approval-id> [--decision-note "..."] [--decided-by-user-id <userId>]

# Reject
pnpm paperclipai approval reject <approval-id> [--decision-note "..."] [--decided-by-user-id <userId>]

# Request revision
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."] [--decided-by-user-id <userId>]

# Resubmit
pnpm paperclipai approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm paperclipai approval comment <approval-id> --body "..."
```

## 활동 명령

```sh
pnpm paperclipai activity list -C <company-id> [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## 대시보드

```sh
pnpm paperclipai dashboard get -C <company-id>
```

## 하트비트

```sh
pnpm paperclipai heartbeat run --agent-id <agent-id> \
  [--api-base http://localhost:3200] \
  [--source manual] [--trigger <trigger>] [--timeout-ms <ms>] \
  [--debug] [--config <path>] [--data-dir <path>] \
  [--context <path>] [--profile <name>] [--api-key <token>] [--json]
```

## 인증 명령

```sh
# Login to an instance (board operator)
pnpm paperclipai auth login [--api-base http://localhost:3200]

# Logout
pnpm paperclipai auth logout

# Show current identity
pnpm paperclipai auth whoami

# Bootstrap the CEO board account (setup)
pnpm paperclipai auth bootstrap-ceo [--force] [--expires-hours <n>] [--base-url <url>]
```

`auth bootstrap-ceo`는 최초 보드 운영자 계정을 생성합니다. `--force`는 기존 계정을 덮어쓰고, `--expires-hours`는 클레임 링크 만료 시간을 제어합니다.
