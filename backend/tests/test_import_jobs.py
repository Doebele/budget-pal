"""
Budget-Pal Backend — PDF-Import als Hintergrundjob

Der synchrone Weg haelt den Request minutenlang offen. Hier wird ein ImportLog
als Job angelegt, im Hintergrund gefuellt und per Polling abgefragt.

Der Hintergrundlauf oeffnet bewusst eine EIGENE DB-Session (die des Requests
ist zu, sobald die Antwort raus ist). In den Tests wird diese Factory auf die
Test-Session umgebogen — sonst liefe der Job gegen eine andere Datenbank.
"""

from contextlib import asynccontextmanager
from unittest.mock import patch

import pytest

from app.models.models import ImportLog, ImportStatus

MINIMAL_PDF_LINES = [
    "Musterbank Kontoauszug 03/2026",
    "03.03.2026  Coop Pronto Zuerich           12.50",
    "05.03.2026  SBB Ticket                    34.00",
]


def build_pdf(path: str) -> None:
    """Gueltiges Minimal-PDF ohne Zusatzbibliothek."""
    content = "BT /F1 9 Tf 40 780 Td 12 TL\n"
    for line in MINIMAL_PDF_LINES:
        content += f"({line}) Tj T*\n"
    content += "ET"
    stream = content.encode("latin-1")
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objs) + 1,
        xref,
    )
    open(path, "wb").write(bytes(out))


@pytest.fixture
def pdf_bytes(tmp_path):
    path = tmp_path / "auszug.pdf"
    build_pdf(str(path))
    return path.read_bytes()


@pytest.fixture
def background_session(db_session):
    """Die Session-Factory des Hintergrundlaufs auf die Test-Session umbiegen."""

    @asynccontextmanager
    async def _factory():
        yield db_session

    with patch("app.core.database.AsyncSessionLocal", lambda: _factory()):
        yield db_session


class TestStartJob:
    def test_returns_202_with_import_id(self, client, test_account, pdf_bytes, background_session):
        response = client.post(
            "/api/imports/pdf/preview-async",
            files={"file": ("auszug.pdf", pdf_bytes, "application/pdf")},
            data={"account_id": str(test_account.id)},
        )
        assert response.status_code == 202
        body = response.json()
        assert body["import_id"] > 0
        assert body["filename"] == "auszug.pdf"

    def test_rejects_foreign_account(self, client, pdf_bytes):
        response = client.post(
            "/api/imports/pdf/preview-async",
            files={"file": ("auszug.pdf", pdf_bytes, "application/pdf")},
            data={"account_id": "999999"},
        )
        assert response.status_code == 404

    def test_job_record_is_created(self, client, test_account, pdf_bytes, background_session):
        response = client.post(
            "/api/imports/pdf/preview-async",
            files={"file": ("auszug.pdf", pdf_bytes, "application/pdf")},
            data={"account_id": str(test_account.id)},
        )
        job = client.get(f"/api/imports/jobs/{response.json()['import_id']}")
        assert job.status_code == 200
        body = job.json()
        # TestClient fuehrt Background-Tasks vor der Antwort aus — der Lauf ist durch
        assert body["status"] == "completed", body.get("error_message")
        assert body["error_message"] is None
        # Ergebnis liegt am Job und hat die Form der synchronen Vorschau
        assert body["result"] is not None
        assert body["result"]["filename"] == "auszug.pdf"
        assert isinstance(body["result"]["rows"], list)

    def test_result_matches_synchronous_preview(
        self, client, test_account, pdf_bytes, background_session
    ):
        """Beide Wege muessen dieselben Zeilen liefern — sonst haengt die
        Vorschau davon ab, welchen Weg der Nutzer erwischt hat."""
        started = client.post(
            "/api/imports/pdf/preview-async",
            files={"file": ("auszug.pdf", pdf_bytes, "application/pdf")},
            data={"account_id": str(test_account.id)},
        )
        from_job = client.get(
            f"/api/imports/jobs/{started.json()['import_id']}"
        ).json()["result"]

        sync = client.post(
            "/api/imports/pdf/preview",
            files={"file": ("auszug.pdf", pdf_bytes, "application/pdf")},
            data={"account_id": str(test_account.id)},
        ).json()

        assert from_job["total_rows"] == sync["total_rows"]
        assert [(r["original_date"], r["amount"], r["description"]) for r in from_job["rows"]] == [
            (r["original_date"], r["amount"], r["description"]) for r in sync["rows"]
        ]


class TestJobStatus:
    def test_unknown_job_is_404(self, client):
        assert client.get("/api/imports/jobs/999999").status_code == 404

    async def test_foreign_job_is_404(self, client, db_session, test_user_2):
        """Ein Job eines anderen Nutzers darf nicht sichtbar sein."""
        foreign = ImportLog(
            user_id=test_user_2.id,
            filename="fremd.pdf",
            file_type="pdf",
            status=ImportStatus.completed,
        )
        db_session.add(foreign)
        await db_session.flush()

        assert client.get(f"/api/imports/jobs/{foreign.id}").status_code == 404


class TestStaleJobCleanup:
    """Ein Neustart mitten im Lauf darf keinen ewig drehenden Indikator
    hinterlassen — beim Start werden haengende Jobs als gescheitert markiert."""

    async def test_marks_running_jobs_as_failed(self, db_session, test_user):
        from app.api.imports import fail_stale_import_jobs

        for status_value in (ImportStatus.pending, ImportStatus.processing):
            db_session.add(
                ImportLog(
                    user_id=test_user.id,
                    filename=f"{status_value.value}.pdf",
                    file_type="pdf",
                    status=status_value,
                )
            )
        done = ImportLog(
            user_id=test_user.id,
            filename="fertig.pdf",
            file_type="pdf",
            status=ImportStatus.completed,
        )
        db_session.add(done)
        await db_session.flush()

        cleaned = await fail_stale_import_jobs(db_session)
        assert cleaned == 2

        await db_session.refresh(done)
        # Abgeschlossene Jobs bleiben unangetastet
        assert done.status == ImportStatus.completed

    async def test_is_idempotent(self, db_session, test_user):
        from app.api.imports import fail_stale_import_jobs

        assert await fail_stale_import_jobs(db_session) == 0


class TestActiveJob:
    def test_none_when_nothing_runs(self, client):
        response = client.get("/api/imports/jobs/active")
        assert response.status_code == 200
        assert response.json() is None

    async def test_reports_running_job(self, client, db_session, test_user):
        log = ImportLog(
            user_id=test_user.id,
            filename="laeuft.pdf",
            file_type="pdf",
            status=ImportStatus.processing,
            preview_json={"progress": {"done": 1, "total": 4}},
        )
        db_session.add(log)
        await db_session.flush()

        body = client.get("/api/imports/jobs/active").json()
        assert body is not None
        assert body["status"] == "processing"
        assert (body["chunks_done"], body["chunks_total"]) == (1, 4)

    async def test_completed_job_is_not_active(self, client, db_session, test_user):
        db_session.add(
            ImportLog(
                user_id=test_user.id,
                filename="fertig.pdf",
                file_type="pdf",
                status=ImportStatus.completed,
            )
        )
        await db_session.flush()
        assert client.get("/api/imports/jobs/active").json() is None
