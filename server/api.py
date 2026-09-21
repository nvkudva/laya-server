"""Jev-compatible (TypeSafe System One) HTTP API backed by the local laya model."""

from __future__ import annotations

import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from importlib.metadata import version
from pathlib import Path
from typing import Annotated, Any, Literal

import laya
from fastapi import Body, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from .presets import examples
from .registry import DEFAULT_MODEL, Model, download, resolve

INDEX_HTML = Path(__file__).resolve().parent / "static" / "index.html"

JSONContent = str | dict[str, Any] | list[Any]


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
    # Stock Jev clients hard-code "laya"; accept it as an alias for whichever checkpoint is loaded.
    model: str = DEFAULT_MODEL
    questions: dict[str, Question] = Field(min_length=1)


_lock = threading.Lock()
_agent = None
_model: Model = resolve(DEFAULT_MODEL)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    # Load before uvicorn accepts connections, so a reply from any route means ready to decide.
    agent()
    yield


app = FastAPI(title="Laya System One", version=version("laya-server"), lifespan=lifespan)


def use_model(model: Model) -> None:
    """Pick the checkpoint this process serves. Call before startup."""
    global _model, _agent
    _model, _agent = model, None


def agent():
    global _agent
    if _agent is None:
        _agent = laya.load(download(_model))
    return _agent


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
def health() -> dict[str, Any]:
    """Liveness check. Reachable only once the model is loaded, since uvicorn binds after startup."""
    return {"status": "ok", "model": _model.name, "ui": "/demo"}


@app.get("/demo")
def demo() -> FileResponse:
    return FileResponse(INDEX_HTML, media_type="text/html")


@app.get("/ui/presets")
def ui_presets() -> dict[str, Any]:
    return examples()


@app.get("/v1/models")
def list_models() -> dict[str, Any]:
    return {
        "models": [
            {
                "name": _model.name,
                "description": f"{_model.description} ({_model.encoder}, {_model.context}-token context).",
                "release_date": _model.released,
            }
        ]
    }


@app.post("/v1/systemone")
def system_one(req: Annotated[SystemOneRequest, Body()]) -> Any:
    if req.model not in (_model.name, DEFAULT_MODEL):
        return _invalid(["body", "model"], f"this server serves {_model.name!r}, not {req.model!r}")
    questions = {name: _to_laya(name, q) for name, q in req.questions.items()}
    try:
        with _lock:
            result = agent().system_one(req.state, questions)
    except ValueError as exc:
        return _invalid(["body", "questions"], str(exc))
    result["model"] = _model.name
    return result


@app.exception_handler(Exception)
def _unhandled(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=500, content={"detail": [{"loc": ["body"], "msg": str(exc), "type": "internal_error"}]})
