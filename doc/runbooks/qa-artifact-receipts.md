# QA 산출물 영수증 — P1/P2 통합 계약

대상: 런타임·도구 통합 담당자. **Content/명시적 HTML 계약의 공식 등록→선택→QA→서버 영수증→검증 바이트 발행 연결을 구현했습니다. 승인된 v3.1 코드 수정·격리 검증은 완료했으며 운영에는 적용하지 않았습니다.**

## 최종 검증 (2026-09-30 13:50 KST)

- 최종 후보 전체 타입 검사·빌드 exit 0. 966파일 최초 검사에서 실패 2건을 보존하고 해당 묶음 전체를 같은 조건으로 1회 재검증했습니다. 최초 6묶음+재검증 2묶음 합산은 **7,236개 통과·실패 0·기존 건너뜀 2**입니다. 한 번에 모두 통과한 결과가 아닙니다.
- 파일·시험 이름 누락/중복 0, 런타임 소스 3,011개·도구 소스 35개 전후 동일. 도구 최종 121개 통과·건너뜀 0. 건너뜀은 원래 비활성화된 비동기 정리 경합 시험과 Windows 전용 시험입니다.
- 영구 근거: `/Users/kwak/Projects/ai/papercompany/papercompany-artifacts/reports/oversight-v31-implementation-20260930/README.md`, `VERIFICATION.md`, `verification-identity.json` 및 `manifest.json`. 아래의 과거 부분 검사 기록은 보존하되 최종 상태는 이 절을 따릅니다.
- 실제 CMS 시험의 D1/SQLite·R2 메모리 대역, 전체 13단계 미션 미실행, 같은 OS 사용자 장악 방어 제외 등 아래 한계는 그대로입니다. 운영 배포·DB 적용·미션 조작은 하지 않았습니다.

## 현재 범위 / 완료 조건

승인된 전체 목표는 P1–P10이며, 이 문서는 그중 P1/P2 계약을 설명합니다. 전체 통합 후보의 검증 결과는 공유 계획의 최신 진행 기록에서 확인합니다. 서비스 소스·라이브 DB·배포는 변경하지 않았습니다. 실행 권위는 공식 work-product 등록, 고정 실행 정의, 현재 단계 요청/세대, 서버가 검증한 DB 영수증입니다. stdout·절대 경로는 권위가 아닙니다.

정의 계약 예시(실제 정의 동기화는 별도 승인 원본에서 수행):

```json
{
  "workProductSelectors": { "write": { "type": "document", "title": "content.json" } },
  "toolArtifactContract": {
    "schemaVersion": "manual-onboarding.qa.v1", "role": "qa", "inputStepId": "write"
  },
  "toolArgs": {
    "content": "{$steps.write.workProductPath}",
    "assetsDir": "{$steps.write.siblingAssetsDir}",
    "section": "tech-blog"
  }
}
```

- 공식 등록 서비스는 DB heartbeat의 typed step/generation 연결에서 생산 시도 정보를 기록합니다. 구형 heartbeat의 연결 부재를 최신 이슈에서 추측하지 않습니다. 기존 등록/고정 연결을 자동 이관하지 않습니다.
- 선택 조건이 있으면 타입/제목/회사/미션/run/step/세대/retry/iteration/heartbeat를 확인하고 정확히 하나만 선택합니다. 새 선택 조건은 기존 binding feature flag와 무관하게 고정하며, 기존 pin은 변경하지 않습니다. 선택 조건이 없으면 기존 선택 의미는 유지합니다.
- 최초 선택과 공식 등록은 같은 mission → run → 정렬된 step 잠금을 사용합니다. 등록은 공유 잠금, 최초 선택·전체 입력 해석·고정은 배타적 잠금으로 한 트랜잭션 안에서 끝냅니다. 등록이 먼저면 중복을 보고 고정하지 않고, 선택이 먼저면 커밋 후 추가 등록을 허용하되 기존 고정을 바꾸지 않습니다. 중간 입력 해석 실패 시 일부 고정도 남지 않습니다. 이 짧은 구간 동안 같은 미션/실행의 등록·쓰기가 대기할 수 있습니다.
- QA는 단계 루트 아래 `attempts/<generation>/<SHA256(requestId)>`를 단독 생성합니다. 같은 경로는 재사용하지 않습니다. 입력·에셋은 안전한 핸들에서 얻은 버퍼를 읽기 전용 복사본으로 전달합니다.
- `qa-result.json`을 실제로 읽고 schema/hash/size/에셋 명세를 확인합니다. 도구 응답 stdout은 읽지 않습니다. 현재 요청/세대 조건부 결과 UPDATE에서 `toolArtifactReceipt`도 같이 저장합니다.
- 소비자는 영수증 파일 바이트와 입력 복사본을 재검증하고, CLI에는 검증한 버퍼를 `manual-onboarding.input.v1` 표준입력으로 넘깁니다. 경로는 표시·호환성용이며, 계약 도구는 원본/복사 경로를 재개방하지 않습니다.
- 파일 읽기는 별도 Node 자식의 고정 cwd+inode 검사를 사용합니다. macOS는 `O_NOFOLLOW_ANY`, Linux는 디렉터리 FD의 `/proc/self/fd` 순회입니다. FIFO/디렉터리/초과 크기/상위 탈출/심볼릭 링크/루트 교체는 거부합니다. 전체 런타임과 같은 UID를 탈취한 프로세스는 방어 범위 밖입니다.

## P2 한정 교정 진행

- 목표/단계: 전체 v3.1은 부분 구현 상태 유지. 이번 교정은 취소된 발행 요청의 실행과 QA 복사본 쓰기 경합만 해결합니다.
- 경로: 현재 DB 요청·시도 확인 → 입력 검증 → 고정 cwd 기반 디렉터리 생성/쓰기 → 실행 직전 재확인. 자연어는 실행 권위가 아닙니다.
- 완료 조건: 취소/run·mission·step 및 오래된 요청의 도구 실행 거절, symlink/부모 교체 시 외부 쓰기 없음, 정상 QA 경로 회귀 통과. Linux와 macOS 검증 범위는 구분합니다.
- 제외: 복구·생산자·공유 계획·라이브 DB·실제 CMS·커밋·배포. 기존 dirty 변경 보존. 검사 오류를 버그 재현으로 취급하지 않습니다.
- 초기 실행 증거: `/tmp/p2-regression-red.log`에서 교정 전 10개 실패를 확인했습니다. `/tmp/p2-final-tests.log`는 macOS + 격리 PostgreSQL 6파일/30개 통과, `/tmp/p2-final-typecheck.log`는 서버 타입 검사 통과입니다. 이 시점의 Linux 미검증과 경로 재개방 한계는 아래 바이트 전달·Linux 검사로 보완됐습니다. 전체 검사는 별도입니다.
- 구현: `artifact-writer.ts`는 각 경로 구성요소마다 `O_DIRECTORY|O_NOFOLLOW`로 연 디렉터리의 inode를 다음 자식의 고정 cwd와 대조합니다. 생성·파일 쓰기·권한 변경은 단일 이름 또는 `.`에만 수행합니다. 부모가 교체되면 새 위치로 쓰지 않고 실패하거나 기존 고정 디렉터리에 씁니다. 기존 안전한 파일 읽기는 유지했습니다.
- 실행 직전에는 mission→run→step 공유 잠금 아래 현재 requestId·generation·retry·iteration을 재확인하고 동기 spawn까지 보호합니다. 잠금은 도구 완료까지 유지하지 않습니다. 이미 시작된 도구의 외부 효과를 취소/되돌리는 기능은 추가하지 않았습니다.
- 초기의 고정 cwd/상대경로 실험은 기존 결과 계약과 충돌해 되돌렸습니다. 최종 계약은 아래의 표준입력 바이트 전달로 해결합니다. 같은 OS 사용자 권한을 탈취한 프로세스, 이미 시작된 외부 효과의 취소, CMS 의도 저장소 자체의 불변성까지 보장하지는 않습니다.

## P2 바이트 전달 교정 (2026-09-30)

- 이번 해소 조건: 검증→CLI 재개방 사이 부모 경로 교체. `PAPERCOMPANY_QA_INPUT=stdin-v1`과 본문/에셋/QA-result의 base64·크기·SHA256 봉투를 사용합니다. 입력 JSON 총 64MiB, 본문 8MiB, 개별 에셋 16MiB, QA 결과 1MiB 제한입니다. CLI는 형식/버전/해시/크기/중복 파일명/탈출을 검사하고 오류 시 파일 경로로 폴백하지 않습니다.
- QA 및 발행 결과는 FD4 기계 채널로 반환합니다. 서버는 캡처한 디렉터리 inode 아래 단일 파일을 배타적으로 저장하고 QA 파일을 독립적으로 재개방·검증합니다. stdout은 QA 권위가 아닙니다. FD3 진행보고 의미는 유지합니다. 발행 결과는 QA 루트 아래 별도 `publication-<uuid>`에 저장합니다.
- 출력 부모가 교체되면 서버 저장은 실패하며 새 경로로 쓰지 않습니다. 이미 시작한 CMS 외부 효과를 되돌리지는 않습니다. CMS 의도/상태 원장의 기존 저장 경계는 이번 입력 바이트 전송 교정과 별개입니다.
- 기존 비계약 도구와 수동 legacy 파일 입력은 유지합니다. 새 계약을 선언한 QA producer는 stdin/FD4를 구현해야 하며, 예전 producer를 조용히 경로 모드로 실행하지 않습니다. 도구 배포는 기존 8파일 그대로이며 공용 읽기는 기존 `manual-onboarding-assets.mjs`에 들어갑니다.
- 최신 부분 증거: `/tmp/p2-bytes-final-runtime.log` 5파일/28개, `/tmp/p2-bytes-real-producer.log` 실제 QA+DB 영수증, `/tmp/p2-bytes-final-typecheck.log` 서버 타입 검사, `/tmp/p2-bytes-final-linux-tools.log` Linux 실제 QA/발행 모형 포함 106개 통과. Linux `--network none --read-only --tmpfs /tmp` 격리이며 기존 colima 프로필만 사용했습니다. `/tmp/p2-bytes-linux-runtime.log`는 실제 Linux FD 읽기/심볼릭 링크/FIFO/크기/고정 쓰기/루트 교체 및 runtime→실제 QA 실행 통과입니다. Linux 전체 DB 통합 테스트와 전체 v3.1 검증은 별도입니다.
- 검증 중 이탈: 첫 발행 모형에서 잘못된 환경변수명을 사용해 실제 기본 release 주소로 테스트 토큰 에셋 PUT이 시도되어 401 거부됐습니다. 성공한 외부 쓰기 증거는 없습니다. 이후 정확한 환경변수와 Linux 외부 네트워크 차단으로 재검증했습니다.

## HTML 및 발행 결과 계약 (2026-09-30)

HTML은 명시적인 `htmlManifest` 인자가 필요하며, 선택된 HTML 옆의 정확한 `html-input.json`만 허용합니다.

```json
{
  "schemaVersion": "manual-onboarding.html-input.v1",
  "htmlSha256": "<sha256>",
  "assets": [{"fileName": "nested/hero.png", "sha256": "<sha256>", "byteSize": 22008}],
  "ancillary": [{"role": "repoMeta", "fileName": "repo-meta.json", "sha256": "<sha256>", "byteSize": 12}]
}
```

- 에셋은 HTML 옆 `assets/`, 부속 자료는 HTML 디렉터리 기준 명시 상대 경로입니다. 부속 역할은 `repoMeta`, `shotResult`, `empiricalResult`입니다. 서버가 원본 해시·크기와 안전한 파일 핸들을 검증하며 디렉터리를 임의 탐색하지 않습니다.
- HTML QA는 기존 구조/저장소/스크린샷/실증 검사에 검증 버퍼를 사용합니다. `mode:html`, `htmlSha256`, `assetManifest`, `ancillaryManifest`를 기록합니다. 미지원 `srcset`·CSS `url()`·비정규 로컬 참조는 거부합니다. 경로는 ASCII 구성요소와 중첩 상대 경로로 제한합니다.
- 계약 HTML 발행은 같은 버퍼를 기존 ContentV1 변환기와 CMS 전송 함수로 넘깁니다. 원본 HTML 화면을 그대로 게시하는 기능이 아니며 레거시 R2/D1·로컬 카탈로그 쓰기는 거치지 않습니다. 구형 정의/생산자는 자동 이관하지 않습니다.
- 발행은 FD4의 `manual-onboarding.publication.v1`을 엄격히 검사합니다. 성공 여부·회사/미션/실행/단계/요청/시도·입력/QA/파일 명세·대상을 대조한 후 실제 저장 파일 바이트를 다시 검증합니다. 결과 경로는 서버가 정하며 stdout의 결과 주장은 쓰지 않습니다. 비계약 도구의 기존 동작은 유지합니다.
- 같은 이미지 바이트를 서로 다른 파일명으로 쓰면 QA 명세는 이름별로 유지하고 CMS 업로드만 내용 해시로 중복 제거합니다.
- 최신 독립 검증: `/tmp/oversight-final-p12-review/`의 runtime 73개, 실제 도구 15개, 실제 QA/DB 2개, 교차 결과 검증 5개 및 HTML 오류/경로 교체 probe. 관리 정의 두 등록 순서의 최신 연결은 `/tmp/oversight-managed-scope-20260930-111741.log` 2개 통과입니다. CMS 저장소 대체와 실제 서비스 통합 증거는 구분합니다.

## 최초 선택 경합 최종 교정 (2026-09-30)

실제 등록 API와 PostgreSQL 잠금 대기를 사용하는 5개 시험으로 등록 우선·선택 우선·미션 없는 실행·전체 입력 롤백·선택 순서 역전 경합을 검증했습니다. 수정 전 5개 실패(`/tmp/oversight-selector-race-red-final.log`), 독립 5개 통과(`/tmp/oversight-selector-independent-review.log`), 통합 후 관련 12파일·78개 통과(`/tmp/oversight-integrated-final-focused.log`)입니다. 검토본과 통합 파일 해시는 `/tmp/oversight-integrated-final-hashes.json`에서 일치하며, 독립 통합 검토는 `/tmp/oversight-final-integrated-independent-review.md`입니다. 전체 타입 검사 최신 exit 0은 `/tmp/oversight-final4-verification/typecheck.status.json`이며 전체 시험/빌드 판정은 공유 계획을 따릅니다.

## 검증 및 잔여 조건

- 9개 대상 테스트 파일 46개 통과: `/tmp/p1p2-final-tests.log`.
- 실제 도구 저장소 QA producer 실행 + DB 영수증 + 소비 복사본: `/tmp/p2-final-real.log`. 일반 CI는 명시적 Node producer test double만 실행합니다. 실제 producer 검증 시 `OVERSIGHT_QA_PRODUCER=/absolute/path/manual-onboarding-qa.mjs pnpm exec vitest run server/src/__tests__/workflow-qa-receipt.test.ts`.
- `pnpm -r typecheck` 통과: `/tmp/p1p2-full-typecheck.log`; `pnpm build` 통과: `/tmp/p1p2-build-final.log`. 전체 `pnpm test:run`은 이 하위 작업에서 미실행.
- 위 초기 증거 당시 Linux 미검증은 2026-09-30 격리 FD 회귀로 보완됐습니다. 전체 Linux DB 통합 및 장시간 경합 스트레스는 남았습니다.
- HTML은 위 명시 계약이 있는 경우 지원합니다. 명세가 없는 구형 입력을 자동 보정하거나 기존 HTML/일반 도구 정의를 일괄 전환하지 않습니다.
- legacy 비-QA native artifactPath 전달은 유지됩니다. 새 QA 계약의 data.artifactPath/rawPath는 완료 저장에서 권위 경로로 남기지 않습니다. 모든 native 도구로 확대하는 일은 미완료입니다.
- 실제 DB에서 읽기 전용으로 가져온 정의와 관리 후보는 operations의 `workflow-definitions/`에 보존했고, 고정 정의/두 등록 순서/현재 정의 변경 불변성 및 UI 필드 왕복을 격리 검증했습니다. **라이브 동기화는 미실시**이며 수집 시 활성 실행 1건이 있었습니다. 전체 적재 의존성 증명, 장시간 경합 스트레스와 같은 UID 악성 프로세스 방어까지 보장하지 않습니다.
- producer 스크립트 이름이 실제 `manual-onboarding-qa.mjs`이면 확인된 배포 8파일 전체 hash를 기록합니다. interpreter/실행 중 전체 의존성 바이트 동일성까지 입증하지 않습니다.

## 보이지 않는 변화

QA 계약에서는 cache를 재사용하지 않습니다. 구형/누락 provenance는 선택 거부됩니다. QA 영수증과 입력/소비 복사본은 디스크를 추가 사용하며 자동 삭제하지 않습니다. 같은 요청의 출력 경로가 이미 있으면 조용히 재사용하지 않고 실패합니다. `qaResultPath`를 쓰는 native builtin 호출은 서버 영수증 없는 경로를 거부합니다. 그 외 도구·전역 대표 파일 정책·이미 존재하는 pin은 바꾸지 않습니다.
