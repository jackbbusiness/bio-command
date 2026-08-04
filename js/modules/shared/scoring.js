"use strict";

/**
 * Not one of the four originally planned shared files. This is the
 * readiness/strain scoring engine — used directly by Fuel
 * (baselineFor), Training (computeScores), Settings (computeStrain),
 * Sync (computeScores), and Dashboard (all three). It reads
 * DB.telemetry/DB.operator, so it's a factory
 * (createScoringHelpers({ getDB })) rather than a plain object,
 * since DB is reassigned at runtime (import/reset/cloud sync).
 */
(function (global) {
  function createScoringHelpers({ getDB, clamp01 }) {
    function baselineFor(field, excludeKey, windowDays) {
      const DB = getDB();
      const keys = Object.keys(DB.telemetry)
        .filter(k => k !== excludeKey && DB.telemetry[k][field] != null)
        .sort()
        .reverse()
        .slice(0, windowDays);
      if (keys.length < 3) return null;
      const sum = keys.reduce((s, k) => s + DB.telemetry[k][field], 0);
      return sum / keys.length;
    }

    /* Strain: RPE-based when the operator logged perceived effort (most
       accurate). When Garmin supplied minutes and average training HR but
       no RPE (the normal auto-sync case), fall back to a heart-rate-reserve
       proxy: %HRR maps to an effective RPE, then runs through the same
       saturating curve so the two methods land on a comparable scale.
       Requires the operator's max HR (set once in SYS > Profile). */
    function computeStrain(row) {
      const DB = getDB();
      const trainMin = row.trainingMinutes;
      if (!trainMin || trainMin <= 0) return { value: 0, method: "none" };

      if (row.sessionRPE != null) {
        const lp = trainMin * row.sessionRPE;
        return { value: 21 * (1 - Math.exp(-lp / 450)), method: "rpe" };
      }

      const maxHR = DB.operator.maxHR;
      if (row.trainingAvgHR != null && row.restingHR != null && maxHR && maxHR > row.restingHR) {
        const hrr = clamp01((row.trainingAvgHR - row.restingHR) / (maxHR - row.restingHR));
        const effRPE = hrr * 10;
        const lp = trainMin * effRPE;
        return { value: 21 * (1 - Math.exp(-lp / 450)), method: "hr" };
      }

      return { value: 0, method: "none" };
    }

    function computeScores(row, key) {
      const DB = getDB();
      const win = DB.operator.baselineWindowDays;
      const target = DB.operator.targetSleepMinutes;

      const hrvBase = baselineFor("hrvMs", key, win);
      const rhrBase = baselineFor("restingHR", key, win);

      const out = {
        hrvBase: hrvBase,
        hrvDeltaPct: null,
        readiness: null,
        sleepPerf: null,
        strain: 0,
        strainMethod: "none",
        calibrating: hrvBase == null
      };
      const strainResult = computeStrain(row);
      out.strain = strainResult.value;
      out.strainMethod = strainResult.method;

      if (row.sleepTotalMin != null) {
        out.sleepPerf = Math.min(100, Math.round(row.sleepTotalMin / target * 100));
      }

      if (hrvBase != null && row.hrvMs != null) {
        const ratio = row.hrvMs / hrvBase;
        out.hrvDeltaPct = Math.round((ratio - 1) * 100);
        const hrvScore = clamp01((ratio - 0.55) / (1.20 - 0.55)) * 100;

        let rhrScore = null;
        if (rhrBase != null && row.restingHR != null && row.restingHR > 0) {
          const rRatio = rhrBase / row.restingHR;
          rhrScore = clamp01((rRatio - 0.80) / (1.12 - 0.80)) * 100;
        }
        const sleepScore = out.sleepPerf != null ? out.sleepPerf : null;

        if (rhrScore != null && sleepScore != null) {
          out.readiness = Math.round(0.50 * hrvScore + 0.25 * rhrScore + 0.25 * sleepScore);
          out.components = [
            { label: "HRV vs baseline", weight: 0.50, score: hrvScore },
            { label: "Resting HR vs baseline", weight: 0.25, score: rhrScore },
            { label: "Sleep vs target", weight: 0.25, score: sleepScore }
          ];
        } else if (sleepScore != null) {
          out.readiness = Math.round(0.65 * hrvScore + 0.35 * sleepScore);
          out.components = [
            { label: "HRV vs baseline", weight: 0.65, score: hrvScore },
            { label: "Sleep vs target", weight: 0.35, score: sleepScore }
          ];
        } else {
          out.readiness = Math.round(hrvScore);
          out.components = [
            { label: "HRV vs baseline", weight: 1.00, score: hrvScore }
          ];
        }
      }

      return out;
    }

    return { baselineFor, computeStrain, computeScores };
  }

  global.BioCommandShared = global.BioCommandShared || {};
  global.BioCommandShared.scoring = { createScoringHelpers };
})(window);
