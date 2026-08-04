"use strict";

/**
 * Not one of the four originally planned shared files. Chart-drawing
 * primitives used by Dashboard (all five) and Biomarkers (bigLine).
 * sparkLine/sparkBars/bigLine take color as a parameter and are
 * pure, but bigBars/bigStacked also read the *current* COLORS
 * palette directly (target-line stroke, sleep-stage segment colors),
 * so this is a factory (createChartHelpers({ getColors })) rather
 * than a plain object, matching the accessor pattern used everywhere
 * else mutable state crosses a module boundary.
 */
(function (global) {
  const SPARK_W = 132, SPARK_H = 38;

  function createChartHelpers({ getColors, hexToRgba, clamp01 }) {
    function sparkLine(values, color) {
      const n = values.length;
      const defined = values.map((v, i) => ({ v, i })).filter(p => p.v != null);
      if (!defined.length) return '<svg class="mc-spark" viewBox="0 0 132 38"></svg>';
      const vals = defined.map(p => p.v);
      const min = Math.min(...vals), max = Math.max(...vals);
      const pad = (max - min) * 0.18 || Math.max(1, max * 0.05);
      const lo = min - pad, hi = max + pad;
      const x = i => 6 + i * (SPARK_W - 12) / (n - 1);
      const y = v => SPARK_H - 5 - (v - lo) / (hi - lo) * (SPARK_H - 10);

      let d = "", prevIdx = null;
      defined.forEach(p => {
        const cmd = (prevIdx != null && p.i === prevIdx + 1) ? "L" : "M";
        d += cmd + x(p.i).toFixed(1) + " " + y(p.v).toFixed(1) + " ";
        prevIdx = p.i;
      });
      const last = defined[defined.length - 1];
      const area = d && defined.length > 1
        ? '<path d="' + d + 'L' + x(last.i).toFixed(1) + " " + (SPARK_H - 3) +
          " L" + x(defined[0].i).toFixed(1) + " " + (SPARK_H - 3) +
          ' Z" fill="' + hexToRgba(color, 0.1) + '" stroke="none"></path>'
        : "";
      return '<svg class="mc-spark" viewBox="0 0 132 38">' + area +
        '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round"></path>' +
        '<circle cx="' + x(last.i).toFixed(1) + '" cy="' + y(last.v).toFixed(1) +
        '" r="3" fill="' + color + '"></circle></svg>';
    }

    function sparkBars(values, color, fixedMax) {
      const n = values.length;
      const max = fixedMax || Math.max(...values.filter(v => v != null), 1);
      const slot = SPARK_W / n, bw = slot * 0.5;
      let rects = "";
      values.forEach((v, i) => {
        const cx = i * slot + slot / 2;
        if (v == null || v <= 0) {
          rects += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + (SPARK_H - 4) +
            '" width="' + bw.toFixed(1) + '" height="2" rx="1" fill="' +
            hexToRgba(color, 0.18) + '"></rect>';
        } else {
          const h = Math.max(3, (v / max) * (SPARK_H - 8));
          rects += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + (SPARK_H - 2 - h).toFixed(1) +
            '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" fill="' +
            color + '"></rect>';
        }
      });
      return '<svg class="mc-spark" viewBox="0 0 132 38">' + rects + "</svg>";
    }

    function bigLine(values, color) {
      const n = values.length;
      const defined = values.map((v, i) => ({ v, i })).filter(p => p.v != null);
      if (!defined.length) return '<svg class="detail-chart" viewBox="0 0 320 100"></svg>';
      const vals = defined.map(p => p.v);
      const min = Math.min(...vals), max = Math.max(...vals);
      const pad = (max - min) * 0.18 || Math.max(1, max * 0.05);
      const lo = min - pad, hi = max + pad;
      const x = i => 14 + i * (320 - 28) / Math.max(1, n - 1);
      const y = v => 90 - (v - lo) / (hi - lo) * 66;

      let d = "", prevIdx = null;
      defined.forEach(p => {
        const cmd = (prevIdx != null && p.i === prevIdx + 1) ? "L" : "M";
        d += cmd + x(p.i).toFixed(1) + " " + y(p.v).toFixed(1) + " ";
        prevIdx = p.i;
      });
      const last = defined[defined.length - 1];
      const area = defined.length > 1
        ? '<path d="' + d + "L" + x(last.i).toFixed(1) + " 90 L" +
          x(defined[0].i).toFixed(1) + ' 90 Z" fill="' + hexToRgba(color, 0.1) + '" stroke="none"></path>'
        : "";
      const dots = defined.map(p =>
        '<circle cx="' + x(p.i).toFixed(1) + '" cy="' + y(p.v).toFixed(1) +
        '" r="2.6" fill="' + color + '"></circle>').join("");
      return '<svg class="detail-chart" viewBox="0 0 320 100">' + area +
        '<path d="' + d + '" fill="none" stroke="' + color +
        '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>' +
        dots + "</svg>";
    }

    function bigBars(values, color, fixedMax, targetLine) {
      const COLORS = getColors();
      const n = values.length;
      const max = fixedMax || Math.max(...values.filter(v => v != null), 1);
      const slot = (320 - 16) / n, bw = slot * 0.55;
      let rects = "";
      values.forEach((v, i) => {
        const cx = 8 + i * slot + slot / 2;
        if (v == null || v <= 0) {
          rects += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="87" width="' +
            bw.toFixed(1) + '" height="3" rx="1.5" fill="' + hexToRgba(color, 0.18) + '"></rect>';
        } else {
          const h = Math.max(4, (v / max) * 70);
          rects += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + (90 - h).toFixed(1) +
            '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) +
            '" rx="3" fill="' + color + '"></rect>';
        }
      });
      let line = "";
      if (targetLine != null && max) {
        const ty = 90 - clamp01(targetLine / max) * 70;
        line = '<line x1="4" y1="' + ty.toFixed(1) + '" x2="316" y2="' + ty.toFixed(1) +
          '" stroke="' + COLORS.dim + '" stroke-width="1" stroke-dasharray="3,3"></line>';
      }
      return '<svg class="detail-chart" viewBox="0 0 320 100">' + line + rects + "</svg>";
    }

    function bigStacked(days) {
      const COLORS = getColors();
      const n = days.length;
      const maxTotal = Math.max(...days.map(d => (d.deep || 0) + (d.core || 0) + (d.rem || 0) + (d.awake || 0)), 1);
      const slot = (320 - 16) / n, bw = slot * 0.55;
      const seg = [["deep", COLORS.sleepDeep], ["core", COLORS.sleepCore], ["rem", COLORS.cyan], ["awake", COLORS.red]];
      let rects = "";
      days.forEach((d, i) => {
        const cx = 8 + i * slot + slot / 2;
        const total = (d.deep || 0) + (d.core || 0) + (d.rem || 0) + (d.awake || 0);
        if (total <= 0) {
          rects += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="87" width="' +
            bw.toFixed(1) + '" height="3" rx="1.5" fill="' + hexToRgba(COLORS.dim, 0.3) + '"></rect>';
          return;
        }
        const scale = 70 / maxTotal;
        let yBottom = 90;
        seg.forEach(([key, col]) => {
          const v = d[key] || 0;
          if (v <= 0) return;
          const h = v * scale;
          const yTop = yBottom - h;
          rects += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + yTop.toFixed(1) +
            '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) +
            '" rx="1.5" fill="' + col + '"></rect>';
          yBottom = yTop;
        });
      });
      return '<svg class="detail-chart" viewBox="0 0 320 100">' + rects + "</svg>";
    }

    return { sparkLine, sparkBars, bigLine, bigBars, bigStacked };
  }

  global.BioCommandShared = global.BioCommandShared || {};
  global.BioCommandShared.charts = { createChartHelpers };
})(window);
