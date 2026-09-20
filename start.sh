#!/usr/bin/env bash
# One-shot setup + run. Installs uv if missing, syncs deps, downloads the model,
# starts the server and opens the UI. Tested on macOS; should work on Linux.
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
uv sync

echo "==> Fetching model weights (~810 MB on first run, cached in ~/.cache/huggingface)"
uv run python -c 'import server; print(server.model_dir())'

PORT="$(PORT="${PORT:-8000}" uv run python - <<'PY'
import os, socket
start = int(os.environ["PORT"])
for p in range(start, start + 50):
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", p))
        except OSError:
            continue
    print(p)
    break
else:
    raise SystemExit("no free port in range")
PY
)"

URL="http://127.0.0.1:$PORT/"

echo "==> Starting server on $URL"
uv run uvicorn server:app --host 127.0.0.1 --port "$PORT" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' INT TERM EXIT

# uvicorn accepts connections only after the startup warm-up, so a 200 here means the model is loaded.
for _ in $(seq 1 600); do
  curl -fsS "${URL}v1/models" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "server exited during startup"; exit 1; }
  sleep 1
done

case "$(uname -s)" in
  Darwin) open "$URL" ;;
  *) command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL" >/dev/null 2>&1 || echo "Open $URL in your browser." ;;
esac

echo "==> Ready. Ctrl-C to stop."
wait "$SERVER_PID"
