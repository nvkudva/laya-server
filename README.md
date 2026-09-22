# laya server

A local HTTP server that runs the [Laya](https://huggingface.co/convaiinnovations/laya) decision
model behind TypeSafe's **Jev / System One** wire API.

> **Already calling TypeSafe or Jev? This is a drop-in replacement.** Point `TYPESAFE_BASE_URL` at
> this server and your existing code keeps working — same routes, same request and response shapes,
> so the stock `typesafe-sdk` and the `jev` decorators need no edits and no API key. The one thing
> that changes is where the answers come from: Laya, on your own machine, instead of the hosted
> service. See [Differences from hosted Jev](#differences-from-hosted-jev) before you rely on it.

- Laya writes no text. You send one **state** and any number of typed **questions**.
- You get back a calibrated probability for each question, from a single forward pass.
- One FastAPI process owns HTTP, validation, the wire contract and inference.
- One checkpoint is loaded at startup, and requests run one at a time behind a lock.

## Features

- **Drop-in Jev / System One API** — `GET /v1/models` and `POST /v1/systemone`, matching
  `api.typesafe.ai` v0.2.0. An `Authorization: Bearer <key>` header is accepted and ignored, so
  clients that always send one keep working.
- **Runs entirely on your machine** — after the first download it needs no network, no account and no
  key. Nothing you send leaves the host.
- **Three question types** — `noul` (yes/no), `choice` (pick one label) and `score` (ordered levels).
  Each answer carries a calibrated probability distribution and a confidence, never free text.
- **Many questions, one forward pass** — the marginal question is cheap. One question takes about
  20 ms; twelve take about 58 ms, roughly 5 ms each.
- **Three checkpoints**, picked at start time: English, multilingual (100+ languages), and one tuned
  for agent traces, support, invoices and security incidents.
- **A built-in web UI** at `/demo`, with five ready-made examples, a JSON editor and a running log of
  decisions — no build step.
- **One process, one port** — the UI and the API are routes on the same server, so there is no CORS
  setup and no second address to manage.
- **Quick to start and easy to watch** — about three seconds to a serving port, with requests, errors
  and full tracebacks in a rotating `server.log`.

## Quick start

```sh
git clone https://github.com/nvkudva/laya-server.git
cd laya-server
./start.sh          # macOS, Linux
.\start.ps1         # Windows
```

- The wrappers install [uv](https://docs.astral.sh/uv/) only if it is missing, run `uv sync`, then
  hand off to the `laya-server` CLI — so every platform takes the same code path.
- The default action is `serve`: download the weights if needed, start on the first free port from
  8000, and open the UI. Ctrl-C stops it.
- On a bare interactive run it offers once to install `laya-server` on your PATH, so later runs can
  skip the wrapper. Answer either way and it still starts the server; with arguments, or when the
  output is piped, it never asks. The install is editable, so it follows this checkout — remove it
  with `uv tool uninstall laya-server`.
- Arguments pass straight through, so the wrapper is also how you pick a model:

```sh
./start.sh models                            # menu: choose a checkpoint, it downloads and starts
./start.sh serve laya-typed-decisions        # skip the menu, run one directly
```

See [Models](#models) for the full list and what each one is for.

## Example

One state, three questions of different types, one round trip:

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

Field by field, that is the whole contract — see [API](#api) for the schema and
[Web UI](#web-ui) for the same thing with nothing to type.

## Web UI

Open <http://127.0.0.1:8000/demo> with the server running.

![The Laya demo page: a request panel on the left with a state box, a choice question and its
criteria, and a decision log on the right](demo.png)

The left column holds a **Request** panel. It has two views, toggled in its header:

- **UI** — the *state* textarea plus one editable card per question; `+ noul` / `+ choice` / `+ score`
  add a new one.
- **JSON** — the same request as raw JSON in a CodeMirror editor, with syntax highlighting, folding
  and inline parse errors. Edits round-trip back into the UI view.

**load an example…**, the picker in the request header, loads one of five ready-made requests:

- It fills both the state box and the question set, so picking one and pressing Send gives a real
  answer with nothing to type.
- The question sets are Laya's built-in ones, read live from the installed package. The sample states
  are this project's, since `laya` ships questions only.
- Edit either afterwards. Send with the **Send** button, or ⌘/Ctrl+Enter from the state box.

The right pane is a log of decisions. Each turn sends one *state* and draws a card per question:

- ranked probability bars for `choice`
- a legend strip with the expected-value marker for `score`
- a 0–1 gauge for `noul`
- confidence, `act_probability` and the input-token count on all three

Turns are independent — Laya has no memory. The question set, the current state and the last 30 turns
live in `localStorage`.

CodeMirror loads from esm.sh on demand. If that CDN is unreachable the UI view works normally and the
JSON view reports `JSON editor unavailable`; nothing else needs a network.

Two routes serve the UI and sit **outside the Jev contract**:

| route | returns |
|---|---|
| `GET /demo` | `demo.html` |
| `GET /ui/presets` | the five examples — `triage`, `router`, `moderation`, `guard`, `email` — each `{state, questions}` |

`GET /` is a health check, also outside the Jev contract: `{"status": "ok", "model": "laya", "ui":
"/demo"}`. It answers only once the model is loaded — the CLI claims the socket up front, but uvicorn
starts accepting on it only after the startup hook finishes. So a 200 there means the server is ready
to decide, not merely running.

## CLI

```sh
laya-server                      # serve the default checkpoint
laya-server models               # menu: pick a checkpoint, or delete downloaded ones
laya-server serve [model]        # serve a named checkpoint
laya-server pull [model...]      # download without starting (no name = all)
```

Four options work on all of them:

- `--host` — bind address, default `127.0.0.1`.
- `--port` — default is the first free port from 8000. Name a port and it is used as given: if it is
  busy the command fails at once rather than drifting to another one.
- `--no-browser` — do not open the UI.
- `--log-file` — default `server.log`.

What goes where:

- **The log file** gets every request, the startup and shutdown lines, and the full traceback for any
  500. It rotates at 5 MB and keeps three older files.
- **The console** stays quiet — warnings and errors only.
- **Clients** never see an internal error message. The log file is the only place they appear.

## Models

Three checkpoints. One is loaded per process, chosen at start time.

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

- `cached` means the weights are already on disk. A size is what downloading will cost.
- Pick a number and it downloads if needed, then starts the server — one step, no separate pull.
- Piped or run from a script, `models` prints the same table and exits instead of asking.

### Or name it directly

```sh
./start.sh serve laya-typed-decisions
```

- To switch, stop the server and start it again with a different name. Nothing is cached per project
  and nothing needs re-syncing.
- Check which one is running with `curl -s http://127.0.0.1:8000/v1/models`:

```json
{"models": [{"name": "laya-typed-decisions",
             "description": "Agent traces, customer service, invoices, security incidents (ModernBERT-large, 1024-token context).",
             "release_date": "2026-09-18"}]}
```

To run two checkpoints side by side, start two servers on different ports:

```sh
./start.sh serve laya --port 8000 --no-browser --log-file laya.log &
./start.sh serve laya-typed-decisions --port 8001 --no-browser --log-file typed.log &
```

Give each one its own `--log-file`. Two servers sharing the default `server.log` mix their lines
together and race each other's rotation.

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

Optional — `serve` and the menu both download on demand. It is useful for warming a machine before a
demo, or downloading on a fast network and running elsewhere.

### Deleting checkpoints

Option 4 in the menu removes every downloaded Laya checkpoint.

- It lists what will go and makes you type `yes` first.
- The weights live in the **shared** Hugging Face cache, so any other project on the machine that
  uses the same repos will download them again.

### Client compatibility

Two names are accepted as aliases for whichever checkpoint is loaded, so a client keeps working
after you switch checkpoints:

- `jev-latest` — `typesafe-sdk`'s built-in default, which is what a client sends when it never passes
  `model=` at all.
- `laya` — what stock Jev clients hard-code in the request body.
- The loaded checkpoint's own name works too. Any other name is a 422 that lists the accepted ones.

### Adding a checkpoint

One entry in `server/registry.py`:

```python
Model("my-laya", "myorg/my-laya", "ModernBERT-large", 1024, 846, "what it is good at"),
```

- It then shows up in the `models` menu, in `pull` and in `serve <name>`.
- The repo must have the same layout as the official ones: `rl_agent_config.json`,
  `model.safetensors`, `tokenizer/`, `encoder/`.

## Startup

- The first run downloads the checkpoint and takes a few minutes.
- Later runs touch no network — weights resolve from the cache with `local_files_only` — so startup
  is just the read into RAM, about three seconds to a serving port:

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

- There is **one server and one port**. The UI and the API are routes on the same FastAPI process, so
  the UI needs no CORS and no second address.
- `--host 0.0.0.0` puts it on the LAN instead of loopback only.

## Throughput

- One request is inside the model at a time, behind a `threading.Lock`.
- On Apple Silicon that lock is **required, not a tuning choice**: two threads inside a forward pass
  abort the process outright with `failed assertion ... IOGPUMetalCommandBuffer`. Do not remove it.

Measured on an M3 Max, one `noul` question, 846 MB `laya` checkpoint:

| | throughput | per request |
|---|---|---|
| MPS, one process | ~60 req/s | ~16 ms |
| MPS, two processes on two ports | ~106 req/s | ~16 ms |
| CPU, one process | ~16 req/s | ~63 ms |

- Extra questions in one call are nearly free in time — they ride one batched forward pass, so five
  questions cost about 40 ms rather than five times 16 ms. Put related questions in one request
  instead of fanning out into several. They are not free in tokens: each question carries its own
  copy of the state.
- To go past one process, run several servers on different ports behind a load balancer, each with
  its own `--log-file`. Every worker holds its own copy of the weights, so budget the checkpoint size
  per process.
- Batching concurrent requests into one forward pass would reach roughly 230 req/s, but `laya` does
  not expose the batch dimension in its public API, so this server does not attempt it.
- These are M3 Max figures. A base M2 has a quarter of the GPU cores, so expect nearer 40–60 ms per
  request. Memory does not change with the machine: about 2.2 GB of unified memory once loaded,
  peaking near 3.3 GB on a request with many full-length questions.

## Model weights

Weights live in the shared Hugging Face cache, not in the repo:

```
~/.cache/huggingface/hub/models--convaiinnovations--laya/
```

- The large files are content-addressed and symlinked, so several projects on one machine share a
  single copy, and each checkpoint sits under its own `models--convaiinnovations--*` directory.
- To put the cache elsewhere, set `HF_HOME` (moves the whole HF directory) or `HF_HUB_CACHE` (moves
  only the model cache) before running `./start.sh`.
- If the weights are missing and the machine is offline, startup fails with a clear message rather
  than stalling silently.

## Manual run

```sh
uv sync
uv run laya-server serve               # the CLI, without the wrapper
.venv/bin/laya-server serve            # the same entry point, directly
uv run python -m server serve          # module form
uv run python -m uvicorn server.api:app --port 8000   # bare ASGI app, default checkpoint
```

Once installed with `uv tool install --editable .` — which `./start.sh` offers on a bare run — plain
`laya-server` works from any directory.

## Tests

```sh
uv run --extra dev pytest              # the contract and CLI, no weights, about a second
uv run --extra dev python verify_sdk.py   # a real round trip through the official SDK, needs a running server
```

`tests/test_contract.py` patches `agent()` out, so the app starts and routes for real while nothing
is read from disk. It covers what the wire contract promises: the criteria minimums, the accepted
model aliases (including `typesafe-sdk`'s own default), one error shape across 404, 405, 422 and 500,
the instructions fallback, and every response validated against TypeSafe's generated schemas. The
CLI tests cover port handling and address families.

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
| `state` | string \| object \| array | the content every question refers to; re-encoded per question and silently truncated — see [Differences from hosted Jev](#differences-from-hosted-jev) |
| `model` | string | the loaded checkpoint's name, or the aliases `jev-latest` / `laya`; anything else is a 422 |
| `questions` | object | question name → question, at least one |

Question types — all take an optional `instructions`, which may be a string, object or array:

| `type` | `criteria` | answer fields |
|---|---|---|
| `noul` | optional `{"true": ..., "false": ...}` | `noul` = p(yes), `confidence` |
| `choice` | `{label: description-or-null}`, at least two | `choice`, `probabilities`, `confidence` |
| `score` | ordered list of at least two level descriptions | `score` (expected level), `legend`, `probabilities`, `confidence` |

Response and errors:

- A reply is `{"model": ..., "answers": {name: answer}, "usage": {"input_tokens": n, "output_tokens": 0}}`.
- Every answer also carries `action.act_probability` — a Laya extra that Jev clients ignore.
- Every error uses one shape, `{"detail": [{"loc": [...], "msg": ..., "type": ...}]}`:
  - **422** — a validation failure, or a `model` this server does not serve.
  - **404** and **405** — routing.
  - **500** — anything unexpected. The message is always the fixed `"internal error"`; the real one
    goes to the log file.

A worked call is at the top, under [Example](#example).

## Using the official clients

The stock `typesafe-sdk` and the `jev` decorator library work unchanged against this server:

```sh
export TYPESAFE_API_KEY=local
export TYPESAFE_BASE_URL=http://127.0.0.1:8000
```

`verify_sdk.py` is a round-trip check that exercises all three question types through the real SDK,
which parses responses in strict mode:

```sh
uv run --extra dev python verify_sdk.py
```

## Differences from hosted Jev

- **`instructions` is optional in Jev but required by Laya.** When it is left out, the server uses the
  humanized question name instead (`is_urgent` → `is urgent`).
- Answers are a **superset** of Jev's — `action.act_probability` on every answer, and `confidence` on
  `noul`.
- `usage.input_tokens` is a real token count, summed over every question. `output_tokens` is always
  0, since nothing is generated.
- **Each question is encoded on its own, with its own copy of the state**, and long input truncates
  silently. Per question the budget is 512 tokens on `laya` and 1024 on the other two: the
  instructions and option labels share the first 192, and the state takes what is left — roughly 320
  on `laya` — losing its tail beyond that. Adding questions never shrinks the state's budget, but it
  does multiply `input_tokens`, since each carries the state again.
- Requests are serialized: one forward pass at a time, in order of arrival.
- Answer quality, calibration and language coverage are Laya's, not Jev's. The two are not comparable.

## Platform support

- macOS and Linux are tested.
- On Linux, `torch` resolves to the CPU build from `download.pytorch.org/whl/cpu`. PyPI's Linux wheel
  pulls in the whole CUDA toolkit — several GB — which is wasted on a 421M-parameter model doing one
  forward pass at a time. For a GPU box, sync against the matching CUDA index instead of `whl/cpu` in
  `pyproject.toml`.
- Windows should work, since the CLI is pure Python and `start.ps1` mirrors `start.sh`, but it is
  untested and the `torch==2.14.0` Windows wheel has not been verified.

## Provenance

Laya is by Convai Innovations (Apache-2.0). The Jev API shape is TypeSafe's. This project is not
affiliated with TypeSafe and uses none of their code or weights.

## Files

| file | role |
|---|---|
| `start.sh`, `start.ps1` | thin wrappers: install uv, `uv sync`, hand off to the CLI |
| `server/cli.py` | the `models` menu, `pull` and `serve`; port binding, logging, browser, startup banner |
| `server/registry.py` | the checkpoint table and the download / cache / delete helpers |
| `server/presets.py` | the five examples: Laya's question sets plus a sample state for each |
| `server/api.py` | FastAPI app: routing, validation, error shaping, Jev↔Laya adapting, inference |
| `server/static/demo.html` | the web UI markup; `style.css` and `main.js` sit beside it. No build step — the JSON editor pulls CodeMirror from esm.sh at runtime |
| `pyproject.toml`, `uv.lock` | pinned dependency set |
| `verify_sdk.py` | round-trip check against the real `typesafe-sdk` client |
| `tests/test_contract.py` | the wire contract and the CLI, with no checkpoint loaded |

## License

Apache-2.0 — see [LICENSE](LICENSE). The model weights are licensed separately by Convai
Innovations, also Apache-2.0.
