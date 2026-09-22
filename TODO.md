# TODO

- [ ] throughput-improvement Pass `"server.api:app"` as an import string to `uvicorn.Config`, not the app object — uvicorn refuses `workers > 1` otherwise (uvicorn `main.py:617`)
- [ ] throughput-improvement Move model selection to an env var that `server/api.py` reads at import, since each spawned worker re-imports instead of inheriting `api.use_model()`
- [ ] throughput-improvement Do not call `cfg.load()` in the parent — it resolves the FastAPI app, which fails to pickle for spawn with `Can't get local object 'FastAPI.setup.<locals>.openapi'`
- [ ] throughput-improvement Guard `server/__main__.py`'s `main()` behind `if __name__ == "__main__":` — spawn re-imports the main module in every child, so each worker would otherwise re-run the CLI
- [ ] throughput-improvement Give each worker its own log file — N processes sharing one `RotatingFileHandler` race on rotation
- [ ] throughput-improvement Keep the banner, browser-open and readiness probe in the parent process only
- [ ] throughput-improvement Add `--workers N` to `add_serve_options` in `server/cli.py`, and document that each worker holds its own 846 MB copy of the weights
- [ ] throughput-improvement Pass the pre-bound socket straight to `Multiprocess(cfg, sockets=[sock])` — it accepts it as-is, no change needed in `bind()`
- [ ] throughput-improvement Measure two-worker throughput through the real server; the ~106 req/s figure is from two independent processes, never confirmed end to end
- [ ] Write tests: criteria `min_length`, `models --port`, IPv6 `bind()` — all reachable without the weights (`TestClient(app)` outside a `with` block skips lifespan)
