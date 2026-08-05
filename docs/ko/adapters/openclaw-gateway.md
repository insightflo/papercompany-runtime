---
title: OpenClaw 게이트웨이
summary: OpenClaw webhook 게이트웨이 어댑터
---

`openclaw_gateway` 어댑터는 로컬 CLI를 실행하는 대신 wake 페이로드를 OpenClaw webhook으로 전송합니다. OpenClaw는 별도의 서비스(일반적으로 Docker)로 실행되며 HTTP로 wake 요청을 받습니다.

## 사전 요구 사항

- webhook 엔드포인트가 있는 실행 중인 OpenClaw 인스턴스
- papercompany 서버에서 접근 가능한 webhook URL

## 구성 필드

| 필드 | 타입 | 필수 | 설명 |
|-------|------|----------|-------------|
| `webhookUrl` | string | 예 | wake 페이로드를 받을 OpenClaw webhook URL |
| `headers` | object | 아니요 | 각 wake 페이로드와 함께 보낼 추가 헤더 |
| `timeoutSec` | number | 아니요 | 요청 타임아웃 |

## Wake 페이로드

각 하트비트는 런 컨텍스트(에이전트 ID, 회사 ID, 런 ID, 태스크 컨텍스트)를 담은 wake 페이로드를 전송하여 OpenClaw가 작업을 가져갈 수 있게 합니다.

## Docker 설정

로컬 개발의 경우 자동화된 조인 스모크 테스트와 초대/온보딩 플로우에 대해서는 [Running OpenClaw in Docker](/ko/guides/openclaw-docker-setup)를 참고하세요.
