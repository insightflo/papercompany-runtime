---
title: 스킬 작성하기(Writing a Skill)
summary: SKILL.md 형식과 모범 사례
---

스킬은 에이전트가 하트비트 중에 호출할 수 있는 재사용 가능한 지침입니다. 특정 태스크를 수행하는 방법을 에이전트에게 가르치는 마크다운 파일입니다.

## 스킬 구조(Skill Structure)

스킬은 YAML frontmatter가 포함된 `SKILL.md` 파일을 담은 디렉터리입니다:

```
skills/
└── my-skill/
    ├── SKILL.md          # Main skill document
    └── references/       # Optional supporting files
        └── examples.md
```

## SKILL.md 형식(SKILL.md Format)

```markdown
---
name: my-skill
description: >
  Short description of what this skill does and when to use it.
  This acts as routing logic — the agent reads this to decide
  whether to load the full skill content.
---

# My Skill

Detailed instructions for the agent...
```

### Frontmatter 필드(Frontmatter Fields)

- **name** — 스킬의 고유 식별자(kebab-case)
- **description** — 에이전트에게 이 스킬을 언제 사용할지 알려주는 라우팅 설명. 마케팅 문구가 아니라 결정 로직으로 작성하세요.

## 런타임에서 스킬이 동작하는 방식(How Skills Work at Runtime)

1. 에이전트가 컨텍스트에서 스킬 메타데이터(이름 + 설명)를 봅니다
2. 에이전트가 스킬이 현재 태스크와 관련이 있는지 결정합니다
3. 관련이 있으면 전체 SKILL.md 콘텐츠를 로드합니다
4. 에이전트가 스킬의 지침을 따릅니다

이렇게 하면 기본 프롬프트가 작게 유지됩니다 — 전체 스킬 콘텐츠는 필요할 때만 로드됩니다.

## 모범 사례(Best Practices)

- **설명을 라우팅 로직으로 작성하세요** — "언제 사용"과 "언제 사용하지 말 것" 지침을 포함
- **구체적이고 실행 가능하게 작성하세요** — 에이전트가 모호함 없이 스킬을 따를 수 있어야 함
- **코드 예시를 포함하세요** — 구체적인 API 호출과 커맨드 예시가 산문보다 더 신뢰할 수 있음
- **스킬을 집중적으로 유지하세요** — 관심사 하나당 스킬 하나; 관련 없는 절차를 합치지 말 것
- **참조 파일을 아껴 쓰세요** — 보조 세부 사항은 메인 SKILL.md를 부풀리지 말고 `references/`에 넣기

## 스킬 주입(Skill Injection)

어댑터는 스킬을 자신의 에이전트 런타임이 발견할 수 있게 만들 책임이 있습니다. `claude_local` 어댑터는 심볼릭 링크가 있는 임시 디렉터리와 `--add-dir`을 사용합니다. `codex_local` 어댑터는 전역 스킬 디렉터리를 사용합니다. 자세한 내용은 [어댑터 만들기](/adapters/creating-an-adapter) 가이드를 참고하세요.

## 증거에서 스킬 개선하기(Improving Skills From Evidence)

papercompany 에이전트는 스킬을 훈련 가능한 운영 자산으로 취급해야 하지만, 검증 없는 자기 편집 메모리로는 취급해서는 안 됩니다. 반복 작업을 통해 스킬, 규칙, KB 항목, 워크플로 또는 역할 하니스(role harness)가 바뀌어야 한다는 것이 드러나면 SkillOpt-lite 자기 개선 루프를 사용하세요. 기본 패치 형태는 광범위한 재작성이 아니라 제한된(bounded) add/delete/replace 제안입니다.

### 입력(Inputs)

편집을 제안하기 전에 롤아웃 증거(rollout evidence)를 수집하세요:

- 이슈 코멘트와 클로즈아웃,
- 런 로그와 툴 출력,
- 테스트, API/DB 리드백, 스크린샷 또는 생성된 아티팩트,
- 검증자의 PASS / REQUEST_CHANGES / BLOCKED 근거,
- 사용자 수정.

수정이 명시적이고 지속적이지 않은 한, 단일 일화(anecdote)를 충분한 증거로 사용하지 마세요.

### 패치 제안 형식(Patch proposal format)

편집을 제한적이고 검토 가능하게 유지하세요:

```md
Self-improvement candidate:
- Asset: <skill | rule | KB | workflow | role harness>
- Evidence source: <links/issue/run/log/test/screenshot/user correction>
- Current failure or success pattern: <reusable behavior>
- Proposed bounded edit: <add/delete/replace, exact section>
- Validation plan: <reference task/check/test/readback>
- Rejected-edit note: <if a similar edit failed before>
- Gate owner: <agent/peer validator responsible for automatic validation>
- Auto-adoption result: <accepted | rejected | queued_for_validation | repair_needed>
```

### 게이트(Gate)

에이전트 검증자 또는 피어 게이트가 전후 증거를 비교하거나 레퍼런스 태스크에 대해 제한된 편집을 승인할 수 있으면 패치를 자동으로 수용하세요. 이것은 자동화된 검증 게이트입니다: 사용자 승인 워크플로가 아니라 에이전트 게이트 채택입니다. 제한된 내부 스킬/규칙/KB/워크플로/역할 하니스 채택에 사용자 승인을 기다리지 마세요. 검증이 실패하면 거부된 편집 노트에 이유를 남겨 미래 에이전트가 같은 비효과적 지침을 재시도하지 않게 하세요. 검증 증거가 없으면 사용자에게 결정을 요청하는 대신 검증/수리 슬라이스를 큐에 넣으세요.

### 승격하지 말 것(What not to promote)

스킬에 낡은 상태를 추가하지 마세요: PR 번호, 이슈 ID, 커밋 해시, 일회성 로그, 임시 워크어라운드, 세션 요약. 그것들은 이슈 히스토리에 속하지, 재사용 가능한 스킬에 속하지 않습니다.
