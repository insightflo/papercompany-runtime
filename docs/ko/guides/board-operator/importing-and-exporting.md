---
title: 컴퍼니 가져오기와 내보내기(Importing & Exporting Companies)
summary: 컴퍼니를 휴대용 패키지로 내보내고 로컬 경로 또는 GitHub에서 가져오기
---

papercompany 컴퍼니는 휴대용 마크다운 패키지로 내보내고, 로컬 디렉터리 또는 GitHub 저장소에서 가져올 수 있습니다. 이를 통해 컴퍼니 구성을 공유하고, 설정을 복제하고, 에이전트 팀을 버전 관리할 수 있습니다.

## 패키지 형식(Package Format)

내보낸 패키지는 [에이전트 컴퍼니 규격(Agent Companies specification)](/ko/companies/companies-spec)을 따르며 마크다운 우선 구조를 사용합니다:

```text
my-company/
├── COMPANY.md          # Company metadata
├── agents/
│   ├── ceo/AGENT.md    # Agent instructions + frontmatter
│   └── cto/AGENT.md
├── projects/
│   └── main/PROJECT.md
├── skills/
│   └── review/SKILL.md
├── tasks/
│   └── onboarding/TASK.md
└── .paperclip.yaml     # Adapter config, env inputs, routines
```

- **COMPANY.md**는 컴퍼니 이름, 설명, 메타데이터를 정의합니다.
- **AGENT.md** 파일은 에이전트 정체성, 역할, 지침을 담습니다.
- **SKILL.md** 파일은 에이전트 스킬 생태계(Agent Skills ecosystem)와 호환됩니다.
- **.paperclip.yaml**은 Paperclip 관련 구성(어댑터 유형, env 입력, 예산)을 선택적 사이드카로 보관합니다.

## 컴퍼니 내보내기(Exporting a Company)

컴퍼니를 휴대용 폴더로 내보냅니다:

```sh
paperclipai company export <company-id> --out ./my-export
```

### 옵션(Options)

| 옵션(Option) | 설명(Description) | 기본값(Default) |
|--------|-------------|---------|
| `--out <path>` | 출력 디렉터리(필수) | — |
| `--include <values>` | 쉼표로 구분된 집합: `company`, `agents`, `projects`, `issues`, `tasks`, `skills` | `company,agents` |
| `--skills <values>` | 특정 스킬 슬러그만 내보내기 | all |
| `--projects <values>` | 특정 프로젝트 shortname 또는 ID만 내보내기 | all |
| `--issues <values>` | 특정 이슈 식별자 또는 ID 내보내기 | none |
| `--project-issues <values>` | 특정 프로젝트에 속한 이슈 내보내기 | none |
| `--expand-referenced-skills` | 업스트림 참조를 유지하는 대신 스킬 파일 내용을 벤더링(vendoring) | `false` |

### 예시(Examples)

```sh
# Export company with agents and projects
paperclipai company export abc123 --out ./backup --include company,agents,projects

# Export everything including tasks and skills
paperclipai company export abc123 --out ./full-export --include company,agents,projects,tasks,skills

# Export only specific skills
paperclipai company export abc123 --out ./skills-only --include skills --skills review,deploy
```

### 내보내지는 것(What Gets Exported)

- 컴퍼니 이름, 설명, 메타데이터
- 에이전트 이름, 역할, 보고 구조, 지침
- 프로젝트 정의와 워크스페이스 구성
- 태스크/이슈 설명(포함된 경우)
- 스킬 패키지(참조 또는 벤더링된 콘텐츠로)
- `.paperclip.yaml`의 어댑터 유형과 env 입력 선언

시크릿 값, 머신 로컬 경로, 데이터베이스 ID는 **절대** 내보내지 않습니다.

## 컴퍼니 가져오기(Importing a Company)

로컬 디렉터리, GitHub URL 또는 GitHub shorthand에서 가져옵니다:

```sh
# From a local folder
paperclipai company import ./my-export

# From a GitHub URL
paperclipai company import https://github.com/org/repo

# From a GitHub subfolder
paperclipai company import https://github.com/org/repo/tree/main/companies/acme

# From GitHub shorthand
paperclipai company import org/repo
paperclipai company import org/repo/companies/acme
```

### 옵션(Options)

| 옵션(Option) | 설명(Description) | 기본값(Default) |
|--------|-------------|---------|
| `--target <mode>` | `new`(새 컴퍼니 생성) 또는 `existing`(기존 컴퍼니에 병합) | 컨텍스트에서 추론 |
| `--company-id <id>` | `--target existing`의 대상 컴퍼니 ID | 현재 컨텍스트 |
| `--new-company-name <name>` | `--target new`의 컴퍼니 이름 오버라이드 | 패키지에서 |
| `--include <values>` | 쉼표로 구분된 집합: `company`, `agents`, `projects`, `issues`, `tasks`, `skills` | 자동 감지 |
| `--agents <list>` | 가져올 에이전트 슬러그 목록 또는 `all` | `all` |
| `--collision <mode>` | 이름 충돌 처리 방식: `rename`, `skip` 또는 `replace` | `rename` |
| `--ref <value>` | GitHub 가져오기의 Git ref(브랜치, 태그 또는 커밋) | 기본 브랜치 |
| `--dry-run` | 적용하지 않고 무엇이 가져와질지 미리 보기 | `false` |
| `--yes` | 대화형 확인 프롬프트 건너뛰기 | `false` |
| `--json` | 결과를 JSON으로 출력 | `false` |

### 대상 모드(Target Modes)

- **`new`** — 패키지에서 새 컴퍼니를 생성합니다. 컴퍼니 템플릿 복제에 유용합니다.
- **`existing`** — 패키지를 기존 컴퍼니에 병합합니다. 대상 지정에는 `--company-id`를 사용하세요.

`--target`이 지정되지 않으면 papercompany가 추론합니다: `--company-id`가 제공되면(또는 컨텍스트에 하나가 있으면) `existing`으로, 그렇지 않으면 `new`로 기본 설정됩니다.

### 충돌 전략(Collision Strategies)

기존 컴퍼니로 가져올 때 에이전트 또는 프로젝트 이름이 기존 것과 충돌할 수 있습니다:

- **`rename`**(기본값) — 충돌을 피하기 위해 접미사를 붙입니다(예: `ceo`가 `ceo-2`가 됨).
- **`skip`** — 이미 존재하는 엔티티를 건너뜁니다.
- **`replace`** — 기존 엔티티를 덮어씁니다. 안전하지 않은(non-safe) 가져오기에서만 사용할 수 있습니다(CEO API에서는 사용할 수 없음).

### 대화형 선택(Interactive Selection)

대화형으로 실행할 때(`--yes` 또는 `--json` 플래그 없음), 가져오기 명령은 적용 전에 선택 픽커를 표시합니다. 체크박스 인터페이스로 정확히 어떤 에이전트, 프로젝트, 스킬, 태스크를 가져올지 선택할 수 있습니다.

### 적용 전 미리 보기(Preview Before Applying)

항상 먼저 `--dry-run`으로 미리 보세요:

```sh
paperclipai company import org/repo --target existing --company-id abc123 --dry-run
```

미리 보기는 다음을 보여줍니다:
- **패키지 내용(Package contents)** — 소스에 에이전트, 프로젝트, 태스크, 스킬이 몇 개 있는지
- **가져오기 계획(Import plan)** — 무엇이 생성, 이름 변경, 건너뛰기 또는 교체될지
- **Env 입력(Env inputs)** — 가져온 후 값이 필요할 수 있는 환경 변수
- **경고(Warnings)** — 누락된 스킬이나 해결되지 않은 참조 같은 잠재적 문제

가져온 에이전트는 항상 타이머 하트비트가 비활성화된 상태로 시작합니다. 패키지의 배정/주문형 웨이크 동작은 유지되지만, 보드 운영자가 다시 활성화할 때까지 예약된 런은 꺼져 있습니다.

### 일반적인 워크플로(Common Workflows)

**GitHub에서 컴퍼니 템플릿 복제:**

```sh
paperclipai company import org/company-templates/engineering-team \
  --target new \
  --new-company-name "My Engineering Team"
```

**패키지에서 기존 컴퍼니로 에이전트 추가:**

```sh
paperclipai company import ./shared-agents \
  --target existing \
  --company-id abc123 \
  --include agents \
  --collision rename
```

**특정 브랜치 또는 태그 가져오기:**

```sh
paperclipai company import org/repo --ref v2.0.0 --dry-run
```

**비대화형 가져오기(CI/스크립트):**

```sh
paperclipai company import ./package \
  --target new \
  --yes \
  --json
```

## API 엔드포인트(API Endpoints)

CLI 명령은 내부적으로 다음 API 엔드포인트를 사용합니다:

| 작업(Action) | 엔드포인트(Endpoint) |
|--------|----------|
| 컴퍼니 내보내기 | `POST /api/companies/{companyId}/export` |
| 가져오기 미리 보기(기존 컴퍼니) | `POST /api/companies/{companyId}/imports/preview` |
| 가져오기 적용(기존 컴퍼니) | `POST /api/companies/{companyId}/imports/apply` |
| 가져오기 미리 보기(새 컴퍼니) | `POST /api/companies/import/preview` |
| 가져오기 적용(새 컴퍼니) | `POST /api/companies/import` |

CEO 에이전트는 안전한 가져오기 라우트(`/imports/preview`와 `/imports/apply`)를 사용할 수 있습니다. 이 라우트는 비파괴 규칙을 강제합니다: `replace`는 거부되고, 충돌은 `rename` 또는 `skip`으로 해결되며, 이슈는 항상 새로 생성됩니다.

## GitHub 소스(GitHub Sources)

papercompany는 여러 GitHub URL 형식을 지원합니다:

- 전체 URL: `https://github.com/org/repo`
- 하위 폴더 URL: `https://github.com/org/repo/tree/main/path/to/company`
- Shorthand: `org/repo`
- 경로가 있는 Shorthand: `org/repo/path/to/company`

GitHub에서 가져올 때 특정 브랜치, 태그 또는 커밋 해시에 고정하려면 `--ref`를 사용하세요.
