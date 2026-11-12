import pytest

from notation_server.index import NoteIndex, parse_file_name

from .conftest import A, B, C, JOURNAL, MISSING


@pytest.mark.parametrize(
    "name, slug, tags, aliases",
    [
        ("__plain.org", "plain", (), ()),
        ("__two_words--a-b.org", "two_words", ("a", "b"), ()),
        ("__t==x=y.pdf", "t", (), ("x", "y")),
        ("__t--a-b==x.md", "t", ("a", "b"), ("x",)),
        ("__noext", "noext", (), ()),
        ("__archive.tar.gz", "archive.tar", (), ()),  # like file-name-base
    ],
)
def test_parse_file_name(name, slug, tags, aliases):
    parsed = parse_file_name(name)
    assert (parsed.slug, parsed.tags, parsed.aliases) == (slug, tags, aliases)


def test_parse_title_replaces_underscores():
    assert parse_file_name("__two_words.org").title == "two words"


def test_index_finds_only_valid_notes(tree):
    index = NoteIndex(tree)
    index.rebuild()
    assert set(index.notes) == {A, B, C, JOURNAL}
    alpha = index.get(A)
    assert alpha.tags == ("physics", "ideas")
    assert alpha.aliases == ("alf",)
    assert alpha.subdir == ""
    assert index.get(B).subdir == "projects/x"
    assert index.get(JOURNAL).subdir == "journal/2026"


def test_links_and_backlinks(tree):
    index = NoteIndex(tree)
    index.rebuild()
    assert index.get(A).links == [B, MISSING]
    assert index.get(B).links == [A]
    assert index.get(C).links == []  # binary file not scanned
    assert sorted(index.backlinks(A)) == [B]
    assert index.backlinks(C) == [JOURNAL]


def test_problems_reported(tree):
    index = NoteIndex(tree)
    snap = index.rebuild()
    assert any("20260104120000" in p and "2 \"__\" files" in p for p in snap.problems)
    assert any(MISSING in p for p in snap.problems)


def test_graph_excludes_tags_and_broken_edges(tree):
    index = NoteIndex(tree)
    index.rebuild()
    g = index.graph({"journal"})
    assert {n["id"] for n in g["nodes"]} == {A, B, C}
    assert {(e["source"], e["target"]) for e in g["edges"]} == {(A, B), (B, A)}
    alpha = next(n for n in g["nodes"] if n["id"] == A)
    assert alpha["broken"] == [MISSING]


def test_rebuild_picks_up_edits(tree):
    index = NoteIndex(tree)
    index.rebuild()
    beta = index.get(B).path
    beta.write_text(f"Now links to notation:{C}\n")
    index.rebuild()
    assert index.get(B).links == [C]
    assert index.backlinks(A) == []


def test_attachments(tree):
    index = NoteIndex(tree)
    index.rebuild()
    assert index.attachments(index.get(A)) == ["plot.png"]


def test_scan_attachments(tree):
    (tree / "projects" / "x" / B / "extra.txt").write_text(f"notation:{C}")
    assert NoteIndex(tree).rebuild().notes[B].links == [A]
    index = NoteIndex(tree, scan_attachments=True)
    index.rebuild()
    assert index.get(B).links == [A, C]
