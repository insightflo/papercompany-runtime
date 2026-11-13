#!/usr/bin/env bash
# Dockerfile deps 스테이지가 pnpm 워크스페이스의 모든 package.json 과 patches/ 를 복사하는지 검사한다.
#
# 왜 별도 파일인가: pr.yml 이 300줄을 넘겨(저장소 규칙: legacy 초과 파일은 더 키우지 않는다) 이 셸 블록을
#   워크플로 밖으로 옮겼다. 검사 내용은 pr.yml 안에 있던 것과 동일하다(동작 변경 없음).
# 호출: pr.yml 의 policy 잡에서 `bash scripts/check-dockerfile-deps-stage.sh` (경량 경로에서는 호출하지 않는다).
# 수정 시 주의: deps 스테이지 형식(`FROM ... AS deps`)과 pnpm-workspace.yaml 글롭 표기에 의존한다.
#   예외 디렉터리(examples, create-paperclip-plugin)는 dev 전용이라 검사에서 뺀다.
missing=0

# Extract only the deps stage from the Dockerfile
deps_stage="$(awk '/^FROM .* AS deps$/{found=1; next} found && /^FROM /{exit} found{print}' Dockerfile)"

if [ -z "$deps_stage" ]; then
  echo "::error::Could not extract deps stage from Dockerfile (expected 'FROM ... AS deps')"
  exit 1
fi

# Derive workspace search roots from pnpm-workspace.yaml (exclude dev-only packages)
search_roots="$(grep '^ *- ' pnpm-workspace.yaml | sed 's/^ *- //' | sed 's/\*$//' | grep -v 'examples' | grep -v 'create-paperclip-plugin' | tr '\n' ' ')"

if [ -z "$search_roots" ]; then
  echo "::error::Could not derive workspace roots from pnpm-workspace.yaml"
  exit 1
fi

# Check all workspace package.json files are copied in the deps stage
for pkg in $(find $search_roots -maxdepth 2 -name package.json -not -path '*/examples/*' -not -path '*/create-paperclip-plugin/*' -not -path '*/node_modules/*' 2>/dev/null | sort -u); do
  dir="$(dirname "$pkg")"
  if ! echo "$deps_stage" | grep -q "^COPY ${dir}/package.json"; then
    echo "::error::Dockerfile deps stage missing: COPY ${pkg} ${dir}/"
    missing=1
  fi
done

# Check patches directory is copied if it exists
if [ -d patches ] && ! echo "$deps_stage" | grep -q '^COPY patches/'; then
  echo "::error::Dockerfile deps stage missing: COPY patches/ patches/"
  missing=1
fi

if [ "$missing" -eq 1 ]; then
  echo "Dockerfile deps stage is out of sync. Update it to include the missing files."
  exit 1
fi
