# Vendored third-party libraries

Self-hosted instead of loaded from a CDN so the app has no third-party
script-execution supply chain: nothing outside this repo can change what
these files contain between one page load and the next, and a strict
`script-src` (see the CSP `<meta>` tag in `index.html`) can allow `'self'`
only.

| File | Package | Version | License | Source |
|---|---|---|---|---|
| `supabase.min.js` | `@supabase/supabase-js` | 2.112.0 | MIT | `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.0/dist/umd/supabase.min.js` |
| `html5-qrcode.min.js` | `html5-qrcode` | 2.3.8 | Apache-2.0 | `https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js` |

Both files are vendored unmodified (including their original license/build
comments). `supabase.min.js` in particular should **not** be re-fetched via
a Subresource Integrity hash if this ever moves back to a CDN: jsdelivr's
own header comment in that file states it skips minification (the package
already ships pre-minified) and warns against relying on SRI for these
passthrough files, since the bytes it serves for that URL aren't
guaranteed stable over time.

## Updating

1. Pick the new version, confirm the license hasn't changed to something
   incompatible with self-hosting.
2. Download the `.min.js` for that exact version (not a floating tag like
   `@2`) and replace the file here.
3. Update the version/license table above.
4. Bump the `?v=` query string on both the `<script>` tag in `index.html`
   and the matching entry in `sw.js`'s `SHELL_URLS` so the service worker
   picks up the change.
