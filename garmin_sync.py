#!/usr/bin/env python3
"""
garmin_sync.py  //  BIO-COMMAND telemetry relay

Pulls daily wellness data from Garmin Connect using the unofficial
python-garminconnect client, merges it into the encrypted feed at
data/telemetry.enc, and exits. Designed to run headless in GitHub
Actions on a daily schedule. Requires Python 3.12+.

The feed is AES-256-GCM encrypted with a key derived from
SYNC_PASSPHRASE (PBKDF2-SHA256, 210k iterations), so the ciphertext
can live in a public repo without exposing health data. The app
decrypts it on-device with the same passphrase.

Environment variables:
  GARMIN_EMAIL      Garmin Connect login email
  GARMIN_PASSWORD   Garmin Connect password
  GARMINTOKENS      token directory path (optional, restored from a
                    secret for MFA accounts; defaults to ~/.garminconnect)
  SYNC_PASSPHRASE   feed encryption passphrase (required)
  DAYS_BACK         how many recent days to refresh each run (default 14)

Honesty note: this uses an unofficial client of your own account.
Garmin changed authentication in March 2026 and broke the previous
generation of these tools; python-garminconnect rebuilt on a native
auth engine, but it can break again. If a run fails, read the
Actions log; the errors here are written to be legible.
"""

import base64
import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from garminconnect import Garmin

FEED_PATH = Path("data/telemetry.enc")
PBKDF2_ITERATIONS = 210_000
_printed_stats_keys = False


def log(msg: str) -> None:
    print(f"[bio-command] {msg}", flush=True)


# ----------------------------------------------------------------
# Crypto (must stay in lockstep with the WebCrypto code in the app)
# ----------------------------------------------------------------

def derive_key(passphrase: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    return kdf.derive(passphrase.encode("utf-8"))


def decrypt_existing_feed(passphrase: str) -> dict:
    """Load and decrypt the current feed so history is preserved."""
    if not FEED_PATH.exists():
        return {}
    try:
        blob = json.loads(FEED_PATH.read_text())
        key = derive_key(passphrase, base64.b64decode(blob["salt"]))
        plaintext = AESGCM(key).decrypt(
            base64.b64decode(blob["nonce"]),
            base64.b64decode(blob["ct"]),
            None,
        )
        payload = json.loads(plaintext.decode("utf-8"))
        days = payload.get("days", {})
        log(f"existing feed decrypted: {len(days)} day(s) of history")
        return days
    except Exception as e:
        log(f"WARNING could not decrypt existing feed, starting fresh: {e}")
        return {}


def encrypt_feed(passphrase: str, days: dict) -> None:
    salt = os.urandom(16)
    nonce = os.urandom(12)
    key = derive_key(passphrase, salt)
    payload = json.dumps(
        {
            "v": 1,
            "generatedAt": date.today().isoformat(),
            "days": days,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    ct = AESGCM(key).encrypt(nonce, payload, None)
    FEED_PATH.parent.mkdir(parents=True, exist_ok=True)
    FEED_PATH.write_text(
        json.dumps(
            {
                "v": 1,
                "kdf": "PBKDF2-SHA256",
                "iter": PBKDF2_ITERATIONS,
                "salt": base64.b64encode(salt).decode(),
                "nonce": base64.b64encode(nonce).decode(),
                "ct": base64.b64encode(ct).decode(),
            }
        )
    )
    log(f"feed written: {FEED_PATH} ({len(days)} day(s), {FEED_PATH.stat().st_size} bytes)")


# ----------------------------------------------------------------
# Garmin login (token-first so MFA accounts work headless)
# ----------------------------------------------------------------

def garmin_login() -> Garmin:
    tokendir = os.environ.get("GARMINTOKENS") or str(Path.home() / ".garminconnect")
    email = os.environ.get("GARMIN_EMAIL")
    password = os.environ.get("GARMIN_PASSWORD")

    api = Garmin(email=email, password=password)

    # Attempt token-store login first: survives without re-entering
    # credentials and avoids Garmin's login rate limiting on CI IPs.
    try:
        api.login(tokendir)
        log(f"login OK via token store ({tokendir})")
        return api
    except Exception as e:
        log(f"token login unavailable ({e}); trying credential login")

    if not email or not password:
        log("FATAL no token store and no GARMIN_EMAIL / GARMIN_PASSWORD set")
        sys.exit(1)

    try:
        api = Garmin(email=email, password=password)
        api.login()
        log("login OK via credentials")
        # Persist tokens for the next run where possible.
        try:
            api.garth.dump(tokendir)
            log(f"tokens saved to {tokendir}")
        except Exception:
            pass
        return api
    except Exception as e:
        log(f"FATAL Garmin login failed: {e}")
        log("If this is a 429, wait an hour; repeated credential logins from")
        log("CI are rate limited. The token-store path avoids this entirely.")
        sys.exit(1)


# ----------------------------------------------------------------
# Fetch + map into Bio-Command schema field names
# ----------------------------------------------------------------

def safe(day: str, fn, *args):
    try:
        return fn(*args)
    except Exception as e:
        log(f"WARNING {getattr(fn, '__name__', 'call')}({day}) failed: {e}")
        return None


def fetch_day(api: Garmin, d: date) -> dict:
    global _printed_stats_keys
    ds = d.isoformat()
    row = {"dayKey": ds, "hrvMethod": "rmssd", "source": "garmin"}

    # Daily summary: RHR, steps, energy, respiration
    stats = safe(ds, api.get_stats, ds) or {}

    def pick(*names):
        for n in names:
            v = stats.get(n)
            if v is not None:
                return v
        return None

    row["restingHR"] = pick("restingHeartRate")
    row["steps"] = pick("totalSteps")
    row["activeEnergyKcal"] = pick("activeKilocalories")
    row["basalEnergyKcal"] = pick("bmrKilocalories")
    row["respiratoryRate"] = pick(
        "avgWakingRespirationValue", "averageRespirationValue"
    )

    if stats and row["restingHR"] is None and not _printed_stats_keys:
        _printed_stats_keys = True
        log("DEBUG get_stats keys (field names may have drifted): "
            + ", ".join(sorted(stats.keys())))

    # Overnight HRV (Garmin reports RMSSD)
    hrv = safe(ds, api.get_hrv_data, ds) or {}
    summary = hrv.get("hrvSummary") or {}
    if summary.get("lastNightAvg") is not None:
        row["hrvMs"] = summary["lastNightAvg"]

    # Sleep architecture
    sleep = safe(ds, api.get_sleep_data, ds) or {}
    dto = sleep.get("dailySleepDTO") or {}

    def mins(key):
        v = dto.get(key)
        return round(v / 60) if isinstance(v, (int, float)) and v > 0 else None

    if mins("sleepTimeSeconds"):
        row["sleepTotalMin"] = mins("sleepTimeSeconds")
        row["sleepDeepMin"] = mins("deepSleepSeconds")
        row["sleepREMMin"] = mins("remSleepSeconds")
        row["sleepCoreMin"] = mins("lightSleepSeconds")
        row["sleepAwakeMin"] = mins("awakeSleepSeconds")

    # Body mass (Garmin reports grams)
    body = safe(ds, api.get_body_composition, ds) or {}
    weight = (body.get("totalAverage") or {}).get("weight")
    if isinstance(weight, (int, float)) and weight > 0:
        row["bodyMassKg"] = round(weight / 1000.0, 1)

    return {k: v for k, v in row.items() if v is not None}


def merge_activities(api: Garmin, days: dict, start: date, end: date) -> None:
    """Sum activity minutes per day; average HR weighted by duration."""
    acts = safe("range", api.get_activities_by_date, start.isoformat(), end.isoformat())
    if not acts:
        return
    per_day = {}
    for a in acts:
        start_local = str(a.get("startTimeLocal", ""))[:10]
        dur_sec = a.get("duration") or 0
        avg_hr = a.get("averageHR")
        if not start_local or dur_sec <= 0:
            continue
        slot = per_day.setdefault(start_local, {"sec": 0.0, "hr_x_sec": 0.0, "hr_sec": 0.0})
        slot["sec"] += dur_sec
        if isinstance(avg_hr, (int, float)) and avg_hr > 0:
            slot["hr_x_sec"] += avg_hr * dur_sec
            slot["hr_sec"] += dur_sec
    for ds, v in per_day.items():
        row = days.setdefault(ds, {"dayKey": ds, "source": "garmin"})
        row["trainingMinutes"] = round(v["sec"] / 60)
        if v["hr_sec"] > 0:
            row["trainingAvgHR"] = round(v["hr_x_sec"] / v["hr_sec"])
    log(f"activities merged for {len(per_day)} day(s)")


# ----------------------------------------------------------------
# Main
# ----------------------------------------------------------------

def main() -> None:
    passphrase = os.environ.get("SYNC_PASSPHRASE")
    if not passphrase:
        log("FATAL SYNC_PASSPHRASE is not set")
        sys.exit(1)

    days_back = int(os.environ.get("DAYS_BACK", "14"))
    api = garmin_login()

    days = decrypt_existing_feed(passphrase)
    today = date.today()
    start = today - timedelta(days=days_back)

    fetched = 0
    for i in range(days_back + 1):
        d = start + timedelta(days=i)
        row = fetch_day(api, d)
        if len(row) > 3:  # more than just dayKey/method/source
            existing = days.get(row["dayKey"], {})
            days[row["dayKey"]] = {**existing, **row}
            fetched += 1

    merge_activities(api, days, start, today)
    encrypt_feed(passphrase, days)
    log(f"sync complete: {fetched} day(s) refreshed, {len(days)} total in feed")


if __name__ == "__main__":
    main()
