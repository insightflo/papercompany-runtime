---
title: Tailscale 사설 접근
summary: Tailscale 친화적 호스트 바인딩으로 papercompany 실행, 다른 기기에서 접속
---

`localhost`가 아닌 Tailscale(또는 사설 LAN/VPN)을 통해 papercompany에 접근하려면 이 문서를 사용하세요.

## 1. 사설 인증 모드로 papercompany 시작

```sh
pnpm dev --tailscale-auth
```

이 명령이 구성하는 것:

- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`
- `PAPERCLIP_AUTH_BASE_URL_MODE=auto`
- `HOST=0.0.0.0` (모든 인터페이스에 바인딩)

동등한 플래그:

```sh
pnpm dev --authenticated-private
```

## 2. 접근 가능한 Tailscale 주소 찾기

papercompany가 실행 중인 머신에서:

```sh
tailscale ip -4
```

Tailscale MagicDNS 호스트 이름(예: `my-macbook.tailnet.ts.net`)을 사용할 수도 있습니다.

## 3. 다른 기기에서 papercompany 열기

papercompany 포트(`pnpm dev`의 기본값 `3200`)와 함께 Tailscale IP 또는 MagicDNS 호스트를 사용하세요:

```txt
http://<tailscale-host-or-ip>:3200
```

예시:

```txt
http://my-macbook.tailnet.ts.net:3200
```

## 4. 필요할 때 커스텀 사설 호스트 이름 허용

커스텀 사설 호스트 이름으로 papercompany에 접근한다면 이를 허용 목록에 추가하세요:

```sh
pnpm paperclipai allowed-hostname my-macbook.tailnet.ts.net
```

## 5. 서버 접근 가능 여부 확인

Tailscale에 연결된 원격 기기에서:

```sh
curl http://<tailscale-host-or-ip>:3200/api/health
```

예상 결과:

```json
{"status":"ok"}
```

## 문제 해결

- 사설 호스트 이름에서 로그인 또는 리다이렉트 오류: `paperclipai allowed-hostname`으로 추가하세요.
- 앱이 `localhost`에서만 동작함: `--tailscale-auth`로 시작했는지 확인하세요(또는 사설 모드에서 `HOST=0.0.0.0` 설정).
- 로컬에서는 연결되는데 원격에서는 안 됨: 두 기기가 같은 Tailscale 네트워크에 있고 포트 `3200`에 접근 가능한지 확인하세요.
