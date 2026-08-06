---
title: 설정 명령
summary: Onboard, run, doctor, configure
---

인스턴스 설정 및 진단 명령입니다.

## `paperclipai run`

원커맨드 부트스트랩 및 시작:

```sh
pnpm paperclipai run
```

수행하는 작업:

1. 설정이 없으면 자동 온보딩
2. 복구가 활성화된 상태로 `paperclipai doctor` 실행
3. 검사를 통과하면 서버 시작

특정 인스턴스 선택:

```sh
pnpm paperclipai run --instance dev
```

복구 제어:

```sh
pnpm paperclipai run --repair     # run doctor with auto-repair before start
pnpm paperclipai run --no-repair  # skip repair
```

설정 및 data-dir 플래그(설정 명령은 클라이언트 옵션 대신 `-c/--config`, `-d/--data-dir` 사용):

```sh
pnpm paperclipai run -c ./config.json -d ./data
```

## `paperclipai onboard`

대화형 최초 설정:

```sh
pnpm paperclipai onboard
```

첫 번째 프롬프트:

1. `Quickstart`(권장): 로컬 기본값(임베디드 데이터베이스, LLM 제공자 없음, 로컬 디스크 스토리지, 기본 시크릿)
2. `Advanced setup`: 전체 대화형 설정

온보딩 직후 시작:

```sh
pnpm paperclipai onboard --run
```

비대화형 기본값 + 즉시 시작(서버 리슨 시 브라우저 열림):

```sh
pnpm paperclipai onboard --yes
```

커스텀 설정 및 데이터 디렉터리:

```sh
pnpm paperclipai onboard --config ./config.json --data-dir ./data
```

## `paperclipai doctor`

선택적 자동 복구가 포함된 상태 확인:

```sh
pnpm paperclipai doctor
pnpm paperclipai doctor --repair
pnpm paperclipai doctor --fix      # alias for --repair
pnpm paperclipai doctor -y --repair # non-interactive repair
pnpm paperclipai doctor --config ./config.json --data-dir ./data
```

검증 항목:

- 서버 설정
- 데이터베이스 연결
- 시크릿 어댑터 설정
- 스토리지 설정
- 누락된 핵심 파일

## `paperclipai configure`

설정 섹션 업데이트:

```sh
pnpm paperclipai configure --section server
pnpm paperclipai configure --section secrets
pnpm paperclipai configure --section storage
pnpm paperclipai configure --section llm
pnpm paperclipai configure --section database
pnpm paperclipai configure --section logging
```

사용 가능한 섹션: `llm`, `database`, `logging`, `server`, `storage`, `secrets`.

## `paperclipai env`

해석된 환경 설정 표시:

```sh
pnpm paperclipai env
```

## `paperclipai allowed-hostname`

인증/사설 모드에서 사설 호스트 이름 허용:

```sh
pnpm paperclipai allowed-hostname my-tailscale-host
```

## `paperclipai db:backup`

데이터베이스 백업 생성:

```sh
pnpm paperclipai db:backup
```

옵션:

| 플래그 | 설명 |
|------|-------------|
| `--dir <path>` | 백업 출력 디렉터리 |
| `--retention-days <n>` | 보존 기간(일) |
| `--filename-prefix <prefix>` | 백업 파일 이름 접두사 |
| `--json` | JSON으로 출력 |

## 로컬 스토리지 경로

| 데이터 | 기본 경로 |
|------|-------------|
| 설정 | `~/.paperclip/instances/default/config.json` |
| 데이터베이스 | `~/.paperclip/instances/default/db` |
| 로그 | `~/.paperclip/instances/default/logs` |
| 스토리지 | `~/.paperclip/instances/default/data/storage` |
| 시크릿 키 | `~/.paperclip/instances/default/secrets/master.key` |

다음으로 재정의:

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

또는 아무 명령에 `--data-dir`을 직접 전달:

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
pnpm paperclipai doctor --data-dir ./tmp/paperclip-dev
```
