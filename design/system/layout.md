# 레이아웃 규칙 — papercompany UI

> 버전: 1.0 | 생성: 2026-04-01
> 이 파일은 그리드, 브레이크포인트, 앱 레이아웃 구조, 페이지 템플릿, 수직 리듬 규칙을 정의합니다. 실제 구현 코드(JS/TS)는 포함하지 않습니다.
> 색상, 스페이싱, 반경 값은 반드시 `design/system/tokens.md`의 토큰을 참조합니다.

---

## 1. 그리드 시스템

### 1-1. 12컬럼 그리드

모든 페이지 레이아웃은 12컬럼 그리드를 기반으로 합니다.

- Tailwind: `grid grid-cols-12 gap-4` (기본 갭 16px)
- 컬럼 스팬 예시:
  - 전체 너비: `col-span-12`
  - 절반 너비: `col-span-6`
  - 1/3 너비: `col-span-4`
  - 2/3 너비: `col-span-8`
  - 사이드 패널 (1/4): `col-span-3`
  - 메인 콘텐츠 (3/4): `col-span-9`

### 1-2. 컨테이너 최대 너비

| 이름 | max-width | Tailwind | 용도 |
|---|---|---|---|
| `sm` | 640px | `max-w-sm` | 폼 페이지, 확인 모달 |
| `md` | 768px | `max-w-md` | 단일 컬럼 상세 콘텐츠 |
| `lg` | 1024px | `max-w-4xl` | 중간 크기 페이지 |
| `xl` | 1280px | `max-w-[1280px]` | 기본 페이지 컨테이너 |
| `2xl` | 1536px | `max-w-[1536px]` | 와이드 스크린 대시보드 (선택적) |

기본 페이지 컨테이너는 `max-w-[1280px]`을 사용합니다.

### 1-3. 컨테이너 가로 여백

| 화면 크기 | 여백 | Tailwind |
|---|---|---|
| 모바일 (< 640px) | 16px | `px-4` |
| 태블릿 (640px ~ 1023px) | 24px | `sm:px-6` |
| 데스크톱 (≥ 1024px) | 32px | `lg:px-8` |

조합 예시:
```
mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8
```

---

## 2. 브레이크포인트

### 2-1. 정의

| 이름 | 범위 | Tailwind 접두사 | 대응 기기 |
|---|---|---|---|
| `mobile` | < 640px | (기본, 접두사 없음) | 스마트폰 세로 |
| `tablet` | 640px ~ 1023px | `sm:` | 스마트폰 가로, 태블릿 |
| `desktop` | ≥ 1024px | `lg:` | 노트북, 모니터 |
| `wide` | ≥ 1280px | `xl:` | 와이드 모니터, 외부 디스플레이 |

> 참고: Tailwind 기본값에서 `md:`(768px)는 tablet 중간에 해당합니다. 이 시스템에서는 `sm:`과 `lg:`가 주 분기점이며, `md:`는 필요 시 tablet 내 세부 조정에만 사용합니다.

### 2-2. 모바일 퍼스트 원칙

이 앱은 개발자/운영자 전용 도구로 **데스크톱 퍼스트 사용**이 예상됩니다. 그러나 Tailwind의 모바일 퍼스트 CSS 구조(작은 화면 → 큰 화면 오버라이드)를 그대로 따릅니다.

- 기본(모바일) 스타일을 먼저 선언하고, `lg:`, `xl:` 접두사로 데스크톱 확장
- 태블릿/모바일 레이아웃에서는 사이드바를 숨기고 상단 토글 메뉴로 대체

---

## 3. 앱 레이아웃 구조

### 3-1. AppShell

전체 앱을 감싸는 최상위 레이아웃 컨테이너입니다.

```
구조:
[AppShell]  flex h-screen overflow-hidden bg-neutral-900

  [Sidebar]   w-[240px] shrink-0 flex flex-col
              bg-neutral-800 border-r border-neutral-600
              fixed inset-y-0 left-0 z-sticky

  [MainArea]  flex-1 flex flex-col ml-[240px] overflow-hidden
    [TopBar]  h-[56px] shrink-0
    [Content] flex-1 overflow-y-auto
```

색상 토큰: `--color-neutral-900`(앱 배경), `--color-neutral-800`(사이드바), `--color-neutral-600`(보더)
z-index: `z-sticky` (200) — 사이드바가 스크롤 콘텐츠 위에 고정

모바일: Sidebar `hidden lg:flex`. 모바일에서는 `MainArea`의 `ml-[240px]` 제거.

### 3-2. Sidebar

구조:

```
[Sidebar]  flex flex-col h-full

  [상단 로고 영역]  h-[56px] flex items-center px-4
                  border-b border-neutral-600

  [Navigation]    flex-1 overflow-y-auto py-4 px-2
    nav 항목: 미션 / 에이전트 / 도구 / KB / 설정
    각 항목: rounded-lg px-3 py-2 text-sm font-medium
    활성 항목: bg-neutral-700 text-neutral-100
    비활성 항목: text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100

  [하단 상태 영역]  shrink-0 p-4 border-t border-neutral-600
    - 현재 활성 에이전트 수
    - 미션 상태 요약
    - 사용자 / 설정 링크
```

사이드바 너비: `w-[240px]` 고정 (접힘 상태 없음 — 현재 버전).
nav 항목 아이콘: 16px, `text-neutral-400 group-hover:text-neutral-100`, `mr-3` 간격.

### 3-3. TopBar

```
[TopBar]  h-[56px] flex items-center justify-between
          px-6 border-b border-neutral-600 bg-neutral-900
          z-sticky sticky top-0

  [왼쪽]  페이지 제목 (text-xl font-semibold text-neutral-100) 또는 브레드크럼
  [오른쪽] 페이지 레벨 액션 버튼들 (Primary + Ghost 조합)
```

### 3-4. PageContainer

페이지 콘텐츠를 감싸는 내부 컨테이너:

```
mx-auto max-w-[1280px] w-full px-4 sm:px-6 lg:px-8 py-8
```

스페이싱 토큰: `spacing-8` (32px) 상하 패딩.

---

## 4. 페이지 템플릿

### 4-1. List Page (목록 페이지)

미션 목록, 에이전트 목록, 도구 목록 등에 적용합니다.

```
[TopBar]        페이지 제목 + [+ 새로 만들기] Primary 버튼

[PageContainer]
  [Filter Bar]  flex items-center gap-3 mb-6
                - 검색 인풋 (flex-1, max-w-sm)
                - 상태 필터 Select
                - 정렬 Select
                - 뷰 토글 (그리드/테이블)

  [Content]
    [카드 그리드]  grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4
    또는
    [테이블]      w-full, 헤더 bg-neutral-800, 행 border-b border-neutral-700
```

빈 상태(Empty state): 목록이 없을 때 중앙 정렬 안내 메시지 + CTA 버튼.

### 4-2. Detail Page (상세 페이지)

미션 상세, 에이전트 상세 등에 적용합니다.

```
[TopBar]        브레드크럼 또는 [← 뒤로] Ghost 버튼 + 페이지 제목

[PageContainer]
  [브레드크럼]   text-sm text-neutral-400, 구분자 "/" text-neutral-600

  [2컬럼 레이아웃]  grid grid-cols-12 gap-6
    [메인 콘텐츠]   col-span-12 lg:col-span-8
                  섹션 구분: gap-8
    [사이드 패널]   col-span-12 lg:col-span-4
                  bg-neutral-800 border border-neutral-600 rounded-xl p-4
                  상단 고정: lg:sticky lg:top-[72px]
```

사이드 패널 상단 고정 계산: TopBar(56px) + 여유(16px) = `top-[72px]`.

### 4-3. Dashboard (대시보드)

운영 현황 요약에 적용합니다.

```
[TopBar]        "대시보드" 제목 + 새로고침 Ghost 버튼 + 날짜 범위 Select

[PageContainer]
  [통계 카드 행]  grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8
                각 카드: text-3xl font-bold text-neutral-100 (숫자)
                         text-sm text-neutral-400 (레이블)

  [세부 섹션들]  flex flex-col gap-8
    - 미션 상태별 분포 (가로 막대)
    - 에이전트 활동 타임라인
    - 최근 워크트리 규칙 위반 로그
```

통계 숫자: `text-3xl font-bold` — 타이포그래피 토큰 `text-3xl`(30px, 700) 적용.

### 4-4. Form Page (폼 페이지)

미션 생성, 에이전트 설정 등 단일 폼에 적용합니다.

```
[TopBar]        페이지 제목 + [취소] Secondary 버튼

[PageContainer]
  [폼 컨테이너]  max-w-[640px] mx-auto

  [폼 섹션들]   flex flex-col gap-8
    각 섹션:
      [섹션 제목]  text-lg font-semibold text-neutral-100 mb-4
      [필드들]     flex flex-col gap-4

  [폼 푸터]    mt-8 flex items-center justify-end gap-3
               [취소] Secondary md + [저장] Primary md (또는 lg)
```

폼 너비 최대 640px: 긴 텍스트 입력의 가독성과 읽기 편의성 확보.

---

## 5. 수직 리듬 (Vertical Rhythm)

Tailwind `gap-*` 클래스를 스페이싱 토큰(`spacing-*`)에 직접 매핑합니다.

| 맥락 | 간격 | Tailwind | 스페이싱 토큰 |
|---|---|---|---|
| 페이지 내 최상위 섹션 간 | 32px | `gap-8` | `spacing-8` |
| 카드 그리드 아이템 간 | 16px | `gap-4` | `spacing-4` |
| 폼 필드 간 | 16px | `gap-4` | `spacing-4` |
| Label → Input 간 | 4px | `gap-1` / `mb-1` | `spacing-1` |
| 아이콘 → 텍스트 인라인 | 8px | `gap-2` | `spacing-2` |
| 사이드바 nav 항목 간 | 4px | `gap-1` / `space-y-1` | `spacing-1` |
| 배지 내부 패딩 (상하) | 4px | `py-1` | `spacing-1` |
| 카드 내부 패딩 | 16px | `p-4` | `spacing-4` |

**규칙**: 스페이싱은 반드시 4px 배수(4, 8, 12, 16, 24, 32, 48, 64)를 사용합니다. 비규격 값(3px, 5px, 10px 등)은 금지합니다.

---

## 6. Governance — 레이아웃 규칙 검증

### 6-1. 단일 검증 명령

```bash
make verify
# 또는
bash scripts/verify_all.sh
```

### 6-2. 체크 항목 매핑

| 체크 항목 | 실행 방법 | CI 잡 | 아티팩트 경로 | 판정 |
|---|---|---|---|---|
| 비규격 스페이싱 값 | `eslint-plugin-tailwindcss enforced-shorthand` | `lint-css` | `reports/tailwind.log` | Block |
| 12컬럼 초과 스팬 | Custom ESLint rule (gridSpan) | `lint-js` | `reports/eslint.json` | Block |
| 하드코딩 px/rem 인라인 스타일 | `eslint no-inline-styles` | `lint-js` | `reports/eslint.json` | Warn |
| 반응형 Tailwind 누락 | PR 리뷰 체크리스트 수동 확인 | — | — | Warn |
| 레이아웃 스냅샷 회귀 | Storybook + Chromatic (viewport 3종: 375/768/1280) | `visual-regression` | Chromatic 대시보드 | Warn |
| PageContainer 최대 너비 초과 | `playwright` 스크린샷 비교 | `e2e-layout` | `reports/playwright/` | Warn |

### 6-3. 업데이트 트리거

이 파일(`layout.md`)은 아래 상황에서 반드시 업데이트합니다:

- `tokens.md`의 스페이싱 토큰 변경 → 수직 리듬 표 재검토
- 사이드바 너비 또는 TopBar 높이 변경 → AppShell 구조 및 sticky 계산 수정
- 새 페이지 템플릿이 2개 이상의 페이지에서 반복 사용 → 이 파일에 패턴 등록
- 접근성 위반 발견 (포커스 순서, 터치 타깃 등) → 관련 레이아웃 규칙 수정
