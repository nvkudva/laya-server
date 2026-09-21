# laya server

A local HTTP server that exposes the [Laya](https://huggingface.co/convaiinnovations/laya) decision model
behind TypeSafe's **Jev / System One** wire API.

A single FastAPI process owns HTTP, validation, the wire contract and inference. One checkpoint is
loaded once at startup and requests are serialized behind a lock.

Laya generates no text. You send one **state** plus any number of typed **questions**; it returns a
calibrated probability distribution per question from a single forward pass.

## Quick start

```sh
git clone <this repo>
cd laya-local
./start.sh          # macOS, Linux
.\start.ps1         # Windows
```

The wrappers only install [uv](https://docs.astral.sh/uv/) if it is missing and run `uv sync`; all
the real work is in the `laya-server` CLI, so every platform takes the same code path. Default
behaviour is `serve`: download the weights if needed, start on the first free port from 8000, open
the UI. Ctrl-C stops it.

Any CLI arguments pass straight through — `./start.sh models list`, `./start.sh serve --port 9000`.

## CLI

```sh
uv run laya-server models list              # every checkpoint, and whether it is cached
uv run laya-server models pull <name>...    # download ahead of time (no name = all)
uv run laya-server serve [options]          # run the server
```

`serve` options: `--model <name>`, `--host`, `--port`, `--fixed-port` (fail instead of scanning for
a free port), `--no-ui` (API only), `--no-browser`, `--log-level`.

## Models

One checkpoint per process, picked with `--model`; `/v1/models` reports whichever is loaded.

| name | encoder | context | download | use it for |
|---|---|---|---|---|
| `laya` (default) | ModernBERT-large | 512 | 846 MB | English, general purpose |
| `laya-multilingual` | mmBERT-base | 1024 | 678 MB | 100+ languages |
| `laya-typed-decisions` | ModernBERT-large | 1024 | 846 MB | agent traces, customer service, invoices, security incidents |

```sh
uv run laya-server serve --model laya-typed-decisions
```

Stock Jev clients hard-code `model: "laya"`, so that value is accepted as an alias for whichever
checkpoint is loaded. Any other name is a 422.

Adding a checkpoint is one entry in `laya_server/registry.py`.

First run pulls ~810 MB and takes a few minutes. Later runs touch no network — the server resolves
the cached snapshot with `local_files_only` and prints `==> Using model at <path>` — so startup is
just the ~800 MB read into RAM.

On start it prints every endpoint it serves:

```
==> Ready. Serving laya on http://127.0.0.1:8000

    Jev / System One API
      GET   http://127.0.0.1:8000/v1/models        list the model
      POST  http://127.0.0.1:8000/v1/systemone     answer questions about a state

    Web UI (outside the Jev contract)
      GET   http://127.0.0.1:8000/                 the demo page
      GET   http://127.0.0.1:8000/ui/presets       Laya's built-in question sets

    For the TypeSafe SDK:
      export TYPESAFE_BASE_URL=http://127.0.0.1:8000
      export TYPESAFE_API_KEY=local
```

There is **one server and one port** — the UI and the API are routes on the same FastAPI process, so
the UI needs no CORS and no second address. `--no-ui` drops the two UI routes if you want the API
alone; `--host 0.0.0.0` exposes it on the LAN instead of loopback only.

## Model weights

Weights live in the shared Hugging Face cache, not in the repo:

```
~/.cache/huggingface/hub/models--convaiinnovations--laya/
```

The large files are content-addressed and symlinked, so several projects on the same machine share
one copy, and each checkpoint lives under its own `models--convaiinnovations--*` directory. To put
the cache elsewhere, set `HF_HOME` (moves the whole HF directory) or `HF_HUB_CACHE` (moves only the
model cache) before running `./start.sh`.

If the weights are missing and the machine is offline, startup fails with an explicit message rather
than a silent stall.

## Manual run

```sh
uv sync
uv run python -m laya_server serve          # same as the laya-server script
uv run python -m uvicorn laya_server.api:app --port 8000   # bare ASGI app, default checkpoint
```

## Files

| file | role |
|---|---|
| `start.sh`, `start.ps1` | thin wrappers: install uv, `uv sync`, hand off to the CLI |
| `laya_server/cli.py` | `models list` / `models pull` / `serve`, port scan, browser, startup banner |
| `laya_server/registry.py` | the checkpoint table and the download/cache helpers |
| `laya_server/api.py` | FastAPI app: routing, validation, 422 shaping, Jev↔Laya adapting, inference |
| `laya_server/static/index.html` | the web UI — one file, no build step; the JSON editor pulls CodeMirror from esm.sh at runtime |
| `pyproject.toml`, `uv.lock` | pinned dependency set |
| `verify_sdk.py` | round-trip check against the real `typesafe-sdk` client |

## API

Mirrors `https://api.typesafe.ai` v0.2.0. An `Authorization: Bearer <key>` header is accepted and ignored.

### `GET /v1/models`

```json
{"models": [{"name": "laya", "description": "...", "release_date": "2026-01-01"}]}
```

### `POST /v1/systemone`

Request:

| field | type | notes |
|---|---|---|
| `state` | string \| object \| array | the content every question refers to |
| `model` | string | the loaded checkpoint's name, or the alias `laya`; anything else is a 422 |
| `questions` | object | question name → question, at least one |

Question types (all take an optional `instructions`, a string, object or array):

| `type` | `criteria` | answer fields |
|---|---|---|
| `noul` | optional `{"true": ..., "false": ...}` | `noul` = p(yes), `confidence` |
| `choice` | `{label: description-or-null}` | `choice`, `probabilities`, `confidence` |
| `score` | ordered non-empty list of level descriptions | `score` (expected level), `legend`, `probabilities`, `confidence` |

Response: `{"model": ..., "answers": {name: answer}, "usage": {"input_tokens": n, "output_tokens": 0}}`.
Every answer also carries `action.act_probability` — a Laya-specific extra that Jev clients ignore.

Validation failures return HTTP 422 with `{"detail": [{"loc": [...], "msg": ..., "type": ...}]}`.

### Example

```sh
curl -s http://127.0.0.1:8000/v1/systemone -H 'content-type: application/json' -d '{
  "state": "I was charged twice for the same order and nobody answers my emails. I want my money back now.",
  "model": "laya",
  "questions": {
    "area":    {"type":"choice","instructions":"Which product area is this about?","criteria":{"refund & dispute":"A billing dispute or refund request","card":"Anything about a card","other":null}},
    "urgency": {"type":"score","instructions":"How urgent is this message?","criteria":["Can wait","Needs attention this week","Needs attention today"]},
    "refund":  {"type":"noul","instructions":"The customer is asking for a refund."}
  }
}'
```

```json
{
  "model": "laya",
  "answers": {
    "area":    {"type":"choice","choice":"refund & dispute","confidence":0.7228,
                "probabilities":{"refund & dispute":0.9286,"card":0.0267,"other":0.0447},
                "action":{"act_probability":1.0}},
    "urgency": {"type":"score","score":1.9062,"confidence":0.7092,
                "legend":{"0":"Can wait","1":"Needs attention this week","2":"Needs attention today"},
                "probabilities":{"0":0.0076,"1":0.0787,"2":0.9137},
                "action":{"act_probability":1.0}},
    "refund":  {"type":"noul","noul":0.9321,"confidence":0.9321,"action":{"act_probability":1.0}}
  },
  "usage": {"input_tokens": 167, "output_tokens": 0}
}
```

## Web UI

Open <http://127.0.0.1:8000/> with the server running.

The left column holds a **Request** panel and an **Examples** panel. Request has two views, toggled
in its header:

- **UI** — the *state* textarea plus one editable card per question; `+ noul` / `+ choice` / `+ score`
  append a new one.
- **JSON** — the same request as raw JSON in a CodeMirror editor, with syntax highlighting, folding
  and inline parse errors. Edits round-trip back into the UI view.

**Examples** loads one of Laya's built-in question sets into the editor, ready to modify. Send with
the **Send** button or ⌘/Ctrl+Enter from the state box.

The right pane is a log of decisions — each turn sends one *state* and renders a card per question:
ranked probability bars for `choice`, a legend strip with the expected-value marker for `score`, a
0–1 gauge for `noul`, plus confidence, `act_probability` and the input-token count. Turns are
independent; Laya has no memory. The question set, the current state and the last 30 turns live in
`localStorage`.

CodeMirror is loaded from esm.sh on demand. If that CDN is unreachable the UI view works normally and
the JSON view reports `JSON editor unavailable`; nothing else needs a network.

Two routes exist for the UI and are **outside the Jev contract**:

| route | returns |
|---|---|
| `GET /` | `index.html` |
| `GET /ui/presets` | Laya's five built-in question sets (`triage`, `router`, `moderation`, `guard`, `email`), read live from the installed `laya` package |

## Using the official clients

The stock `typesafe-sdk` and the `jev` decorator library work unchanged against this server:

```sh
export TYPESAFE_API_KEY=local
export TYPESAFE_BASE_URL=http://127.0.0.1:8000
```

`verify_sdk.py` is a round-trip check that exercises all three question types through the real SDK
(which parses responses in strict mode):

```sh
uv run --extra dev python verify_sdk.py
```

## Differences from hosted Jev

- **`instructions` is optional in Jev but required by Laya.** When omitted, the server substitutes the
  humanized question name (`is_urgent` → `is urgent`).
- Answers are a **superset** of Jev's — `action.act_probability` on every answer, `confidence` on `noul`.
- `usage.input_tokens` is a real token count; `output_tokens` is always 0 (nothing is generated).
- **The context is shared by the state and all questions combined**, and it truncates silently —
  512 tokens on `laya`, 1024 on the other two. Long states with many questions lose the tail.
- Requests are serialized — one forward pass at a time, queued in order of arrival.
- Answer quality, calibration and language coverage are Laya's, not Jev's; the two are not comparable.

## Platform support

macOS and Linux are tested. On Linux `torch` resolves to the CPU build from
`download.pytorch.org/whl/cpu` — PyPI's Linux wheel pulls the whole CUDA toolkit, several GB, which
is wasted on a 421M-parameter model doing one forward pass at a time. For a GPU box, sync against
the matching CUDA index instead of `whl/cpu` in `pyproject.toml`.

Windows should work — the CLI is pure Python and `start.ps1` mirrors `start.sh` — but it is
untested, and the `torch==2.14.0` Windows wheel has not been verified.

## Provenance

Laya is by Convai Innovations (Apache-2.0). The Jev API
shape is TypeSafe's; this project is not affiliated with TypeSafe and uses none of their code or weights.
