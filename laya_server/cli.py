"""Command line entry point: list and download checkpoints, run the server."""

from __future__ import annotations

import argparse
import socket
import threading
import time
import urllib.error
import urllib.request
import webbrowser

from .registry import DEFAULT_MODEL, MODELS, cached_path, download, resolve


def free_port(host: str, start: int, tries: int = 50) -> int:
    for port in range(start, start + tries):
        with socket.socket() as s:
            try:
                s.bind((host, port))
            except OSError:
                continue
        return port
    raise SystemExit(f"no free port in {start}..{start + tries - 1}")


def cmd_list(_args: argparse.Namespace) -> None:
    width = max(len(n) for n in MODELS)
    for model in MODELS.values():
        state = "cached" if cached_path(model) else f"{model.size_mb} MB"
        default = " (default)" if model.name == DEFAULT_MODEL else ""
        print(f"  {model.name:<{width}}  {state:>7}  {model.context:>4} tok  {model.description}{default}")


def cmd_pull(args: argparse.Namespace) -> None:
    for name in args.model or list(MODELS):
        download(resolve(name))


def banner(host: str, port: int, model_name: str, ui: bool) -> str:
    base = f"http://{host}:{port}"
    lines = [
        "",
        f"==> Ready. Serving {model_name} on {base}",
        "",
        "    Jev / System One API",
        f"      GET   {base}/v1/models        list the model",
        f"      POST  {base}/v1/systemone     answer questions about a state",
    ]
    if ui:
        lines += [
            "",
            "    Web UI (outside the Jev contract)",
            f"      GET   {base}/                 the demo page",
            f"      GET   {base}/ui/presets       Laya's built-in question sets",
        ]
    lines += [
        "",
        "    For the TypeSafe SDK:",
        f"      export TYPESAFE_BASE_URL={base}",
        "      export TYPESAFE_API_KEY=local",
        "",
        "    Ctrl-C to stop.",
        "",
    ]
    return "\n".join(lines)


def cmd_serve(args: argparse.Namespace) -> None:
    import uvicorn

    from . import api

    model = resolve(args.model)
    api.use_model(model)
    api.serve_ui = not args.no_ui

    port = args.port if args.fixed_port else free_port(args.host, args.port)
    # 0.0.0.0 and :: are bind addresses, not connectable ones (Windows rejects them outright).
    probe_host = "127.0.0.1" if args.host in ("0.0.0.0", "::", "") else args.host

    # The weights load in uvicorn's startup hook; fetch them here so download progress is visible
    # before the server claims a port.
    download(model)
    print(f"==> Loading {model.name} ({model.size_mb} MB) into memory", flush=True)

    ui = not args.no_ui
    announce = threading.Thread(
        target=_announce_when_ready,
        args=(probe_host, port, model.name, ui, not args.no_browser and ui),
        daemon=True,
    )
    announce.start()
    uvicorn.run(api.app, host=args.host, port=port, log_level=args.log_level)


def _announce_when_ready(host: str, port: int, model_name: str, ui: bool, open_browser: bool) -> None:
    """uvicorn binds the socket only once the model is loaded, so a 200 here means it is ready."""
    url = f"http://{host}:{port}/"
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(f"{url}v1/models", timeout=1).close()
            break
        except (urllib.error.URLError, OSError):
            time.sleep(0.5)
    else:
        return
    print(banner(host, port, model_name, ui), flush=True)
    if open_browser:
        webbrowser.open(url)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="laya-server", description="Run the Laya decision model behind the Jev API.")
    sub = parser.add_subparsers(dest="command", required=True)

    models = sub.add_parser("models", help="inspect and download checkpoints")
    models_sub = models.add_subparsers(dest="models_command", required=True)
    models_sub.add_parser("list", help="show every checkpoint and whether it is cached").set_defaults(func=cmd_list)
    pull = models_sub.add_parser("pull", help="download checkpoints ahead of time")
    pull.add_argument("model", nargs="*", help=f"checkpoint names (default: all of {', '.join(MODELS)})")
    pull.set_defaults(func=cmd_pull)

    serve = sub.add_parser("serve", help="start the HTTP server")
    serve.add_argument("--model", default=DEFAULT_MODEL, help=f"checkpoint to serve (default: {DEFAULT_MODEL})")
    serve.add_argument("--host", default="127.0.0.1", help="bind address (default: 127.0.0.1)")
    serve.add_argument("--port", type=int, default=8000, help="first port to try (default: 8000)")
    serve.add_argument("--fixed-port", action="store_true", help="fail instead of scanning for a free port")
    serve.add_argument("--no-ui", action="store_true", help="serve the API only, no demo page")
    serve.add_argument("--no-browser", action="store_true", help="do not open a browser")
    serve.add_argument("--log-level", default="warning", help="uvicorn log level (default: warning)")
    serve.set_defaults(func=cmd_serve)

    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except KeyboardInterrupt:
        pass
