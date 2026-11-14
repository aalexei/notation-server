"""Turn a note's main file into something the browser can show.

Org and Markdown go through pandoc (behind the `Renderer` protocol, so an
Emacs `ox-html' backend can be swapped in later); PDFs and images are
shown natively by the browser; other text is syntax highlighted.
"""

from __future__ import annotations

import html
import re
import shutil
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

from pygments import highlight
from pygments.formatters import HtmlFormatter
from pygments.lexers import TextLexer, guess_lexer_for_filename
from pygments.util import ClassNotFound

from .index import Note

LUA_FILTER = Path(__file__).parent / "static" / "notation-links.lua"

PANDOC_FORMATS = {"org": "org", "md": "markdown", "markdown": "markdown"}
IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "bmp"}
# Above this, text files are offered for download instead of highlighted.
MAX_HIGHLIGHT_BYTES = 2 * 1024 * 1024

ViewKind = Literal["html", "pdf", "image", "download"]


@dataclass
class View:
    kind: ViewKind
    # Rendered HTML fragment, for kind == "html".
    html: str = ""
    # Shown above the content, e.g. "pandoc not found; showing source".
    notice: str = ""


class Renderer(Protocol):
    def can_render(self, note: Note) -> bool: ...

    def render(self, note: Note) -> str:
        """Return an HTML fragment for NOTE's main file."""
        ...


class RenderError(Exception):
    pass


# "#+STARTUP:" options that open an Org file with its headings folded.
FOLDED_STARTUP = re.compile(r"^#\+startup:.*\b(overview|fold|content)\b", re.IGNORECASE | re.MULTILINE)


class PandocRenderer:
    # Some Org constructs (long runs of underscores in babel output) make
    # pandoc's Org reader take seconds; past this, the source is shown instead.
    def __init__(self, pandoc: str | None = None, timeout: float = 15,
                 todo_keywords: tuple[str, ...] = ("TODO | DONE",)):
        self.pandoc = pandoc or shutil.which("pandoc")
        self.timeout = timeout
        # Pandoc only knows the keywords declared in the file itself, so
        # Org files get the configured ones prepended. Also turn on planning
        # lines (SCHEDULED, DEADLINE, CLOSED), and only take a_{b}, not
        # a_b, as a subscript: underscores in names are common in notes.
        self.org_preamble = "#+OPTIONS: p:t ^:{}\n" + "".join(f"#+TODO: {seq}\n" for seq in todo_keywords)

    def can_render(self, note: Note) -> bool:
        return self.pandoc is not None and note.ext.lower() in PANDOC_FORMATS

    def render(self, note: Note) -> str:
        assert self.pandoc
        fmt = PANDOC_FORMATS[note.ext.lower()]
        cmd = [
            self.pandoc,
            "--from", fmt,
            "--to", "html5",
            "--wrap", "none",
            # Only read the input: no network fetches, no #+include.
            "--sandbox",
            "--metadata", f"notation_id={note.id}",
            "--lua-filter", str(LUA_FILTER),
        ]
        stdin = None
        if fmt == "org":
            try:
                text = note.path.read_bytes().decode("utf-8", errors="replace")
            except OSError as e:
                raise RenderError(str(e)) from e
            if FOLDED_STARTUP.search(text):
                cmd += ["--metadata", "notation_folded=true"]
            stdin = self.org_preamble + text
        else:
            cmd.append(str(note.path))
        try:
            proc = subprocess.run(cmd, input=stdin, capture_output=True, encoding="utf-8",
                                  errors="replace", timeout=self.timeout)
        except subprocess.TimeoutExpired as e:
            raise RenderError(f"pandoc timed out after {self.timeout}s") from e
        if proc.returncode != 0:
            raise RenderError(proc.stderr.strip() or f"pandoc exited {proc.returncode}")
        return proc.stdout


class ViewBuilder:
    """Picks a view by file extension and caches rendered HTML by mtime."""

    def __init__(self, renderer: Renderer | None = None):
        self.renderer = renderer or PandocRenderer()
        self._formatter = HtmlFormatter(cssclass="highlight")
        self._cache: dict[Path, tuple[int, View]] = {}
        self._lock = threading.Lock()

    @property
    def highlight_css(self) -> str:
        return self._formatter.get_style_defs(".highlight")

    def view(self, note: Note) -> View:
        ext = note.ext.lower()
        if ext == "pdf":
            return View("pdf")
        if ext in IMAGE_EXTS:
            return View("image")
        try:
            mtime = note.path.stat().st_mtime_ns
        except OSError:
            return View("download", notice="File is no longer on disk.")
        with self._lock:
            cached = self._cache.get(note.path)
        if cached and cached[0] == mtime:
            return cached[1]
        result = self._build(note, ext)
        with self._lock:
            self._cache[note.path] = (mtime, result)
        return result

    def _build(self, note: Note, ext: str) -> View:
        notice = ""
        if self.renderer.can_render(note):
            try:
                return View("html", self.renderer.render(note))
            except RenderError as e:
                notice = f"Rendering failed, showing source: {e}"
        elif ext in PANDOC_FORMATS:
            notice = "pandoc not found; showing source."
        if ext == "ipynb":
            if (body := _render_notebook(note.path)) is not None:
                return View("html", body)
        source = self._highlight(note.path)
        if source is None:
            return View("download", notice=notice)
        return View("html", source, notice)

    def _highlight(self, path: Path) -> str | None:
        try:
            if path.stat().st_size > MAX_HIGHLIGHT_BYTES:
                return None
            data = path.read_bytes()
        except OSError:
            return None
        if b"\0" in data:
            return None
        text = data.decode("utf-8", errors="replace")
        try:
            lexer = guess_lexer_for_filename(path.name, text)
        except ClassNotFound:
            lexer = TextLexer()
        return highlight(text, lexer, self._formatter)


def _render_notebook(path: Path) -> str | None:
    try:
        from nbconvert import HTMLExporter
    except ImportError:
        return None
    try:
        body, _ = HTMLExporter(template_name="basic").from_filename(str(path))
    except Exception as e:  # nbconvert raises a wide variety of errors
        return f"<p class='notice'>Notebook rendering failed: {html.escape(str(e))}</p>"
    return body
