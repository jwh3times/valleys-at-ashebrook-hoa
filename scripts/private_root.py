import os
from pathlib import Path

PRIVATE_ROOT_ENV = "ASHEBROOK_PRIVATE_ROOT"
REPOSITORY_ROOT = Path(__file__).resolve().parent.parent


def resolve_private_root(repository_root=REPOSITORY_ROOT, configured_root=None):
    configured = (
        os.environ.get(PRIVATE_ROOT_ENV, "")
        if configured_root is None
        else configured_root
    )
    selected = configured.strip() or "private"
    root = Path(selected)
    if not root.is_absolute():
        root = Path(repository_root) / root
    return root.resolve()


def private_path(*segments):
    return resolve_private_root().joinpath(*segments)
