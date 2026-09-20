"""Jev-compatible (TypeSafe System One) HTTP API backed by the local laya model."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Annotated, Any, Literal

import laya
from fastapi import Body, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from huggingface_hub import snapshot_download
from pydantic import BaseModel, Field

INDEX_HTML = Path(__file__).resolve().parent / "index.html"

JSONContent = str | dict[str, Any] | list[Any]

MODEL_ID = "convaiinnovations/laya"
MODEL_NAME = "laya"
# laya.load() would pull the whole 2.2 GB repo; these are the only files it reads (~810 MB).
MODEL_FILES = ["rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*"]


class NoulCriteria(BaseModel):
    true: JSONContent | None = None
    false: JSONContent | None = None


class NoulQuestion(BaseModel):
    type: Literal["noul"]
    instructions: JSONContent | None = None
    criteria: NoulCriteria | None = None


class ChoiceQuestion(BaseModel):
    type: Literal["choice"]
    instructions: JSONContent | None = None
    criteria: dict[str, JSONContent | None]


class ScoreQuestion(BaseModel):
    type: Literal["score"]
    instructions: JSONContent | None = None
    criteria: list[JSONContent] = Field(min_length=1)


Question = Annotated[NoulQuestion | ChoiceQuestion | ScoreQuestion, Field(discriminator="type")]


class SystemOneRequest(BaseModel):
    state: JSONContent
    model: Literal["laya"] = MODEL_NAME
    questions: dict[str, Question] = Field(min_length=1)


app = FastAPI(title="Laya System One", version="0.2.0")
_lock = threading.Lock()
_agent = None


def model_dir() -> str:
    return snapshot_download(MODEL_ID, allow_patterns=MODEL_FILES)


def agent():
    global _agent
    if _agent is None:
        _agent = laya.load(model_dir())
    return _agent


@app.on_event("startup")
def _warm() -> None:
    agent()


def _invalid(loc: list[str | int], msg: str, kind: str = "value_error") -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": [{"loc": loc, "msg": msg, "type": kind}]})


def _to_laya(name: str, q: Question) -> dict[str, Any]:
    # Jev leaves instructions optional; laya requires them. Fall back to the humanized question name.
    instructions = q.instructions
    if instructions is None:
        instructions = name.replace("_", " ")
    out: dict[str, Any] = {"type": q.type, "instructions": instructions}
    if isinstance(q, NoulQuestion):
        if q.criteria is not None:
            out["criteria"] = q.criteria.model_dump(exclude_none=True)
    else:
        out["criteria"] = q.criteria
    return out


@app.get("/")
def index() -> FileResponse:
    return FileResponse(INDEX_HTML, media_type="text/html")


@app.get("/ui/presets")
def ui_presets() -> dict[str, Any]:
    return {
        "triage": laya.triage_questions(),
        "router": laya.router_questions(),
        "moderation": laya.moderation_questions(),
        "guard": laya.guard_questions(),
        "email": laya.email_questions(),
    }


@app.get("/v1/models")
def list_models() -> dict[str, Any]:
    return {
        "models": [
            {"name": MODEL_NAME, "description": "Laya decision model (ModernBERT-large).", "release_date": "2026-01-01"},
        ]
    }


@app.post("/v1/systemone")
def system_one(req: Annotated[SystemOneRequest, Body()]) -> Any:
    questions = {name: _to_laya(name, q) for name, q in req.questions.items()}
    try:
        with _lock:
            result = agent().system_one(req.state, questions)
    except ValueError as exc:
        return _invalid(["body", "questions"], str(exc))
    result["model"] = MODEL_NAME
    return result


@app.exception_handler(Exception)
def _unhandled(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=500, content={"detail": [{"loc": ["body"], "msg": str(exc), "type": "internal_error"}]})
