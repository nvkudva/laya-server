"""Command line entry point: pick a checkpoint, download it, run the server."""

from __future__ import annotations

import argparse
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser

from .registry import DEFAULT_MODEL, MODELS, Model, cached_path, cached_repos, delete_cached, download, resolve


def bind(host: str, port: int | None, tries: int = 50) -> tuple[socket.socket, int]:
    """Claim the port up front and hand the listening socket to uvicorn.

    Checking a port and then letting uvicorn bind it leaves a window where something else takes it,
    after a 45-second model load. Binding here means a busy port fails in the first second instead.
    """
    candidates = [port] if port is not None else range(8000, 8000 + tries)
    for candidate in candidates:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, candidate))
        except OSError:
            sock.close()
            continue
        sock.listen(128)
        sock.set_inheritable(True)
        return sock, candidate
    if port is not None:
        raise SystemExit(f"port {port} is already in use on {host}; pick another with --port")
    raise SystemExit(f"no free port in 8000..{8000 + tries - 1}")


def rows() -> list[tuple[Model, str]]:
    return [(m, "cached" if cached_path(m) else f"{m.size_mb} MB") for m in MODELS.values()]


def print_table() -> None:
    width = max(len(n) for n in MODELS)
    for model, state in rows():
        default = " (default)" if model.name == DEFAULT_MODEL else ""
        print(f"  {model.name:<{width}}  {state:>7}  {model.context:>4} tok  {model.description}{default}")


def cmd_models(args: argparse.Namespace) -> None:
    """Interactive picker on a terminal; the plain table when piped or scripted."""
    if not sys.stdin.isatty():
        print_table()
        return

    listed = rows()
    width = max(len(n) for n in MODELS)
    print("\nLaya checkpoints\n")
    for i, (model, state) in enumerate(listed, 1):
        default = " (default)" if model.name == DEFAULT_MODEL else ""
        print(f"  {i}  {model.name:<{width}}  {state:>7}  {model.context:>4} tok  {model.description}{default}")
    print(f"\n  {len(listed) + 1}  delete all downloaded checkpoints")
    print("  q  quit\n")

    choice = input(f"Select [1-{len(listed) + 1}, q]: ").strip().lower()
    if choice in ("q", "quit", ""):
        return
    if choice == str(len(listed) + 1):
        confirm_delete()
        return
    if not choice.isdigit() or not 1 <= int(choice) <= len(listed):
        raise SystemExit(f"not a choice: {choice!r}")

    model = listed[int(choice) - 1][0]
    serve(model, host=args.host, port=args.port, fixed_port=False, open_browser=not args.no_browser)


def confirm_delete() -> None:
    cached = cached_repos()
    if not cached:
        print("\nNothing downloaded.")
        return
    total = sum(cached.values())
    print(f"\nThis deletes {len(cached)} checkpoint(s), {total / 1e9:.1f} GB, from the shared Hugging Face cache:\n")
    for repo_id, size in sorted(cached.items()):
        print(f"  {repo_id:<40} {size / 1e9:.1f} GB")
    print("\nOther projects on this machine that use these repos will re-download them.")
    if input("\nType 'yes' to confirm: ").strip() != "yes":
        print("Cancelled.")
        return
    print(f"Freed {delete_cached() / 1e9:.1f} GB.")


def cmd_pull(args: argparse.Namespace) -> None:
    for name in args.model or list(MODELS):
        download(resolve(name))


def cmd_serve(args: argparse.Namespace) -> None:
    serve(
        resolve(args.model or DEFAULT_MODEL),
        host=args.host,
        # An explicit --port means that port; only scan when it was defaulted.
        port=args.port,
        fixed_port=args.port is not None,
        open_browser=not args.no_browser,
    )


def serve(model: Model, *, host: str, port: int | None, fixed_port: bool, open_browser: bool) -> None:
    import uvicorn

    from . import api

    api.use_model(model)
    sock, port = bind(host, port if fixed_port else None)
    # 0.0.0.0 and :: are bind addresses, not connectable ones (Windows rejects them outright).
    probe_host = "127.0.0.1" if host in ("0.0.0.0", "::", "") else host

    # The weights load in uvicorn's startup hook; fetch them here so download progress is visible
    # before the server claims a port.
    download(model)
    print(f"==> Loading {model.name} ({model.size_mb} MB) into memory", flush=True)

    threading.Thread(
        target=_announce_when_ready, args=(probe_host, port, model.name, open_browser), daemon=True
    ).start()
    uvicorn.Server(uvicorn.Config(api.app, log_level="warning")).run(sockets=[sock])


def banner(host: str, port: int, model_name: str) -> str:
    base = f"http://{host}:{port}"
    return "\n".join(
        [
            "",
            f"==> Ready. Serving {model_name} on {base}",
            "",
            "    Jev / System One API",
            f"      GET   {base}/v1/models        list the model",
            f"      POST  {base}/v1/systemone     answer questions about a state",
            "",
            "    Web UI (outside the Jev contract)",
            f"      GET   {base}/                 the demo page",
            f"      GET   {base}/ui/presets       the five examples (state + questions)",
            "",
            "    For the TypeSafe SDK:",
            f"      export TYPESAFE_BASE_URL={base}",
            "      export TYPESAFE_API_KEY=local",
            "",
            "    Ctrl-C to stop.",
            "",
        ]
    )


def _announce_when_ready(host: str, port: int, model_name: str, open_browser: bool) -> None:
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
    print(banner(host, port, model_name), flush=True)
    if open_browser:
        webbrowser.open(url)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="laya-server", description="Run the Laya decision model behind the Jev API.")
    parser.set_defaults(func=cmd_serve, model=None)
    sub = parser.add_subparsers(dest="command")

    def add_serve_options(p: argparse.ArgumentParser) -> None:
        p.add_argument("--host", default="127.0.0.1", help="bind address (default: 127.0.0.1)")
        p.add_argument("--port", type=int, help="port to use (default: the first free one from 8000)")
        p.add_argument("--no-browser", action="store_true", help="do not open a browser")

    add_serve_options(parser)

    models = sub.add_parser("models", help="pick a checkpoint to run, or delete downloaded ones")
    add_serve_options(models)
    models.set_defaults(func=cmd_models)

    serve_cmd = sub.add_parser("serve", help="start the HTTP server")
    serve_cmd.add_argument("model", nargs="?", help=f"checkpoint to serve (default: {DEFAULT_MODEL})")
    add_serve_options(serve_cmd)
    serve_cmd.set_defaults(func=cmd_serve)

    pull = sub.add_parser("pull", help="download checkpoints without starting the server")
    pull.add_argument("model", nargs="*", help=f"checkpoint names (default: all of {', '.join(MODELS)})")
    pull.set_defaults(func=cmd_pull)

    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except (KeyboardInterrupt, EOFError):
        print()
