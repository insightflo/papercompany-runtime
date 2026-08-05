# 에이전트 컴퍼니 규격(Agent Companies Specification)

에이전트 스킬 규격(Agent Skills Specification)의 확장

버전: `agentcompanies/v1-draft`

## 1. 목적

에이전트 컴퍼니(Agent Company) 패키지는 YAML frontmatter가 포함된 마크다운 파일을 사용하여 회사, 팀, 에이전트, 프로젝트, 태스크 및 관련 스킬을 기술하는 파일시스템 및 GitHub 네이티브 형식입니다.

이 규격은 에이전트 스킬 규격의 확장이지, 이를 대체하는 것이 아닙니다.

기존 `SKILL.md` 모델을 중심으로 회사·팀·에이전트 수준의 패키지 구조가 어떻게 구성되는지를 정의합니다.

이 규격은 벤더 중립적입니다. papercompany뿐만 아니라 어떤 에이전트-컴퍼니 런타임에서도 사용할 수 있도록 설계되었습니다.

이 형식은 다음을 위해 설계되었습니다:

- 사람이 읽고 쓸 수 있을 것
- 로컬 폴더 또는 GitHub 저장소에서 직접 작동할 것
- 중앙 레지스트리가 필요 없을 것
- 업스트림 파일에 대한 귀속(attribution) 및 고정(pinned) 참조를 지원할 것
- 기존 에이전트 스킬 생태계를 재정의하지 않고 확장할 것
- papercompany 밖에서도 유용할 것

## 2. 핵심 원칙

1. 마크다운이 표준(canonical)이다.
2. Git 저장소는 유효한 패키지 컨테이너이다.
3. 레지스트리는 선택적 발견 계층일 뿐, 권위(authority)가 아니다.
4. `SKILL.md`는 에이전트 스킬 규격이 소유한다.
5. 외부 참조는 불변 Git 커밋으로 고정(pin)할 수 있어야 한다.
6. 귀속 및 라이선스 메타데이터는 가져오기/내보내기 시에도 보존되어야 한다.
7. 슬러그와 상대 경로가 이식 가능한 신원 계층이며, 데이터베이스 ID가 아니다.
8. 관례적인 폴더 구조는 장황한 배선(wiring) 없이도 작동해야 한다.
9. 벤더별 세부 정보는 기본 패키지가 아닌 선택적 확장에 속한다.

## 3. 패키지 종류

패키지 루트는 하나의 기본 마크다운 파일로 식별됩니다:

- `COMPANY.md` — 컴퍼니 패키지
- `TEAM.md` — 팀 패키지
- `AGENTS.md` — 에이전트 패키지
- `PROJECT.md` — 프로젝트 패키지
- `TASK.md` — 태스크 패키지
- `SKILL.md` — 에이전트 스킬 규격이 정의하는 스킬 패키지

GitHub 저장소에는 루트에 하나의 패키지가 있거나 하위 디렉터리에 여러 패키지가 있을 수 있습니다.

## 4. 예약 파일 및 디렉터리

공통 관례:

```text
COMPANY.md
TEAM.md
AGENTS.md
PROJECT.md
TASK.md
SKILL.md

agents/<slug>/AGENTS.md
teams/<slug>/TEAM.md
projects/<slug>/PROJECT.md
projects/<slug>/tasks/<slug>/TASK.md
tasks/<slug>/TASK.md
skills/<slug>/SKILL.md
.paperclip.yaml

HEARTBEAT.md
SOUL.md
TOOLS.md
README.md
assets/
scripts/
references/
```

규칙:

- 마크다운 파일만 표준 콘텐츠 문서이다
- `assets/`, `scripts/`, `references/` 같은 비(非)마크다운 디렉터리는 허용된다
- 패키지 도구는 선택적 잠금 파일을 생성할 수 있지만, 작성 시 잠금 파일은 필수가 아니다

## 5. 공통 Frontmatter

패키지 문서는 다음 필드를 지원할 수 있습니다:

```yaml
schema: agentcompanies/v1
kind: company | team | agent | project | task
slug: my-slug
name: Human Readable Name
description: Short description
version: 0.1.0
license: MIT
authors:
  - name: Jane Doe
homepage: https://example.com
tags:
  - startup
  - engineering
metadata: {}
sources: []
```

참고:

- `schema`는 선택 사항이며 일반적으로 패키지 루트에만 나타나야 합니다
- `kind`는 파일 경로와 파일 이름만으로 종류가 명확할 때는 선택 사항입니다
- `slug`는 URL에 안전하고 안정적이어야 합니다
- `sources`는 출처(provenance)와 외부 참조용입니다
- `metadata`는 도구별 확장용입니다
- 내보내기 도구는 빈 필드나 기본값 필드를 생략해야 합니다

## 6. COMPANY.md(컴퍼니)

`COMPANY.md`는 전체 컴퍼니 패키지의 루트 진입점입니다.

### 필수 필드

```yaml
name: Lean Dev Shop
description: Small engineering-focused AI company
slug: lean-dev-shop
schema: agentcompanies/v1
```

### 권장 필드

```yaml
version: 1.0.0
license: MIT
authors:
  - name: Example Org
goals:
  - Build and ship software products
includes:
  - https://github.com/example/shared-company-parts/blob/0123456789abcdef0123456789abcdef01234567/teams/engineering/TEAM.md
requirements:
  secrets:
    - OPENAI_API_KEY
```

### 의미(Semantics)

- `includes`는 패키지 그래프를 정의합니다
- 로컬 패키지 콘텐츠는 폴더 관례에 따라 암묵적으로 발견되어야 합니다
- `includes`는 선택 사항이며 주로 외부 참조나 비표준 위치에 사용해야 합니다
- 포함 항목은 로컬 참조일 수도 외부 참조일 수도 있습니다
- `COMPANY.md`는 에이전트, 팀, 프로젝트, 태스크 또는 스킬을 직접 포함할 수 있습니다
- 컴퍼니 가져오기 도구는 `includes`를 트리/체크박스 가져오기 UI로 렌더링할 수 있습니다

## 7. TEAM.md(팀)

`TEAM.md`는 조직 하위 트리(subtree)를 정의합니다.

### 예시

```yaml
name: Engineering
description: Product and platform engineering team
schema: agentcompanies/v1
slug: engineering
manager: ../cto/AGENTS.md
includes:
  - ../platform-lead/AGENTS.md
  - ../frontend-lead/AGENTS.md
  - ../../skills/review/SKILL.md
tags:
  - team
  - engineering
```

### 의미(Semantics)

- 팀 패키지는 반드시 런타임 데이터베이스 테이블일 필요는 없는 재사용 가능한 하위 트리입니다
- `manager`는 하위 트리의 루트 에이전트를 식별합니다
- `includes`에는 자식 에이전트, 자식 팀 또는 공유 스킬이 포함될 수 있습니다
- 팀 패키지는 기존 컴퍼니로 가져와 대상 매니저 아래에 연결할 수 있습니다

## 8. AGENTS.md(에이전트)

`AGENTS.md`는 에이전트를 정의합니다.

### 예시

```yaml
name: CEO
title: Chief Executive Officer
reportsTo: null
skills:
  - plan-ceo-review
  - review
```

### 의미(Semantics)

- 본문 콘텐츠는 에이전트의 표준 기본 지시 콘텐츠입니다
- `docs`는 있으면 형제(sibling) 마크다운 문서를 가리킵니다
- `skills`는 스킬 짧은 이름(shortname) 또는 슬러그로 재사용 가능한 `SKILL.md` 패키지를 참조합니다
- `review` 같은 단순 스킬 항목은 관례에 따라 `skills/review/SKILL.md`로 해석되어야 합니다
- 패키지가 외부 스킬을 참조하는 경우에도 에이전트는 스킬을 짧은 이름으로 참조해야 합니다. 스킬 패키지 자체가 모든 소스 참조, 고정(pinning) 또는 귀속 세부 정보를 소유합니다
- 도구는 탈출구로 경로 또는 URL 항목을 허용할 수 있지만, 내보내기 도구는 `AGENTS.md`에서 짧은 이름 기반 스킬 참조를 선호해야 합니다
- 벤더별 어댑터/런타임 설정은 기본 패키지에 있어서는 안 됩니다
- 로컬 절대 경로, 머신별 cwd 값, 시크릿 값은 표준 패키지 데이터로 내보내면 안 됩니다

### 스킬 해석(Skill Resolution)

에이전트와 스킬 사이의 선호 연관 표준은 스킬 짧은 이름입니다.

에이전트 스킬 항목에 대한 권장 해석 순서:

1. `skills/<shortname>/SKILL.md`의 로컬 패키지 스킬
2. 선언된 슬러그 또는 짧은 이름이 일치하는 참조 또는 포함된 스킬 패키지
3. 같은 짧은 이름을 가진 도구가 관리하는 컴퍼니 스킬 라이브러리 항목

규칙:

- 내보내기 도구는 가능할 때마다 `AGENTS.md`에 짧은 이름을 출력해야 합니다
- 가져오기 도구는 일반적인 스킬 참조에 전체 파일 경로를 요구해서는 안 됩니다
- 외부 참조, 벤더링(vendoring), 미러, 고정된 업스트림 콘텐츠 관련 복잡성은 스킬 패키지 자체가 담당해야 합니다
- 이렇게 하면 `AGENTS.md`를 읽기 쉽게 유지하고 `skills.sh` 스타일 공유와 일관성을 유지합니다

## 9. PROJECT.md(프로젝트)

`PROJECT.md`는 가벼운 프로젝트 패키지를 정의합니다.

### 예시

```yaml
name: Q2 Launch
description: Ship the Q2 launch plan and supporting assets
owner: cto
```

### 의미(Semantics)

- 프로젝트 패키지는 관련 시작 태스크와 보조 마크다운을 그룹화합니다
- `owner`는 명확한 프로젝트 소유자가 있을 때 에이전트 슬러그를 참조해야 합니다
- 관례적인 `tasks/` 하위 폴더는 암묵적으로 발견되어야 합니다
- `includes`는 명시적 배선이 필요할 때 `TASK.md`, `SKILL.md` 또는 보조 문서를 포함할 수 있습니다
- 프로젝트 패키지는 계획된 작업을 시드(seed)하기 위한 것이지, 런타임 태스크 상태를 나타내기 위한 것이 아닙니다

## 10. TASK.md(태스크)

`TASK.md`는 가벼운 시작 태스크를 정의합니다.

### 예시

```yaml
name: Monday Review
assignee: ceo
project: q2-launch
schedule:
  timezone: America/Chicago
  startsAt: 2026-03-16T09:00:00-05:00
  recurrence:
    frequency: weekly
    interval: 1
    weekdays:
      - monday
    time:
      hour: 9
      minute: 0
```

### 의미(Semantics)

- 본문 콘텐츠는 표준 마크다운 태스크 설명입니다
- `assignee`는 패키지 내부의 에이전트 슬러그를 참조해야 합니다
- `project`는 태스크가 `PROJECT.md`에 속할 때 프로젝트 슬러그를 참조해야 합니다
- 태스크는 의도적으로 기본적인 시드 작업입니다: 제목, 마크다운 본문, 담당자, 선택적 반복
- 도구는 `priority`, `labels` 또는 `metadata` 같은 선택적 필드도 지원할 수 있지만, 기본 패키지에서는 이를 요구해서는 안 됩니다

### 스케줄링

스케줄링 모델은 의도적으로 가볍습니다. 다음과 같은 일반적인 반복 패턴을 다뤄야 합니다:

- 6시간마다
- 평일마다 9:00에
- 매주 월요일 아침
- 매월 1일에
- 매월 첫 번째 월요일
- 매년 1월 1일에

권장 형태:

```yaml
schedule:
  timezone: America/Chicago
  startsAt: 2026-03-14T09:00:00-05:00
  recurrence:
    frequency: hourly | daily | weekly | monthly | yearly
    interval: 1
    weekdays:
      - monday
      - wednesday
    monthDays:
      - 1
      - 15
    ordinalWeekdays:
      - weekday: monday
        ordinal: 1
    months:
      - 1
      - 6
    time:
      hour: 9
      minute: 0
    until: 2026-12-31T23:59:59-06:00
    count: 10
```

규칙:

- `timezone`은 `America/Chicago` 같은 IANA 타임존을 사용해야 합니다
- `startsAt`은 첫 번째 발생을 고정합니다
- `frequency`와 `interval`만 필수 반복 필드입니다
- `weekdays`, `monthDays`, `ordinalWeekdays`, `months`는 선택적 축소(narrowing) 규칙입니다
- `ordinalWeekdays`는 `1`, `2`, `3`, `4` 또는 "마지막"을 뜻하는 `-1` 같은 `ordinal` 값을 사용합니다
- `time.hour`와 `time.minute`는 "아침 / 9:00 / 하루 종료" 같은 일반적인 스케줄을 사람이 읽기 쉽게 유지합니다
- `until`과 `count`는 선택적 반복 종료 경계입니다
- 도구는 RFC5545 `RRULE` 같은 더 풍부한 달력 문법을 받아들일 수 있지만, 내보내기 도구는 위의 구조화된 형태를 선호해야 합니다

## 11. SKILL.md 호환성

스킬 패키지는 유효한 에이전트 스킬 패키지로 유지되어야 합니다.

규칙:

- `SKILL.md`는 에이전트 스킬 규격을 따라야 합니다
- papercompany는 스킬 유효성을 위해 추가 최상위 필드를 요구해서는 안 됩니다
- Paperclip별 확장은 `metadata.paperclip` 또는 `metadata.sources` 아래에 있어야 합니다
- 스킬 디렉터리는 에이전트 스킬 생태계가 기대하는 것과 똑같이 `scripts/`, `references/`, `assets/`를 포함할 수 있습니다
- 이 규격을 구현하는 도구는 병렬 스킬 형식을 새로 발명하기보다 `skills.sh` 호환성을 일급 목표로 취급해야 합니다

즉, 이 규격은 에이전트 스킬을 위로 확장하여 컴퍼니/팀/에이전트 구성을 가능하게 합니다. 스킬 패키지 의미를 재정의하지는 않습니다.

### 호환 확장 예시

```yaml
---
name: review
description: Paranoid code review skill
allowed-tools:
  - Read
  - Grep
metadata:
  paperclip:
    tags:
      - engineering
      - review
  sources:
    - kind: github-file
      repo: vercel-labs/skills
      path: review/SKILL.md
      commit: 0123456789abcdef0123456789abcdef01234567
      sha256: 3b7e...9a
      attribution: Vercel Labs
      usage: referenced
---
```

## 12. 소스 참조

패키지는 벤더링(vendoring) 대신 업스트림 콘텐츠를 가리킬 수 있습니다.

### 소스 객체

```yaml
sources:
  - kind: github-file
    repo: owner/repo
    path: path/to/file.md
    commit: 0123456789abcdef0123456789abcdef01234567
    blob: abcdef0123456789abcdef0123456789abcdef01
    sha256: 3b7e...9a
    url: https://github.com/owner/repo/blob/0123456789abcdef0123456789abcdef01234567/path/to/file.md
    rawUrl: https://raw.githubusercontent.com/owner/repo/0123456789abcdef0123456789abcdef01234567/path/to/file.md
    attribution: Owner Name
    license: MIT
    usage: referenced
```

### 지원 종류

- `local-file`
- `local-dir`
- `github-file`
- `github-dir`
- `url`

### 사용 모드

- `vendored`: 바이트가 패키지에 포함됨
- `referenced`: 패키지가 업스트림 불변 콘텐츠를 가리킴
- `mirrored`: 바이트는 로컬에 캐시되지만 업스트림 귀속은 표준으로 유지됨

### 규칙

- 엄격 모드에서 `github-file`과 `github-dir`에는 `commit`이 필수입니다
- `sha256`은 강력히 권장되며 fetch 시 검증되어야 합니다
- 브랜치 전용 참조는 개발 모드에서 허용될 수 있지만 경고해야 합니다
- 내보내기 도구는 재배포가 명확히 허용되지 않는 한 타사 콘텐츠에 대해 기본적으로 `referenced`를 사용해야 합니다

## 13. 해석 규칙

패키지 루트가 주어지면 가져오기 도구는 다음 순서로 해석합니다:

1. 로컬 상대 경로
2. 가져오기 도구가 명시적으로 허용하는 경우 로컬 절대 경로
3. 고정된 GitHub 참조
4. 일반 URL

고정된 GitHub 참조의 경우:

1. `repo + commit + path` 해석
2. 콘텐츠 fetch
3. 있으면 `sha256` 검증
4. 있으면 `blob` 검증
5. 불일치 시 안전하게 실패(fail closed)

가져오기 도구는 다음을 표면화해야 합니다:

- 누락된 파일
- 해시 불일치
- 누락된 라이선스
- 네트워크 fetch가 필요한 참조된 업스트림 콘텐츠
- 스킬 또는 스크립트의 실행 가능 콘텐츠

## 14. 가져오기 그래프

패키지 가져오기 도구는 다음에서 그래프를 구축해야 합니다:

- `COMPANY.md`
- `TEAM.md`
- `AGENTS.md`
- `PROJECT.md`
- `TASK.md`
- `SKILL.md`
- 로컬 및 외부 참조

권장 가져오기 UI 동작:

- 그래프를 트리로 렌더링
- 원시 파일 수준이 아닌 엔티티 수준에서 체크박스
- 에이전트를 선택하면 필수 문서와 참조된 스킬이 자동 선택
- 팀을 선택하면 하위 트리가 자동 선택
- 프로젝트를 선택하면 포함된 태스크가 자동 선택
- 반복 태스크를 선택하면 가져오기 전에 스케줄을 표시
- 참조된 타사 콘텐츠를 선택하면 귀속, 라이선스, fetch 정책을 표시

## 15. 벤더 확장

벤더별 데이터는 기본 패키지 형태 밖에 있어야 합니다.

papercompany의 경우 선호되는 충실도 확장은 다음과 같습니다:

```text
.paperclip.yaml
```

사용 예:

- 어댑터 타입 및 어댑터 설정
- 어댑터 env 입력 및 기본값
- 런타임 설정
- 권한
- 예산
- 승인 정책
- 프로젝트 실행 워크스페이스 정책
- 이슈/태스크 papercompany 전용 메타데이터

규칙:

- 기본 패키지는 확장 없이도 읽을 수 있어야 합니다
- 벤더 확장을 이해하지 못하는 도구는 이를 무시해야 합니다
- papercompany 도구는 기본 마크다운을 깨끗하게 유지하면서 사이드카로 벤더 확장을 기본 출력할 수 있습니다

권장 papercompany 형태:

```yaml
schema: paperclip/v1
agents:
  claudecoder:
    adapter:
      type: claude_local
      config:
        model: claude-opus-4-6
    inputs:
      env:
        ANTHROPIC_API_KEY:
          kind: secret
          requirement: optional
          default: ""
        GH_TOKEN:
          kind: secret
          requirement: optional
        CLAUDE_BIN:
          kind: plain
          requirement: optional
          default: claude
```

papercompany 내보내기 도구에 대한 추가 규칙:

- `AGENTS.md`에 이미 에이전트 지시가 있으면 `promptTemplate`을 중복해서는 안 됩니다
- `secretId`, `version` 또는 `type: secret_ref` 같은 제공자별 시크릿 바인딩을 내보내지 마세요
- env 입력은 `required` 또는 `optional` 의미와 선택적 기본값을 가진 이식 가능한 선언으로 내보내세요
- 절대 명령과 절대 `PATH` 재정의 같은 시스템 의존 값을 경고하세요
- 가능하면 비어 있는 papercompany 필드와 기본값 필드를 생략하세요

## 16. 내보내기 규칙

규격을 준수하는 내보내기 도구는 다음을 수행해야 합니다:

- 마크다운 루트와 상대 폴더 레이아웃을 출력
- 머신 로컬 ID와 타임스탬프 생략
- 시크릿 값 생략
- 머신별 경로 생략
- 태스크를 내보낼 때 태스크 설명과 반복 정의 보존
- 빈/기본값 필드 생략
- 기본적으로 벤더 중립 기본 패키지를 사용
- papercompany 내보내기 도구는 기본적으로 `.paperclip.yaml`을 사이드카로 출력
- 귀속과 소스 참조 보존
- 타사 콘텐츠에 대해 조용한 벤더링보다 `referenced` 선호
- 호환 스킬을 내보낼 때 `SKILL.md`를 그대로 보존

## 17. 라이선스 및 귀속

규격을 준수하는 도구는 다음을 수행해야 합니다:

- 가져오기 및 내보내기 시 `license`와 `attribution` 메타데이터 보존
- vendored 콘텐츠와 referenced 콘텐츠 구분
- 내보내기 중 참조된 타사 콘텐츠를 조용히 인라인하지 않기
- 누락된 라이선스 메타데이터를 경고로 표면화
- 콘텐츠가 vendored 또는 mirrored 상태일 때 제한적이거나 알 수 없는 라이선스를 설치/가져오기 전에 표면화

## 18. 선택적 잠금 파일

작성(authoring)에는 잠금 파일이 필요하지 않습니다.

도구는 다음과 같은 선택적 잠금 파일을 생성할 수 있습니다:

```text
company-package.lock.json
```

목적:

- 해석된 참조 캐시
- 최종 해시 기록
- 재현 가능한 설치 지원

규칙:

- 잠금 파일은 선택 사항입니다
- 잠금 파일은 생성 산출물이지, 표준 작성 입력이 아닙니다
- 마크다운 패키지가 진실의 원천(source of truth)으로 유지됩니다

## 19. papercompany 매핑

papercompany는 이 규격을 다음과 같이 자체 런타임 모델에 매핑할 수 있습니다:

- 기본 패키지:
  - `COMPANY.md` -> 컴퍼니 메타데이터
  - `TEAM.md` -> 가져올 수 있는 조직 하위 트리
  - `AGENTS.md` -> 에이전트 신원 및 지시
  - `PROJECT.md` -> 시작 프로젝트 정의
  - `TASK.md` -> 시작 이슈/태스크 정의, 또는 반복이 있을 때 자동화 템플릿
  - `SKILL.md` -> 가져온 스킬 패키지
  - `sources[]` -> 출처 및 고정된 업스트림 참조
- papercompany 확장:
  - `.paperclip.yaml` -> 어댑터 설정, 런타임 설정, env 입력 선언, 권한, 예산 및 기타 Paperclip별 충실도

공유 마크다운 파일 안에 있어야 하는 인라인 papercompany 전용 메타데이터는 다음을 사용해야 합니다:

- `metadata.paperclip`

이렇게 하면 기본 형식이 papercompany보다 더 넓게 유지됩니다.

이 규격 자체는 벤더 중립적으로 유지되며 papercompany뿐만 아니라 어떤 에이전트-컴퍼니 런타임을 위한 것입니다.

## 20. 전환(Cutover)

papercompany는 이 마크다운 우선 패키지 모델을 기본 이식성 형식으로 전환해야 합니다.

`paperclip.manifest.json`은 미래 패키지 시스템의 호환성 요구 사항으로 보존할 필요가 없습니다.

papercompany의 경우 이는 장기간 지속되는 이중 형식 전략이 아니라 제품 방향의 단호한 전환으로 취급되어야 합니다.

## 21. 최소 예시

```text
lean-dev-shop/
├── COMPANY.md
├── agents/
│   ├── ceo/AGENTS.md
│   └── cto/AGENTS.md
├── projects/
│   └── q2-launch/
│       ├── PROJECT.md
│       └── tasks/
│           └── monday-review/
│               └── TASK.md
├── teams/
│   └── engineering/TEAM.md
├── tasks/
│   └── weekly-review/TASK.md
└── skills/
    └── review/SKILL.md

Optional:

```text
.paperclip.yaml
```
```

**권장 사항**
이것이 제가 취할 방향입니다:

- 이것을 사람을 위한 규격으로 만든다
- `SKILL.md` 호환성을 양보할 수 없는 것으로 정의한다
- 이 규격을 병렬 형식이 아닌 에이전트 스킬의 확장으로 취급한다
- `companies.sh`를 이 규격을 구현하는 저장소의 발견 계층으로 만들되, 게시 권위(authority)로는 만들지 않는다
