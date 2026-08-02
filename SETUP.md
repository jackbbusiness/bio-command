# BIO-COMMAND // Garmin Uplink Setup

Automatic Garmin sync with no server to run and nothing to pay.
A GitHub robot (Actions) logs into your Garmin account every morning,
pulls your wellness data, encrypts it with your passphrase, and
publishes only the ciphertext. The app decrypts it on your phone.

Time required: about 15 minutes, once.

## Read this first

1. This uses an UNOFFICIAL Garmin client (python-garminconnect).
   Garmin's official API is for approved business partners only.
   The unofficial route works today, broke once in March 2026 before
   being rebuilt, and can break again. If it breaks, the app keeps
   all synced history and manual logging still works.
2. Technically this is against Garmin's terms of service (automated
   access), even though it is your own account and your own data.
   Realistic worst case seen in the wild is rate limiting or a forced
   password reset. Your call.
3. Your health data is never public. The repo only ever contains
   telemetry.enc, which is AES-256 encrypted. Your passphrase lives
   in two places: a GitHub secret and your phone. Do not commit it,
   do not reuse a password you care about.

## Setup steps

1. Create a GitHub account at github.com if you do not have one.

2. Create a new repository. Name: bio-command. Visibility: Public
   (required for free GitHub Pages). Do not add any starter files.

3. Upload the contents of this folder to the repository:
   on the repo page choose "uploading an existing file" and drag in
   index.html, garmin_sync.py, make_tokens.py, SETUP.md and the
   .github folder. Commit.

4. Add the secrets. Repo > Settings > Secrets and variables >
   Actions > New repository secret. Create:
   - GARMIN_EMAIL      your Garmin Connect login email
   - GARMIN_PASSWORD   your Garmin Connect password
   - SYNC_PASSPHRASE   a NEW strong passphrase you invent now
   If your Garmin account has multi-factor authentication, also do
   the MFA appendix below and add GARMINTOKENS_B64.

5. Run the first sync. Repo > Actions > "Garmin Sync" > Run workflow.
   Wait for the green tick, then check that data/telemetry.enc now
   exists in the repo. If the run fails, open it, copy the log, and
   bring it back to Claude.

6. Turn on hosting. Repo > Settings > Pages > Source: Deploy from a
   branch > Branch: main, folder: / (root) > Save. After a minute
   your app is live at https://YOURNAME.github.io/bio-command/

7. Open that URL on your iPhone in Safari. On the Command screen,
   in the GARMIN UPLINK card: leave FEED URL as data/telemetry.enc,
   enter your SYNC_PASSPHRASE, tap SAVE CONFIG, then SYNC NOW.
   Rings populate from real Garmin data.

8. Install it: Share button > Add to Home Screen. From then on it
   launches full screen and auto-syncs on open.

## MFA appendix (only if your Garmin login asks for a code)

GitHub's robot cannot type an MFA code, so you hand it long-lived
tokens instead:

1. On a computer with Python 3.12+ installed:
   pip install garminconnect
   python make_tokens.py
2. Enter your email, password, and the MFA code when prompted.
3. Copy the long base64 string it prints and save it as the repo
   secret GARMINTOKENS_B64.

Tokens are long-lived. If syncs start failing with auth errors many
months from now, rerun this ritual.

## Troubleshooting

- "429 Too Many Requests" in the log: Garmin rate-limits credential
  logins from cloud IPs. Wait an hour, or set up the token store
  (MFA appendix), which avoids logins entirely.
- "WARNING ... failed" lines for individual metrics: Garmin renames
  fields occasionally. The script logs the available field names.
  Paste the log to Claude for a one-line fix.
- Wrong passphrase in the app shows DECRYPT FAILED. Re-enter and
  save config again.
- Sync works but a metric is blank: not every Garmin device records
  every metric (HRV requires overnight wear and HRV Status support).
