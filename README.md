# laya server

A local HTTP server that exposes the [Laya](https://huggingface.co/convaiinnovations/laya) decision model
behind TypeSafe's **Jev / System One** wire API.

A single FastAPI process owns HTTP, validation, the wire contract and inference. The model is
loaded once at startup and requests are serialized behind a lock.

Laya generates no text. You send one **state** plus any number of typed **questions**; it returns a
calibrated probability distribution per question from a single forward pass.

## Quick start

```sh
git clone <this repo>
cd laya-mlx
./start.sh
```

`start.sh` installs [uv](https://docs.astral.sh/uv/) if it is missing, provisions Python 3.12 and
the pinned dependencies, downloads the weights, starts the server on the first free port from 8000
and opens the UI in your browser. Ctrl-C stops it. Written for macOS; it also works on Linux with
`xdg-open` installed.

First run pulls ~810 MB into `~/.cache/huggingface` and takes a few minutes; later runs start in
seconds.

## Manual run

```sh
uv sync
uv run uvicorn server:app --port 8000
```

## Files

| file | role |
|---|---|
| `start.sh` | one-shot setup + run: uv, deps, weights, server, browser |
| `server.py` | FastAPI server: routing, validation, 422 shaping, Jev↔Laya adapting, inference |
| `index.html` | the web UI — one file, no build step |
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
| `model` | string | `laya` — the only model; anything else is a 422 |
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

Open <http://127.0.0.1:8000/> with the server running. The left pane edits the
question set (add `noul` / `choice` / `score`, or load one of Laya's built-in sets from
the preset dropdown); the right pane is a log of decisions — each turn sends one *state*
and renders a card per question: ranked probability bars for `choice`, a legend strip
with the expected-value marker for `score`, a 0–1 gauge for `noul`, plus confidence,
`act_probability` and the input-token count. Turns are independent; Laya has no memory.
The question set and the last 30 turns live in `localStorage`.

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
- **512-token context, shared by the state and all questions combined**, and it truncates silently.
  Long states with many questions will quietly lose the tail.
- Requests are serialized — one forward pass at a time, queued in order of arrival.
- Answer quality, calibration and language coverage are Laya's, not Jev's; the two are not comparable.

## Provenance

Laya is by Convai Innovations (Apache-2.0). The Jev API
shape is TypeSafe's; this project is not affiliated with TypeSafe and uses none of their code or weights.
