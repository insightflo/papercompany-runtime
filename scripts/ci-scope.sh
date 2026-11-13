#!/usr/bin/env bash
# [CI-REDUCE 2026-11-13] PR CI 범위 판정기 — 이번 이벤트에서 무엇을 돌릴지 한 곳에서 정한다.
#
# 왜: pr.yml 은 PR push 마다 policy·verify·verify-tests(3샤드)·verify-tests-serial·e2e 전량을 돌렸다
#   (실측 샤드 13~23분, 성공 run 전체 40~45분). 같은 PR 에 push 가 반복되면 그 전량이 매번 다시 돌아
#   러너 시간이 PR 수에 비례해 늘었다. 이 스크립트가 판정을 소유하고 pr.yml 은 출력만 소비한다.
#
# 판정 순서(계약 — 순서 자체가 의미를 갖는다):
#   ① EVENT_NAME=workflow_dispatch, INPUT_SCOPE=full  → fast=heavy=full=true (사람의 수동 전체 실행)
#   ② EVENT_NAME=workflow_dispatch, 그 밖(기본 policy) → fast=heavy=true, full=false (lockfile 봇 경로 유지)
#   ③ PR_LABELS 에 CI_FULL_LABEL(기본 ci-full)         → fast=heavy=full=true (**명시 요청** — 드래프트여도 실행)
#   ④ PR_DRAFT=true                                    → 전부 false (자동 트리거인 push 는 드래프트를 건너뛴다)
#   ⑤ EVENT_ACTION=ready_for_review                    → fast=heavy=full=true (검수 요청 = 병합 후보)
#   ⑥ 그 밖(opened/synchronize/reopened/labeled)        → fast=heavy=true, full=false (경량 잡만)
#   ⑦ 변경 파일이 전부 문서                             → heavy=false, full=false (①을 제외하고 전체 스위트를 끈다)
#      → 이때 pr.yml 은 verify-tests-docs-only 잡을 success 로 남겨 "전체 스위트 불필요"를 구조화해 알린다.
#        병합 가드는 verify-tests 성공 잡이 하나도 없으면 병합하지 않으므로, 그 잡이 없으면 문서 PR 은 영구 미병합이 된다.
#
# 드래프트(④)보다 라벨(③)을 앞에 두는 이유: 병합 가드를 통과하기 전에는 `gh pr ready` 에 도달하지 못하므로
#   라벨을 드래프트로 막으면 병합 파이프라인이 그 PR 을 영원히 통과시키지 못한다. 명시 라벨은
#   "이 head 를 전체 스위트로 검사하라"는 요청이므로 드래프트 여부와 무관하게 실행하는 게 맞다.
#
# 입력(전부 env)
#   EVENT_NAME, EVENT_ACTION, PR_DRAFT, PR_LABELS, INPUT_SCOPE, CI_FULL_LABEL, CHANGED_FILE_LIST(경로)
# 출력(stdout key=value, GITHUB_OUTPUT 이 있으면 같이 append)
#   fast, heavy, full, docs_only, reason
#
# 수정 시 주의:
#   - 판정 규칙을 워크플로 `if:` 에 복제하지 않는다. 복제하면 행렬 시험이 실제 실행 경로를 검증하지 못한다.
#   - 변경 파일 목록을 못 받으면(빈 목록) 문서 전용으로 보지 않는다. 모르는 상태에서는 CI 를 더 돌리는 쪽이 안전하다.
#   - 문서 판정은 "문서 파일만 있는가"다. doc/·docs/ 아래라도 코드 확장자(.ts/.js/.sh/.py/.sql 등)가 있으면
#     문서 전용이 아니다(그런 파일을 문서로 오인하면 테스트 0회로 병합될 수 있다).
#   - `set -e` 를 쓰지 않는다. 출력 append 실패가 CI 판정 자체를 실패로 바꾸면 안 된다.
set -uo pipefail

EVENT_NAME=${EVENT_NAME:-}
EVENT_ACTION=${EVENT_ACTION:-}
PR_DRAFT=${PR_DRAFT:-}
PR_LABELS=${PR_LABELS:-}
INPUT_SCOPE=${INPUT_SCOPE:-}
CI_FULL_LABEL=${CI_FULL_LABEL:-ci-full}
CHANGED_FILE_LIST=${CHANGED_FILE_LIST:-}

is_true() { case "${1:-}" in true|TRUE|True|1) return 0;; *) return 1;; esac; }

# 라벨 목록은 콤마 구분이다. 앞뒤 공백·빈 항목은 무시하고 이름이 정확히 같을 때만 인정한다
# (ci-full-extra 같은 근사 이름이 전체 스위트를 켜지 않게).
has_label() {
  local want=$1 item
  local IFS=','
  for item in $PR_LABELS; do
    item=${item#"${item%%[![:space:]]*}"}
    item=${item%"${item##*[![:space:]]}"}
    [ "$item" = "$want" ] && return 0
  done
  return 1
}

# 문서 파일 판정. 마크다운은 어디에 있든 문서로 보고, doc/·docs/ 아래는 문서 산출물 확장자만 인정한다.
is_doc_file() {
  case "$1" in
    *.md | *.mdx) return 0 ;;
    doc/* | docs/*)
      case "$1" in
        *.json | *.yaml | *.yml | *.svg | *.html | *.css | *.txt | *.toml) return 0 ;;
        *.png | *.jpg | *.jpeg | *.gif | *.webp | *.ico) return 0 ;;
        *) return 1 ;;
      esac ;;
    *) return 1 ;;
  esac
}

# 문서 판정: 목록이 없거나 비었으면 "모르는 상태" → false.
docs_only=false
if [ -n "$CHANGED_FILE_LIST" ] && [ -r "$CHANGED_FILE_LIST" ] && [ -s "$CHANGED_FILE_LIST" ]; then
  docs_only=true
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if ! is_doc_file "$path"; then
      docs_only=false
      break
    fi
  done < "$CHANGED_FILE_LIST"
fi

fast=false
heavy=false
full=false
reason=push-fast-only

if [ "$EVENT_NAME" = workflow_dispatch ]; then
  # 기본값(policy)은 lockfile 봇 경로다 — 봇 PR 은 GITHUB_TOKEN 으로 만들어져 pull_request 이벤트가 없어
  # 필수 검사 policy 를 붙이려고 이 워크플로를 dispatch 한다. 전체 스위트는 명시적으로 요청할 때만 돈다.
  fast=true; heavy=true; full=false; reason=dispatch-policy
  if [ "$INPUT_SCOPE" = full ]; then
    full=true; reason=dispatch-full
  fi
elif has_label "$CI_FULL_LABEL"; then
  fast=true; heavy=true; full=true; reason=ci-full-label
elif is_true "$PR_DRAFT"; then
  reason=draft
elif [ "$EVENT_ACTION" = ready_for_review ]; then
  fast=true; heavy=true; full=true; reason=ready_for_review
else
  fast=true; heavy=true; full=false
fi

# 문서 전용은 경량 잡의 무거운 스텝과 전체 스위트를 함께 끈다(수동 dispatch 는 위에서 이미 처리됨).
if [ "$docs_only" = true ] && [ "$EVENT_NAME" != workflow_dispatch ]; then
  heavy=false
  full=false
  reason="${reason}+docs-only"
fi

emit() {
  printf '%s=%s\n' "$1" "$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
  fi
}

emit fast "$fast"
emit heavy "$heavy"
emit full "$full"
emit docs_only "$docs_only"
emit reason "$reason"
