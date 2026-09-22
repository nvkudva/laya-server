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

# Offer the global install, but only on a bare interactive run: with arguments this script is doing
# a specific job (often backgrounded, or in CI), and a prompt there would hang waiting for a key.
# --editable keeps the installed command following this checkout instead of freezing a copy of it.
if [ $# -eq 0 ] && [ -t 0 ] && ! uv tool list 2>/dev/null | grep -q '^laya-server'; then
  printf '\nInstall laya-server globally, so you can run it from anywhere? [y/N] '
  read -r reply || reply=""
  case "$reply" in
    [yY]*)
      if uv tool install --editable . --quiet; then
        echo "==> Installed. From now on just run:  laya-server"
      else
        echo "==> Install failed; carrying on with this checkout."
      fi
      ;;
  esac
  echo
fi

exec uv run laya-server "$@"
