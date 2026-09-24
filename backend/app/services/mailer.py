"""E-Mails per SMTP — bisher nur fuer "Passwort vergessen" und die Info nach
einem Passwortwechsel. Standardbibliothek, kein Mail-Dienst-SDK: jedes
Postfach mit SMTP-Zugang taugt (produktiv ein Strato-Postfach)."""
from __future__ import annotations

import asyncio
import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

from app.core.config import settings

logger = logging.getLogger(__name__)


def _send_blocking(to: str, subject: str, text: str) -> None:
    msg = EmailMessage()
    msg["From"] = settings.smtp_from or settings.smtp_user
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=(settings.smtp_from or "budgetpal").split("@")[-1])
    msg.set_content(text)

    context = ssl.create_default_context()
    if settings.smtp_port == 465:
        server = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, context=context, timeout=20)
    else:
        server = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20)
        server.starttls(context=context)
    with server:
        if settings.smtp_user:
            server.login(settings.smtp_user, settings.smtp_password)
        server.send_message(msg)


async def send_mail(to: str, subject: str, text: str) -> None:
    """Verschickt eine Klartext-Mail. Wirft nie: laeuft als Hintergrundaufgabe,
    ein Fehler landet im Log statt beim Nutzer."""
    if not settings.smtp_host:
        if settings.is_development:
            # Lokal ohne Postfach: Inhalt ins Log, damit der Link testbar ist
            logger.warning("Kein SMTP konfiguriert — Mail an %s:\n%s\n%s", to, subject, text)
        else:
            logger.warning("Kein SMTP konfiguriert — Mail an %s nicht versendet (%s)", to, subject)
        return
    try:
        await asyncio.to_thread(_send_blocking, to, subject, text)
    except Exception as e:
        # Kein Mailinhalt ins Log: er kann einen Reset-Link enthalten
        logger.error("Mail an %s fehlgeschlagen: %s: %s", to, type(e).__name__, e)
