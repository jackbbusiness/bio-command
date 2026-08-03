# BIO-COMMAND v2.2

A privacy-first tactical health dashboard combining recovery, training, nutrition, biomarkers, protocols, journaling and Garmin telemetry.

## What changed in v2

- Split the original monolithic application into maintainable CSS and JavaScript modules.
- Added the OPS intelligence screen with a 24-hour readiness forecast, fatigue estimate, sleep debt, weekly load, protocol adherence, recovery drivers, prioritised actions and a unified event timeline.
- Upgraded the service worker to cache all app modules and work from its installed scope rather than relying exclusively on a hardcoded path.
- Added a complete GitHub Actions Garmin sync workflow and pinned runtime requirements.
- Retained all existing v1 functionality and local data formats.

## Run locally

```bash
python -m http.server 8080
```

Open `http://localhost:8080`.

## Deploy

Publish the repository root through GitHub Pages. The default manifest is configured for a repository named `bio-command`. Change `start_url` and `scope` in `manifest.json` when deploying under a different path.

## Data and privacy

Garmin telemetry is encrypted with AES-256-GCM before it is committed. Supabase row-level security restricts cloud records to their authenticated owner. API credentials entered in the app remain browser-side, so use a restricted key and understand the security limitations of a static client application.

See `SETUP.md` for the Garmin uplink instructions and `supabase-setup.sql` for optional cloud sync.


## Fuel barcode scanner

Fuel now includes a camera barcode scanner. It reads EAN, UPC and Code 128 barcodes with `html5-qrcode`, looks products up through Open Food Facts, lets the user choose grams or servings, then writes calories and macros into the existing daily fuel log. Camera access requires HTTPS, which GitHub Pages provides. A manual barcode field is included when camera access is unavailable.


## History Mode v2.2

Tap the date in the app header to open historical data. Browse individual days, choose a calendar date, review 7/30/90-day, yearly or all-time trends, and inspect Garmin, Fuel, Training, Protocol, Journal and biomarker records together.


## v2.2.1 audit fixes

- Includes biomarker-only dates in All Time history.
- Keeps the 14-day selector anchored to the date being reviewed.
- Refreshes History immediately when data changes in the same app session.
- Escapes user-entered text before rendering historical records.
- Adds a maximum date to the calendar so future dates cannot be selected.
- Removes a duplicate historical-record render.
- Cache-busts all updated assets and service-worker state.
