# A1 GitHub Actions 배포

이 저장소는 커밋 검증과 레거시 SSH 배포 경로를 유지합니다.
환경별 승인 및 배포 오케스트레이션은 운영자가 소유한 Operations 저장소에 속합니다.

배포는 의도적으로 서버 측에서 수행됩니다:

1. GitHub Actions가 typecheck, 배포 스모크 테스트, 빌드로 커밋을 검증합니다.
2. GitHub Actions가 `scripts/deploy-a1.sh`를 A1에 복사합니다.
3. A1이 `/srv/papercompany/papercompany-runtime`을 검증된 커밋으로 fast-forward합니다.
4. A1이 `pnpm install --frozen-lockfile`과 `pnpm build`를 실행합니다.
5. A1이 `papercompany-runtime.service`를 재시작합니다.
6. A1이 내부 및 공개 헬스 엔드포인트를 확인합니다.

A1에서 `pnpm build`를 실행하면 워크스페이스 빌드가 `@paperclipai/ui` 패키지 빌드를 실행하므로 UI 빌드도 포함됩니다.

## 필수 GitHub Secrets

워크플로우를 활성화하기 전에 다음 저장소 시크릿을 설정하세요:

- `A1_SSH_HOST`: A1 호스트 또는 IP 주소.
- `A1_SSH_USER`: SSH 사용자, 현재 `opc`가 될 것으로 예상됩니다.
- `A1_SSH_PRIVATE_KEY`: A1에 SSH 접속이 허용된 개인 키.

A1 사용자는 대화형 비밀번호 프롬프트 없이 다음을 실행할 수 있어야 합니다:

```sh
sudo -n systemctl restart papercompany-runtime.service
```

## 선택적 GitHub Variables

다음 저장소 변수로 프로덕션 기본값을 재정의할 수 있습니다:

- `A1_LEGACY_DEPLOY_ENABLED`: 미설정 시 기본적으로 활성화됩니다. Operations 소유, 사람 운영자 승인 방식의 배포 경로가 준비된 경우에만 `false`로 설정하세요. `verify` 작업은 계속 실행되어 정확한 `main` 커밋이 승인 게이트를 충족할 수 있게 합니다. 레거시 SSH 배포 작업만 건너뜁니다.
- `A1_SSH_PORT`: 기본값 `22`
- `A1_DEPLOY_PATH`: 기본값 `/srv/papercompany/papercompany-runtime`
- `A1_SERVICE_NAME`: 기본값 `papercompany-runtime.service`
- `A1_INTERNAL_HEALTH_URL`: 기본값 `http://127.0.0.1:3100/api/health`
- `A1_PUBLIC_HEALTH_URL`: 기본값 `https://papercompany.showk.ing/api/health`
- `A1_HEALTH_TIMEOUT_SECONDS`: 기본값 `120`
- `A1_HEALTH_INTERVAL_SECONDS`: 기본값 `3`

## A1 호스트 요구 사항

배포 경로는 `main`을 fetch할 수 있는 `origin` 리모트가 있는 깨끗한 git 체크아웃이어야 합니다. A1 호스트에는 다음도 필요합니다:

- `git`
- `pnpm`
- `curl`
- `systemctl`
- `flock`

체크아웃에 로컬 변경 사항이 있으면 풀하기 전에 배포가 중지됩니다.
