#!/usr/bin/env python3
"""
make_tokens.py  //  one-time local helper for MFA-enabled Garmin accounts

GitHub Actions cannot answer an MFA prompt. Run this once on your own
machine instead: it logs in interactively (you type the MFA code),
saves the Garmin token store, and prints it as a single base64 string.
Paste that string into the repo secret GARMINTOKENS_B64. Tokens are
long-lived, so this is a rare ritual, not a daily one.

Usage:
  pip install garminconnect
  python make_tokens.py
"""

import base64
import io
import sys
import tarfile
from getpass import getpass
from pathlib import Path

from garminconnect import Garmin

TOKEN_DIR = Path.home() / ".garminconnect"


def main() -> None:
    email = input("Garmin email: ").strip()
    password = getpass("Garmin password: ")

    api = Garmin(email=email, password=password)
    api.login()  # prompts for the MFA code in the terminal if required
    try:
        api.garth.dump(str(TOKEN_DIR))
    except Exception:
        pass  # newer library versions persist tokens automatically

    if not TOKEN_DIR.exists() or not any(TOKEN_DIR.iterdir()):
        print("Login succeeded but no token store was written at "
              f"{TOKEN_DIR}. Check the library version and try again.")
        sys.exit(1)

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for f in TOKEN_DIR.iterdir():
            tar.add(f, arcname=f.name)

    print("\nLogin OK. Add this as the GitHub secret GARMINTOKENS_B64:\n")
    print(base64.b64encode(buf.getvalue()).decode())


if __name__ == "__main__":
    main()
