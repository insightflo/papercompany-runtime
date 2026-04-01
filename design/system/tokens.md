# 디자인 토큰 — papercompany UI

> 버전: 1.0 | 생성: 2026-04-01
> 이 파일은 디자인 시스템의 원자 단위를 정의합니다. 모든 컴포넌트와 레이아웃은 여기서 정의된 토큰만 참조해야 합니다.

---

## 1. 컬러 팔레트

### 1-1. 기반 원칙

- **다크 모드 퍼스트**: 기본값이 다크 모드이며, 라이트 모드는 선택적 지원입니다.
- **CSS 커스텀 프로퍼티** (`--color-*`) 로 선언하고, Tailwind 설정에서 `extend.colors`로 매핑합니다.
- 모든 색상 값은 `oklch()` 또는 `hsl()` 표기를 사용합니다. 매직 HEX는 토큰 파일에서만 정의하며 컴포넌트에서 직접 사용을 금지합니다.

---

### 1-2. 중립 (Neutral) — 그레이 스케일

페이지 배경, 서피스, 보더, 텍스트 계층에 사용합니다.

| 토큰 이름 | 값 (hex) | 용도 |
|---|---|---|
| `--color-neutral-950` | `#0a0a0f` | 최심층 배경 (앱 배경) |
| `--color-neutral-900` | `#111118` | 기본 페이지 배경 |
| `--color-neutral-800` | `#1a1a24` | 카드, 사이드바 배경 |
| `--color-neutral-700` | `#252534` | 인풋 배경, 호버 서피스 |
| `--color-neutral-600` | `#32324a` | 보더, 구분선 |
| `--color-neutral-500` | `#4a4a6a` | 비활성 아이콘, 플레이스홀더 |
| `--color-neutral-400` | `#6b6b8e` | 보조 텍스트 (secondary label) |
| `--color-neutral-300` | `#9595b4` | 설명 텍스트 |
| `--color-neutral-200` | `#c4c4d8` | 기본 텍스트 |
| `--color-neutral-100` | `#e8e8f0` | 강조 텍스트 (heading) |
| `--color-neutral-50`  | `#f5f5fa` | 최고 강조 (화이트에 가까움) |

**Tailwind 클래스 예시:**
```
bg-neutral-900   text-neutral-100   border-neutral-600
```

---

### 1-3. 프라이머리 (Primary) — 인디고/블루 계열

주요 액션 버튼, 링크, 선택 상태, 포커스 링에 사용합니다.

| 토큰 이름 | 값 (hex) | 용도 |
|---|---|---|
| `--color-primary-950` | `#0d0d2e` | 깊은 배경 강조 (거의 사용 안 함) |
| `--color-primary-900` | `#141452` | 프라이머리 호버 배경 |
| `--color-primary-800` | `#1e1e7a` | — |
| `--color-primary-700` | `#2b2baa` | 버튼 호버 |
| `--color-primary-600` | `#3b3bcc` | 기본 버튼 배경 |
| `--color-primary-500` | `#5555e8` | 포커스 링, 선택 테두리 |
| `--color-primary-400` | `#7878f0` | 링크 색상 |
| `--color-primary-300` | `#9a9af5` | 강조 라벨 |
| `--color-primary-200` | `#bebef9` | 서브틀한 강조 배경 |
| `--color-primary-100` | `#e0e0fc` | 프라이머리 틴트 배경 |

**Tailwind 클래스 예시:**
```
bg-primary-600   hover:bg-primary-700   text-primary-400   ring-primary-500
```

---

### 1-4. 시맨틱 — 상태 컬러

#### Success (성공, 초록)
| 토큰 | 값 | 용도 |
|---|---|---|
| `--color-success-600` | `#16a34a` | 버튼, 배지 배경 |
| `--color-success-500` | `#22c55e` | 아이콘, 포커스 링 |
| `--color-success-400` | `#4ade80` | 텍스트 |
| `--color-success-100` | `#dcfce7` | 배지 배경 (서브틀) |

#### Warning (경고, 앰버)
| 토큰 | 값 | 용도 |
|---|---|---|
| `--color-warning-600` | `#d97706` | 배지 배경 |
| `--color-warning-500` | `#f59e0b` | 아이콘, 테두리 |
| `--color-warning-400` | `#fbbf24` | 텍스트 |
| `--color-warning-100` | `#fef3c7` | 배지 배경 (서브틀) |

#### Error (오류, 레드)
| 토큰 | 값 | 용도 |
|---|---|---|
| `--color-error-700` | `#b91c1c` | Danger 버튼 호버 |
| `--color-error-600` | `#dc2626` | Danger 버튼 배경 |
| `--color-error-500` | `#ef4444` | 오류 아이콘 |
| `--color-error-400` | `#f87171` | 오류 텍스트 |
| `--color-error-100` | `#fee2e2` | 오류 배지 배경 |

#### Info (정보, 블루)
| 토큰 | 값 | 용도 |
|---|---|---|
| `--color-info-600` | `#2563eb` | 정보 배지 배경 |
| `--color-info-400` | `#60a5fa` | 정보 텍스트, 아이콘 |
| `--color-info-100` | `#dbeafe` | 정보 배지 배경 (서브틀) |

---

### 1-5. 미션 상태 컬러

`missions.status` 열거형: `planning | active | paused | completed | cancelled`

| 상태 | 배경 토큰 | 텍스트 토큰 | 의미 |
|---|---|---|---|
| `planning` | `--color-status-planning-bg`: `#1e293b` | `--color-status-planning-text`: `#94a3b8` | 계획 중 (슬레이트 중간) |
| `active` | `--color-status-active-bg`: `#14532d` | `--color-status-active-text`: `#4ade80` | 진행 중 (초록) |
| `paused` | `--color-status-paused-bg`: `#78350f` | `--color-status-paused-text`: `#fbbf24` | 일시 중지 (앰버) |
| `completed` | `--color-status-completed-bg`: `#1e1b4b` | `--color-status-completed-text`: `#a5b4fc` | 완료 (인디고 연하) |
| `cancelled` | `--color-status-cancelled-bg`: `#1c1917` | `--color-status-cancelled-text`: `#78716c` | 취소 (스톤 어둡) |

**Tailwind 클래스 예시 (active 상태):**
```
bg-[--color-status-active-bg]   text-[--color-status-active-text]
```

---

### 1-6. Worktree 티어 컬러

`worktree_rules.severity`: `MUST | SHOULD | MAY`

| 티어 | 배경 토큰 | 텍스트 토큰 | 보더 토큰 | 의미 |
|---|---|---|---|---|
| `MUST` | `#450a0a` | `#fca5a5` | `#dc2626` | 필수 — 위반 시 즉시 차단 |
| `SHOULD` | `#451a03` | `#fcd34d` | `#d97706` | 권장 — 위반 시 경고 |
| `MAY` | `#1c1c2e` | `#9ca3af` | `#4b5563` | 선택 — 위반 시 감사 로그만 |

MUST는 레드, SHOULD는 앰버, MAY는 뉴트럴 회색입니다. MUST 배지는 반드시 레드 계열을 유지해야 하며 다른 목적으로 오용하지 않습니다.

---

### 1-7. 에이전트 상태 배지 컬러

`agents.status`: `idle | running | paused | error`

| 상태 | 도트 색상 | 텍스트 색상 | 비고 |
|---|---|---|---|
| `idle` | `#6b7280` (neutral-500) | `--color-neutral-400` | 회색 도트 |
| `running` | `#22c55e` (success-500) | `--color-success-400` | 초록, 애니메이션 pulse 적용 |
| `paused` | `#f59e0b` (warning-500) | `--color-warning-400` | 앰버 도트 |
| `error` | `#ef4444` (error-500) | `--color-error-400` | 레드, 애니메이션 없음 |

---

## 2. 타이포그래피

### 2-1. 폰트 스택

이 도구는 개발자/운영자 중심입니다. 코드와 데이터가 많으므로 모노스페이스를 보조 폰트로 격상합니다.

**Sans-serif (UI 텍스트):**
```
font-family: "Inter", "Geist", system-ui, -apple-system, sans-serif;
```
- 가변 폰트(variable font) 우선 로드
- 숫자 정렬: `font-feature-settings: "tnum"` (tabular numbers)

**Monospace (코드, ID, 기술값):**
```
font-family: "GeistMono", "JetBrains Mono", "Fira Code", ui-monospace, monospace;
```
- 리가처(ligature): 선택적. 운영자 도구이므로 `->`, `!=`, `=>` 리가처는 켜도 무방합니다.
- JSON 에디터, cron 식 인풋, 에이전트 ID 표시에 강제 적용합니다.

---

### 2-2. 타입 스케일

4px 베이스 그리드 기준. `rem` 단위 사용 (루트 16px 기준).

| 토큰 | rem | px | line-height | font-weight | 용도 |
|---|---|---|---|---|---|
| `text-xs` | `0.75rem` | 12px | `1rem` (16px) | 400 | 캡션, 메타 정보, 타임스탬프 |
| `text-sm` | `0.875rem` | 14px | `1.25rem` (20px) | 400 | 보조 텍스트, 배지 라벨, 폼 힌트 |
| `text-base` | `1rem` | 16px | `1.5rem` (24px) | 400 | 기본 본문 텍스트 |
| `text-lg` | `1.125rem` | 18px | `1.75rem` (28px) | 500 | 카드 제목, 섹션 라벨 |
| `text-xl` | `1.25rem` | 20px | `1.75rem` (28px) | 600 | 페이지 서브 헤딩 |
| `text-2xl` | `1.5rem` | 24px | `2rem` (32px) | 600 | 페이지 제목 |
| `text-3xl` | `1.875rem` | 30px | `2.25rem` (36px) | 700 | 대시보드 숫자, 빅 스탯 |
| `text-4xl` | `2.25rem` | 36px | `2.5rem` (40px) | 700 | 히어로 숫자 (미션 카운트 등) |

**모노스페이스 전용 스케일:**
- 코드 블록, JSON 에디터: `text-sm` 고정 (14px/20px)
- 인라인 코드 (배지 내): `text-xs` 고정 (12px)

---

### 2-3. 폰트 웨이트

| 토큰 | 값 | 용도 |
|---|---|---|
| `font-normal` | 400 | 일반 본문 |
| `font-medium` | 500 | 레이블, 카드 제목 |
| `font-semibold` | 600 | 섹션 헤딩, 버튼 |
| `font-bold` | 700 | 페이지 제목, 강조 숫자 |

---

## 3. 스페이싱

### 3-1. 베이스 그리드

**4px 베이스 그리드.** 모든 여백, 패딩, 갭은 4의 배수입니다.

| 토큰 | px | Tailwind | 용도 |
|---|---|---|---|
| `spacing-1` | 4px | `p-1`, `m-1`, `gap-1` | 최소 간격, 아이콘 주변 |
| `spacing-2` | 8px | `p-2`, `m-2`, `gap-2` | 배지 내 패딩, 인라인 갭 |
| `spacing-3` | 12px | `p-3`, `m-3`, `gap-3` | 버튼 패딩 (상하), 소형 카드 |
| `spacing-4` | 16px | `p-4`, `m-4`, `gap-4` | 기본 카드 패딩, 인풋 패딩 |
| `spacing-6` | 24px | `p-6`, `m-6`, `gap-6` | 섹션 간격, 사이드바 패딩 |
| `spacing-8` | 32px | `p-8`, `m-8`, `gap-8` | 페이지 내부 섹션 |
| `spacing-12` | 48px | `p-12`, `m-12`, `gap-12` | 섹션 타이틀 하단 마진 |
| `spacing-16` | 64px | `p-16`, `m-16`, `gap-16` | 페이지 최상단 패딩 |

---

## 4. 보더 반경 (Border Radius)

| 토큰 | 값 | Tailwind | 용도 |
|---|---|---|---|
| `radius-sm` | 4px | `rounded-sm` | 배지, 인라인 칩 |
| `radius-md` | 6px | `rounded-md` | 버튼, 인풋 |
| `radius-lg` | 8px | `rounded-lg` | 카드, 모달 내부 섹션 |
| `radius-xl` | 12px | `rounded-xl` | 모달, 드로어 |
| `radius-2xl` | 16px | `rounded-2xl` | 대형 카드 (대시보드) |
| `radius-full` | 9999px | `rounded-full` | 상태 도트, 아바타 |

---

## 5. 그림자 (Shadows)

다크 모드에서 그림자는 밝기 대비보다 테두리 + 미묘한 glow로 표현합니다.

| 토큰 | 값 | 용도 |
|---|---|---|
| `shadow-sm` | `0 1px 2px rgba(0,0,0,0.4)` | 인풋 필드, 소형 드롭다운 |
| `shadow-md` | `0 4px 12px rgba(0,0,0,0.5)` | 카드, 툴팁 |
| `shadow-lg` | `0 8px 24px rgba(0,0,0,0.6)` | 모달, 팝오버 |
| `shadow-xl` | `0 16px 48px rgba(0,0,0,0.7)` | 전체 모달 오버레이 |
| `shadow-glow-primary` | `0 0 0 2px rgba(85,85,232,0.4)` | 포커스 링 (primary) |
| `shadow-glow-error` | `0 0 0 2px rgba(239,68,68,0.4)` | 오류 상태 포커스 링 |

---

## 6. Z-인덱스 스케일

| 토큰 | 값 | 용도 |
|---|---|---|
| `z-base` | 0 | 일반 콘텐츠 |
| `z-dropdown` | 100 | 셀렉트 드롭다운, 컨텍스트 메뉴 |
| `z-sticky` | 200 | 고정 헤더, 사이드바 |
| `z-overlay` | 300 | 오버레이 배경 (모달 뒤) |
| `z-modal` | 400 | 모달 패널 |
| `z-toast` | 500 | 토스트 알림 (최상위) |

---

## 7. 애니메이션 / 트랜지션

| 토큰 | 값 | 용도 |
|---|---|---|
| `duration-fast` | 100ms | 호버 상태 전환 |
| `duration-normal` | 200ms | 버튼 클릭, 토글 |
| `duration-slow` | 300ms | 모달 진입/퇴장, 사이드바 접기 |
| `easing-default` | `cubic-bezier(0.4, 0, 0.2, 1)` | 일반 이징 (ease-in-out) |
| `easing-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 스프링 팝오버 (경량) |

에이전트 `running` 상태 도트: `animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite`
`prefers-reduced-motion` 미디어 쿼리가 활성화된 경우 모든 애니메이션을 제거해야 합니다. (접근성 참조)

---

## 8. Governance — 디자인 시스템 준수 검증

### 8-1. 정의 위치

모든 토큰은 두 군데에 선언합니다:

1. `ui/src/styles/tokens.css` — CSS 커스텀 프로퍼티 선언 (`:root` 내)
2. `tailwind.config.ts` — `extend.colors`, `extend.spacing` 등에 토큰 값 매핑

컴포넌트 내 `style={{ color: '#...' }}` 직접 HEX 사용은 금지합니다.

### 8-2. 린트 규칙

| 항목 | 강제 방법 |
|---|---|
| Tailwind 클래스 외 하드코딩 색상 | ESLint + `eslint-plugin-tailwindcss` `no-custom-classname` 규칙 |
| 임의 값 사용 (`text-[#abc]`) | PR 리뷰 체크리스트 항목: "임의 HEX 사용 여부" |
| 토큰 미정의 상태 | `tailwind.config.ts`에 `safelist` 없이 `content` 경로만 스캔 — 미사용 클래스 자동 제거 |

### 8-3. PR 체크리스트

새 컴포넌트 또는 스타일 변경 PR에서 다음을 확인합니다:

- [ ] 색상은 토큰 또는 Tailwind 클래스만 사용 (임의 HEX 없음)
- [ ] 스페이싱은 4px 그리드 단위 (3px, 5px 등 비규격 없음)
- [ ] 다크 모드 기준으로 설계 (라이트 모드 전환 시 깨지지 않음)
- [ ] 새 시맨틱 컬러 추가 시 `tokens.md` + `tokens.css` 동시 업데이트
- [ ] 미션/에이전트/워크트리 상태 색상 변경 시 `components.md` 배지 섹션도 함께 갱신

### 8-4. 주기적 감사

- 분기마다 Storybook 기반 시각적 회귀 테스트 실행 (Chromatic 또는 Percy)
- `tokens.css` 내 사용되지 않는 CSS 변수를 반기마다 정리
- 접근성 대비 비율: Lighthouse + axe-core CI 연동으로 AA 미달 자동 감지
