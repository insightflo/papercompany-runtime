# 컴포넌트 규칙 — papercompany UI

> 버전: 1.0 | 생성: 2026-04-01
> 이 파일은 UI 컴포넌트의 시각적 규칙과 상태 정의를 담습니다. 실제 구현 코드(JS/TS)는 포함하지 않습니다.
> 모든 색상, 스페이싱, 반경, 그림자 값은 반드시 `design/system/tokens.md`의 토큰을 참조합니다.

---

## 1. Button

### 1-1. Variants

버튼은 4가지 의미론적 변형을 제공합니다. 페이지 내 동일 레벨에서 Primary 버튼은 최대 1개를 원칙으로 합니다.

| Variant | Tailwind 클래스 | 용도 |
|---|---|---|
| **Primary** | `bg-primary-600 hover:bg-primary-700 active:bg-primary-800 text-white font-semibold rounded-md` | 핵심 단일 행동 (미션 생성, 저장) |
| **Secondary** | `bg-neutral-700 hover:bg-neutral-600 active:bg-neutral-500 text-neutral-100 border border-neutral-600 font-medium rounded-md` | 보조 행동 (취소, 뒤로가기) |
| **Ghost** | `bg-transparent hover:bg-neutral-700 active:bg-neutral-600 text-neutral-300 hover:text-neutral-100 font-medium rounded-md` | 툴바, 아이콘 인접 텍스트 버튼 |
| **Danger** | `bg-error-600 hover:bg-error-700 active:bg-error-800 text-white font-semibold rounded-md` | 삭제, 강제 중단 등 파괴적 행동 |

색상 토큰 참조: `--color-primary-600/700/800`, `--color-neutral-700/600/500`, `--color-error-600/700/800`

### 1-2. 크기 변형

| Size | Tailwind 패딩 | 텍스트 | 아이콘 크기 | 용도 |
|---|---|---|---|---|
| `sm` | `px-3 py-1.5` | `text-sm` | 14px | 테이블 인라인 액션, 배지 내부 |
| `md` (기본) | `px-4 py-2` | `text-sm font-semibold` | 16px | 페이지 내 일반 버튼 |
| `lg` | `px-6 py-3` | `text-base font-semibold` | 20px | 모달 푸터, 폼 제출 |

### 1-3. 상태

| 상태 | 적용 규칙 |
|---|---|
| **Default** | Variant 기본 스타일 적용 |
| **Hover** | `hover:` 접두사 클래스 적용. 전환: `transition-colors duration-fast` (100ms) |
| **Active** | `active:` 접두사 클래스 적용. Primary active: `bg-primary-800` |
| **Disabled** | `disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none` |
| **Loading** | 버튼 텍스트를 숨기고 스피너(16px) 중앙 표시. `aria-busy="true"` + `disabled` 속성 필수 |

Loading 상태 스피너: `animate-spin w-4 h-4 border-2 border-current border-t-transparent rounded-full`
단, `prefers-reduced-motion` 활성 시 스피너 회전 애니메이션 비활성화 — 정적 점 3개 또는 "처리 중..." 텍스트 대체.

### 1-4. Icon Button

아이콘만 표시하는 버튼 규칙:

- 최소 터치 타깃: `w-8 h-8` (sm) / `w-10 h-10` (md) — WCAG 2.5.5 권장 44×44px 충족을 위해 `min-w-[44px] min-h-[44px]`를 권장
- `aria-label` 필수 (예: `aria-label="미션 삭제"`)
- Variant는 Ghost를 기본으로 사용
- Tailwind 예시: `inline-flex items-center justify-center w-10 h-10 rounded-md bg-transparent hover:bg-neutral-700 text-neutral-400 hover:text-neutral-100`

---

## 2. Input Fields

모든 인풋의 기본 베이스 스타일:

```
bg-neutral-700 border border-neutral-600 rounded-md text-neutral-100
placeholder:text-neutral-500 text-sm px-3 py-2
focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 focus:ring-offset-neutral-900
transition-colors duration-fast
```

색상 토큰: `--color-neutral-700`, `--color-neutral-600`, `--color-neutral-100`, `--color-neutral-500`, `--color-primary-500`

### 2-1. 상태

| 상태 | 추가 스타일 |
|---|---|
| **Default** | 베이스 스타일 |
| **Focus** | `focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:ring-offset-neutral-900` |
| **Error** | `border-error-500 focus:border-error-500 focus:ring-error-500` + 하단 에러 메시지 표시 |
| **Disabled** | `disabled:opacity-40 disabled:cursor-not-allowed bg-neutral-800 border-neutral-700` |

에러 상태 토큰: `--color-error-500`, `--color-error-400`

### 2-2. 필드 유형별 규칙

**Text Input / Textarea**
- 단일 줄: 위 베이스 스타일 그대로 적용
- Textarea: `resize-none` 기본. 최소 높이 `min-h-[80px]`. 줄 수 고정 시 `rows` 속성 사용

**Select**
- 네이티브 `<select>` 대신 shadcn/ui `<Select>` 컴포넌트 사용
- 드롭다운 패널: `bg-neutral-800 border border-neutral-600 rounded-md shadow-md`
- 드롭다운 항목 호버: `bg-neutral-700`
- z-index: `z-dropdown` (100) 적용

**Checkbox / Radio**
- 체크박스: `accent-primary-500` 또는 커스텀 구현 시 `w-4 h-4 rounded-sm border-neutral-600 bg-neutral-700 checked:bg-primary-600 checked:border-primary-600`
- 라디오: `w-4 h-4 rounded-full` 동일 색상 규칙

### 2-3. Label + Helper Text + Error Message 패턴

```
[Label]        text-sm font-medium text-neutral-200 mb-1
[Input]        베이스 스타일
[Helper text]  text-xs text-neutral-400 mt-1
[Error msg]    text-xs text-error-400 mt-1 (에러 상태일 때만 표시)
```

- Label은 항상 `<label htmlFor>` 연결 필수
- 에러 메시지는 `id="field-error"`, 인풋에 `aria-describedby="field-error" aria-invalid="true"` 연결
- Helper text는 에러 발생 시 에러 메시지로 교체 (동시 표시 금지)

---

## 3. Card

### 3-1. Base Card

```
bg-neutral-800 border border-neutral-600 rounded-xl p-4
```

hover 효과 (클릭 가능한 카드):
```
hover:border-neutral-500 hover:bg-neutral-700/50 transition-colors duration-fast cursor-pointer
```

색상 토큰: `--color-neutral-800`, `--color-neutral-600`, `--color-neutral-700`, `--color-neutral-500`

### 3-2. Mission Card

구조:
```
[헤더]   flex items-center justify-between mb-3
  [제목]  text-base font-semibold text-neutral-100
  [배지]  Mission Status Badge (§4 참조)
[본문]   text-sm text-neutral-300 mb-4 line-clamp-2
[푸터]   flex items-center gap-4 text-xs text-neutral-400
  - 에이전트 수, 마지막 활동 시각, 워크트리 규칙 수
```

Mission card 클릭 시 Detail page로 이동. hover 효과 적용.

### 3-3. Agent Card

구조:
```
[헤더]   flex items-center gap-3
  [상태 도트]  Agent Status Badge (§4 참조)
  [이름]       text-sm font-medium text-neutral-100
[에이전트 ID]  text-xs font-mono text-neutral-400  (GeistMono 적용)
[액션 버튼]   Ghost sm 버튼들 (일시정지 / 재시작 / 로그 보기)
```

상태 도트: `w-2 h-2 rounded-full` + 상태별 색상 (`--color-success-500` 등)
running 상태: `animate-pulse` 클래스 추가. `prefers-reduced-motion` 시 pulse 비활성화.

### 3-4. Worktree Rule Card

MUST / SHOULD / MAY 세 가지 배경 색상을 카드 좌측 보더로 표현합니다:

| 티어 | 좌측 보더 | 배경 | 텍스트 |
|---|---|---|---|
| MUST | `border-l-4 border-l-[--color-error-600]` | `--color-neutral-800` | 규칙 텍스트 `text-neutral-100` |
| SHOULD | `border-l-4 border-l-[--color-warning-600]` | `--color-neutral-800` | 규칙 텍스트 `text-neutral-100` |
| MAY | `border-l-4 border-l-neutral-600` | `--color-neutral-800` | 규칙 텍스트 `text-neutral-300` |

Tailwind 예시 (MUST):
```
bg-neutral-800 border border-neutral-600 border-l-4 border-l-error-600 rounded-xl p-4
```

---

## 4. Badge / Status Badge

### 4-1. 기본 크기

| Size | Tailwind | 용도 |
|---|---|---|
| `sm` | `text-xs px-1.5 py-0.5 rounded-sm font-medium` | 테이블 셀, 인라인 레이블 |
| `md` (기본) | `text-sm px-2 py-1 rounded-sm font-medium` | 카드, 상세 페이지 |

### 4-2. Mission Status Badge

`missions.status` 열거형에 대한 색상 매핑:

| 상태 | Tailwind (배경 + 텍스트) | 레이블 |
|---|---|---|
| `planning` | `bg-[--color-status-planning-bg] text-[--color-status-planning-text]` | 계획 중 |
| `active` | `bg-[--color-status-active-bg] text-[--color-status-active-text]` | 진행 중 |
| `paused` | `bg-[--color-status-paused-bg] text-[--color-status-paused-text]` | 일시 중지 |
| `completed` | `bg-[--color-status-completed-bg] text-[--color-status-completed-text]` | 완료 |
| `cancelled` | `bg-[--color-status-cancelled-bg] text-[--color-status-cancelled-text]` | 취소 |

### 4-3. Worktree Rule Severity Badge

| 티어 | 배경 | 텍스트 | 보더 |
|---|---|---|---|
| `MUST` | `bg-[#450a0a]` | `text-[#fca5a5]` | `ring-1 ring-error-600` |
| `SHOULD` | `bg-[#451a03]` | `text-[#fcd34d]` | `ring-1 ring-warning-600` |
| `MAY` | `bg-neutral-800` | `text-neutral-400` | `ring-1 ring-neutral-600` |

MUST 배지는 레드 계열을 반드시 유지합니다. 다른 목적(에러가 아닌 강조 등)으로 오용하지 않습니다.

### 4-4. Agent Status Badge

도트 + 텍스트 조합 패턴:

```
<span class="inline-flex items-center gap-1.5">
  <span class="w-2 h-2 rounded-full [상태별 색상]" aria-hidden="true"></span>
  <span class="text-sm [상태별 텍스트 색상]">[상태 레이블]</span>
</span>
```

| 상태 | 도트 | 텍스트 | 애니메이션 |
|---|---|---|---|
| `idle` | `bg-neutral-500` | `text-neutral-400` | 없음 |
| `running` | `bg-success-500 animate-pulse` | `text-success-400` | pulse (2s infinite) |
| `paused` | `bg-warning-500` | `text-warning-400` | 없음 |
| `error` | `bg-error-500` | `text-error-400` | 없음 |

접근성: `aria-label="상태: 실행 중"` 패턴으로 스크린 리더에 상태 전달.

---

## 5. Modal

### 5-1. 구조

```
[Overlay]   fixed inset-0 bg-black/60 backdrop-blur-sm z-overlay flex items-center justify-center
[Panel]     bg-neutral-800 border border-neutral-600 rounded-xl shadow-xl z-modal
  [Header]  flex items-center justify-between px-6 py-4 border-b border-neutral-600
    [제목]    text-lg font-semibold text-neutral-100
    [닫기]    Icon Button (Ghost sm, X 아이콘, aria-label="닫기")
  [Body]    px-6 py-4 text-sm text-neutral-200 overflow-y-auto
  [Footer]  flex items-center justify-end gap-3 px-6 py-4 border-t border-neutral-600
```

색상 토큰: `--color-neutral-800`, `--color-neutral-600`. z-index: `z-overlay`(300), `z-modal`(400).

### 5-2. 최대 너비 기준

| Size | max-width | 용도 |
|---|---|---|
| `sm` | `max-w-[400px]` | 확인/경고 다이얼로그 |
| `md` | `max-w-[560px]` | 일반 폼 모달 |
| `lg` | `max-w-[720px]` | 복잡한 폼, 상세 정보 |
| `xl` | `max-w-[900px]` | 에이전트 로그, 코드 에디터 |

패널 전체 스타일 예시 (md):
```
w-full max-w-[560px] mx-auto bg-neutral-800 border border-neutral-600 rounded-xl shadow-xl
```

### 5-3. 닫기 방법

- X 버튼 클릭
- Overlay 클릭 (선택적 — 파괴적 행동 확인 모달은 Overlay 클릭 닫기 비활성화)
- `Escape` 키 입력

모달 열릴 때 첫 번째 포커스 가능 요소로 포커스 이동. 닫힐 때 트리거 요소로 포커스 복귀.
`role="dialog" aria-modal="true" aria-labelledby` 필수. 자세한 내용은 `accessibility.md` §3 참조.

---

## 6. Toast / Notification

### 6-1. 4종 스타일

| 종류 | 아이콘 색상 | 보더 왼쪽 | 배경 | 용도 |
|---|---|---|---|---|
| `success` | `text-success-400` | `border-l-4 border-l-success-500` | `bg-neutral-800` | 저장 완료, 에이전트 시작 |
| `warning` | `text-warning-400` | `border-l-4 border-l-warning-500` | `bg-neutral-800` | 주의가 필요한 상태 변경 |
| `error` | `text-error-400` | `border-l-4 border-l-error-500` | `bg-neutral-800` | 요청 실패, 에이전트 오류 |
| `info` | `text-info-400` | `border-l-4 border-l-info-600` | `bg-neutral-800` | 일반 알림, 상태 변경 |

기본 구조:
```
fixed bottom-4 right-4 z-toast
w-80 bg-neutral-800 border border-neutral-600 rounded-xl shadow-lg
px-4 py-3 flex items-start gap-3
```

### 6-2. 위치

오른쪽 하단 고정: `fixed bottom-4 right-4`. z-index: `z-toast` (500).
Toast 여러 개 쌓일 경우 `flex flex-col gap-2` 방향으로 위쪽 방향 스택.

### 6-3. 자동 소멸 기준

| 종류 | 기본 duration | 비고 |
|---|---|---|
| `success` | 4,000ms | 자동 소멸 |
| `info` | 5,000ms | 자동 소멸 |
| `warning` | 8,000ms | 자동 소멸 또는 수동 닫기 |
| `error` | 소멸 없음 | 수동 닫기 필수 |

WCAG 2.2.1: 시간 제한 콘텐츠는 15초 이상 유지하거나 수동 닫기를 제공해야 합니다. 위 기준 중 warning/error는 이미 충족. success/info는 `pause on hover` 구현으로 보완합니다.

### 6-4. 액션 버튼 포함 패턴

Toast 내 액션 버튼: Ghost sm 버튼 사용.
예시: "실행 취소", "자세히 보기", "재시도"

```
[아이콘]  w-5 h-5 shrink-0 [종류별 텍스트 색상]
[콘텐츠]  flex-1
  [제목]    text-sm font-medium text-neutral-100
  [설명]    text-xs text-neutral-400 mt-0.5
  [액션]    mt-2 flex gap-2
[닫기]    Ghost Icon Button (X 아이콘, w-8 h-8, aria-label="알림 닫기")
```

ARIA: success/info/warning → `role="status"`. error → `role="alert"`. 자세한 내용은 `accessibility.md` §3 참조.

---

## 7. Governance — 컴포넌트 규칙 검증

### 7-1. 단일 검증 명령

```bash
make verify
# 또는
bash scripts/verify_all.sh
```

### 7-2. 체크 항목 매핑

| 체크 항목 | 실행 방법 | CI 잡 | 아티팩트 경로 | 판정 |
|---|---|---|---|---|
| Tailwind 클래스 유효성 | `npx tailwindcss --dry-run` | `lint-css` | `reports/tailwind.log` | Block |
| 하드코딩 HEX 색상 | `eslint --rule tailwindcss/no-custom-classname` | `lint-js` | `reports/eslint.json` | Block |
| TypeScript 타입 오류 | `npx tsc --noEmit` | `type-check` | `reports/tsc.log` | Block |
| 접근성 AA 미달 | `axe-core` + `pa11y-ci` | `a11y` | `reports/a11y.json` | Block (AA) / Warn (AAA) |
| 컴포넌트 스냅샷 회귀 | Storybook + Chromatic | `visual-regression` | Chromatic 대시보드 | Warn |
| MUST 배지 오용 | Custom ESLint rule (badgeMustColor) | `lint-js` | `reports/eslint.json` | Block |

### 7-3. 업데이트 트리거

이 파일(`components.md`)은 아래 상황에서 반드시 업데이트합니다:

- `tokens.md`의 컬러 토큰 값 변경 → 관련 배지/버튼 섹션 색상 재검토
- 접근성 위반 발견 (AA 미달) → 해당 컴포넌트 상태 규칙 수정
- 새 핵심 도메인 패턴 추가 (예: 새 에이전트 상태, 새 미션 타입) → 배지 섹션 확장
- 신규 컴포넌트가 3개 이상의 페이지에서 반복 사용 → 이 파일에 패턴 등록

업데이트 시 `tokens.md` § 8-3 PR 체크리스트도 함께 확인합니다.
