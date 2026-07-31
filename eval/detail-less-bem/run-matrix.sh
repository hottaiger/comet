#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PYTHON_BIN="$EVAL_ROOT/.venv/bin/python"
if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="python3"
fi

DRY_RUN=false
EVIDENCE_ROOT="$SCRIPT_DIR/evidence"
REPORTS_ROOT="$SCRIPT_DIR/reports"
OUTER_TIMEOUT=900
export BENCH_CC_VERSION="${BENCH_CC_VERSION:-2.1.205}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --evidence-root)
      EVIDENCE_ROOT="$2"
      shift 2
      ;;
    --reports-root)
      REPORTS_ROOT="$2"
      shift 2
      ;;
    --outer-timeout)
      OUTER_TIMEOUT="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

RUN_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_ROOT="$EVIDENCE_ROOT/${RUN_STAMP}-$$"
PLAN_FILE="$RUN_ROOT/matrix-plan.tsv"
mkdir -p "$RUN_ROOT" "$REPORTS_ROOT"

if ! "$PYTHON_BIN" "$SCRIPT_DIR/report.py" plan >"$PLAN_FILE"; then
  echo "Unable to build the fixed 48-attempt matrix plan." >&2
  exit 2
fi

EXCLUSION_REASON=""
if [[ "$DRY_RUN" == "true" ]]; then
  EXCLUSION_REASON="dry_run"
elif ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  EXCLUSION_REASON="docker_unavailable"
fi

ATTEMPT_COUNT=0
while IFS=$'\t' read -r TASK TREATMENT REP VARIANT; do
  [[ -z "$TASK" ]] && continue
  ATTEMPT_COUNT=$((ATTEMPT_COUNT + 1))
  ATTEMPT_DIR="$RUN_ROOT/attempts/$TASK/$TREATMENT/rep-$REP"
  if [[ -n "$EXCLUSION_REASON" ]]; then
    "$PYTHON_BIN" "$SCRIPT_DIR/report.py" record-excluded \
      --run-root "$RUN_ROOT" \
      --task "$TASK" \
      --treatment "$TREATMENT" \
      --rep "$REP" \
      --variant "$VARIANT" \
      --reason "$EXCLUSION_REASON"
  else
    "$PYTHON_BIN" "$SCRIPT_DIR/report.py" execute-attempt \
      --run-root "$RUN_ROOT" \
      --task "$TASK" \
      --treatment "$TREATMENT" \
      --rep "$REP" \
      --variant "$VARIANT" \
      --outer-timeout "$OUTER_TIMEOUT"
    if [[ ! -f "$ATTEMPT_DIR/metadata.json" ]]; then
      "$PYTHON_BIN" "$SCRIPT_DIR/report.py" record-flagged \
        --run-root "$RUN_ROOT" \
        --task "$TASK" \
        --treatment "$TREATMENT" \
        --rep "$REP" \
        --variant "$VARIANT" \
        --reason "matrix_runner_failure"
    fi
  fi
done <"$PLAN_FILE"

if [[ "$ATTEMPT_COUNT" -ne 48 ]]; then
  echo "Matrix invariant failed: recorded $ATTEMPT_COUNT attempts, expected 48." >&2
  exit 2
fi

REPORT_DIR="$($PYTHON_BIN "$SCRIPT_DIR/report.py" summarize "$RUN_ROOT" --output-root "$REPORTS_ROOT" --timestamp "$RUN_STAMP")"
echo "Evidence: $RUN_ROOT"
echo "Report: $REPORT_DIR"
