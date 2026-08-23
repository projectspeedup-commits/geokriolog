"""Мост «почта → Twenty CRM» для НПО ГЕОКРИОЛОГ.

Читает почтовый ящик info@geokriolog.ru по IMAP, находит письма-заявки
с сайта, создаёт в Twenty контакт и сделку, прикладывает текст заявки
заметкой и убирает письмо в папку CRM, чтобы не обработать его дважды.

Работает на стандартной библиотеке Python — ставить ничего не нужно.
Настройки берутся из файла .env рядом со скриптом; секреты в код
не попадают и в лог не печатаются.

Запуск вручную:      python leads_bridge.py
Проверка без записи: python leads_bridge.py --dry-run
"""

import email
import imaplib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from email.header import decode_header, make_header

# консоль Windows по умолчанию не utf-8 — иначе кириллица в логе падает
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "leads_bridge.log")

SUBJECT_MARK = "заявка"          # тема письма от Apps Script — «Заявка с сайта»
DONE_FOLDER = "CRM"              # куда убирать обработанные письма
LOOKBACK_DAYS = 14               # насколько глубоко смотреть при первом запуске
NOT_LEAD_FROM = ("noreply@", "no-reply@", "mailer-daemon@")


# ── вспомогательное ───────────────────────────────────────────────────────

def log(msg):
    line = "%s  %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def load_env():
    """Читает .env рядом со скриптом. Значения не логируются."""
    path = os.path.join(HERE, ".env")
    if not os.path.exists(path):
        log("нет файла .env рядом со скриптом — заполните его по образцу .env.example")
        sys.exit(1)
    env = {}
    with open(path, encoding="utf-8-sig") as f:
        for raw in f:
            raw = raw.strip()
            if not raw or raw.startswith("#") or "=" not in raw:
                continue
            k, v = raw.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    need = ["IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD", "TWENTY_URL", "TWENTY_TOKEN"]
    missing = [k for k in need if not env.get(k)]
    if missing:
        log("в .env не заполнены: %s" % ", ".join(missing))
        sys.exit(1)
    return env


def decode(value):
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def body_text(msg):
    """Достаёт текстовую часть письма."""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                payload = part.get_payload(decode=True) or b""
                charset = part.get_content_charset() or "utf-8"
                return payload.decode(charset, "replace")
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                payload = part.get_payload(decode=True) or b""
                charset = part.get_content_charset() or "utf-8"
                html = payload.decode(charset, "replace")
                return re.sub(r"<[^>]+>", " ", html)
        return ""
    payload = msg.get_payload(decode=True) or b""
    return payload.decode(msg.get_content_charset() or "utf-8", "replace")


FIELDS = {
    "name": ("имя",),
    "phone": ("телефон",),
    "type": ("тип объекта", "тип"),
    "region": ("регион",),
    "message": ("задача", "сообщение", "комментарий"),
    "page": ("страница", "источник"),
}


def parse_lead(text):
    """Разбирает тело письма вида «Имя: …\nТелефон: …» в словарь."""
    found = {}
    for line in text.splitlines():
        line = line.strip()
        if ":" not in line:
            continue
        label, value = line.split(":", 1)
        label = label.strip().lower()
        value = value.strip()
        if not value:
            continue
        for key, aliases in FIELDS.items():
            if label in aliases and key not in found:
                found[key] = value
    return found


# ── Twenty REST ───────────────────────────────────────────────────────────

class Twenty:
    def __init__(self, base, token, dry=False):
        self.base = base.rstrip("/")
        self.token = token
        self.dry = dry

    def call(self, method, path, payload=None):
        if self.dry:
            log("[dry-run] %s %s" % (method, path))
            return {"data": {"dryRun": {"id": "dry-run"}}}
        url = self.base + path
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.token)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            raise RuntimeError("HTTP %s на %s %s: %s" % (e.code, method, path, detail))

    @staticmethod
    def unwrap(res, *keys):
        node = (res or {}).get("data") or {}
        for k in keys:
            if k in node:
                node = node[k]
                break
        return node.get("id") if isinstance(node, dict) else None

    def person(self, lead):
        first, _, last = (lead.get("name") or "Контакт с сайта").partition(" ")
        body = {"name": {"firstName": first[:60], "lastName": last[:60]}}
        phone = re.sub(r"[^\d+]", "", lead.get("phone") or "")
        if phone:
            body["phones"] = {"primaryPhoneNumber": phone[-10:],
                              "primaryPhoneCallingCode": "+7",
                              "primaryPhoneCountryCode": "RU"}
        try:
            return self.unwrap(self.call("POST", "/rest/people", body),
                               "createPerson", "person")
        except RuntimeError as e:
            log("контакт не создан (%s) — сделку заведу без него" % e)
            return None

    def opportunity(self, lead, person_id):
        title = "%s — %s — %s" % (lead.get("name") or "Заявка",
                                  lead.get("region") or "регион не указан",
                                  datetime.now().strftime("%d.%m"))
        body = {"name": title[:120], "stage": "NEW",
                "closeDate": (datetime.now() + timedelta(days=14)
                              ).strftime("%Y-%m-%dT%H:%M:%S.000Z")}
        if person_id:
            body["pointOfContactId"] = person_id
        return self.unwrap(self.call("POST", "/rest/opportunities", body),
                           "createOpportunity", "opportunity")

    def note(self, lead, opp_id):
        text = "\n".join("%s: %s" % (k, v) for k, v in lead.items())
        note_id = self.unwrap(
            self.call("POST", "/rest/notes",
                      {"title": "Заявка с сайта", "bodyV2": {"markdown": text}}),
            "createNote", "note")
        if note_id and opp_id:
            self.call("POST", "/rest/noteTargets",
                      {"noteId": note_id, "opportunityId": opp_id})
        return note_id


# ── почта ─────────────────────────────────────────────────────────────────

def ensure_folder(imap, name):
    try:
        imap.create(name)
    except Exception:
        pass


def is_lead(subject, sender):
    s = (subject or "").lower()
    f = (sender or "").lower()
    if any(bad in f for bad in NOT_LEAD_FROM):
        return False
    return SUBJECT_MARK in s


def run(dry=False):
    env = load_env()
    crm = Twenty(env["TWENTY_URL"], env["TWENTY_TOKEN"], dry=dry)

    # CRM должна быть живой — иначе письма трогать нельзя
    if not dry:
        try:
            urllib.request.urlopen(env["TWENTY_URL"].rstrip("/") + "/healthz", timeout=10)
        except Exception as e:
            log("Twenty недоступна (%s) — выхожу, письма не трогаю" % e)
            return 1

    imap = imaplib.IMAP4_SSL(env["IMAP_HOST"])
    imap.login(env["IMAP_USER"], env["IMAP_PASSWORD"])
    imap.select("INBOX")
    ensure_folder(imap, DONE_FOLDER)

    since = (datetime.now() - timedelta(days=LOOKBACK_DAYS)).strftime("%d-%b-%Y")
    typ, data = imap.search(None, "SINCE", since)
    if typ != "OK":
        log("IMAP search вернул %s — выхожу" % typ)
        imap.logout()
        return 1

    ids = (data[0] or b"").split()
    log("писем за %s дней: %d" % (LOOKBACK_DAYS, len(ids)))
    made = 0

    for num in ids:
        typ, raw = imap.fetch(num, "(RFC822)")
        if typ != "OK" or not raw or not raw[0]:
            continue
        msg = email.message_from_bytes(raw[0][1])
        subject = decode(msg.get("Subject"))
        sender = decode(msg.get("From"))
        if not is_lead(subject, sender):
            continue

        lead = parse_lead(body_text(msg))
        if not lead.get("name") and not lead.get("phone"):
            log("письмо «%s» не похоже на заявку — пропускаю" % subject[:60])
            continue
        if "тест" in json.dumps(lead, ensure_ascii=False).lower():
            log("тестовая заявка «%s» — в CRM не завожу" % (lead.get("name") or "")[:40])
            if not dry:
                imap.copy(num, DONE_FOLDER)
                imap.store(num, "+FLAGS", "\\Deleted")
            continue

        try:
            person_id = crm.person(lead)
            opp_id = crm.opportunity(lead, person_id)
            crm.note(lead, opp_id)
        except RuntimeError as e:
            log("сделка не создана: %s — письмо оставляю во «Входящих»" % e)
            continue

        made += 1
        log("создана сделка по заявке от «%s»" % (lead.get("name") or "без имени")[:40])
        if not dry:
            imap.copy(num, DONE_FOLDER)
            imap.store(num, "+FLAGS", "\\Deleted")

    if not dry:
        imap.expunge()
    imap.logout()
    log("готово, новых сделок: %d" % made)
    return 0


if __name__ == "__main__":
    sys.exit(run(dry="--dry-run" in sys.argv))
