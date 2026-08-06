---
title: Docker
summary: Docker Compose 퀵스타트
---

Node나 pnpm을 로컬에 설치하지 않고 Docker에서 papercompany를 실행하세요.

## Compose 퀵스타트(권장)

```sh
docker compose -f docker-compose.quickstart.yml up --build
```

[http://localhost:3200](http://localhost:3200)을 엽니다.

기본값:

- 호스트 포트: `3200`
- 데이터 디렉터리: `./data/docker-paperclip`

환경 변수로 재정의:

```sh
PAPERCLIP_PORT=3300 PAPERCLIP_DATA_DIR=./data/pc \
  docker compose -f docker-compose.quickstart.yml up --build
```

## 수동 Docker 빌드

`Dockerfile` 이미지는 `PORT=3100`을 고정합니다(퀵스타트의 `3200`과 다름):

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

## 데이터 영속화

모든 데이터는 바인드 마운트(`./data/docker-paperclip`) 아래에 저장됩니다:

- 임베디드 PostgreSQL 데이터
- 업로드된 에셋
- 로컬 시크릿 키
- 에이전트 워크스페이스 데이터

## Docker의 Claude 및 Codex 어댑터

Docker 이미지에는 다음이 사전 설치되어 있습니다:

- `claude` (Anthropic Claude Code CLI)
- `codex` (OpenAI Codex CLI)

컨테이너 내부에서 로컬 어댑터 런을 활성화하려면 API 키를 전달하세요:

```sh
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-... \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

API 키가 없어도 앱은 정상적으로 실행됩니다. 어댑터 환경 검사에서 누락된 사전 요구 사항을 표시해 줄 것입니다.
