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
cd laya-server
./start.sh          # macOS, Linux
.\start.ps1         # Windows
```

The wrappers only install [uv](https://docs.astral.sh/uv/) if it is missing and run `uv sync`; all
the real work is in the `laya-server` CLI, so every platform takes the same code path. Default
behaviour is `serve`: download the weights if needed, start on the first free port from 8000, open
the UI. Ctrl-C stops it.

Any CLI arguments pass straight through, so the wrapper is also how you pick a model:

```sh
./start.sh models                            # menu: choose a checkpoint, it downloads and starts
./start.sh serve laya-typed-decisions        # skip the menu, run one directly
```

See [Models](#models) for the full list and what each one is for.

## CLI

```sh
laya-server                      # serve the default checkpoint
laya-server models               # menu: pick a checkpoint, or delete downloaded ones
laya-server serve [model]        # serve a named checkpoint
laya-server pull [model...]      # download without starting (no name = all)
```

Three options, shared by all of them: `--host` (default `127.0.0.1`), `--port` (default: the first
free port from 8000) and `--no-browser`. An explicit `--port` is used as given — if it is busy the
command fails immediately rather than drifting to another port.

## Models

Three checkpoints are available. One is loaded per process, chosen at start time.

| name | encoder | context | download | use it for |
|---|---|---|---|---|
| `laya` (default) | ModernBERT-large | 512 | 846 MB | English, general purpose |
| `laya-multilingual` | mmBERT-base | 1024 | 678 MB | 100+ languages |
| `laya-typed-decisions` | ModernBERT-large | 1024 | 846 MB | agent traces, customer service, invoices, security incidents |

### Pick one interactively

```sh
./start.sh models
```

```
Laya checkpoints

  1  laya                   cached   512 tok  English, general purpose (default)
  2  laya-multilingual      678 MB  1024 tok  100+ languages
  3  laya-typed-decisions   cached  1024 tok  Agent traces, customer service, invoices, security incidents

  4  delete all downloaded checkpoints
  q  quit

Select [1-4, q]:
```

`cached` means the weights are already on disk; a size is what downloading will cost. Pick a number
and it downloads if needed, then starts the server — one step, no separate pull.

Piped or run from a script, `models` prints the same table and exits instead of prompting.

### Or name it directly

```sh
./start.sh serve laya-typed-decisions
```

Switching is just that: stop the server, start it again with a different name. Nothing is cached per
project and nothing needs re-syncing. Check which one is running with:

```sh
curl -s http://127.0.0.1:8000/v1/models
```

```json
{"models": [{"name": "laya-typed-decisions",
             "description": "Agent traces, customer service, invoices, security incidents (ModernBERT-large, 1024-token context).",
             "release_date": "2026-09-18"}]}
```

To run two checkpoints side by side, start two servers on different ports:

```sh
./start.sh serve laya --port 8000 --no-browser &
./start.sh serve laya-typed-decisions --port 8001 --no-browser &
```

### Download without starting

```sh
./start.sh pull laya-typed-decisions      # one
./start.sh pull laya laya-multilingual    # several
./start.sh pull                           # all three, ~2.4 GB
```

```
==> Downloading convaiinnovations/laya-typed-decisions (~846 MB, one time)
==> Cached at /Users/you/.cache/huggingface/hub/models--convaiinnovations--laya-typed-decisions/snapshots/...
```

Optional — `serve` and the menu both download on demand. Useful for warming a machine before a demo,
or downloading on a fast network and running elsewhere.

### Deleting checkpoints

Option 4 in the menu removes every downloaded Laya checkpoint. It lists what will go and requires
typing `yes`, because the weights live in the **shared** Hugging Face cache — any other project on
the machine using the same repos will re-download them.

### Client compatibility

Stock Jev clients hard-code `model: "laya"` in the request body, so that value is accepted as an
alias for whichever checkpoint is loaded — the SDK keeps working after a switch. The loaded
checkpoint's own name is also accepted. Any other name is a 422.

### Adding a checkpoint

One entry in `server/registry.py`:

```python
Model("my-laya", "myorg/my-laya", "ModernBERT-large", 1024, 846, "what it is good at"),
```

It then shows up in the `models` menu, in `pull` and in `serve <name>`. The repo must have the same
layout as the official ones (`rl_agent_config.json`, `model.safetensors`, `tokenizer/`, `encoder/`).

## Startup

First run downloads the checkpoint and takes a few minutes. Later runs touch no network — weights
resolve from the cache with `local_files_only` — so startup is just the read into RAM:

```
==> Loading laya (846 MB) into memory
```

On start it prints every endpoint it serves:

```
==> Ready. Serving laya on http://127.0.0.1:8000

    Jev / System One API
      GET   http://127.0.0.1:8000/v1/models        list the model
      POST  http://127.0.0.1:8000/v1/systemone     answer questions about a state

    Web UI (outside the Jev contract)
      GET   http://127.0.0.1:8000/demo             the demo page
      GET   http://127.0.0.1:8000/ui/presets       the five examples (state + questions)

    Health
      GET   http://127.0.0.1:8000/                 status, and which checkpoint is loaded

    For the TypeSafe SDK:
      export TYPESAFE_BASE_URL=http://127.0.0.1:8000
      export TYPESAFE_API_KEY=local
```

There is **one server and one port** — the UI and the API are routes on the same FastAPI process, so
the UI needs no CORS and no second address. `--host 0.0.0.0` exposes it on the LAN instead of
loopback only.

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
uv run python -m server serve          # same as the laya-server script
uv run python -m uvicorn server.api:app --port 8000   # bare ASGI app, default checkpoint
```

## Files

| file | role |
|---|---|
| `start.sh`, `start.ps1` | thin wrappers: install uv, `uv sync`, hand off to the CLI |
| `server/cli.py` | the `models` menu, `pull` and `serve`; port binding, browser, startup banner |
| `server/registry.py` | the checkpoint table and the download / cache / delete helpers |
| `server/presets.py` | the five examples: Laya's question sets plus a sample state for each |
| `server/api.py` | FastAPI app: routing, validation, 422 shaping, Jev↔Laya adapting, inference |
| `server/static/index.html` | the web UI — one file, no build step; the JSON editor pulls CodeMirror from esm.sh at runtime |
| `pyproject.toml`, `uv.lock` | pinned dependency set |
| `verify_sdk.py` | round-trip check against the real `typesafe-sdk` client |

## API

Mirrors `https://api.typesafe.ai` v0.2.0. An `Authorization: Bearer <key>` header is accepted and ignored.

### `GET /v1/models`

```json
{"models": [{"name": "laya", "description": "...", "release_date": "2026-09-18"}]}
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

Open <http://127.0.0.1:8000/demo> with the server running.

The left column holds a **Request** panel and an **Examples** panel. Request has two views, toggled
in its header:

- **UI** — the *state* textarea plus one editable card per question; `+ noul` / `+ choice` / `+ score`
  append a new one.
- **JSON** — the same request as raw JSON in a CodeMirror editor, with syntax highlighting, folding
  and inline parse errors. Edits round-trip back into the UI view.

**Examples** loads one of five ready-made requests — it fills both the state box and the question
set, so picking one and pressing Send gives a real answer with nothing to type. The question sets are
Laya's built-in ones, read live from the installed package; the sample states are this project's,
since `laya` ships questions only. Edit either afterwards. Send with the **Send** button or
⌘/Ctrl+Enter from the state box.

The right pane is a log of decisions — each turn sends one *state* and renders a card per question:
ranked probability bars for `choice`, a legend strip with the expected-value marker for `score`, a
0–1 gauge for `noul`, plus confidence, `act_probability` and the input-token count. Turns are
independent; Laya has no memory. The question set, the current state and the last 30 turns live in
`localStorage`.

CodeMirror is loaded from esm.sh on demand. If that CDN is unreachable the UI view works normally and
the JSON view reports `JSON editor unavailable`; nothing else needs a network.

Two routes serve the UI and are **outside the Jev contract**:

| route | returns |
|---|---|
| `GET /demo` | `index.html` |
| `GET /ui/presets` | the five examples — `triage`, `router`, `moderation`, `guard`, `email` — each `{state, questions}` |

`GET /` is a health check, also outside the Jev contract: `{"status": "ok", "model": "laya", "ui":
"/demo"}`. It answers only once the model is loaded, because uvicorn binds the socket after the
startup hook — so a 200 there means the server is ready to decide, not merely running.

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
