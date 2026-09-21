#!/usr/bin/env bash
# Thin wrapper: make sure uv is available, then hand off to the CLI.
# Everything else lives in server/cli.py so macOS, Linux and Windows share one code path.
set -euo pipefail

cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"

if ! command -v uv >/dev/null 2>&1; then
  echo "==> uv not found, installing from https://astral.sh/uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  command -v uv >/dev/null 2>&1 || { echo "uv install failed; see https://docs.astral.sh/uv/"; exit 1; }
fi

echo "==> Setting up Python 3.12 and dependencies"
uv sync --quiet

exec uv run laya-server "$@"
