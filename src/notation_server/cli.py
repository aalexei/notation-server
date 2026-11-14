"""Command line entry point: `notation-server --dir ~/notation`."""

from __future__ import annotations

import argparse
import os
import secrets
import shutil
import sys
from pathlib import Path

import uvicorn

from .app import create_app
from .config import Settings

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="notation-server", description=__doc__)
    p.add_argument("--dir", default="~/notation", help="notation root directory (default: %(default)s)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--emacsclient", help="path to emacsclient (default: found on PATH)")
    p.add_argument("--no-emacs", action="store_true", help="disable the Edit in Emacs button")
    p.add_argument("--no-watch", action="store_true", help="don't watch the tree for changes")
    p.add_argument("--scan-attachments", action="store_true",
                   help="also take links from a note's non-main files")
    p.add_argument("--exclude-tags", default="journal",
                   help="comma-separated tags hidden by default (default: %(default)s)")
    p.add_argument("--todo-keywords", action="append", metavar="SEQUENCE",
                   help='an Org TODO sequence as on a #+TODO line, e.g. "TODO NEXT | DONE"; '
                        'repeat for several (default: "TODO | DONE")')
    args = p.parse_args(argv)

    root = Path(args.dir).expanduser()
    if not root.is_dir():
        p.error(f"{root} is not a directory")
    if args.host not in LOCAL_HOSTS:
        print(f"warning: listening on {args.host}; notes will be readable from the network",
              file=sys.stderr)

    emacsclient = None if args.no_emacs else (args.emacsclient or shutil.which("emacsclient"))
    # notation-server.el passes its own token so it can call the POST routes.
    token = os.environ.get("NOTATION_SERVER_TOKEN") or secrets.token_urlsafe(24)
    settings = Settings(
        root=root,
        host=args.host,
        port=args.port,
        token=token,
        emacsclient=emacsclient,
        watch=not args.no_watch,
        scan_attachments=args.scan_attachments,
        exclude_tags=tuple(t for t in args.exclude_tags.split(",") if t),
        **({"todo_keywords": tuple(args.todo_keywords)} if args.todo_keywords else {}),
    )
    if "NOTATION_SERVER_TOKEN" not in os.environ:
        print(f"notation-server token: {token}", file=sys.stderr)
    print(f"notation-server: serving {root} at http://{args.host}:{args.port}/", file=sys.stderr)
    uvicorn.run(create_app(settings), host=args.host, port=args.port,
                timeout_graceful_shutdown=2, log_level="warning")


if __name__ == "__main__":
    main()
