# BIO Command — Architecture

This document describes the modular architecture produced by the
foundation refactor on `feature/foundation-refactor`. It reflects the
codebase as it exists after that refactor, not aspirational design.

## Application shape

BIO Command is a vanilla-JS, no-build PWA. There is no bundler and no
module loader — every file is a plain `<script>` tag, and modules
attach themselves to `window` under a `BioCommand*` namespace. Load
order in `index.html` is the only thing that makes dependency
wiring work, and it is deliberate:

```
storage.js
shared/*.js            (any order among themselves)
history/index.js
fuel/index.js
training/index.js
journal/index.js
biomarkers/index.js
protocols/index.js
dashboard/index.js
settings/index.js
data-management/index.js
sync/index.js
notifications/index.js
app.js                 (constructs and wires every module above)
intelligence.js
history.js              (a thin boot script for the History module)
```

Every `js/modules/**/index.js` file only *defines* a factory
(`window.BioCommandX = { createXModule }`) at load time — it does not
run any of its own code yet. `app.js` is what actually calls each
factory, in a specific order, and wires the result together. This is
why script order in `index.html` only needs "all modules before
`app.js`", not a strict dependency order among the modules
themselves.

## Module responsibilities

| Module | File | Owns |
|---|---|---|
| Storage | `js/modules/storage.js` | localStorage adapter, DB schema defaults, load/save |
| Shared utilities | `js/modules/shared/*.js` | Pure helpers and small factories used by 2+ modules (see below) |
| History | `js/modules/history/index.js` | Read-only day/range explorer across all other modules' data |
| Fuel | `js/modules/fuel/index.js` | Meal logging, AI quick-log, barcode scanner, meal plan, macro targets |
| Training | `js/modules/training/index.js` | Workout builder, session execution (timers/sets/reps), PR detection |
| Journal | `js/modules/journal/index.js` | Morning check-in, streak, behavior-insight correlations |
| Biomarkers | `js/modules/biomarkers/index.js` | Lab marker tracking, AI lab-report import, trend charts |
| Protocols | `js/modules/protocols/index.js` | Habit/directive scheduling, streaks, completion tracking |
| Dashboard | `js/modules/dashboard/index.js` | Today/Command view: scoring display, intel flags, detail drill-down, manual log, AI brief |
| Settings | `js/modules/settings/index.js` | Theme, operator profile (max HR), AI key storage |
| Data Management | `js/modules/data-management/index.js` | Export / import / wipe |
| Sync | `js/modules/sync/index.js` | Garmin encrypted-feed pull, Supabase cloud push/pull/auth |
| Notifications | `js/modules/notifications/index.js` | Service worker registration, notification scheduling, push subscriptions |
| App bootstrap | `js/app.js` | DB/COLORS state, module construction, dependency wiring, tab navigation, startup rendering |

**Protocols was not in the original module list** but is a
substantial, self-contained feature (the PROTO tab's habit tracker)
with no natural home in the other modules, so it was extracted as its
own module.

### Shared utilities — why not exactly 4 files

The plan named `formatting.js` / `dates.js` / `dom.js` /
`validation.js`. In practice:

- **No `validation.js`** — no validation helper in the codebase is
  used by more than one module. Forcing one into existence would be
  the kind of unnecessary abstraction the refactor was explicitly
  asked to avoid.
- **`ids.js`, `colors.js`, `charts.js`, `scoring.js` added** — these
  were explicitly called out as likely candidates ("ID generation",
  "Color helpers") or don't fit the other four at all (the
  readiness/strain scoring engine is business logic, not formatting).

| File | Exports | Shape |
|---|---|---|
| `dates.js` | `dayKey`, `weekdayBit` | plain object — pure |
| `formatting.js` | `fmtMin`, `clamp01`, `meanOf` | plain object — pure |
| `dom.js` | `armDangerButton` | plain object — pure |
| `ids.js` | `genId` | plain object — pure |
| `colors.js` | `hexToRgba`, `readColors`, `createColorHelpers({ getColors })` → `{ bandColor, bandName }` | `bandColor`/`bandName` read the *current* theme palette, so they're behind a factory |
| `charts.js` | `createChartHelpers({ getColors, hexToRgba, clamp01 })` → `{ sparkLine, sparkBars, bigLine, bigBars, bigStacked }` | `bigBars`/`bigStacked` also read the current palette |
| `scoring.js` | `createScoringHelpers({ getDB, clamp01 })` → `{ baselineFor, computeStrain, computeScores }` | reads `DB.telemetry`/`DB.operator` directly |

`app.js` destructures the pure exports directly and calls the
factories once at boot, binding them to app.js's own `DB`/`COLORS`
state. Because the resulting identifiers (`dayKey`, `computeScores`,
`bandColor`, ...) keep the exact same names as before this pass, no
feature module's dependency-injection call site needed to change.

## Dependency injection pattern

Every feature module follows the same shape:

```js
window.BioCommandX = { createXModule };

function createXModule({ ...dependencies, getDB, getColors }) {
  function init() { /* wire DOM event listeners */ }
  function render() { /* draw current state */ }
  return { init, render, /* + only what other code genuinely needs */ };
}
```

`app.js` constructs each module once at boot:

```js
const xModule = window.BioCommandX.createXModule({
  dayKey, saveDB, ...,
  getDB: () => DB,
  getColors: () => COLORS
});
xModule.init();
```

**Rule: mutable values are always accessors, never captured values.**
`DB` and `COLORS` are both reassigned at runtime — `DB` on import,
wipe, and cloud-pull merge; `COLORS` on every theme toggle. A module
that captured `DB` as a plain value at construction time would go
stale the moment either happens. Every module instead receives
`getDB: () => DB` / `getColors: () => COLORS` and calls them fresh
inside each function body (`const DB = getDB();`) rather than caching
the result. This was verified directly: importing a backup file
updates the Training and Fuel tabs' rendered content *without a page
reload*, because their `getDB()` calls pick up the reassignment
Data Management made to the single `DB` binding in `app.js`.

Two modules go a step further and are given a **write** callback
(`setDB`) because they are themselves a source of DB reassignment:
Data Management (import, wipe) and Sync (cloud-pull merge).

### Exceptions to plain `{ init, render }`

A few modules expose extra public methods, always because app.js's
boot-time glue or another module genuinely calls them:

- **History**: `init, render, setDate, openHistory`
- **Journal**: `init, render, renderProto` (compact widget on Today vs. full view on PROTO)
- **Dashboard**: `init, render, openDetail, closeDetail, setAdvisorStatus, showBrief`
- **Training**: `init, render, seedDefaultWorkouts` (also called once at boot regardless of which tab is open)
- **Sync**: `init, render, renderUplink, renderCloudCard, loadSyncConfig, syncNow, initSupabase, getSB, getCurrentUser, enqueueCloudSync`
- **Settings**: `init, render, applyTheme, loadAI, saveAI`

## Module initialization order (as written in `app.js`)

1. Storage adapter + `DB` state
2. Shared utilities (destructured/constructed)
3. Settings — constructed *before* Dashboard, because Fuel,
   Biomarkers, and Dashboard all read the AI key through
   `settingsModule.loadAI`
4. Dashboard
5. Sync
6. *(Advisor key boot glue — see below)*
7. Data Management
8. Training
9. Fuel
10. Journal
11. Biomarkers
12. Protocols
13. Notifications
14. Tab badge / navigation wiring
15. Boot: initial renders, service worker init, initial cloud/Garmin sync

This order is **not arbitrary** — it resolves two real dependency
constraints:

- Settings must exist before anything that reads `settingsModule.loadAI`
  (Dashboard, Fuel, Biomarkers).
- Notifications reads `syncModule.getSB` / `syncModule.getCurrentUser`
  directly, so Sync must be constructed first.

Everything else is safe in any order because JS function
declarations are hoisted: a module's dependency object can reference
a bare identifier like `renderCommand` before that identifier's
*definition* appears later in the file, because the function is
fully defined by the time the script starts executing top to bottom
— it just can't be *called* before the module that defines it has
actually run, which is guaranteed since nothing calls these functions
until user interaction or the final boot sequence.

### The one real circular dependency: Settings ↔ Dashboard

Dashboard needs `loadAI` (Settings) to call the Anthropic API for
briefs. Settings' "save AI key" action ought to refresh Dashboard's
advisor status on Today. Wiring both directions directly would create
a cycle. Resolution: the AI-key save button and the boot-time
"do we already have a key" check live as ~20 lines of glue directly
in `app.js` (`ADVISOR KEY BOOT GLUE`), calling `settingsModule.saveAI`
/ `settingsModule.loadAI` and `dashboardModule.setAdvisorStatus` /
`dashboardModule.showBrief`. This is the only feature-shaped code
left in `app.js`, and it's there because it structurally cannot live
in either module without creating the cycle.

## Storage ownership

- `js/modules/storage.js` owns the localStorage key, the empty-DB
  schema, and the raw `loadDB`/`saveDB` functions.
- `app.js` owns the single live `DB` binding (`let DB = loadDB();`)
  and the `saveDB(db)` wrapper that also triggers
  `renderDataCard()`, `enqueueCloudSync()`, and a
  `biocommand:data-changed` event.
- No feature module ever holds its own copy of `DB` — every read goes
  through `getDB()`, every write mutates the object returned by
  `getDB()` and then calls the injected `saveDB`.
- `DB` is only ever *reassigned* (not just mutated) in two modules:
  Data Management (import, wipe) and Sync (cloud-pull merge). Both
  reassign through the same `setDB` callback that writes `app.js`'s
  `DB` binding, so every other module's next `getDB()` call sees the
  new object immediately.

## Service worker / offline caching

`sw.js` is a separate script (not part of the `index.html` load
chain — it's registered via `navigator.serviceWorker.register(...)`
inside Notifications' `initServiceWorker()`). Its `SHELL_URLS` list
must be kept in sync with every file `index.html` loads; every module
extraction in this refactor added its new file to both. As of this
refactor, `SHELL_URLS` includes all 19 `js/modules/**` files plus
`app.js`, `intelligence.js`, `history.js`, and the CSS/manifest.

Verified directly: a full offline reload (service worker active,
network disabled) renders the Today view correctly with no errors,
when served under the `/bio-command/` path the service worker
registers its scope against. **Note:** the SW registers with a
hardcoded `scope: "/bio-command/"` (pre-existing, not changed by this
refactor) — if the app is ever served from a different path, the
service worker will register but will not actually control the page.

`CACHE_VERSION` was intentionally **not** bumped for any extraction
commit in this refactor, matching the precedent set by the earlier
History/Storage extractions: adding a file to `SHELL_URLS` is enough,
since browsers detect the service worker script's own byte-level
change regardless of the version string.

## Rules for adding a future module

1. Follow the existing shape: `window.BioCommandX = { createXModule }`,
   factory returns `{ init, render, ...only what's genuinely needed }`.
2. Never capture `DB` or `COLORS` (or any other runtime-reassignable
   value) as a plain constructor value — always `getDB`/`getColors`
   accessors, called fresh inside each function body.
3. If the new module needs to *write* shared mutable state (like DB
   reassignment), add a `setX` callback dependency rather than
   reaching into another module's internals.
4. Add the new script tag to `index.html` *before* `js/app.js`.
   Order relative to other `js/modules/**` scripts doesn't matter —
   only "loads before `app.js`" does.
5. Add the same path to `sw.js`'s `SHELL_URLS`.
6. Construct the module in `app.js` and call `.init()`. If other
   already-existing code calls one of its old bare-function names
   (e.g. `renderFoo()`), add a same-named wrapper function in
   `app.js` that delegates to `fooModule.render()` — this is the
   pattern used for every extraction so far and keeps call sites in
   not-yet-extracted code working without modification.
7. Test: view opens, create/edit/delete works, data persists across
   reload, theme toggle doesn't leave stale colors, and — if the
   module touches `DB` — that another already-open view reflects an
   import/reset without needing a reload.

## Known runtime globals

These are the `window.BioCommand*` namespaces every module attaches
itself to. They exist only so `app.js` can call the factory; nothing
else should reference them directly.

`BioCommandStorage`, `BioCommandShared` (`.dates`, `.formatting`,
`.dom`, `.ids`, `.colors`, `.charts`, `.scoring`), `BioCommandHistory`,
`BioCommandFuel`, `BioCommandTraining`, `BioCommandJournal`,
`BioCommandBiomarkers`, `BioCommandProtocols`, `BioCommandDashboard`,
`BioCommandSettings`, `BioCommandDataManagement`, `BioCommandSync`,
`BioCommandNotifications`.

## Remaining technical debt

None of the following are new — they were discovered during this
refactor, moved verbatim into their new module homes, and
deliberately **not** fixed (out of scope for a behavior-preserving
extraction):

- **`_originalSaveDB` / `_saveThenSync` in `sync/index.js`** — dead
  code. Looks like an abandoned attempt to wrap `saveDB()` with a
  cloud-sync side effect; `saveDB` is never actually reassigned to
  `_saveThenSync` anywhere. Cloud sync instead runs through the
  separate `enqueueCloudSync()` call already present in `app.js`'s
  `saveDB()`.
- **Journal's `buildJournalUI` re-attaches a click listener on every
  render** rather than removing the previous one, so the container
  accumulates listeners over repeated renders. Not visibly harmful
  (the handlers are idempotent), but real duplicate-listener debt.
- **Settings only exposes max HR** as an editable operator-profile
  field — there is no UI anywhere in the app for the other
  `DB.operator` targets (`targetSleepMinutes`, `targetBodyMassKg`,
  `targetProteinPerKg`, `baselineWindowDays`, `callsign`). Nothing to
  extract; flagging in case a future Settings UI is planned.
- **Tab badge logic (`renderTabBadges`) stays in `app.js`**, not its
  own module — it's ~20 lines, reads `DB.journal`/`DB.protocols`
  directly, and exists purely to drive the nav tab-bar's badge dots.
  It was judged to be "navigation coordination" (which the target
  bootstrap shape explicitly allows to remain in `app.js`) rather
  than a feature module in its own right.
- **The SW's hardcoded `/bio-command/` scope** (see Service Worker
  section above) means local development under a different path
  never gets real offline behavior, only a registered-but-inactive
  service worker.

## Manual testing checklist

Automated (Playwright) coverage exists for all of the below as of
this refactor; re-run manually after any future change to these
areas:

- [ ] Every tab opens with no console/page errors
- [ ] Training: create workout → start session → log sets → finish → summary correct → persists after reload
- [ ] Fuel: quick-log (needs AI key), barcode scan UI opens/closes, meal template create/edit/delete, targets recalculate on goal chip
- [ ] Journal: answer questions on both Today (compact) and PROTO (full) views, confirm they stay in sync, streak/note persist
- [ ] Biomarkers: log a result, badge/trend chart update, persists after reload
- [ ] Protocols: check off a directive, create/edit/delete, streak and correlation line update
- [ ] Dashboard: hero ring / metric card / sleep card open the correct detail overlay; manual log overlay saves and recalculates scores; sim mode banner shows only when the store is empty
- [ ] Settings: theme toggle updates colors everywhere without a reload; profile max HR validates and recalculates strain; AI key save updates Today's advisor card immediately
- [ ] Data Management: export downloads valid JSON; import updates every open tab without a reload; wipe reseeds Training defaults
- [ ] Sync: Garmin passphrase save/sync error handling; Supabase config save/sign-in flow doesn't crash without real credentials
- [ ] Notifications: card reflects current permission state; service worker registers and reaches `activated`
- [ ] History: shows Training/Fuel/Journal/Biomarker records for the selected day across all range presets (7/30/90/365/all)
- [ ] Offline: with the app served under `/bio-command/`, a full reload with the network disabled still renders Today
