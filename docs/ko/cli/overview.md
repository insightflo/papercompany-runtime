---
title: CLI 개요
summary: CLI 설치 및 설정
---

papercompany CLI는 인스턴스 설정, 진단, 컨트롤 플레인 운영을 처리합니다.

## 사용법

```sh
pnpm paperclipai --help
```

## 클라이언트 옵션

컨트롤 플레인(클라이언트) 명령 — issues, agents, approvals, activity, dashboard, company, plugin, auth — 은 다음 옵션을 지원합니다:

| 플래그 | 설명 |
|------|-------------|
| `-C, --company-id <id>` | 회사 ID(회사 범위 명령에 필수) |
| `--api-base <url>` | API base URL |
| `--api-key <token>` | API 인증 토큰 |
| `--context <path>` | 컨텍스트 파일 경로 |
| `--profile <name>` | 컨텍스트 프로필 이름 |
| `--json` | JSON으로 출력 |

설정 명령(`onboard`, `doctor`, `env`, `configure`, `run`, `db:backup`)은 **이 옵션들을 지원하지 않습니다** — 대신 `-c/--config`와 `-d/--data-dir`을 사용합니다.

깨끗한 로컬 인스턴스를 원한다면 실행하는 명령에 `--data-dir`을 전달하세요:

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
```

## 컨텍스트 프로필

플래그를 반복하지 않도록 기본값을 저장하세요:

```sh
# Set defaults
pnpm paperclipai context set --api-base http://localhost:3200 --company-id <id>

# View current context
pnpm paperclipai context show

# List profiles
pnpm paperclipai context list

# Switch profile
pnpm paperclipai context use default

# Set a profile
pnpm paperclipai context set --profile ops --api-base http://localhost:3200

# JSON output
pnpm paperclipai context list --json
```

컨텍스트에 시크릿을 저장하지 않으려면 env var 참조를 사용하세요:

```sh
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

컨텍스트는 `~/.paperclip/context.json`에 저장됩니다.

## 명령 범주

CLI에는 두 가지 범주가 있습니다:

1. **[설정 명령](/cli/setup-commands)** — 인스턴스 부트스트랩, 진단, 설정
2. **[컨트롤 플레인 명령](/cli/control-plane-commands)** — issues, agents, approvals, activity
