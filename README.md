# notation-server

Experimental: browse a [notation](../notation) note tree in the browser as
a 3D graph of linked notes. Clicking a note renders it (Org and Markdown via
pandoc, PDFs and images inline, other text syntax highlighted), with a
small graph of the notes it links to and from, and its attachments.

The server is read-only and listens on localhost only.

## Running

```sh
uv run notation-server --dir ~/notation        # http://127.0.0.1:8765/
```

Needs [uv](https://docs.astral.sh/uv/) and, for Org/Markdown rendering,
`pandoc` on PATH. The page loads 3d-force-graph, Cytoscape.js and HTMX
from unpkg.

## Searching

The search box is the one place the graph is filtered. Terms combine:

| Term | |
|---|---|
| `word` | highlight notes whose title, aliases or id contain every word, in any order |
| `#tag` | only notes with this tag |
| `-#tag` | hide notes with this tag |
| `~#tag` | collapse notes with this tag into one node |
| `2026..` `..202609` `20260901..20260930` | only notes created in a range of id beginnings (`YYYYMMDDhhmmss`); either end open |

Folders count as tags ending in `/`, one per level: a note filed in
`journal/2025` has the tags `journal/` and `journal/2025/`. A note's
colour comes from its first tag. Clicking a legend entry adds or removes
`-#tag`; shift-clicking adds or removes `~#tag`. The tags given with
`--exclude-tags` (default `journal`) start out as `-#tag`.

## From Emacs

```elisp
(add-to-list 'load-path "~/projects/notation-server")
(require 'notation-server)   ; needs notation.el loaded
(server-start)               ; for the "Edit in Emacs" button
```

- `M-x notation-server-start` / `notation-server-stop`
- `M-x notation-server-browse`: show the current note in the open tab
- `M-x notation-server-follow-mode`: keep the graph on the note you're visiting

`notation-server-start` passes your `org-todo-keywords` along, so Org
headings show your own keywords. Without Emacs, give each sequence with
`--todo-keywords "TODO NEXT | DONE"`.

## Tracking notation.el

`src/notation_server/index.py` re-implements notation.el's conventions in
Python, currently as of **notation 0.3.2**:

- a note is a 14-digit id directory containing one `__` file
- file names are `__TITLE[--TAG1-TAG2][==ALIAS1=ALIAS2].EXT`
- links are plain-text `notation:ID`

`notation-server.el` also calls two internal notation helpers,
`notation--note-file-p` and `notation--id-from-file`. If either side
changes, update the parser tests in `tests/test_index.py` first.

## Tests

```sh
uv run pytest
```
