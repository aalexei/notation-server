"""Discovery of notes and the links between them.

A Python port of the conventions in notation.el: a note is a directory
named with a 14-digit id containing exactly one file whose name starts
with "__"; that file's name encodes __TITLE[--TAG1-TAG2][==ALIAS1=ALIAS2].EXT;
and notes link to each other with plain-text "notation:ID" references.
"""

from __future__ import annotations

import os
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path

ID_RE = re.compile(r"[0-9]{14}")
LINK_RE = re.compile(r"notation:([0-9]{14})")
MARKER = "__"

# Files larger than this aren't scanned for links.
MAX_SCAN_BYTES = 20 * 1024 * 1024


@dataclass(frozen=True)
class ParsedName:
    slug: str
    tags: tuple[str, ...]
    aliases: tuple[str, ...]

    @property
    def title(self) -> str:
        return self.slug.replace("_", " ")


def parse_file_name(name: str) -> ParsedName:
    """Port of `notation--parse-file-name'.

    "==" (aliases) and "--" (tags) each occur at most once as markers, since
    title, tag and alias tokens never contain "=" or "-" themselves. Aliases
    come last in the name, so they are split off first.
    """
    base = Path(name).stem if "." in name else name
    body = base[len(MARKER):] if base.startswith(MARKER) else base
    aliases: tuple[str, ...] = ()
    tags: tuple[str, ...] = ()
    if m := re.search(r"==(.+)$", body):
        aliases = tuple(a for a in m.group(1).split("=") if a)
        body = body[: m.start()]
    if m := re.search(r"--(.+)$", body):
        tags = tuple(t for t in m.group(1).split("-") if t)
        body = body[: m.start()]
    return ParsedName(slug=body, tags=tags, aliases=aliases)


def extract_link_ids(path: Path) -> list[str]:
    """Return the ids of every notation:ID link in PATH, in order, deduplicated.

    Binary files (anything containing a NUL byte, e.g. most PDFs) are
    skipped, which matches what ripgrep does for `notation-backlinks'.
    """
    try:
        if path.stat().st_size > MAX_SCAN_BYTES:
            return []
        data = path.read_bytes()
    except OSError:
        return []
    if b"\0" in data:
        return []
    text = data.decode("utf-8", errors="replace")
    return list(dict.fromkeys(LINK_RE.findall(text)))


@dataclass
class Note:
    id: str
    path: Path
    slug: str
    tags: tuple[str, ...]
    aliases: tuple[str, ...]
    ext: str
    # The filing subdirectory relative to the root, or "" at the root.
    subdir: str
    mtime: float
    links: list[str] = field(default_factory=list)

    @property
    def title(self) -> str:
        return self.slug.replace("_", " ")

    @property
    def dir(self) -> Path:
        return self.path.parent

    def summary(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "tags": list(self.tags),
            "aliases": list(self.aliases),
            "ext": self.ext,
            "subdir": self.subdir,
        }


@dataclass
class Snapshot:
    notes: dict[str, Note]
    backlinks: dict[str, list[str]]
    # Human-readable invariant violations, as `notation-doctor' reports them.
    problems: list[str]
    version: int


class NoteIndex:
    """In-memory index of a note tree.

    `rebuild` rescans the whole tree but only re-reads files whose mtime or
    size changed, so it is cheap enough to run on every file-system event.
    Readers always see a consistent snapshot, swapped in atomically.
    """

    def __init__(self, root: Path, scan_attachments: bool = False):
        self.root = root.expanduser().resolve()
        self.scan_attachments = scan_attachments
        self.snapshot = Snapshot({}, {}, [], 0)
        self._link_cache: dict[Path, tuple[int, int, list[str]]] = {}
        self._lock = threading.Lock()

    # Convenience accessors over the current snapshot.

    @property
    def notes(self) -> dict[str, Note]:
        return self.snapshot.notes

    def get(self, note_id: str) -> Note | None:
        return self.snapshot.notes.get(note_id)

    def backlinks(self, note_id: str) -> list[str]:
        return self.snapshot.backlinks.get(note_id, [])

    def attachments(self, note: Note) -> list[str]:
        """Files in the note's directory other than its main file, relative to it."""
        out = []
        for dirpath, dirnames, filenames in os.walk(note.dir):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            for name in sorted(filenames):
                p = Path(dirpath) / name
                if p != note.path and not name.startswith("."):
                    out.append(p.relative_to(note.dir).as_posix())
        return out

    # Building.

    def _links_for(self, path: Path) -> list[str]:
        try:
            st = path.stat()
        except OSError:
            return []
        cached = self._link_cache.get(path)
        if cached and cached[0] == st.st_mtime_ns and cached[1] == st.st_size:
            return cached[2]
        links = extract_link_ids(path)
        self._link_cache[path] = (st.st_mtime_ns, st.st_size, links)
        return links

    def _scan(self) -> dict[str, list[Path]]:
        """Map each id to its candidate main files; skip hidden entries like rg does."""
        found: dict[str, list[Path]] = {}
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            parent = Path(dirpath)
            if parent == self.root or not ID_RE.fullmatch(parent.name):
                continue
            for name in filenames:
                if name.startswith(MARKER):
                    found.setdefault(parent.name, []).append(parent / name)
        return found

    def rebuild(self) -> Snapshot:
        with self._lock:
            found = self._scan()
            problems: list[str] = []
            notes: dict[str, Note] = {}
            for note_id, files in sorted(found.items()):
                dirs = {f.parent for f in files}
                if len(dirs) > 1:
                    problems.append(
                        f"id {note_id} is used by {len(dirs)} directories: "
                        + ", ".join(str(d.relative_to(self.root)) for d in sorted(dirs))
                    )
                    continue
                if len(files) > 1:
                    problems.append(
                        f"note {note_id} has {len(files)} \"__\" files: "
                        + ", ".join(sorted(f.name for f in files))
                    )
                    continue
                path = files[0]
                parsed = parse_file_name(path.name)
                container = path.parent.parent
                subdir = "" if container == self.root else container.relative_to(self.root).as_posix()
                try:
                    mtime = path.stat().st_mtime
                except OSError:
                    continue
                links = self._links_for(path)
                note = Note(
                    id=note_id,
                    path=path,
                    slug=parsed.slug,
                    tags=parsed.tags,
                    aliases=parsed.aliases,
                    ext=path.suffix.lstrip("."),
                    subdir=subdir,
                    mtime=mtime,
                )
                if self.scan_attachments:
                    for rel in self.attachments(note):
                        links = links + self._links_for(note.dir / rel)
                note.links = [i for i in dict.fromkeys(links) if i != note_id]
                notes[note_id] = note

            backlinks: dict[str, list[str]] = {}
            for note in notes.values():
                for target in note.links:
                    backlinks.setdefault(target, []).append(note.id)
                    if target not in notes:
                        problems.append(f"note {note.id} links to missing note {target}")

            live = {n.path for n in notes.values()}
            self._link_cache = {
                p: v for p, v in self._link_cache.items()
                if p in live or (self.scan_attachments and p.exists())
            }
            self.snapshot = Snapshot(notes, backlinks, problems, self.snapshot.version + 1)
            return self.snapshot

    # Views.

    def graph(self, exclude_tags: set[str] | None = None) -> dict:
        snap = self.snapshot
        exclude_tags = exclude_tags or set()
        shown = {
            i: n for i, n in snap.notes.items() if not exclude_tags.intersection(n.tags)
        }
        nodes = []
        edges = []
        for note in shown.values():
            broken = [t for t in note.links if t not in snap.notes]
            nodes.append({**note.summary(), "broken": broken})
            edges.extend(
                {"source": note.id, "target": t} for t in note.links if t in shown
            )
        return {
            "version": snap.version,
            "nodes": nodes,
            "edges": edges,
            "problems": snap.problems,
        }
