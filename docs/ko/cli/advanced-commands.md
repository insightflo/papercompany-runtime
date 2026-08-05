---
title: 고급 명령
summary: 플러그인, 워크트리, 컨텍스트 명령
---

플러그인 관리, 워크트리, 컨텍스트 프로필을 위한 고급 CLI 명령입니다.

## 플러그인 명령

컨트롤 플레인에 설치된 플러그인 관리:

```sh
# List installed plugins
pnpm paperclipai plugin list

# Install a plugin
pnpm paperclipai plugin install <source> [--version <v>]

# Uninstall a plugin
pnpm paperclipai plugin uninstall <plugin-id>

# Enable / disable
pnpm paperclipai plugin enable <plugin-id>
pnpm paperclipai plugin disable <plugin-id>

# Inspect a plugin
pnpm paperclipai plugin inspect <plugin-id>

# List example plugins
pnpm paperclipai plugin examples
```

## 워크트리 명령

격리된 에이전트 실행을 위한 워크트리 로컬 Paperclip 인스턴스 관리:

```sh
# 현재 저장소에 워크트리 설정 초기화
pnpm paperclipai worktree init [--name <name>] [--instance <id>] [--home <path>] \
  [--from-config <path>] [--from-data-dir <path>] [--from-instance <id>] \
  [--server-port <port>] [--db-port <port>] [--seed-mode minimal|full] \
  [--no-seed] [--force]

# 새 워크트리 인스턴스 생성 (init과 옵션을 공유하는 별도 top-level 명령)
pnpm paperclipai worktree:make <name> [--start-point <ref>] [--instance <id>] [--home <path>] \
  [--from-config <path>] [--from-data-dir <path>] [--from-instance <id>] \
  [--server-port <port>] [--db-port <port>] [--seed-mode minimal|full] \
  [--no-seed] [--force]

# 현재 디렉토리의 워크트리 환경 출력
pnpm paperclipai worktree env [-c, --config <path>] [--json]

# 워크트리 목록
pnpm paperclipai worktree:list [--json]

# 워크트리 간 머지 이력 보기 (기본은 import 계획 미리보기)
pnpm paperclipai worktree:merge-history \
  [--from <worktree>] [--to <worktree>] [--company <id-or-prefix>] \
  [--scope issues,comments] [--apply] [--dry] [--yes]

# 머지 완료/오래된 워크트리 정리
pnpm paperclipai worktree:cleanup [--instance <id>]
```

참고:

- `worktree:make`는 소스 인스턴스에서 새 격리 인스턴스를 생성합니다 (기본적으로 설정과 DB를 시드)
- `--start-point`는 새 브랜치의 기준이 되는 원격 ref를 지정합니다 (`PAPERCLIP_WORKTREE_START_POINT` 환경 변수)
- `worktree:merge-history`는 워크트리 간 이슈/댓글 import 계획을 미리 보여주며, `--apply`를 붙이면 실행합니다
- `worktree:cleanup`은 머지가 완료된 워크트리를 제거합니다 (인스턴스 id는 기본적으로 워크트리 이름)

## 컨텍스트 명령

컨텍스트 프로필은 플래그를 반복하지 않도록 기본값을 저장합니다:

```sh
# Set a context default
pnpm paperclipai context set --api-base http://localhost:3200 --company-id <id>

# Set a profile
pnpm paperclipai context set --profile ops --api-base http://localhost:3200

# Show the current context
pnpm paperclipai context show

# List profiles
pnpm paperclipai context list [--json]

# Use a profile
pnpm paperclipai context use <profile>

# Use a context file directly
pnpm paperclipai context use <path-to-context.json>
```

컨텍스트에 시크릿을 저장하지 않으려면 env var 참조를 사용하세요:

```sh
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

컨텍스트는 `~/.paperclip/context.json`에 저장됩니다.
