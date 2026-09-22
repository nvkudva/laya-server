"""The wire contract and the CLI, without loading a checkpoint.

`agent()` is patched out, so the app starts and routes for real while no weights are read. Every
test here runs in milliseconds; anything that needs actual inference belongs in `verify_sdk.py`.
"""

from __future__ import annotations

import socket
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from server import api, cli
from server.presets import examples
from server.registry import DEFAULT_MODEL, resolve

NOUL_ANSWER = {"type": "noul", "noul": 0.5, "confidence": 0.5, "action": {"act_probability": 1.0}}


@pytest.fixture(autouse=True)
def _reset_module_state():
    """`use_model` and `agent` are process globals; put them back between tests."""
    yield
    api._model = resolve(DEFAULT_MODEL)
    api._agent = None


@pytest.fixture
def agent():
    """The patched laya agent, so assertions can see what the adapter passed it."""
    stub = MagicMock()
    stub.system_one.return_value = {"answers": {}, "usage": {"input_tokens": 1, "output_tokens": 0}}
    with patch.object(api, "agent", return_value=stub):
        yield stub


@pytest.fixture
def client(agent):
    with TestClient(api.app, raise_server_exceptions=False) as c:
        yield c


def ask(client, questions, **body):
    return client.post("/v1/systemone", json={"state": "hello", "questions": questions, **body})


def assert_error_shape(response):
    """Every error, whatever its status, is a list of {loc, msg, type}."""
    detail = response.json()["detail"]
    assert isinstance(detail, list) and detail, detail
    for item in detail:
        assert {"loc", "msg", "type"} <= item.keys(), item
        assert isinstance(item["loc"], list)
        assert isinstance(item["msg"], str)


# --- criteria: laya raises on fewer than two, so these must be rejected before it is called -------


@pytest.mark.parametrize(
    "question",
    [
        pytest.param({"type": "choice", "instructions": "pick", "criteria": {}}, id="choice-0"),
        pytest.param({"type": "choice", "instructions": "pick", "criteria": {"only": "x"}}, id="choice-1"),
        pytest.param({"type": "score", "instructions": "rate", "criteria": ["only"]}, id="score-1"),
    ],
)
def test_under_two_criteria_is_422_not_500(client, agent, question):
    response = ask(client, {"q": question})
    assert response.status_code == 422
    assert_error_shape(response)
    agent.system_one.assert_not_called()


@pytest.mark.parametrize(
    "question",
    [
        pytest.param({"type": "choice", "instructions": "pick", "criteria": {"a": "x", "b": None}}, id="choice-2"),
        pytest.param({"type": "score", "instructions": "rate", "criteria": ["lo", "hi"]}, id="score-2"),
        pytest.param({"type": "noul", "instructions": "yes?"}, id="noul"),
    ],
)
def test_two_criteria_is_accepted(client, question):
    assert ask(client, {"q": question}).status_code == 200


# --- model aliases: the gap that let an untouched typesafe-sdk client 422 --------------------------


@pytest.mark.parametrize("name", ["laya", "jev-latest", None])
def test_accepted_model_names(client, name):
    body = {} if name is None else {"model": name}
    assert ask(client, {"q": {"type": "noul", "instructions": "yes?"}}, **body).status_code == 200


def test_sdk_default_model_is_accepted():
    """typesafe-sdk sends this when the caller never passes `model=`; it must not 422."""
    constants = pytest.importorskip("typesafe_sdk.constants")
    assert constants.DEFAULT_MODEL in api.ALIASES


def test_unknown_model_is_422_and_lists_the_alternatives(client, agent):
    response = ask(client, {"q": {"type": "noul", "instructions": "yes?"}}, model="gpt-9")
    assert response.status_code == 422
    assert_error_shape(response)
    assert "jev-latest" in response.json()["detail"][0]["msg"]
    agent.system_one.assert_not_called()


# --- one error shape for every status -------------------------------------------------------------


def test_404_and_405_use_the_same_shape_as_validation_errors(client):
    for response, status in [(client.get("/nope"), 404), (client.get("/v1/systemone"), 405)]:
        assert response.status_code == status
        assert_error_shape(response)


def test_405_keeps_the_allow_header(client):
    assert "POST" in client.get("/v1/systemone").headers["allow"]


def test_500_does_not_leak_the_exception(client):
    @api.app.get("/_boom")
    async def boom():
        raise RuntimeError("SECRET-a1b2c3")

    try:
        response = client.get("/_boom")
        assert response.status_code == 500
        assert_error_shape(response)
        assert "SECRET-a1b2c3" not in response.text
        assert response.json()["detail"][0]["msg"] == "internal error"
    finally:
        api.app.router.routes = [r for r in api.app.router.routes if getattr(r, "path", None) != "/_boom"]


# --- the Jev -> laya adapter ----------------------------------------------------------------------


def test_missing_instructions_fall_back_to_the_humanized_name(client, agent):
    ask(client, {"is_urgent": {"type": "noul"}})
    questions = agent.system_one.call_args.args[1]
    assert questions["is_urgent"]["instructions"] == "is urgent"


def test_the_served_model_name_is_reported_not_the_alias(client, agent):
    agent.system_one.return_value = {"answers": {"q": NOUL_ANSWER}, "usage": {"input_tokens": 1, "output_tokens": 0}}
    body = ask(client, {"q": {"type": "noul", "instructions": "yes?"}}, model="jev-latest").json()
    assert body["model"] == "laya"


# --- responses must satisfy TypeSafe's own generated schemas --------------------------------------


def test_responses_validate_against_the_typesafe_schema(client, agent):
    models = pytest.importorskip("typesafe_sdk._schemas.models")
    agent.system_one.return_value = {"answers": {"q": NOUL_ANSWER}, "usage": {"input_tokens": 1, "output_tokens": 0}}

    models.SystemOneResponse.model_validate(ask(client, {"q": {"type": "noul", "instructions": "y"}}).json())
    models.ModelMetadataList.model_validate(client.get("/v1/models").json())
    models.HTTPValidationError.model_validate(client.get("/nope").json())
    models.HTTPValidationError.model_validate(ask(client, {"q": {"type": "score", "instructions": "r", "criteria": ["one"]}}).json())


def test_every_preset_is_a_valid_request():
    for name, example in examples().items():
        assert api.SystemOneRequest(**example), name


# --- CLI ------------------------------------------------------------------------------------------


def test_models_subcommand_passes_port_through_to_serve():
    """It advertises --port via the shared options, so the menu has to honour it, not just parse it."""
    args = cli.build_parser().parse_args(["models", "--port", "9123", "--no-browser"])
    with (
        patch.object(cli.sys.stdin, "isatty", return_value=True),
        patch("builtins.input", return_value="1"),
        patch.object(cli, "serve") as serve,
    ):
        cli.cmd_models(args)
    assert serve.call_args.kwargs["port"] == 9123
    assert serve.call_args.kwargs["fixed_port"] is True


@pytest.mark.parametrize(
    ("host", "expected"),
    [
        ("127.0.0.1", "127.0.0.1"),
        ("0.0.0.0", "127.0.0.1"),
        ("::", "127.0.0.1"),
        ("", "127.0.0.1"),
        ("::1", "[::1]"),
        ("fe80::1", "[fe80::1]"),
    ],
)
def test_url_host_brackets_ipv6_and_maps_wildcards(host, expected):
    assert cli.url_host(host) == expected


@pytest.mark.parametrize(
    ("host", "family"),
    [("127.0.0.1", socket.AF_INET), ("::1", socket.AF_INET6)],
)
def test_bind_picks_the_address_family(host, family):
    sock, _ = cli.bind(host, None)
    try:
        assert sock.family == family
    finally:
        sock.close()


def test_bind_reports_a_busy_port_rather_than_scanning_past_it():
    held, port = cli.bind("127.0.0.1", None)
    try:
        with pytest.raises(SystemExit, match="already in use"):
            cli.bind("127.0.0.1", port)
    finally:
        held.close()


def test_banner_uses_the_url_host_verbatim():
    assert "http://[::1]:8000" in cli.banner(cli.url_host("::1"), 8000, "laya", "server.log")
