"""FastAPI application: graph page, note views, raw files, events, Emacs hooks."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Path as PathParam, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import Settings
from .emacs import TOKEN_HEADER, open_in_emacs, require_token
from .events import EventBroker
from .index import Note, NoteIndex
from .render import ViewBuilder

log = logging.getLogger("notation_server")

HERE = Path(__file__).parent
NoteId = Annotated[str, PathParam(pattern=r"^[0-9]{14}$")]


class FocusRequest(BaseModel):
    id: str = Field(pattern=r"^[0-9]{14}$")


async def _watch(index: NoteIndex, broker: EventBroker, stop: asyncio.Event) -> None:
    from watchfiles import awatch

    async for _changes in awatch(index.root, stop_event=stop, debounce=300):
        try:
            snap = await asyncio.to_thread(index.rebuild)
        except Exception:
            log.exception("index rebuild failed")
            continue
        broker.publish("index-changed", {"version": snap.version})


def create_app(settings: Settings) -> FastAPI:
    index = NoteIndex(settings.root, scan_attachments=settings.scan_attachments)
    views = ViewBuilder()
    broker = EventBroker()
    templates = Jinja2Templates(directory=HERE / "templates")

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        await asyncio.to_thread(index.rebuild)
        stop = asyncio.Event()
        task = asyncio.create_task(_watch(index, broker, stop)) if settings.watch else None
        try:
            yield
        finally:
            stop.set()
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    app = FastAPI(title="notation-server", lifespan=lifespan)
    # Refuse foreign Host headers so a DNS-rebinding page can't read the
    # token out of the graph page.
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=sorted({"127.0.0.1", "localhost", "::1", settings.host, "testserver"}),
    )
    app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
    app.state.settings = settings
    app.state.index = index
    app.state.broker = broker

    def note_or_404(note_id: str) -> Note:
        note = index.get(note_id)
        if note is None:
            raise HTTPException(404, f"no note with id {note_id}")
        return note

    def page(request: Request, initial_id: str | None) -> HTMLResponse:
        return templates.TemplateResponse(
            request,
            "graph.html",
            {
                "config": {
                    "token": settings.token,
                    "tokenHeader": TOKEN_HEADER,
                    "initialId": initial_id,
                    "excludeTags": list(settings.exclude_tags),
                    "emacs": settings.emacsclient is not None,
                },
                "highlight_css": views.highlight_css,
                "token_header": TOKEN_HEADER,
                "token": settings.token,
            },
        )

    # Pages.

    @app.get("/", response_class=HTMLResponse)
    def graph_page(request: Request):
        return page(request, None)

    @app.get("/note/{note_id}", response_class=HTMLResponse)
    def note_page(request: Request, note_id: NoteId):
        note_or_404(note_id)
        return page(request, note_id)

    @app.get("/note/{note_id}/view", response_class=HTMLResponse)
    def note_view(request: Request, note_id: NoteId):
        # Sync route: FastAPI runs it in a worker thread, so pandoc doesn't
        # block the event loop.
        note = note_or_404(note_id)
        snap = index.snapshot
        return templates.TemplateResponse(
            request,
            "note_panel.html",
            {
                "note": note,
                "view": views.view(note),
                "links": [snap.notes.get(i) or i for i in note.links],
                "backlinks": [snap.notes[i] for i in index.backlinks(note_id) if i in snap.notes],
                "attachments": index.attachments(note),
                "emacs": settings.emacsclient is not None,
                "main_file": note.path.name,
            },
        )

    # JSON API.

    @app.get("/api/graph")
    def api_graph(exclude_tags: str | None = None):
        tags = settings.exclude_tags if exclude_tags is None else exclude_tags.split(",")
        return index.graph({t.strip() for t in tags if t.strip()})

    @app.get("/api/notes/{note_id}")
    def api_note(note_id: NoteId):
        note = note_or_404(note_id)
        return {
            **note.summary(),
            "path": str(note.path.relative_to(index.root)),
            "mtime": note.mtime,
            "links": note.links,
            "backlinks": index.backlinks(note_id),
            "attachments": index.attachments(note),
        }

    @app.get("/files/{note_id}/{relpath:path}")
    def note_file(note_id: NoteId, relpath: str):
        note = note_or_404(note_id)
        base = note.dir.resolve()
        target = (base / relpath).resolve()
        if not target.is_relative_to(base) or not target.is_file():
            raise HTTPException(404, "no such file in this note")
        # Inline so PDFs and images display rather than download.
        return FileResponse(target, filename=target.name, content_disposition_type="inline")

    @app.get("/events")
    async def events(request: Request):
        async def stream():
            async for message in broker.subscribe():
                if await request.is_disconnected():
                    break
                yield message

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # Emacs integration.

    @app.post("/api/focus", dependencies=[Depends(require_token)])
    def api_focus(body: FocusRequest):
        note_or_404(body.id)
        return {"listeners": broker.publish("focus", {"id": body.id})}

    @app.post("/api/notes/{note_id}/edit", dependencies=[Depends(require_token)])
    async def api_edit(note_id: NoteId):
        if settings.emacsclient is None:
            raise HTTPException(501, "editing in Emacs is not enabled")
        note = note_or_404(note_id)
        try:
            await open_in_emacs(settings.emacsclient, note.path)
        except (RuntimeError, OSError) as e:
            raise HTTPException(502, str(e)) from e
        return {"opened": str(note.path)}

    return app
