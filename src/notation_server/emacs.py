"""Browser -> Emacs: open notes with emacsclient, guarded by the launch token."""

from __future__ import annotations

import asyncio
import secrets
from pathlib import Path

from fastapi import Header, HTTPException, Request

TOKEN_HEADER = "X-Notation-Token"


def require_token(request: Request, x_notation_token: str | None = Header(default=None)) -> None:
    """FastAPI dependency: reject requests that don't carry the launch token."""
    expected = request.app.state.settings.token
    if not x_notation_token or not secrets.compare_digest(x_notation_token, expected):
        raise HTTPException(status_code=403, detail="missing or invalid token")


async def open_in_emacs(emacsclient: str, path: Path, timeout: float = 10) -> None:
    """Run `emacsclient -n PATH` (no shell); raise RuntimeError on failure."""
    proc = await asyncio.create_subprocess_exec(
        emacsclient, "-n", str(path),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        raise RuntimeError("emacsclient timed out; is the Emacs server running?") from None
    if proc.returncode != 0:
        msg = stderr.decode(errors="replace").strip()
        raise RuntimeError(msg or f"emacsclient exited {proc.returncode}")
