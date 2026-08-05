# Docker에서 OpenClaw 실행하기(로컬 개발)(Running OpenClaw in Docker (Local Development))

로컬 개발과 papercompany OpenClaw 어댑터 통합 테스트를 위해 Docker 컨테이너에서 OpenClaw를 실행하는 방법입니다.

## 자동화된 조인 스모크 테스트(권장)(Automated Join Smoke Test (Recommended First))

papercompany에는 엔드투엔드 조인 스모크 하니스(join smoke harness)가 포함되어 있습니다:

```bash
pnpm smoke:openclaw-join
```

하니스는 다음을 자동화합니다:

- 초대(invite) 생성(`allowedJoinTypes=agent`)
- OpenClaw 에이전트 조인 요청(`adapterType=openclaw`)
- 보드 승인
- 일회용 API 키 클레임(무효/리플레이 클레임 확인 포함)
- Docker로 실행된 OpenClaw 스타일 웹훅 수신기로 웨이크업 콜백 전달

기본적으로 미리 구성된 Docker 수신기 이미지(`docker/openclaw-smoke`)를 사용하므로 런이 결정적이고 수동 OpenClaw 구성 편집이 필요 없습니다.

권한 참고:

- 하니스는 보드가 통제하는 작업(초대 생성, 조인 승인, 새 에이전트 웨이크업)을 수행합니다.
- 인증 모드에서는 보드/운영자 인증을 제공하세요. 그렇지 않으면 런이 명시적인 권한 오류와 함께 조기 종료됩니다.

## 원커맨드 OpenClaw 게이트웨이 UI(수동 Docker 흐름)(One-Command OpenClaw Gateway UI (Manual Docker Flow))

Docker에서 OpenClaw를 띄우고 호스트 브라우저 대시보드 URL을 한 명령으로 출력하려면:

```bash
pnpm smoke:openclaw-docker-ui
```

기본 동작은 제로 플래그입니다: 페어링 관련 env 변수 없이 그대로 명령을 실행할 수 있습니다.

이 명령이 하는 일:

- `/tmp/openclaw-docker`에서 `openclaw/openclaw` 클론/업데이트
- `openclaw:local` 빌드(`OPENCLAW_BUILD=0`이 아니면)
- `~/.openclaw-paperclip-smoke/openclaw.json`과 Docker `.env`에 격리된 스모크 구성 작성
- 에이전트 모델 기본값을 OpenAI로 고정(`openai/gpt-5.2`, OpenAI 폴백 포함)
- Compose로 `openclaw-gateway` 시작(필수 `/tmp` tmpfs 오버라이드 포함)
- OpenClaw Docker 내부에서 도달 가능한 papercompany 호스트 URL 프로브 및 출력
- 헬스 대기 후 다음 출력:
  - `http://127.0.0.1:18789/#token=...`
- 로컬 스모크 편의를 위해 기본적으로 Control UI 기기 페어링 비활성화

환경 노브(Environment knobs):

- `OPENAI_API_KEY`(필수, env 또는 `~/.secrets`에서 로드)
- `OPENCLAW_DOCKER_DIR`(기본값 `/tmp/openclaw-docker`)
- `OPENCLAW_GATEWAY_PORT`(기본값 `18789`)
- `OPENCLAW_GATEWAY_TOKEN`(기본값 랜덤)
- `OPENCLAW_BUILD=0`으로 재빌드 건너뛰기
- `OPENCLAW_OPEN_BROWSER=1`로 macOS에서 URL 자동 열기
- `OPENCLAW_DISABLE_DEVICE_AUTH=1`(기본값) 로컬 스모크용 Control UI 기기 페어링 비활성화
- `OPENCLAW_DISABLE_DEVICE_AUTH=0` 페어링 유지(그러면 `devices` CLI 명령으로 브라우저 승인)
- `OPENCLAW_MODEL_PRIMARY`(기본값 `openai/gpt-5.2`)
- `OPENCLAW_MODEL_FALLBACK`(기본값 `openai/gpt-5.2-chat-latest`)
- `OPENCLAW_CONFIG_DIR`(기본값 `~/.openclaw-paperclip-smoke`)
- `OPENCLAW_RESET_STATE=1`(기본값) 매 런마다 스모크 에이전트 상태를 리셋해 낡은 인증/세션 드리프트 방지
- `PAPERCLIP_HOST_PORT`(기본값 `3100`)
- `PAPERCLIP_HOST_FROM_CONTAINER`(기본값 `host.docker.internal`)

### 인증 모드(Authenticated mode)

papercompany 배포가 `authenticated`면 인증 컨텍스트를 제공하세요:

```bash
PAPERCLIP_AUTH_HEADER="Bearer <token>" pnpm smoke:openclaw-join
# or
PAPERCLIP_COOKIE="your_session_cookie=..." pnpm smoke:openclaw-join
```

### 네트워크 토폴로지 팁(Network topology tips)

- 로컬 동일 호스트 스모크: 기본 콜백은 `http://127.0.0.1:<port>/webhook`을 사용합니다.
- OpenClaw Docker 내부에서 `127.0.0.1`은 호스트 papercompany 서버가 아니라 컨테이너 자신을 가리킵니다.
- Docker의 OpenClaw가 사용하는 초대/온보딩 URL에는 스크립트가 출력한 papercompany URL(보통 `http://host.docker.internal:3100`)을 사용하세요.
- papercompany가 컨테이너에서 보이는 호스트를 호스트네임 오류로 거부하면 호스트에서 허용하세요:

```bash
pnpm paperclipai allowed-hostname host.docker.internal
```

그런 다음 papercompany를 재시작하고 스모크 스크립트를 다시 실행하세요.
- Docker/원격 OpenClaw: 도달 가능한 호스트네임(Docker 호스트 별칭, Tailscale 호스트네임 또는 공개 도메인)을 선호하세요.
- 인증/프라이빗 모드: 필요할 때 호스트네임이 허용 목록에 있는지 확인하세요:

```bash
pnpm paperclipai allowed-hostname <host>
```

## 사전 요구 사항(Prerequisites)

- **Docker Desktop v29+**(Docker Sandbox 지원 포함)
- Docker 이미지 빌드에 **2 GB+ RAM** 사용 가능
- `~/.secrets`의 **API 키**(최소 `OPENAI_API_KEY`)

## 옵션 A: Docker 샌드박스(권장)(Option A: Docker Sandbox (Recommended))

Docker Sandbox는 Docker Compose보다 더 나은 격리(microVM 기반)와 더 간단한 설정을 제공합니다. Docker Desktop v29+ / Docker Sandbox v0.12+가 필요합니다.

```bash
# 1. Clone the OpenClaw repo and build the image
git clone https://github.com/openclaw/openclaw.git /tmp/openclaw-docker
cd /tmp/openclaw-docker
docker build -t openclaw:local -f Dockerfile .

# 2. Create the sandbox using the built image
docker sandbox create --name openclaw -t openclaw:local shell ~/.openclaw/workspace

# 3. Allow network access to OpenAI API
docker sandbox network proxy openclaw \
  --allow-host api.openai.com \
  --allow-host localhost

# 4. Write the config inside the sandbox
docker sandbox exec openclaw sh -c '
mkdir -p /home/node/.openclaw/workspace /home/node/.openclaw/identity /home/node/.openclaw/credentials
cat > /home/node/.openclaw/openclaw.json << INNEREOF
{
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": "sandbox-dev-token-12345"
    },
    "controlUi": { "enabled": true }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/gpt-5.2",
        "fallbacks": ["openai/gpt-5.2-chat-latest"]
      },
      "workspace": "/home/node/.openclaw/workspace"
    }
  }
}
INNEREOF
chmod 600 /home/node/.openclaw/openclaw.json
'

# 5. Start the gateway (pass your API key from ~/.secrets)
source ~/.secrets
docker sandbox exec -d \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -w /app openclaw \
  node dist/index.js gateway --bind loopback --port 18789

# 6. Wait ~15 seconds, then verify
sleep 15
docker sandbox exec openclaw curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/
# Should print: 200

# 7. Check status
docker sandbox exec -e OPENAI_API_KEY="$OPENAI_API_KEY" -w /app openclaw \
  node dist/index.js status
```

### 샌드박스 관리(Sandbox Management)

```bash
# List sandboxes
docker sandbox ls

# Shell into the sandbox
docker sandbox exec -it openclaw bash

# Stop the sandbox (preserves state)
docker sandbox stop openclaw

# Remove the sandbox
docker sandbox rm openclaw

# Check sandbox version
docker sandbox version
```

## 옵션 B: Docker Compose(폴백)(Option B: Docker Compose (Fallback))

Docker Sandbox를 사용할 수 없을 때(Docker Desktop < v29) 이 방법을 사용하세요.

```bash
# 1. Clone the OpenClaw repo
git clone https://github.com/openclaw/openclaw.git /tmp/openclaw-docker
cd /tmp/openclaw-docker

# 2. Build the Docker image (~5-10 min on first run)
docker build -t openclaw:local -f Dockerfile .

# 3. Create config directories
mkdir -p ~/.openclaw/workspace ~/.openclaw/identity ~/.openclaw/credentials
chmod 700 ~/.openclaw ~/.openclaw/credentials

# 4. Generate a gateway token
export OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)
echo "Your gateway token: $OPENCLAW_GATEWAY_TOKEN"

# 5. Create the config file
cat > ~/.openclaw/openclaw.json << EOF
{
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "lan",
    "auth": {
      "mode": "token",
      "token": "$OPENCLAW_GATEWAY_TOKEN"
    },
    "controlUi": {
      "enabled": true,
      "allowedOrigins": ["http://127.0.0.1:18789"]
    }
  },
  "env": {
    "OPENAI_API_KEY": "\${OPENAI_API_KEY}"
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/gpt-5.2",
        "fallbacks": ["openai/gpt-5.2-chat-latest"]
      },
      "workspace": "/home/node/.openclaw/workspace"
    }
  }
}
EOF
chmod 600 ~/.openclaw/openclaw.json

# 6. Create the .env file (load API keys from ~/.secrets)
source ~/.secrets
cat > .env << EOF
OPENCLAW_CONFIG_DIR=$HOME/.openclaw
OPENCLAW_WORKSPACE_DIR=$HOME/.openclaw/workspace
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN
OPENCLAW_IMAGE=openclaw:local
OPENAI_API_KEY=$OPENAI_API_KEY
OPENCLAW_EXTRA_MOUNTS=
OPENCLAW_HOME_VOLUME=
OPENCLAW_DOCKER_APT_PACKAGES=
EOF

# 7. Add tmpfs to docker-compose.yml (required — see Known Issues)
# Add to BOTH openclaw-gateway and openclaw-cli services:
#   tmpfs:
#     - /tmp:exec,size=512M

# 8. Start the gateway
docker compose up -d openclaw-gateway

# 9. Wait ~15 seconds for startup, then get the dashboard URL
sleep 15
docker compose run --rm openclaw-cli dashboard --no-open
```

대시보드 URL은 다음과 같습니다: `http://127.0.0.1:18789/#token=<your-token>`

### Docker Compose 관리(Docker Compose Management)

```bash
cd /tmp/openclaw-docker

# Stop
docker compose down

# Start again (no rebuild needed)
docker compose up -d openclaw-gateway

# View logs
docker compose logs -f openclaw-gateway

# Check status
docker compose run --rm openclaw-cli status

# Get dashboard URL
docker compose run --rm openclaw-cli dashboard --no-open
```

## 알려진 문제와 해결책(Known Issues and Fixes)

### 컨테이너 시작 시 "no space left on device"

Docker Desktop의 가상 디스크가 가득 찼을 수 있습니다.

```bash
docker system df                   # check usage
docker system prune -f             # remove stopped containers, unused networks
docker image prune -f              # remove dangling images
```

### "Unable to create fallback OpenClaw temp dir: /tmp/openclaw-1000"(Compose 전용)

컨테이너가 `/tmp`에 쓸 수 없습니다. **두** 서비스 모두에 `tmpfs` 마운트를 `docker-compose.yml`에 추가하세요:

```yaml
services:
  openclaw-gateway:
    tmpfs:
      - /tmp:exec,size=512M
  openclaw-cli:
    tmpfs:
      - /tmp:exec,size=512M
```

이 문제는 Docker Sandbox 방식에는 영향을 주지 않습니다.

### 커뮤니티 템플릿 이미지의 Node 버전 불일치

일부 커뮤니티 빌드 샌드박스 템플릿(예: `olegselajev241/openclaw-dmr:latest`)은 Node 20을 탑재하지만, OpenClaw는 Node >=22.12.0이 필요합니다. Node 22를 포함하는 로컬 빌드 `openclaw:local` 이미지를 샌드박스 템플릿으로 대신 사용하세요.

### 시작 후 게이트웨이가 응답하는 데 약 15초 걸림

Node.js 게이트웨이는 초기화 시간이 필요합니다. `http://127.0.0.1:18789/`를 호출하기 전에 15초를 기다리세요.

### CLAUDE_AI_SESSION_KEY 경고(Compose 전용)

이 Docker Compose 경고는 무해하므로 무시해도 됩니다:
```
level=warning msg="The \"CLAUDE_AI_SESSION_KEY\" variable is not set. Defaulting to a blank string."
```

## 구성(Configuration)

구성 파일: `~/.openclaw/openclaw.json`(JSON5 형식)

주요 설정:
- `gateway.auth.token` — 웹 UI와 API용 인증 토큰
- `agents.defaults.model.primary` — AI 모델(`openai/gpt-5.2` 이상 사용)
- `env.OPENAI_API_KEY` — `OPENAI_API_KEY` env 변수 참조(Compose 방식)

API 키는 `~/.secrets`에 저장되고 env 변수로 컨테이너에 전달됩니다.

## 참고 자료(Reference)

- [OpenClaw Docker docs](https://docs.openclaw.ai/install/docker)
- [OpenClaw Configuration Reference](https://docs.openclaw.ai/gateway/configuration-reference)
- [Docker blog: Run OpenClaw Securely in Docker Sandboxes](https://www.docker.com/blog/run-openclaw-securely-in-docker-sandboxes/)
- [Docker Sandbox docs](https://docs.docker.com/ai/sandboxes)
- [OpenAI Models](https://platform.openai.com/docs/models) — 현재 모델: gpt-5.2, gpt-5.2-chat-latest, gpt-5.2-pro
