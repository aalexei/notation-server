import shutil
from pathlib import Path

import pytest

from notation_server.cli import main
from notation_server.index import Note
from notation_server.render import PandocRenderer

pytestmark = pytest.mark.skipif(shutil.which("pandoc") is None, reason="pandoc not installed")

ID = "20260101120000"
ORG = """\
#+title: Tasks
* WAITING [#A] Reply to Bob :work:email:
SCHEDULED: <2026-11-20 Fri>
Waiting on notation:20260102120000.
** DONE Draft
CLOSED: [2026-11-10 Tue 10:00]
Drafted.
** MEET Weekly
* Empty heading
"""


def render(tmp_path: Path, text: str, **kw) -> str:
    path = tmp_path / ID / "__tasks.org"
    path.parent.mkdir(parents=True)
    path.write_text(text)
    note = Note(id=ID, path=path, slug="tasks", tags=(), aliases=(), ext="org", subdir="", mtime=0)
    return PandocRenderer(**kw).render(note)


def test_attachment_links_point_next_to_the_note(tmp_path):
    html = render(tmp_path, "[[attachment:plot.png]] and [[attachment:paper v2.pdf][the paper]]\n")
    assert f'<img src="/files/{ID}/plot.png"' in html
    assert f'href="/files/{ID}/paper v2.pdf">the paper</a>' in html
    assert "attachment:" not in html


def test_configured_keywords_become_pills(tmp_path):
    html = render(tmp_path, ORG, todo_keywords=("TODO WAITING | DONE", "MEET |"))
    assert 'class="todo WAITING keyword" style="--kw: var(--series-4)"' in html
    assert 'class="done DONE keyword"' in html
    assert 'class="todo MEET keyword"' in html


def test_unconfigured_keyword_stays_text(tmp_path):
    html = render(tmp_path, ORG)
    assert "WAITING keyword" not in html
    assert "WAITING" in html


def test_heading_priority_tags_and_planning(tmp_path):
    html = render(tmp_path, ORG, todo_keywords=("WAITING | DONE",))
    assert 'class="priority priority-A"' in html and "[#A]" not in html
    assert '<span class="tags"><span class="tag">work</span><span class="tag">email</span></span>' in html
    assert '<div class="planning">' in html and "SCHEDULED:" in html
    # Links are still rewritten inside sections.
    assert 'href="/note/20260102120000"' in html


def test_sections_fold(tmp_path):
    html = render(tmp_path, ORG, todo_keywords=("WAITING | DONE", "MEET |"))
    assert '<details class="section level1" id="a-reply-to-bob" open>' in html
    # Done subtrees start folded; headings without a body can't fold.
    assert '<details class="section level2" id="draft">' in html
    assert '<details class="section level1 empty" id="empty-heading" open>' in html


def test_startup_overview_folds_everything(tmp_path):
    html = render(tmp_path, "#+STARTUP: overview\n" + ORG)
    assert '<details class="section level1" id="waiting-a-reply-to-bob">' in html


def test_cli_passes_todo_keywords(monkeypatch, tmp_path):
    seen = []
    monkeypatch.setattr("notation_server.cli.create_app", seen.append)
    monkeypatch.setattr("notation_server.cli.uvicorn.run", lambda *a, **k: None)
    main(["--dir", str(tmp_path), "--todo-keywords", "TODO | DONE", "--todo-keywords", "MEET |"])
    main(["--dir", str(tmp_path)])
    assert [s.todo_keywords for s in seen] == [("TODO | DONE", "MEET |"), ("TODO | DONE",)]
