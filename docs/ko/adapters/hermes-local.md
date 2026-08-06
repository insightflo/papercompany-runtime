---
title: Hermes Local
summary: Hermes 로컬 어댑터 설정 및 구성
---

`hermes_local` 어댑터는 Hermes를 papercompany 에이전트 런타임으로 로컬에서 실행합니다.

## 사전 요구 사항

- Hermes CLI 설치 및 구성
- Hermes 홈 디렉터리를 가리키는 `HERMES_HOME`(선택 사항)

## 구성 필드

| 필드 | 타입 | 필수 | 설명 |
|-------|------|----------|-------------|
| `cwd` | string | 예 | 에이전트 프로세스의 작업 디렉터리 |
| `model` | string | 아니요 | 사용할 모델 |
| `promptTemplate` | string | 아니요 | 모든 런에 사용되는 프롬프트 |
| `instructionsFilePath` | string | 아니요 | 유효 `cwd` 기준으로 해석되어 런타임에 주입되는 마크다운 지시 파일 |
| `env` | object | 아니요 | 환경 변수(시크릿 참조 지원) |
| `timeoutSec` | number | 아니요 | 프로세스 타임아웃(0 = 타임아웃 없음) |
| `graceSec` | number | 아니요 | 강제 종료 전 유예 시간 |
| `maxTurnsPerRun` | number | 아니요 | 하트비트당 최대 에이전트 턴 수 |

## 환경 테스트

"Test Environment" 검사는 Hermes CLI가 설치되어 있고 접근 가능한지 검증합니다.
