from pathlib import Path

import pytest

A = "20260101120000"
B = "20260102120000"
C = "20260103120000"
JOURNAL = "20260105090000"
MISSING = "20991231235959"


def write(path: Path, content: str | bytes = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content)
    return path


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    """A small note tree covering the cases the index has to handle."""
    root = tmp_path / "notes"
    write(root / A / "__alpha_note--physics-ideas==alf.org",
          f"#+title: Alpha\nSee [[notation:{B}][Beta]] and notation:{MISSING}.\n[[file:plot.png]]\n")
    write(root / A / "plot.png", b"\x89PNG\r\n\x1a\n\0")
    write(root / "projects" / "x" / B / "__beta.md", f"Back to [Alpha](notation:{A}).\n")
    # A PDF: binary, so links inside it are ignored.
    write(root / C / "__gamma_paper--physics.pdf", b"%PDF-1.4\0 notation:" + A.encode())
    write(root / "journal" / "2026" / JOURNAL / "__2026_w02--journal.org",
          f"* 2026-01-05 Monday\nRead notation:{C}\n")
    # Invariant violations.
    write(root / "20260104120000" / "__one.org")
    write(root / "20260104120000" / "__two.org")
    # Not notes: wrong directory name, hidden directory, no marker.
    write(root / "misc" / "__stray.org", f"notation:{A}")
    write(root / ".trash" / "20260106120000" / "__hidden.org")
    write(root / "20260107120000" / "readme.org")
    return root
