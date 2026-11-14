"""Runtime settings, shared by the CLI, the app and the tests."""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    # Same default as `notation-directory' in notation.el.
    root: Path = field(default_factory=lambda: Path("~/notation").expanduser())
    host: str = "127.0.0.1"
    port: int = 8765
    # Required by the state-changing POST routes (focus, edit-in-Emacs), so
    # that other pages open in the browser can't trigger them.
    token: str = field(default_factory=lambda: secrets.token_urlsafe(24))
    # Path to emacsclient, or None to disable "Edit in Emacs".
    emacsclient: str | None = None
    watch: bool = True
    # Also scan a note's non-main files for notation:ID links.
    scan_attachments: bool = False
    # Tags hidden from the graph by default (mirrors `notation-find-note'
    # hiding journal notes).
    exclude_tags: tuple[str, ...] = ("journal",)
    # Org TODO keyword sequences, as on a "#+TODO:" line ("TODO NEXT | DONE").
    # notation-server.el passes `org-todo-keywords'; Org's own default otherwise.
    todo_keywords: tuple[str, ...] = ("TODO | DONE",)
