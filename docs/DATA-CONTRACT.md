# BIO-COMMAND data contract

This document captures the persistence contract used by the current app so the refactor can preserve behavior safely.

## Storage boundary

The app currently uses browser localStorage as the primary persistence layer. A small in-memory fallback is used when localStorage is unavailable.

The storage adapter is the only persistence boundary. All app modules should read and write through the storage layer rather than calling localStorage directly.

## LocalStorage keys

| Key | Purpose | Shape |
| --- | --- | --- |
| `biocommand.db.v1` | Main application database | JSON string of the full DB object |
| `biocommand.sync` | Garmin uplink config | JSON string of an object with `url`, `pass`, `lastSync` |
| `biocommand.ai` | Advisor configuration | JSON string of an object with `key` |
| `biocommand.supabase` | Supabase config | JSON string of an object with `url`, `key`, `lastSync` |
| `biocommand.cloudsync` | Reserved cloud-sync marker | JSON string, currently unused by runtime |
| `biocommand.theme` | Theme preference | String value of `light` or `dark` |

## Persisted database object: `biocommand.db.v1`

The main DB is versioned and stored as a single JSON object under `biocommand.db.v1`.

### Root shape

```json
{
  "version": 1,
  "operator": { "callsign": "OPERATOR", "usesMetric": true, "baselineWindowDays": 30, "targetSleepMinutes": 450, "targetBodyMassKg": null, "targetProteinPerKg": 2.0, "maxHR": null, "createdAt": "ISO-8601" },
  "telemetry": {},
  "markers": {},
  "biomarkerLogs": [],
  "fuelPlans": {},
  "mealTemplates": [],
  "plannedMeals": [],
  "workouts": [],
  "sessions": [],
  "protocols": [],
  "completions": {},
  "briefings": {},
  "journal": {},
  "fuelLog": [],
  "seededWorkouts": false
}
```

### Date format

- Date keys are stored as `YYYY-MM-DD` strings using `dayKey()`.
- Timestamps use ISO-8601 strings from `new Date().toISOString()`.

### Telemetry record shape

Each telemetry entry is keyed by a day key and may include:

```json
{
  "dayKey": "YYYY-MM-DD",
  "hrvMs": 72,
  "hrvMethod": "rmssd",
  "restingHR": 55,
  "respiratoryRate": 14,
  "bodyMassKg": 78.4,
  "sleepTotalMin": 450,
  "sleepDeepMin": 90,
  "sleepREMMin": 90,
  "sleepCoreMin": 300,
  "sleepAwakeMin": 30,
  "steps": 12000,
  "activeEnergyKcal": 350,
  "basalEnergyKcal": 1800,
  "trainingMinutes": 45,
  "trainingAvgHR": 145,
  "sessionRPE": 7,
  "source": "manual | garmin",
  "scoreVersion": 2,
  "updatedAt": "ISO-8601",
  "readinessScore": 74,
  "systemLoadScore": 8.4,
  "strainMethod": "rpe | hr | none"
}
```

### Garmin uplink config: `biocommand.sync`

```json
{
  "url": "data/telemetry.enc",
  "pass": "passphrase",
  "lastSync": "ISO-8601"
}
```

### Advisor config: `biocommand.ai`

```json
{
  "key": "api-key"
}
```

### Supabase config: `biocommand.supabase`

```json
{
  "url": "https://example.supabase.co",
  "key": "anon-key",
  "lastSync": "ISO-8601"
}
```

### Journal record shape

Journal entries are stored per day under the root `journal` object.

```json
{
  "YYYY-MM-DD": {
    "answers": {
      "sleep_quality": "good",
      "energy": "high"
    },
    "note": "Morning note",
    "updatedAt": "ISO-8601"
  }
}
```

### Protocol record shape

Protocols are stored as array entries under `protocols` and completion state under `completions`.

```json
{
  "id": "pd_123",
  "name": "Hydration",
  "category": "custom",
  "scheduleMask": 63,
  "targetValue": 3,
  "targetUnit": "L",
  "isActive": true,
  "sortOrder": 0
}
```

```json
{
  "YYYY-MM-DD": {
    "pd_123": {
      "completed": true,
      "updatedAt": "ISO-8601"
    }
  }
}
```

### Biomarker record shape

Biomarker logs are stored as array entries under `biomarkerLogs`.

```json
{
  "date": "YYYY-MM-DD",
  "code": "body_weight",
  "marker": "Body weight",
  "value": 78.4,
  "unit": "kg",
  "loggedAt": "ISO-8601"
}
```

### Nutrition record shape

Fuel entries are stored as array entries under `fuelLog`.

```json
{
  "dayKey": "YYYY-MM-DD",
  "name": "Protein shake",
  "kcal": 240,
  "proteinG": 30,
  "carbsG": 20,
  "fatG": 8,
  "createdAt": "ISO-8601",
  "source": "manual | barcode"
}
```

### Training record shape

Training sessions are stored as array entries under `sessions`.

```json
{
  "dayKey": "YYYY-MM-DD",
  "startedAt": "ISO-8601",
  "workoutName": "Lift",
  "durationMin": 45,
  "sets": [],
  "totalVolume": 1200,
  "createdAt": "ISO-8601"
}
```
