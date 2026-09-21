"""The Laya checkpoints this server can run."""

from __future__ import annotations

from dataclasses import dataclass

from huggingface_hub import scan_cache_dir, snapshot_download
from huggingface_hub.errors import LocalEntryNotFoundError

# laya.load() would pull a repo whole; these are the only files it reads.
ALLOW_PATTERNS = ["rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*"]


@dataclass(frozen=True)
class Model:
    name: str
    repo_id: str
    encoder: str
    context: int
    size_mb: int
    description: str


MODELS: dict[str, Model] = {
    m.name: m
    for m in (
        Model("laya", "convaiinnovations/laya", "ModernBERT-large", 512, 846, "English, general purpose"),
        Model("laya-multilingual", "convaiinnovations/laya-multilingual", "mmBERT-base", 1024, 678, "100+ languages"),
        Model(
            "laya-typed-decisions",
            "convaiinnovations/laya-typed-decisions",
            "ModernBERT-large",
            1024,
            846,
            "Agent traces, customer service, invoices, security incidents",
        ),
    )
}

DEFAULT_MODEL = "laya"


def resolve(name: str) -> Model:
    try:
        return MODELS[name]
    except KeyError:
        known = ", ".join(MODELS)
        raise SystemExit(f"unknown model {name!r}; known models: {known}") from None


def cached_path(model: Model) -> str | None:
    """The local snapshot directory, or None if the weights are not downloaded yet."""
    try:
        return snapshot_download(model.repo_id, allow_patterns=ALLOW_PATTERNS, local_files_only=True)
    except LocalEntryNotFoundError:
        return None


def download(model: Model) -> str:
    """Fetch the weights if needed and return the local snapshot directory."""
    path = cached_path(model)
    if path is not None:
        return path
    print(f"==> Downloading {model.repo_id} (~{model.size_mb} MB, one time)", flush=True)
    path = snapshot_download(model.repo_id, allow_patterns=ALLOW_PATTERNS)
    print(f"==> Cached at {path}", flush=True)
    return path


def cached_repos() -> dict[str, int]:
    """repo_id -> bytes on disk, for the checkpoints in this registry that are downloaded."""
    wanted = {m.repo_id for m in MODELS.values()}
    return {r.repo_id: r.size_on_disk for r in scan_cache_dir().repos if r.repo_id in wanted}


def delete_cached() -> int:
    """Remove every downloaded checkpoint in this registry. Returns bytes freed."""
    info = scan_cache_dir()
    wanted = {m.repo_id for m in MODELS.values()}
    revisions = [rev.commit_hash for repo in info.repos if repo.repo_id in wanted for rev in repo.revisions]
    if not revisions:
        return 0
    strategy = info.delete_revisions(*revisions)
    freed = strategy.expected_freed_size
    strategy.execute()
    return freed
