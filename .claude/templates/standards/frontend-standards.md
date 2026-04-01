# Frontend Development Standards

> 프론트엔드 개발 표준 및 가이드라인

## 1. 프로젝트 구조

### 1.1 디렉토리 구조

```
src/
├── app/                    # Next.js App Router
│   ├── (routes)/           # 페이지 라우트
│   ├── layout.tsx          # 루트 레이아웃
│   └── globals.css         # 전역 스타일
│
├── components/
│   ├── ui/                 # 기본 UI 컴포넌트 (Button, Input, Modal)
│   ├── patterns/           # 복합 패턴 (DataTable, FormField)
│   └── features/           # 기능 컴포넌트 (UserProfile, OrderList)
│
├── hooks/                  # 커스텀 훅
├── lib/                    # 유틸리티, API 클라이언트
├── stores/                 # 전역 상태 (Zustand)
├── types/                  # TypeScript 타입 정의
└── styles/                 # 스타일 관련 (tokens, themes)
```

### 1.2 파일 네이밍

```yaml
components:
  - PascalCase: UserProfile.tsx, DataTable.tsx
  - index.ts로 re-export

hooks:
  - camelCase with use prefix: useAuth.ts, useDebounce.ts

utilities:
  - camelCase: formatDate.ts, parseQuery.ts

types:
  - PascalCase: User.ts, Order.ts
  - 또는 {feature}.types.ts
```

---

## 2. 컴포넌트 표준

### 2.1 컴포넌트 구조

```typescript
// 1. Imports (그룹화)
import { useState } from 'react';        // React
import { useQuery } from '@tanstack/react-query';  // 외부 라이브러리
import { Button } from '@/components/ui'; // 내부 컴포넌트
import { formatDate } from '@/lib/utils'; // 내부 유틸
import type { User } from '@/types';      // 타입

// 2. Types
interface UserCardProps {
  user: User;
  onSelect?: (id: string) => void;
}

// 3. Component
export function UserCard({ user, onSelect }: UserCardProps) {
  // 3.1 State
  const [isExpanded, setIsExpanded] = useState(false);

  // 3.2 Queries/Mutations
  const { data, isLoading } = useQuery({ ... });

  // 3.3 Derived state
  const displayName = `${user.firstName} ${user.lastName}`;

  // 3.4 Event handlers
  const handleClick = () => {
    onSelect?.(user.id);
  };

  // 3.5 Effects (최소화)

  // 3.6 Render
  return (
    <div onClick={handleClick}>
      {displayName}
    </div>
  );
}
```

### 2.2 Props 설계

```typescript
// 1. 필수 props는 최소화
interface ButtonProps {
  children: React.ReactNode;    // 필수
  variant?: 'primary' | 'secondary';  // 선택 (기본값 제공)
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  onClick?: () => void;
}

// 2. HTML 속성 확장
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
}

// 3. Polymorphic 컴포넌트
interface BoxProps<T extends React.ElementType> {
  as?: T;
  children: React.ReactNode;
}
```

---

## 3. 상태 관리

### 3.1 상태 분류

| 유형 | 솔루션 | 예시 |
|------|--------|------|
| Server State | TanStack Query | API 데이터 |
| Client State | useState, Zustand | UI 상태, 폼 |
| URL State | nuqs, URL params | 필터, 페이지 |
| Form State | React Hook Form | 폼 입력/검증 |

### 3.2 Server State (TanStack Query)

```typescript
// Query
const { data, isLoading, error } = useQuery({
  queryKey: ['users', filters],
  queryFn: () => api.getUsers(filters),
  staleTime: 5 * 60 * 1000,  // 5분
  gcTime: 30 * 60 * 1000,    // 30분
});

// Mutation
const mutation = useMutation({
  mutationFn: api.createUser,
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['users'] });
  },
});
```

### 3.3 Client State (Zustand)

```typescript
// 최소한의 전역 상태만
interface AppStore {
  theme: 'light' | 'dark';
  setTheme: (theme: 'light' | 'dark') => void;
}

const useAppStore = create<AppStore>((set) => ({
  theme: 'light',
  setTheme: (theme) => set({ theme }),
}));
```

---

## 4. 성능 최적화

### 4.1 리렌더링 최적화

```typescript
// 1. React.memo - props 변경 시에만 리렌더
const UserCard = memo(function UserCard({ user }: Props) {
  return <div>{user.name}</div>;
});

// 2. useMemo - 비용이 큰 계산 캐싱
const sortedItems = useMemo(() => {
  return items.sort((a, b) => a.name.localeCompare(b.name));
}, [items]);

// 3. useCallback - 함수 참조 안정화
const handleClick = useCallback(() => {
  onSelect(item.id);
}, [item.id, onSelect]);
```

### 4.2 코드 스플리팅

```typescript
// 라우트 기반
const Dashboard = lazy(() => import('./pages/Dashboard'));

// 컴포넌트 기반
const HeavyChart = lazy(() => import('./components/HeavyChart'));

// 조건부 로딩
{showChart && (
  <Suspense fallback={<Skeleton />}>
    <HeavyChart data={data} />
  </Suspense>
)}
```

### 4.3 이미지 최적화

```typescript
// Next.js Image 사용
import Image from 'next/image';

<Image
  src="/hero.jpg"
  alt="Hero image"
  width={1200}
  height={600}
  priority       // LCP 이미지
  placeholder="blur"
/>
```

### 4.4 가상화

```typescript
// 대량 목록 가상화
import { useVirtualizer } from '@tanstack/react-virtual';

const virtualizer = useVirtualizer({
  count: items.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 50,
});
```

---

## 5. 접근성 (a11y)

### 5.1 WCAG 2.1 AA 체크리스트

```yaml
perceivable:
  - [ ] 이미지에 alt 텍스트 제공
  - [ ] 색상만으로 정보 전달 금지
  - [ ] 색상 대비 4.5:1 이상
  - [ ] 텍스트 200% 확대 가능

operable:
  - [ ] 키보드로 모든 기능 접근
  - [ ] 포커스 표시 명확
  - [ ] 클릭 영역 44x44px 이상
  - [ ] Skip to content 링크

understandable:
  - [ ] 명확한 에러 메시지
  - [ ] 폼 레이블 연결
  - [ ] 일관된 네비게이션

robust:
  - [ ] 시맨틱 HTML 사용
  - [ ] ARIA 올바르게 사용
```

### 5.2 접근성 패턴

```typescript
// Button
<button
  type="button"
  aria-pressed={isActive}
  aria-describedby="button-help"
>
  Toggle
</button>

// Dialog
<div
  role="dialog"
  aria-modal="true"
  aria-labelledby="dialog-title"
  aria-describedby="dialog-description"
>
  <h2 id="dialog-title">제목</h2>
  <p id="dialog-description">설명</p>
</div>

// Form
<label htmlFor="email">이메일</label>
<input
  id="email"
  type="email"
  aria-invalid={!!errors.email}
  aria-describedby="email-error"
/>
{errors.email && (
  <span id="email-error" role="alert">
    {errors.email.message}
  </span>
)}
```

---

## 6. 스타일링

### 6.1 디자인 토큰

```typescript
// tokens.ts
export const tokens = {
  colors: {
    primary: {
      50: '#eff6ff',
      500: '#3b82f6',
      900: '#1e3a8a',
    },
    gray: {
      50: '#f9fafb',
      500: '#6b7280',
      900: '#111827',
    },
  },
  spacing: {
    xs: '0.25rem',
    sm: '0.5rem',
    md: '1rem',
    lg: '1.5rem',
    xl: '2rem',
  },
  radius: {
    sm: '0.25rem',
    md: '0.375rem',
    lg: '0.5rem',
    full: '9999px',
  },
};
```

### 6.2 스타일 규칙

```yaml
rules:
  - 하드코딩된 값 금지 (토큰 사용)
  - 인라인 스타일 최소화
  - Tailwind 유틸리티 클래스 선호
  - 복잡한 스타일은 CSS 모듈 사용

tailwind_order:
  1. 레이아웃 (flex, grid, position)
  2. 크기 (w, h, min, max)
  3. 여백 (m, p)
  4. 타이포그래피 (font, text)
  5. 색상 (bg, text, border)
  6. 효과 (shadow, opacity)
  7. 상태 (hover, focus, active)
```

---

## 7. 테스트

### 7.1 테스트 유형

```yaml
unit:
  tools: [Vitest]
  coverage: ">= 80%"
  scope: hooks, utils, 순수 함수

component:
  tools: [Testing Library]
  scope: 컴포넌트 렌더링, 상호작용

integration:
  tools: [MSW, Testing Library]
  scope: API 연동, 전체 플로우

e2e:
  tools: [Playwright]
  scope: 주요 사용자 시나리오
```

### 7.2 테스트 패턴

```typescript
// 컴포넌트 테스트
describe('UserCard', () => {
  it('renders user name', () => {
    render(<UserCard user={mockUser} />);
    expect(screen.getByText(mockUser.name)).toBeInTheDocument();
  });

  it('calls onSelect when clicked', async () => {
    const onSelect = vi.fn();
    render(<UserCard user={mockUser} onSelect={onSelect} />);

    await userEvent.click(screen.getByRole('button'));

    expect(onSelect).toHaveBeenCalledWith(mockUser.id);
  });
});
```

---

## 8. 에러 처리

### 8.1 Error Boundary

```typescript
// Error Boundary
<ErrorBoundary
  fallback={<ErrorFallback />}
  onError={(error) => logError(error)}
>
  <App />
</ErrorBoundary>

// Suspense와 함께
<Suspense fallback={<Loading />}>
  <ErrorBoundary fallback={<Error />}>
    <AsyncComponent />
  </ErrorBoundary>
</Suspense>
```

### 8.2 API 에러 처리

```typescript
const { data, error, isError } = useQuery({
  queryKey: ['users'],
  queryFn: fetchUsers,
  retry: 3,
  retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30000),
});

if (isError) {
  if (error.status === 401) {
    return <LoginPrompt />;
  }
  if (error.status === 404) {
    return <NotFound />;
  }
  return <GenericError error={error} />;
}
```

---

## 9. 보안

### 9.1 XSS 방지

```yaml
rules:
  - dangerouslySetInnerHTML 사용 금지 (필요 시 sanitize)
  - 사용자 입력 이스케이프
  - CSP 헤더 설정

sanitization:
  library: DOMPurify
  config: { ALLOWED_TAGS: ['b', 'i', 'em', 'strong'] }
```

### 9.2 인증 토큰 관리

```yaml
storage:
  access_token: 메모리 (Zustand)
  refresh_token: HttpOnly Cookie

security:
  - 토큰 localStorage 저장 금지
  - 자동 갱신 구현
  - 로그아웃 시 토큰 완전 삭제
```

---

## 10. 번들 최적화

### 10.1 번들 사이즈 제한

```yaml
limits:
  initial_js: < 100KB (gzipped)
  initial_css: < 30KB (gzipped)
  per_route: < 50KB (gzipped)

monitoring:
  tool: "@next/bundle-analyzer"
  ci_check: true
```

### 10.2 최적화 기법

```yaml
techniques:
  - Tree shaking (사용하지 않는 코드 제거)
  - Code splitting (라우트/컴포넌트별 분리)
  - Dynamic imports (지연 로딩)
  - Image optimization (Next.js Image)
  - Font optimization (next/font)
```

---

**Version**: 1.0.0
**Last Updated**: 2026-03-03
