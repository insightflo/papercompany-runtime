---
title: 환경 변수
summary: 전체 환경 변수 참조
---

papercompany가 서버 설정에 사용하는 모든 환경 변수입니다.

## 서버 설정

| 변수 | 기본값 | 설명 |
|----------|---------|-------------|
| `PORT` | `3200` | 서버 포트(Docker 이미지는 `3100`으로 고정 — Docker 섹션 참고) |
| `HOST` | `127.0.0.1` | 서버 호스트 바인딩 |
| `DATABASE_URL` | (임베디드) | PostgreSQL 연결 문자열 |
| `PAPERCLIP_HOME` | `~/.paperclip` | 모든 Paperclip 데이터의 기본 디렉터리 |
| `PAPERCLIP_INSTANCE_ID` | `default` | 인스턴스 식별자(여러 로컬 인스턴스용) |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | 런타임 모드 재정의 |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | 배포 노출: `private` 또는 `public` |
| `PAPERCLIP_ALLOWED_HOSTNAMES` | — | 인증/사설 모드에서 허용되는 쉼표로 구분된 호스트 이름 목록 |
| `PAPERCLIP_LISTEN_HOST` | `127.0.0.1` | 명시적 리슨 호스트 재정의 |
| `PAPERCLIP_LISTEN_PORT` | `3200` | 명시적 리슨 포트 재정의(`PORT`의 별칭) |
| `PAPERCLIP_ENABLE_COMPANY_DELETION` | `false` | API를 통한 회사 삭제 허용 |
| `SERVE_UI` | `true` | 서버에서 웹 UI 제공 |
| `PAPERCLIP_OPEN_ON_LISTEN` | `true` | 서버 시작 시 브라우저 열기 |
| `PAPERCLIP_UI_DEV_MIDDLEWARE` | `false` | UI에 Vite dev 미들웨어 사용 |
| `PAPERCLIP_LOG_DIR` | `~/.paperclip/.../logs` | 로그 출력 디렉터리 |
| `PAPERCLIP_CONFIG` | `~/.paperclip/.../config.json` | 설정 파일 경로 |
| `PAPERCLIP_CONTEXT` | `~/.paperclip/context.json` | CLI 컨텍스트 파일 경로 |

## 인증 및 JWT

| 변수 | 기본값 | 설명 |
|----------|---------|-------------|
| `PAPERCLIP_AGENT_JWT_SECRET` | (자동 생성) | 에이전트 런 JWT용 시크릿 |
| `PAPERCLIP_AGENT_JWT_TTL_SECONDS` | `3600` | 에이전트 JWT 유효 시간(time-to-live) |
| `PAPERCLIP_AGENT_JWT_ISSUER` | — | 에이전트 JWT 발급자(issuer) 클레임 |
| `PAPERCLIP_AGENT_JWT_AUDIENCE` | — | 에이전트 JWT 수신자(audience) 클레임 |
| `BETTER_AUTH_SECRET` | (자동 생성) | Better Auth 세션 시크릿 |
| `BETTER_AUTH_URL` | — | Better Auth base URL |
| `BETTER_AUTH_BASE_URL` | — | `BETTER_AUTH_URL`의 별칭 |
| `BETTER_AUTH_TRUSTED_ORIGINS` | — | 인증용 쉼표로 구분된 신뢰 오리진 목록 |
| `PAPERCLIP_PUBLIC_URL` | — | 인스턴스의 공개 URL(인증 링크에 사용) |
| `PAPERCLIP_AUTH_PUBLIC_BASE_URL` | — | 공개 인증 base URL |
| `PAPERCLIP_AUTH_BASE_URL_MODE` | `auto` | 인증 base URL 해석 모드 |
| `PAPERCLIP_AUTH_DISABLE_SIGN_UP` | `false` | 공개 회원가입 비활성화 |
| `PAPERCLIP_AUTH_GOOGLE_CLIENT_ID` | — | Google OAuth 클라이언트 ID |
| `PAPERCLIP_AUTH_GOOGLE_CLIENT_SECRET` | — | Google OAuth 클라이언트 시크릿 |
| `PAPERCLIP_AUTH_KAKAO_CLIENT_ID` | — | Kakao OAuth 클라이언트 ID |
| `PAPERCLIP_AUTH_KAKAO_CLIENT_SECRET` | — | Kakao OAuth 클라이언트 시크릿 |
| `PAPERCLIP_AUTH_NAVER_CLIENT_ID` | — | Naver OAuth 클라이언트 ID |
| `PAPERCLIP_AUTH_NAVER_CLIENT_SECRET` | — | Naver OAuth 클라이언트 시크릿 |

## 데이터베이스

| 변수 | 기본값 | 설명 |
|----------|---------|-------------|
| `PAPERCLIP_MIGRATION_PROMPT` | `true` | 마이그레이션 적용 전 프롬프트 표시 |
| `PAPERCLIP_MIGRATION_AUTO_APPLY` | `false` | 프롬프트 없이 마이그레이션 자동 적용 |
| `PAPERCLIP_EMBEDDED_POSTGRES_VERBOSE` | `false` | 임베디드 PostgreSQL 상세 로깅 |

## 시크릿

| 변수 | 기본값 | 설명 |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | (파일에서) | 32바이트 암호화 키(base64/hex/raw) |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` | 키 파일 경로 |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | 민감한 env 변수에 시크릿 참조 요구 |
| `PAPERCLIP_SECRETS_PROVIDER` | `local_encrypted` | 시크릿 제공자: `local_encrypted` 또는 외부 볼트 |

## 스토리지

| 변수 | 기본값 | 설명 |
|----------|---------|-------------|
| `PAPERCLIP_STORAGE_PROVIDER` | `local_disk` | 스토리지 제공자: `local_disk` 또는 `s3` |
| `PAPERCLIP_STORAGE_LOCAL_DIR` | `~/.paperclip/.../storage` | 로컬 스토리지 디렉터리 |
| `PAPERCLIP_STORAGE_S3_BUCKET` | — | S3 버킷 이름 |
| `PAPERCLIP_STORAGE_S3_REGION` | — | S3 리전 |
| `PAPERCLIP_STORAGE_S3_ENDPOINT` | — | S3 호환 엔드포인트 URL |
| `PAPERCLIP_STORAGE_S3_PREFIX` | — | 버킷 내 키 접두사 |
| `PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE` | `false` | 경로 스타일 S3 주소 지정 강제 |

## 데이터베이스 백업

| 변수 | 기본값 | 설명 |
|----------|---------|-------------|
| `PAPERCLIP_DB_BACKUP_ENABLED` | `true` | 예약 DB 백업 활성화 |
| `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES` | `1440` | 백업 간격 (24시간) |
| `PAPERCLIP_DB_BACKUP_RETENTION_DAYS` | `3` | 백업 보존 기간 |
| `PAPERCLIP_DB_BACKUP_DIR` | — | 백업 출력 디렉터리 |

## 하트비트 스케줄러

| 변수 | 기본값 | 설명 |
|----------|---------|-------------|
| `HEARTBEAT_SCHEDULER_ENABLED` | `true` | 하트비트 스케줄러 활성화 |
| `HEARTBEAT_SCHEDULER_INTERVAL_MS` | — | 스케줄러 틱 간격 |

## 첨부 파일

| 변수 | 기본값 | 설명 |
|----------|---------|-------------|
| `PAPERCLIP_ALLOWED_ATTACHMENT_TYPES` | — | 쉼표로 구분된 허용 MIME 타입 목록 |
| `PAPERCLIP_ATTACHMENT_MAX_BYTES` | — | 최대 첨부 파일 크기(바이트) |

## 어댑터

| 변수 | 기본값 | 설명 |
|----------|---------|-------------|
| `PAPERCLIP_CODEX_COMMAND` | `codex` | Codex CLI 명령 재정의 |
| `PAPERCLIP_CLAUDE_COMMAND` | `claude` | Claude Code CLI 명령 재정의 |
| `PAPERCLIP_GEMINI_COMMAND` | `gemini` | Gemini CLI 명령 재정의 |
| `HERMES_HOME` | — | Hermes 어댑터 홈 디렉터리 |
| `CLAUDE_HOME` | — | Claude Code 홈 디렉터리 |
| `CLAUDE_CONFIG_DIR` | — | Claude Code 설정 디렉터리 |
| `CODEX_HOME` | — | Codex 홈 디렉터리 |

## 로깅 및 런 레코드

| 변수 | 기본값 | 설명 |
|----------|---------|-------------|
| `RUN_LOG_BASE_PATH` | — | 하트비트 런 로그의 기본 경로 |
| `WORKSPACE_OPERATION_LOG_BASE_PATH` | — | 워크스페이스 운영 로그의 기본 경로 |

## 워크트리

| 변수 | 기본값 | 설명 |
|----------|---------|-------------|
| `PAPERCLIP_WORKTREES_DIR` | — | 워크트리의 기본 디렉터리 |
| `PAPERCLIP_WORKTREE_START_POINT` | — | 기본 워크트리 시작점 |
| `PAPERCLIP_WORKTREE_NAME` | — | 워크트리 이름 재정의 |
| `PAPERCLIP_IN_WORKTREE` | — | paperclip 워크트리 내부에서 실행 중일 때 설정됨 |

## CLI 클라이언트

| 변수 | 기본값 | 설명 |
|----------|---------|-------------|
| `PAPERCLIP_SERVER_HOST` | — | CLI 클라이언트 명령용 서버 호스트 |
| `PAPERCLIP_SERVER_PORT` | — | CLI 클라이언트 명령용 서버 포트 |
| `PAPERCLIP_AUTH_STORE` | — | CLI 인증 세션 저장 경로 |

## 에이전트 런타임(에이전트 프로세스에 주입됨)

이 변수들은 에이전트를 호출할 때 서버가 자동으로 설정합니다:

| 변수 | 설명 |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` | 에이전트의 고유 ID |
| `PAPERCLIP_COMPANY_ID` | 회사 ID |
| `PAPERCLIP_API_URL` | Paperclip API base URL(런타임 오리진, `/api` 제외) |
| `PAPERCLIP_API_BASE_URL` | `/api`를 포함한 API base URL(플러그인 도구 호출에 사용) |
| `PAPERCLIP_API_KEY` | API 인증용 단기 JWT |
| `PAPERCLIP_RUN_ID` | 현재 하트비트 런 ID |
| `PAPERCLIP_TASK_ID` | 이번 wake를 트리거한 이슈 |
| `PAPERCLIP_WAKE_REASON` | wake 트리거 사유 |
| `PAPERCLIP_WAKE_COMMENT_ID` | 이번 wake를 트리거한 댓글 |
| `PAPERCLIP_APPROVAL_ID` | 해결된 승인 ID |
| `PAPERCLIP_APPROVAL_STATUS` | 승인 결정 |
| `PAPERCLIP_LINKED_ISSUE_IDS` | 쉼표로 구분된 연결된 이슈 ID 목록 |

## LLM 제공자 키(어댑터용)

| 변수 | 설명 |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API 키(Claude Local 어댑터용) |
| `OPENAI_API_KEY` | OpenAI API 키(Codex Local 어댑터용) |

## Cloudflare(미션 계획)

| 변수 | 설명 |
|----------|-------------|
| `CLOUDFLARE_API_TOKEN` | 미션 소유자 계획 컨텍스트에서 사용되는 Cloudflare API 토큰 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 계정 ID |
| `MANUAL_ONBOARDING_SITE_ROOT` | 수동 온보딩 사이트의 루트 URL |
