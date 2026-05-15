#!/usr/bin/env bash
# Run implement-feature with per-turn token metrics on stderr (BOLLARD_METRICS lines).
# Optionally loads API keys from a dotenv file (see --env-file / BOLLARD_ENV_FILE), then runs docker compose.
#
# Usage:
#   ./scripts/bollard-metrics-run.sh [options] [ "<implementation task>" ] [ <log-file> ]
#
# Options (any order before positional args):
#   --env-file PATH   Load this file with `set -a; source; set +a` (default: ./.env in repo root if it exists).
#                     Override default path with BOLLARD_ENV_FILE when not passing the flag.
#
#   Arg 1 — implementation prompt for --task (quote if it contains spaces).
#           If omitted: BOLLARD_VALIDATION_TASK env, else default snapshotTotal() task.
#   Arg 2 — log file path (default: .bollard/last-metrics-run.log or BOLLARD_METRICS_LOG).
#
# Env: BOLLARD_ENV_FILE, BOLLARD_VALIDATION_TASK, BOLLARD_METRICS_LOG, BOLLARD_AUTO_APPROVE, BOLLARD_METRICS
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE_PATH="${BOLLARD_ENV_FILE:-}"

usage() {
  cat <<'USAGE'
Run implement-feature with BOLLARD_METRICS lines on stderr.

Usage:
  ./scripts/bollard-metrics-run.sh [options] [ "<implementation task>" ] [ <log-file> ]

Options:
  --env-file PATH   Source this dotenv before docker compose (keys for -e passthrough).
                    If neither flag nor BOLLARD_ENV_FILE is set, uses ./.env when present.

Positional:
  Arg 1  Implementation prompt for --task (quote if it contains spaces).
         If omitted: BOLLARD_VALIDATION_TASK env, else default peek() task.
  Arg 2  Log file path (default: .bollard/last-metrics-run.log).

Examples:
  ./scripts/bollard-metrics-run.sh --env-file "$HOME/secrets/bollard.env" "Add a health check endpoint"
  ./scripts/bollard-metrics-run.sh --env-file /config/ci.env "Refactor X" ./runs/metrics.log
  BOLLARD_ENV_FILE=../shared/.env ./scripts/bollard-metrics-run.sh

Env: BOLLARD_ENV_FILE, BOLLARD_VALIDATION_TASK, BOLLARD_METRICS_LOG, BOLLARD_AUTO_APPROVE, BOLLARD_METRICS
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      if [[ -z "${2:-}" ]]; then
        echo "error: --env-file requires a path" >&2
        exit 1
      fi
      ENV_FILE_PATH="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "error: unknown option: $1 (try --help)" >&2
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

if [[ -n "$ENV_FILE_PATH" ]]; then
  if [[ ! -f "$ENV_FILE_PATH" ]]; then
    echo "error: env file not found: $ENV_FILE_PATH" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1091
  source "$ENV_FILE_PATH"
  set +a
  echo "Loaded env from: $ENV_FILE_PATH"
elif [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
  echo "Loaded env from: $ROOT/.env"
else
  echo "No env file loaded (--env-file / BOLLARD_ENV_FILE unset and $ROOT/.env missing)."
fi

DEFAULT_TASK='Add a snapshotTotal(): number method to CostTracker that returns the current accumulated cost total as a plain number, without modifying any state. No parameters. The return value must equal this._total at the time of the call. Do not modify add(), subtract(), divide(), reset(), peek(), snapshot(), or any other existing method. Do not change any existing tests.'

if [[ -n "${1:-}" ]]; then
  TASK="$1"
elif [[ -n "${BOLLARD_VALIDATION_TASK:-}" ]]; then
  TASK="$BOLLARD_VALIDATION_TASK"
else
  TASK="$DEFAULT_TASK"
fi

mkdir -p "$ROOT/.bollard"
printf '%s\n' "$TASK" > "$ROOT/.bollard/.metrics-run-task.txt"

if [[ -n "${2:-}" ]]; then
  LOG="$2"
else
  LOG="${BOLLARD_METRICS_LOG:-$ROOT/.bollard/last-metrics-run.log}"
fi

export BOLLARD_METRICS="${BOLLARD_METRICS:-1}"
export BOLLARD_AUTO_APPROVE="${BOLLARD_AUTO_APPROVE:-1}"

mkdir -p "$(dirname "$LOG")"

echo "Log: $LOG"
echo "Task: ${TASK:0:120}$([[ ${#TASK} -gt 120 ]] && echo …)"
echo ""

docker compose run --rm \
  -e ANTHROPIC_API_KEY \
  -e OPENAI_API_KEY \
  -e GOOGLE_API_KEY \
  -e BOLLARD_AUTO_APPROVE \
  -e BOLLARD_METRICS \
  dev sh -c 'TASK=$(tr -d "\r" < /app/.bollard/.metrics-run-task.txt) && exec pnpm --filter @bollard/cli run start -- run implement-feature --task "$TASK" --work-dir /app --metrics' \
  2>&1 | tee "$LOG"

echo ""
echo "--- BOLLARD_METRICS lines (grep) ---"
grep '^BOLLARD_METRICS' "$LOG" || echo "(none — pipeline may have failed before any LLM turn)"
