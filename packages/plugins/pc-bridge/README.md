# PC Bridge Plugin

Papercompany A1(리눅스 서버)에서 실행할 수 없는 브라우저 자동화(네이버 블로그 발행)를
운영자 PC(맥)의 브리지 서버로 전달하는 플러그인.

맥 브리지는 SSH 역방향 터널(`-R`)로 A1 루프백 8930 포트에 노출되어 있다:

- `POST /naver-publish` — 헤더 `X-Papercompany-Webhook-Key` + JSON `{"url", "workflow"|"category"}`
  → `{"ok", "message", "url"(발행 퍼머링크), "category", "title", "image_count"}`
- `GET /health` — `{"ok":true}`

## 검증 규칙

- url: `https` 필수, 호스트 화이트리스트 `manual-onboarding.pages.dev`, `gazua.showk.ing`
- workflow 6종 → 카테고리 매핑:

| workflow | category |
|---|---|
| `tech-ai-news` | AI뉴스 |
| `tech-ai-scout` | AI소프트웨어 |
| `agent-team-concept-radar` | AI개념 |
| `youtube-report` | AI유투브요약 |
| `gazua-morning` | 한국증시 |
| `gazua-evening` | 미국증시 |

- `category` 직접 지정은 위 6개 값만 허용. `workflow`와 `category`는 동시 지정 불가.

## 설정

| 키 | 설명 |
|---|---|
| `bridgeBaseUrl` | 맥 브리지 주소 (기본 `http://127.0.0.1:8930`) |
| `webhookKeyRef` | 웹훅 키 시크릿 참조 (권장) |
| `webhookKey` | 인라인 웹훅 키 (시크릿 미사용 시 폴백) |
| `requestTimeoutMs` | 발행 요청 타임아웃 (기본 300000ms — 브라우저 발행은 수 분 소요) |
| `historyLimit` | 발행 이력 최대 보관 수 (기본 50) |

웹훅 키는 설정/시크릿에서만 읽으며 코드에 하드코딩되지 않는다.

## A1에서 호출하는 방법

1. **에이전트 툴 (권장)** — 워크플로우/에이전트가 툴 `pc-bridge-publish` 호출:
   ```json
   { "url": "https://gazua.showk.ing/morning/2026-08-28", "workflow": "gazua-morning" }
   ```
   또는 `{ "url": "...", "category": "한국증시" }`.
   결과(`content` + `data.response`)로 퍼머링크/제목/이미지 수를 받는다.

2. **웹훅 (스크립트용, fire-and-forget)** — Paperclip 서버 API로 직접 POST:
   ```sh
   curl -X POST http://<paperclip>/api/plugins/pc-bridge/webhooks/publish \
     -H 'Content-Type: application/json' \
     -H 'X-Papercompany-Webhook-Key: <맥 브리지 웹훅 키와 동일한 값>' \
     -d '{"url":"https://gazua.showk.ing/morning/2026-08-28","workflow":"gazua-morning"}'
   ```
   플러그인이 키를 검증(타이밍-세이프 비교)한 뒤 맥 브리지로 프록시한다.
   웹훅 응답은 처리 성공/실패만 알리며, 발행 결과는 UI 이력에서 확인한다.

3. **UI 수동 발행** — 사이드바 "PC Bridge" 페이지에서 /health 상태, 최근 이력,
   수동 발행 폼(url + 워크플로우/카테고리 선택) 제공.

## Build

```bash
cd packages/pc-bridge
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

## Install (example)

```bash
paperclipai plugin install --api-base http://localhost:3100 ./packages/pc-bridge
```
