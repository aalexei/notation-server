import shutil
import stat
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from notation_server.app import create_app
from notation_server.config import Settings

from .conftest import A, B, C, JOURNAL

TOKEN = "test-token"
AUTH = {"X-Notation-Token": TOKEN}


def make_client(tree: Path, **kw) -> TestClient:
    settings = Settings(root=tree, token=TOKEN, watch=False, **kw)
    return TestClient(create_app(settings))


@pytest.fixture
def client(tree):
    with make_client(tree) as c:
        yield c


def test_graph_default_hides_journal(client):
    g = client.get("/api/graph").json()
    assert JOURNAL not in {n["id"] for n in g["nodes"]}
    assert len(g["edges"]) == 2


def test_graph_without_exclusions(client):
    g = client.get("/api/graph", params={"exclude_tags": ""}).json()
    assert {n["id"] for n in g["nodes"]} == {A, B, C, JOURNAL}
    assert {"source": JOURNAL, "target": C} in g["edges"]


def test_note_metadata(client):
    data = client.get(f"/api/notes/{A}").json()
    assert data["title"] == "alpha note"
    assert data["backlinks"] == [B]
    assert data["attachments"] == ["plot.png"]


def test_bad_and_unknown_ids(client):
    assert client.get("/api/notes/123").status_code == 422
    assert client.get("/api/notes/20000101000000").status_code == 404


def test_pages(client):
    assert client.get("/").status_code == 200
    page = client.get(f"/note/{A}")
    assert page.status_code == 200
    assert f'"initialId": "{A}"' in page.text


@pytest.mark.skipif(shutil.which("pandoc") is None, reason="pandoc not installed")
def test_org_view_rewrites_links(client):
    html = client.get(f"/note/{A}/view").text
    assert f'href="/note/{B}"' in html
    assert f'src="/files/{A}/plot.png"' in html
    assert "Backlinks" in html


def test_pdf_view_embeds_file(client):
    html = client.get(f"/note/{C}/view").text
    assert "<iframe" in html and f"/files/{C}/__gamma_paper--physics.pdf" in html


def test_files_served_inline(client):
    r = client.get(f"/files/{C}/__gamma_paper--physics.pdf")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers["content-disposition"].startswith("inline")


# Encoded, because the HTTP client would normalise a literal "../" away.
@pytest.mark.parametrize("rel", ["..%2F..%2Fmisc%2F__stray.org", "%2E%2E%2F" + C + "%2F__gamma_paper--physics.pdf",
                                 "nope.txt"])
def test_files_cannot_escape_note_dir(client, rel):
    assert client.get(f"/files/{A}/{rel}").status_code == 404


def test_files_subpath_within_note_dir(client):
    # The same encoding does reach files that are inside the note dir.
    assert client.get(f"/files/{A}/.%2Fplot.png").status_code == 200


def test_foreign_host_rejected(client):
    assert client.get("/", headers={"Host": "evil.example"}).status_code == 400


def test_focus_requires_token(client):
    assert client.post("/api/focus", json={"id": A}).status_code == 403
    assert client.post("/api/focus", json={"id": A}, headers={"X-Notation-Token": "x"}).status_code == 403
    r = client.post("/api/focus", json={"id": A}, headers=AUTH)
    assert r.json() == {"listeners": 0}


def test_focus_publishes_event(client):
    broker = client.app.state.broker
    seen = []
    broker._queues.add(type("Q", (), {"put_nowait": staticmethod(seen.append)})())
    assert client.post("/api/focus", json={"id": A}, headers=AUTH).json() == {"listeners": 1}
    assert seen == [f'event: focus\ndata: {{"id": "{A}"}}\n\n']


def test_edit_disabled_without_emacsclient(client):
    assert client.post(f"/api/notes/{A}/edit", headers=AUTH).status_code == 501


def test_edit_runs_emacsclient(tree, tmp_path):
    log = tmp_path / "args.txt"
    fake = tmp_path / "bin" / "emacsclient"
    fake.parent.mkdir()
    fake.write_text(f'#!/bin/sh\nprintf "%s\\n" "$@" > "{log}"\n')
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    with make_client(tree, emacsclient=str(fake)) as c:
        assert c.post(f"/api/notes/{A}/edit").status_code == 403
        r = c.post(f"/api/notes/{A}/edit", headers=AUTH)
        assert r.status_code == 200
    args = log.read_text().splitlines()
    assert args[0] == "-n"
    assert args[1].endswith(f"{A}/__alpha_note--physics-ideas==alf.org")


def test_edit_reports_emacsclient_failure(tree, tmp_path):
    fake = tmp_path / "emacsclient"
    fake.write_text('#!/bin/sh\necho "can\'t find socket" >&2\nexit 1\n')
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    with make_client(tree, emacsclient=str(fake)) as c:
        r = c.post(f"/api/notes/{A}/edit", headers=AUTH)
    assert r.status_code == 502
    assert "socket" in r.json()["detail"]
