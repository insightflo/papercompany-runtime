# 접근성 가이드 — papercompany UI

> 버전: 1.0 | 생성: 2026-04-01
> 이 파일은 WCAG 2.1 AA 기준 준수를 위한 색상 대비, 포커스, ARIA, 키보드 내비게이션, 동작 접근성 규칙을 정의합니다.
> 실제 구현 코드(JS/TS)는 포함하지 않습니다. 토큰 참조는 `design/system/tokens.md`를 기준으로 합니다.

---

## 1. 색상 대비

### 1-1. WCAG AA 기준

| 텍스트 유형 | 최소 대비 비율 |
|---|---|
| 일반 텍스트 (< 18pt 또는 굵지 않은 < 14pt) | **4.5:1** |
| 대형 텍스트 (≥ 18pt, 또는 굵은 ≥ 14pt) | **3:1** |
| UI 컴포넌트 (버튼 보더, 인풋 보더, 아이콘) | **3:1** |
| 링크 (주변 텍스트와 구별) | **3:1** |

### 1-2. 토큰별 대비 비율 표

배경 기준 `--color-neutral-900` (#111118) 대비:

| 텍스트 토큰 | 텍스트 색상 | 대비 비율 | AA 일반 | AA 대형/UI |
|---|---|---|---|---|
| `text-neutral-50` (#f5f5fa) | #f5f5fa | ~17:1 | 통과 | 통과 |
| `text-neutral-100` (#e8e8f0) | #e8e8f0 | ~14:1 | 통과 | 통과 |
| `text-neutral-200` (#c4c4d8) | #c4c4d8 | ~9.5:1 | 통과 | 통과 |
| `text-neutral-300` (#9595b4) | #9595b4 | ~6:1 | 통과 | 통과 |
| `text-neutral-400` (#6b6b8e) | #6b6b8e | ~3.8:1 | 통과 | 통과 |
| `text-neutral-500` (#4a4a6a) | #4a4a6a | ~2.3:1 | **실패** | **실패** |

배경 기준 `--color-neutral-800` (#1a1a24) 대비:

| 텍스트 토큰 | 대비 비율 | AA 일반 | AA 대형/UI |
|---|---|---|---|
| `text-neutral-100` (#e8e8f0) | ~12:1 | 통과 | 통과 |
| `text-neutral-200` (#c4c4d8) | ~8.5:1 | 통과 | 통과 |
| `text-neutral-300` (#9595b4) | ~5:1 | 통과 | 통과 |
| `text-neutral-400` (#6b6b8e) | ~3.2:1 | **실패** (일반) | 통과 (대형/UI) |
| `text-neutral-500` (#4a4a6a) | ~1.9:1 | **실패** | **실패** |

#### 시맨틱 텍스트 색상 — 배경 neutral-900 대비

| 토큰 | 색상 | 대비 비율 | AA 일반 |
|---|---|---|---|
| `text-primary-400` (#7878f0) | #7878f0 | ~4.8:1 | 통과 |
| `text-primary-300` (#9a9af5) | #9a9af5 | ~6.5:1 | 통과 |
| `text-success-400` (#4ade80) | #4ade80 | ~8.5:1 | 통과 |
| `text-warning-400` (#fbbf24) | #fbbf24 | ~9:1 | 통과 |
| `text-error-400` (#f87171) | #f87171 | ~5.5:1 | 통과 |
| `text-info-400` (#60a5fa) | #60a5fa | ~5:1 | 통과 |

### 1-3. 사용 금지 조합 (실패 패턴)

아래 조합은 AA 기준을 충족하지 못합니다. 컴포넌트에서 절대 사용하지 않습니다.

| 배경 | 텍스트 | 대비 비율 | 위반 이유 |
|---|---|---|---|
| `neutral-900` | `neutral-500` | ~2.3:1 | 일반 텍스트 4.5:1 미달 |
| `neutral-800` | `neutral-500` | ~1.9:1 | 일반/대형 모두 미달 |
| `neutral-800` | `neutral-400` | ~3.2:1 | 일반 텍스트 4.5:1 미달 (대형/UI 버튼 보더로만 허용) |
| `neutral-700` | `neutral-400` | ~2.5:1 | 일반/대형 모두 미달 |
| `primary-600` | `primary-300` | ~2.1:1 | 버튼 내 텍스트 미달 |

> `neutral-400`는 보조 텍스트(`text-sm` 이하)에 neutral-900 배경 위에서만 허용됩니다. neutral-700/800 배경 위에서는 `text-sm` 이하 본문 텍스트에 사용 금지입니다. 캡션, 타임스탬프 등 비핵심 정보에는 대형 텍스트(18pt 이상) 기준을 적용하여 허용 여부를 판단합니다.

---

## 2. 포커스 인디케이터

### 2-1. 기본 포커스 링

모든 인터랙티브 요소(버튼, 링크, 인풋, 체크박스, 셀렉트)에 일관되게 적용합니다:

```
focus-visible:outline-none
focus-visible:ring-2
focus-visible:ring-primary-500
focus-visible:ring-offset-2
focus-visible:ring-offset-neutral-900
```

색상 토큰: `--color-primary-500` (#5555e8). 오프셋 배경: `--color-neutral-900` (#111118).

> 중요: `:focus-visible` 의사 클래스만 사용합니다. `:focus`를 전역 사용할 경우 마우스 클릭 시에도 링이 표시되어 시각적 노이즈가 발생합니다.

### 2-2. 에러 상태 포커스 링

인풋 필드의 에러 상태에서 포커스 링 색상을 에러 색상으로 교체합니다:

```
focus-visible:ring-error-500
focus-visible:ring-offset-neutral-900
```

색상 토큰: `--color-error-500` (#ef4444).

### 2-3. 카드 / 클릭 가능한 영역

클릭 가능한 카드, 테이블 행 등 블록 레벨 요소:

```
focus-visible:ring-2
focus-visible:ring-primary-500
focus-visible:ring-offset-2
focus-visible:ring-offset-neutral-900
focus-visible:rounded-xl
```

`rounded-xl`은 카드 반경(`radius-xl`, 12px)에 맞춰 링이 잘리지 않도록 설정합니다.

### 2-4. 포커스 순서 (Tab 순서) 규칙

- Tab 순서는 DOM 순서를 따릅니다. `tabindex` 양수 값 사용을 금지합니다.
- 시각적 순서와 DOM 순서가 다른 CSS 레이아웃(예: `order`, `flex-row-reverse`)은 사용하지 않습니다.
- 모달이 열리면 모달 내부로 포커스를 이동하고, 모달 외부 요소는 `inert` 속성 또는 `aria-hidden="true"`로 포커스 트랩을 구현합니다.
- 숨겨진 요소(`display:none`, `visibility:hidden`)는 Tab 순서에서 자동 제외됩니다. `opacity-0`만 적용된 요소는 포커스에 여전히 포함되므로 함께 `pointer-events-none tabindex="-1"`을 적용합니다.

---

## 3. ARIA 레이블 규칙

### 3-1. 아이콘 전용 버튼

텍스트가 없는 아이콘 버튼은 `aria-label` 필수입니다.

```html
<!-- 올바른 예 -->
<button aria-label="미션 삭제">
  <TrashIcon aria-hidden="true" />
</button>

<!-- 잘못된 예 — 스크린 리더가 버튼 목적을 알 수 없음 -->
<button>
  <TrashIcon />
</button>
```

아이콘 자체는 `aria-hidden="true"`로 설정하여 중복 읽기 방지.

### 3-2. 상태 배지

```html
<!-- Mission Status Badge -->
<span
  class="badge"
  aria-label="상태: 진행 중"
>
  진행 중
</span>

<!-- Agent Status — 도트 + 텍스트 조합 -->
<span aria-label="에이전트 상태: 실행 중" class="inline-flex items-center gap-1.5">
  <span class="status-dot" aria-hidden="true"></span>
  <span>실행 중</span>
</span>
```

### 3-3. 모달

```html
<div
  role="dialog"
  aria-modal="true"
  aria-labelledby="modal-title"
  aria-describedby="modal-description"
>
  <h2 id="modal-title">미션 삭제 확인</h2>
  <p id="modal-description">이 작업은 되돌릴 수 없습니다.</p>
  <!-- ... -->
</div>
```

- `role="dialog"` + `aria-modal="true"` 필수
- `aria-labelledby`: 모달 제목 요소의 `id` 참조
- `aria-describedby`: 본문 설명 요소의 `id` 참조 (선택, 있으면 필수)
- 확인/경고 다이얼로그: `role="alertdialog"` 사용

### 3-4. Toast / Notification

| 종류 | ARIA role | 이유 |
|---|---|---|
| `success`, `info`, `warning` | `role="status"` | 비긴급 — 스크린 리더가 현재 흐름 완료 후 읽음 |
| `error` | `role="alert"` | 긴급 — 즉시 인터럽트하여 읽음 |

```html
<!-- Success -->
<div role="status" aria-live="polite" class="toast toast-success">
  저장되었습니다.
</div>

<!-- Error -->
<div role="alert" aria-live="assertive" class="toast toast-error">
  요청 실패: 서버 연결 오류
</div>
```

### 3-5. Loading 상태

버튼 또는 영역이 로딩 중일 때:

```html
<!-- 버튼 Loading -->
<button aria-busy="true" disabled>
  <span class="sr-only">저장 중...</span>
  <Spinner aria-hidden="true" />
</button>

<!-- 페이지 영역 Loading -->
<div aria-busy="true" aria-label="에이전트 목록 불러오는 중">
  <SkeletonCard />
</div>
```

- `aria-busy="true"`: 콘텐츠가 변경 중임을 알림
- `class="sr-only"`: 시각적으로 숨기되 스크린 리더에만 읽힘 (`position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0)`)

### 3-6. 테이블

```html
<table role="grid" aria-label="미션 목록">
  <thead>
    <tr>
      <th scope="col" aria-sort="ascending">미션 이름</th>
      <th scope="col">상태</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>...</td>
    </tr>
  </tbody>
</table>
```

정렬 가능한 컬럼: `aria-sort="ascending" | "descending" | "none"`.

---

## 4. 키보드 내비게이션

### 4-1. 일반 원칙

- 모든 인터랙티브 요소(버튼, 링크, 인풋, 선택 가능한 카드)는 `Tab` 키로 접근 가능해야 합니다.
- `div` 또는 `span`으로 버튼/링크를 만드는 경우 `role="button"` + `tabindex="0"` + `keydown Enter/Space` 이벤트 핸들러를 모두 적용해야 합니다. 가능하면 시맨틱 `<button>` 또는 `<a>` 사용을 강제합니다.
- 사용자 지정 컴포넌트(Select, Combobox, Datepicker 등)는 [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)의 키보드 패턴을 따릅니다.

### 4-2. 모달 포커스 트랩

| 이벤트 | 동작 |
|---|---|
| 모달 열림 | 모달 내 첫 번째 포커스 가능 요소로 이동 (주로 닫기 버튼 또는 첫 번째 인풋) |
| `Tab` | 모달 내 포커스 가능 요소 사이에서 순환 |
| `Shift + Tab` | 역방향 순환 |
| `Escape` | 모달 닫기 + 트리거 요소로 포커스 복귀 |
| 모달 닫힘 | 모달을 열었던 트리거 요소로 포커스 복귀 |

### 4-3. Escape 키 동작

| 컴포넌트 | Escape 동작 |
|---|---|
| 모달 | 닫기 + 트리거 복귀 |
| 드롭다운 (Select, Context Menu) | 닫기 + 트리거 버튼으로 포커스 복귀 |
| Toast | 현재 포커스된 Toast 닫기 (선택적) |
| 인풋 자동완성 | 제안 목록 닫기 (인풋 포커스 유지) |

### 4-4. 데이터 테이블 키보드 이동

`role="grid"` 테이블에서 Arrow 키 셀 이동 지원:

| 키 | 동작 |
|---|---|
| `Arrow Right` / `Arrow Left` | 같은 행의 다음/이전 셀 |
| `Arrow Down` / `Arrow Up` | 같은 열의 다음/이전 행 |
| `Home` | 현재 행의 첫 번째 셀 |
| `End` | 현재 행의 마지막 셀 |
| `Enter` | 셀/행 선택 또는 내부 링크 활성화 |

### 4-5. 사이드바 Navigation

사이드바 `<nav>` 내 항목 키보드 규칙:

| 키 | 동작 |
|---|---|
| `Tab` | 사이드바 첫 항목 진입 / 사이드바 탈출 |
| `Arrow Down` / `Arrow Up` | nav 항목 간 이동 |
| `Enter` / `Space` | 페이지 이동 (활성화) |
| `Home` | 첫 번째 nav 항목 |
| `End` | 마지막 nav 항목 |

Nav 컨테이너: `role="navigation" aria-label="주 메뉴"`. 각 항목: `role="menuitem"` (드롭다운 없는 단순 목록의 경우 `role="link"`도 허용).

---

## 5. 동작 접근성 (Motion Accessibility)

### 5-1. prefers-reduced-motion

`prefers-reduced-motion: reduce`가 활성화된 경우 **모든 CSS 애니메이션과 트랜지션을 비활성화**합니다.

Tailwind 적용 방법:

```
motion-safe:animate-pulse   /* prefers-reduced-motion이 없을 때만 pulse 적용 */
motion-safe:transition-colors
motion-safe:duration-fast
```

또는 글로벌 CSS 규칙:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

### 5-2. 영향을 받는 애니메이션 목록

| 컴포넌트 | 애니메이션 | 비활성화 시 대체 |
|---|---|---|
| Agent running 상태 도트 | `animate-pulse` (2s infinite) | 정적 초록 도트 |
| 모달 진입/퇴장 | `transition duration-slow` (300ms) | 즉시 표시/숨김 |
| 사이드바 접기 (미래 구현) | `transition-width duration-slow` | 즉시 전환 |
| Toast 슬라이드인 | `translate-x-full → translate-x-0` | 즉시 표시 |
| 버튼 hover 색상 | `transition-colors duration-fast` | 즉시 전환 |
| Loading 스피너 | `animate-spin` | 정적 "처리 중..." 텍스트 |

`motion-safe:` 접두사 또는 `@media (prefers-reduced-motion: reduce)` 블록으로 반드시 처리합니다.

### 5-3. Toast 시간 제한

WCAG 2.2.1 (시간 조절 가능): 자동 소멸 Toast는 아래 조건 중 하나를 충족해야 합니다.

| 조건 | 구현 방법 |
|---|---|
| 15초 이상 표시 | duration을 15,000ms 이상으로 설정 |
| 수동 닫기 제공 | 닫기(X) 버튼 포함 |
| Hover 시 타이머 일시 중지 | `pause on hover` 구현 |

현재 규칙 (`components.md` §6.3 참조): success(4s), info(5s)는 hover 일시 중지를 구현하고 닫기 버튼을 포함합니다. warning(8s)과 error(수동 닫기)는 이미 조건을 충족합니다.

---

## 6. Governance — 접근성 검증

### 6-1. 단일 검증 명령

```bash
make verify
# 또는
bash scripts/verify_all.sh
```

접근성 전용 실행:

```bash
make a11y
# 내부적으로 다음을 순차 실행:
# 1. npx pa11y-ci --config .pa11yrc.json
# 2. npx axe-core-cli http://localhost:3000 --tags wcag2a,wcag2aa
# 3. npx lighthouse http://localhost:3000 --only-categories=accessibility
```

### 6-2. CI 연동

| 도구 | 역할 | CI 잡 | 아티팩트 경로 |
|---|---|---|---|
| `axe-core` (via `@axe-core/playwright`) | DOM 기반 자동 접근성 검사 | `a11y-axe` | `reports/axe-results.json` |
| `pa11y-ci` | 주요 페이지 URL 전체 스캔 | `a11y-pa11y` | `reports/pa11y-results.json` |
| `Lighthouse CI` | 접근성 점수 추적 (목표: ≥ 90) | `lighthouse` | `reports/lighthouse/` |
| `eslint-plugin-jsx-a11y` | 정적 JSX 접근성 규칙 검사 | `lint-js` | `reports/eslint.json` |

### 6-3. Block vs Warn 기준

| 위반 유형 | 심각도 | 판정 |
|---|---|---|
| WCAG AA 색상 대비 미달 (일반 텍스트 < 4.5:1) | Critical | **Block** — PR merge 불가 |
| WCAG AA 색상 대비 미달 (대형/UI < 3:1) | Serious | **Block** |
| `aria-label` 누락 (아이콘 전용 버튼) | Serious | **Block** |
| `role="dialog"` 없는 모달 | Serious | **Block** |
| 포커스 트랩 미구현 (모달) | Serious | **Block** |
| `prefers-reduced-motion` 미처리 | Moderate | **Warn** — 리뷰어 승인 필요 |
| `alt` 텍스트 누락 (장식 이미지 제외) | Serious | **Block** |
| Lighthouse 접근성 점수 < 85 | — | **Block** |
| Lighthouse 접근성 점수 85 ~ 89 | — | **Warn** |
| WCAG AAA 위반 (AA는 통과) | Minor | **Warn** |
| Tab 순서 논리적 불일치 | Moderate | **Warn** |

### 6-4. 업데이트 트리거

이 파일(`accessibility.md`)은 아래 상황에서 반드시 업데이트합니다:

- `tokens.md`의 컬러 토큰 값 변경 → §1.2 대비 비율 표 재계산 및 금지 조합 재검토
- 새 인터랙티브 컴포넌트 추가 → §3 ARIA 패턴 및 §4 키보드 동작 등록
- axe-core 또는 Lighthouse 버전 업 → CI 연동 설정 및 Block 기준 재검토
- WCAG 2.2 신규 기준 적용 결정 시 → 관련 섹션 추가
