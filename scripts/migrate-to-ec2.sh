#!/usr/bin/env bash
# ============================================================================
# migrate-to-ec2.sh — 로컬 Claude Code 컨텍스트를 EC2로 이식할 번들 생성
#
# 무엇을 패키징하나:
#   1. 메모리 폴더    (~/.claude/projects/<encoded>/memory/)
#   2. 옵션: 대화 이력 (~/.claude/projects/<encoded>/*.jsonl)
#   3. 옵션: .env       (--include-env 플래그 필요. secret이라 default off)
#
# 무엇을 패키징하지 않나:
#   - 프로젝트 코드 (git clone으로 EC2에서 가져옴)
#   - node_modules / dist / .ui-server.pid 등 런타임 잔재
#   - 컨테이너 이미지 (EC2에서 docker compose build로 새로 만듦)
#
# 사용법:
#   bash scripts/migrate-to-ec2.sh                    # memory만
#   bash scripts/migrate-to-ec2.sh --with-sessions    # + JSONL 대화 이력
#   bash scripts/migrate-to-ec2.sh --include-env      # + .env (secret 주의)
#   bash scripts/migrate-to-ec2.sh --with-sessions --include-env --output /tmp/x.tar.gz
#
# 자세한 절차는 docs/MIGRATION.md 참조.
# ============================================================================
set -euo pipefail

# --- argument parsing ---
WITH_SESSIONS=0
INCLUDE_ENV=0
OUTPUT="./migration-bundle.tar.gz"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-sessions) WITH_SESSIONS=1; shift ;;
    --include-env)   INCLUDE_ENV=1; shift ;;
    --output|-o)     OUTPUT="$2"; shift 2 ;;
    -h|--help)
      # shebang(#!)는 제외하고 doc 주석만 출력
      grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
done

# --- 프로젝트 경로 → Claude Code 폴더 인코딩 ---
# Windows: C:\Users\SSAFY\... → C--Users-SSAFY-...
# Linux:   /home/ubuntu/...   → -home-ubuntu-...
# 슬래시/콜론/백슬래시를 모두 '-'로 치환 (Claude Code 규칙).
PROJECT_ABS="$(cd "$(dirname "$0")/.." && pwd)"
echo "[migrate] project absolute path: $PROJECT_ABS"

# OS별 Claude 폴더 위치
if [[ -n "${USERPROFILE:-}" && -d "${USERPROFILE//\\/\/}/.claude" ]]; then
  CLAUDE_HOME="${USERPROFILE//\\/\/}/.claude"
elif [[ -d "$HOME/.claude" ]]; then
  CLAUDE_HOME="$HOME/.claude"
else
  echo "[migrate] FATAL: ~/.claude 폴더를 찾을 수 없음" >&2
  exit 1
fi
echo "[migrate] claude home: $CLAUDE_HOME"

# 인코딩된 프로젝트 폴더명 — 슬래시/콜론/백슬래시 → '-'
# Git Bash가 보는 경로는 보통 /c/Users/SSAFY/... 또는 C:/Users/SSAFY/...
# 두 형태 모두 처리하고, 결과 폴더가 실제 존재하는지 검증.
encode_path() {
  local p="$1"
  # /c/x/y → C:/x/y (Git Bash → Windows form)
  if [[ "$p" =~ ^/([a-z])/ ]]; then
    local drive="${BASH_REMATCH[1]}"
    p="${drive^^}:${p#/$drive}"
  fi
  # 콜론/슬래시/백슬래시 → '-'
  echo "$p" | sed -e 's|[:/\\]|-|g'
}

# 매칭 전략:
#   Claude Code는 *실행한 cwd*에 맞춰 폴더 생성. 우리 프로젝트의 경우:
#     - C--Users-SSAFY-myFirstAgentApp                            (project root, 메모리 저장소)
#     - C--Users-SSAFY-myFirstAgentApp--claude-worktrees-XXX     (각 워크트리, 대화 이력)
#   사용자가 *워크트리 안에서* 이 스크립트를 실행하면:
#     1. 정확한 인코딩 시도 (워크트리 폴더)
#     2. 안 되면 워크트리 segment 잘라낸 짧은 경로 (project root) 시도
#     3. 그래도 안 되면 fuzzy match (project basename)
# 메모리는 *project root*에, 대화는 워크트리 폴더에 있는 경우가 일반적이라
# 둘 다 발견되면 둘 다 패키지에 포함.
PROJECT_MEMORY_DIR=""
PROJECT_WORKTREE_DIR=""

try_match() {
  local p="$1"
  local enc
  enc="$(encode_path "$p")"
  if [[ -d "$CLAUDE_HOME/projects/$enc" ]]; then
    echo "$CLAUDE_HOME/projects/$enc"
  fi
}

# 1) 정확한 워크트리 인코딩
WORKTREE_HIT="$(try_match "$PROJECT_ABS")"

# 2) project root 인코딩 (워크트리 segment 잘라냄)
PROJECT_ROOT="$PROJECT_ABS"
if [[ "$PROJECT_ABS" == *"/.claude/worktrees/"* ]]; then
  PROJECT_ROOT="${PROJECT_ABS%%/.claude/worktrees/*}"
fi
ROOT_HIT="$(try_match "$PROJECT_ROOT")"

# 메모리는 root 우선, fallback으로 worktree
if [[ -n "$ROOT_HIT" && -d "$ROOT_HIT/memory" ]]; then
  PROJECT_MEMORY_DIR="$ROOT_HIT"
elif [[ -n "$WORKTREE_HIT" && -d "$WORKTREE_HIT/memory" ]]; then
  PROJECT_MEMORY_DIR="$WORKTREE_HIT"
fi

# 대화 이력은 워크트리 우선, fallback으로 root
if [[ -n "$WORKTREE_HIT" ]]; then
  PROJECT_WORKTREE_DIR="$WORKTREE_HIT"
elif [[ -n "$ROOT_HIT" ]]; then
  PROJECT_WORKTREE_DIR="$ROOT_HIT"
fi

# 둘 다 못 찾으면 fuzzy로 마지막 시도
if [[ -z "$PROJECT_MEMORY_DIR" && -z "$PROJECT_WORKTREE_DIR" ]]; then
  BASENAME="$(basename "$PROJECT_ROOT")"
  CANDIDATE="$(ls "$CLAUDE_HOME/projects/" 2>/dev/null | grep -E "[-_]${BASENAME}([-_]|$)" | head -1 || true)"
  if [[ -n "$CANDIDATE" ]]; then
    echo "[migrate] 정확 매칭 미스 — fuzzy: $CANDIDATE"
    PROJECT_MEMORY_DIR="$CLAUDE_HOME/projects/$CANDIDATE"
    PROJECT_WORKTREE_DIR="$CLAUDE_HOME/projects/$CANDIDATE"
  else
    echo "[migrate] FATAL: 프로젝트 폴더 못 찾음" >&2
    echo "         project root: $PROJECT_ROOT" >&2
    echo "         시도한 인코딩: $(encode_path "$PROJECT_ROOT")" >&2
    echo "         사용 가능한 폴더:" >&2
    ls "$CLAUDE_HOME/projects/" 2>&1 | sed 's/^/           /' >&2 || true
    exit 1
  fi
fi

echo "[migrate] memory dir:   ${PROJECT_MEMORY_DIR:-(없음)}"
echo "[migrate] worktree dir: ${PROJECT_WORKTREE_DIR:-(없음)}"

# --- staging 폴더 만들기 ---
STAGE="$(mktemp -d -t migration-bundle-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
echo "[migrate] staging: $STAGE"

# 1. memory 폴더 복사 (project root 폴더에서)
if [[ -n "$PROJECT_MEMORY_DIR" && -d "$PROJECT_MEMORY_DIR/memory" ]]; then
  cp -r "$PROJECT_MEMORY_DIR/memory" "$STAGE/memory"
  echo "[migrate] memory/: 복사 완료 ($(ls "$STAGE/memory" | wc -l)개 파일)"
else
  echo "[migrate] WARN: memory/ 폴더 없음. 빈 채로 진행."
  mkdir -p "$STAGE/memory"
fi

# 2. (옵션) JSONL 대화 이력 (워크트리 폴더에서)
if [[ "$WITH_SESSIONS" -eq 1 ]]; then
  if [[ -n "$PROJECT_WORKTREE_DIR" ]]; then
    shopt -s nullglob
    JSONLS=("$PROJECT_WORKTREE_DIR"/*.jsonl)
    shopt -u nullglob
    if [[ "${#JSONLS[@]}" -gt 0 ]]; then
      for f in "${JSONLS[@]}"; do
        cp "$f" "$STAGE/"
      done
      echo "[migrate] 대화 이력: ${#JSONLS[@]}개 JSONL 복사"
    else
      echo "[migrate] WARN: --with-sessions 지정됐지만 JSONL 파일 없음."
    fi
  else
    echo "[migrate] WARN: --with-sessions 지정됐지만 워크트리 폴더 못 찾음."
  fi
fi

# 3. (옵션) .env (secret 포함! 사용 주의)
if [[ "$INCLUDE_ENV" -eq 1 ]]; then
  if [[ -f "$PROJECT_ABS/.env" ]]; then
    cp "$PROJECT_ABS/.env" "$STAGE/.env"
    echo "[migrate] .env 포함됨 — secret 노출 주의. 안전한 채널로만 전송."
  else
    echo "[migrate] WARN: --include-env 지정됐지만 .env 없음."
  fi
fi

# --- README in bundle ---
cat > "$STAGE/README.txt" <<EOF
myFirstAgentApp 마이그레이션 번들
생성: $(date -Iseconds)
소스: $PROJECT_ABS

내용:
- memory/         : Claude Code 메모리 ($(ls "$STAGE/memory" 2>/dev/null | wc -l)개 파일)
- *.jsonl (옵션) : 대화 이력 ($([ "$WITH_SESSIONS" -eq 1 ] && ls "$STAGE"/*.jsonl 2>/dev/null | wc -l || echo 0)개)
- .env (옵션)    : $([ "$INCLUDE_ENV" -eq 1 ] && echo "포함 (secret 주의)" || echo "포함 안 됨")

EC2에서 풀기:
  tar -xzf migration-bundle.tar.gz -C /tmp/
  cd /tmp/migration-bundle
  # docs/MIGRATION.md Step 5 참조

자세한 절차: 프로젝트의 docs/MIGRATION.md
EOF

# --- tar 생성 ---
OUTPUT_ABS="$(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"
tar -czf "$OUTPUT_ABS" -C "$STAGE" --transform 's,^,migration-bundle/,' .
echo ""
echo "================================================================"
echo "[migrate] 번들 생성 완료: $OUTPUT_ABS"
echo "          크기: $(du -h "$OUTPUT_ABS" | cut -f1)"
echo "================================================================"
echo ""
echo "다음 단계 (EC2로 전송):"
echo "  scp \"$OUTPUT_ABS\" ubuntu@<EC2_DNS>:/tmp/migration-bundle.tar.gz"
echo ""
echo "EC2에서:"
echo "  tar -xzf /tmp/migration-bundle.tar.gz -C /tmp/"
echo "  cd /tmp/migration-bundle"
echo "  cat README.txt    # 안내 확인"
echo ""
echo "전체 절차: docs/MIGRATION.md"
