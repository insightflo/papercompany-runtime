---
title: 빠른 시작(Quickstart)
summary: 몇 분 안에 papercompany 실행하기
---

papercompany를 5분 안에 로컬에서 실행해 보세요.

## 빠른 시작(권장)

```sh
npx paperclipai onboard --yes
```

이 명령이 설정을 안내하고, 환경을 구성하고, papercompany를 실행합니다.

나중에 papercompany를 다시 시작하려면:

```sh
npx paperclipai run
```

> **참고:** 설정에 `npx`를 사용했다면, 명령을 실행할 때 항상 `npx paperclipai`를 사용하세요. `pnpm paperclipai` 형태는 papercompany 저장소를 클론한 복사본 안에서만 동작합니다(아래 "로컬 개발" 참고).

## 로컬 개발(Local Development)

papercompany 자체를 개발하는 기여자를 위한 방법입니다. 사전 요구 사항: Node.js 24.x 및 pnpm 9+.

저장소를 클론한 다음:

```sh
pnpm install
pnpm dev
```

이렇게 하면 API 서버와 UI가 [http://localhost:3200](http://localhost:3200)에서 시작됩니다.

외부 데이터베이스는 필요 없습니다 — papercompany는 기본적으로 임베디드 PostgreSQL 인스턴스를 사용합니다.

클론한 저장소에서 작업할 때는 다음도 사용할 수 있습니다:

```sh
pnpm paperclipai run
```

이 명령은 설정이 없으면 자동 온보딩(onboarding)을 수행하고, 자동 복구가 포함된 헬스 체크를 실행한 뒤 서버를 시작합니다.

## 다음 단계(What's Next)

papercompany가 실행되면:

1. 웹 UI에서 첫 번째 컴퍼니를 만듭니다
2. 미션과 운영 목표를 정의합니다
3. CEO 에이전트를 만들고 실행 방식을 구성합니다
4. 더 많은 에이전트와 책임으로 조직도를 구축합니다
5. 예산, 승인, 초기 업무를 설정합니다
6. 시작(go)을 누르세요 — 에이전트가 하트비트를 시작하고 컴퍼니가 운영을 시작합니다

<Card title="핵심 개념(Core Concepts)" href="/ko/start/core-concepts">
  papercompany의 핵심 개념 알아보기
</Card>
