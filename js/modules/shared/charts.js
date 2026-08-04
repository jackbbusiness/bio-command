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

  // Catmull-Rom-to-Bezier smoothing for a run of consecutive (no-gap)
  // points, so lines read as smooth curves instead of straight
  // segments. Gaps in the data (missing days) still break the path
  // the same way the old "M vs L" logic did -- smoothing only ever
  // runs within one unbroken run of real values.
  function smoothRunPath(pts) {
    if (pts.length === 1) return "M" + pts[0].x.toFixed(1) + " " + pts[0].y.toFixed(1) + " ";
    let d = "M" + pts[0].x.toFixed(1) + " " + pts[0].y.toFixed(1) + " ";
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      d += "C" + c1x.toFixed(1) + " " + c1y.toFixed(1) + " " + c2x.toFixed(1) + " " +
        c2y.toFixed(1) + " " + p2.x.toFixed(1) + " " + p2.y.toFixed(1) + " ";
    }
    return d;
  }

  function smoothPath(defined, x, y) {
    const runs = [];
    let run = [];
    defined.forEach((p, idx) => {
      if (idx > 0 && p.i !== defined[idx - 1].i + 1) { runs.push(run); run = []; }
      run.push({ x: x(p.i), y: y(p.v) });
    });
    if (run.length) runs.push(run);
    return runs.map(smoothRunPath).join("");
  }

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

    // `band` (optional [low, high], either end nullable) shades a
    // reference range behind the line -- used for the biomarker trend
    // chart's optimal-range context. The data domain expands to
    // include the band so it's never shaded entirely off-chart when
    // all logged values sit outside it.
    function bigLine(values, color, labels, band) {
      const n = values.length;
      const defined = values.map((v, i) => ({ v, i })).filter(p => p.v != null);
      if (!defined.length) return '<svg class="detail-chart" viewBox="0 0 320 100"></svg>';
      const vals = defined.map(p => p.v);
      let min = Math.min(...vals), max = Math.max(...vals);
      if (band) {
        if (band[0] != null) min = Math.min(min, band[0]);
        if (band[1] != null) max = Math.max(max, band[1]);
      }
      const pad = (max - min) * 0.18 || Math.max(1, max * 0.05);
      const lo = min - pad, hi = max + pad;
      const x = i => 14 + i * (320 - 28) / Math.max(1, n - 1);
      const y = v => 90 - (v - lo) / (hi - lo) * 66;

      let bandRect = "";
      if (band && (band[0] != null || band[1] != null)) {
        const bTop = y(band[1] != null ? band[1] : hi);
        const bBottom = y(band[0] != null ? band[0] : lo);
        bandRect = '<rect x="14" y="' + bTop.toFixed(1) + '" width="292" height="' + (bBottom - bTop).toFixed(1) +
          '" fill="' + hexToRgba(color, 0.1) + '" stroke="none"></rect>';
      }

      const d = smoothPath(defined, x, y);
      const last = defined[defined.length - 1];
      const area = defined.length > 1
        ? '<path d="' + d + "L" + x(last.i).toFixed(1) + " 90 L" +
          x(defined[0].i).toFixed(1) + ' 90 Z" fill="' + hexToRgba(color, 0.1) + '" stroke="none"></path>'
        : "";
      const dots = defined.map(p => {
        const label = labels && labels[p.i] != null ? labels[p.i] : "";
        return '<circle cx="' + x(p.i).toFixed(1) + '" cy="' + y(p.v).toFixed(1) +
          '" r="2.6" fill="' + color + '"></circle>' +
          '<circle class="chart-hit" cx="' + x(p.i).toFixed(1) + '" cy="' + y(p.v).toFixed(1) +
          '" r="11" fill="transparent" data-val="' + p.v + '" data-label="' + label + '"></circle>';
      }).join("");
      return '<svg class="detail-chart" viewBox="0 0 320 100">' + bandRect + area +
        '<path d="' + d + '" fill="none" stroke="' + color +
        '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>' +
        dots + "</svg>";
    }

    function bigBars(values, color, fixedMax, targetLine, labels) {
      const COLORS = getColors();
      const n = values.length;
      const max = fixedMax || Math.max(...values.filter(v => v != null), 1);
      const slot = (320 - 16) / n, bw = slot * 0.55;
      let rects = "";
      values.forEach((v, i) => {
        const cx = 8 + i * slot + slot / 2;
        const label = labels && labels[i] != null ? labels[i] : "";
        const hit = '<rect class="chart-hit" x="' + (cx - slot / 2).toFixed(1) + '" y="20" width="' +
          slot.toFixed(1) + '" height="70" fill="transparent" data-val="' + (v == null ? "" : v) +
          '" data-label="' + label + '"></rect>';
        if (v == null || v <= 0) {
          rects += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="87" width="' +
            bw.toFixed(1) + '" height="3" rx="1.5" fill="' + hexToRgba(color, 0.18) + '"></rect>' + hit;
        } else {
          const h = Math.max(4, (v / max) * 70);
          rects += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + (90 - h).toFixed(1) +
            '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) +
            '" rx="3" fill="' + color + '"></rect>' + hit;
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

    // Overlays N smoothed lines on one 320x100 canvas, each series
    // normalized against its own [min,max] domain (so e.g. a 0-100
    // recovery score and a 0-21 strain score can share one chart
    // meaningfully, matching how the old History trend bars
    // normalized recovery/strain independently). Each series:
    // { values, color, domain: [min,max], seriesLabel, pointLabels }.
    // Hit targets carry the *actual* (non-normalized) value.
    function bigMultiLine(series) {
      const n = Math.max(0, ...series.map(s => s.values.length));
      const x = i => 14 + i * (320 - 28) / Math.max(1, n - 1);
      let paths = "", hits = "";
      series.forEach(s => {
        const [dmin, dmax] = s.domain;
        const y = v => 90 - clamp01((v - dmin) / (dmax - dmin || 1)) * 66;
        const defined = s.values.map((v, i) => ({ v, i })).filter(p => p.v != null);
        if (!defined.length) return;
        const d = smoothPath(defined, x, y);
        paths += '<path d="' + d + '" fill="none" stroke="' + s.color +
          '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>';
        defined.forEach(p => {
          const ptLabel = s.pointLabels && s.pointLabels[p.i] != null ? s.pointLabels[p.i] : "";
          const label = (s.seriesLabel ? s.seriesLabel + (ptLabel ? " " + ptLabel : "") : ptLabel);
          hits += '<circle cx="' + x(p.i).toFixed(1) + '" cy="' + y(p.v).toFixed(1) +
            '" r="2.6" fill="' + s.color + '"></circle>' +
            '<circle class="chart-hit" cx="' + x(p.i).toFixed(1) + '" cy="' + y(p.v).toFixed(1) +
            '" r="11" fill="transparent" data-val="' + p.v + '" data-label="' + label + '"></circle>';
        });
      });
      return '<svg class="detail-chart" viewBox="0 0 320 100">' + paths + hits + "</svg>";
    }

    // Wires tap/hover tooltips onto a chart SVG's invisible `.chart-hit`
    // marks (added by bigLine/bigBars when a `labels` array is passed).
    // A no-op if the chart wasn't built with labels -- no .chart-hit
    // elements means nothing to attach to.
    function wireChartTooltip(svgEl) {
      if (!svgEl) return null;
      const container = svgEl.parentElement;
      if (!container) return null;
      if (getComputedStyle(container).position === "static") {
        container.style.position = "relative";
      }
      let tip = container.querySelector(".chart-tooltip");
      if (!tip) {
        tip = document.createElement("div");
        tip.className = "chart-tooltip";
        container.appendChild(tip);
      }
      function hide() { tip.classList.remove("show"); }
      function show(hitEl) {
        const val = hitEl.getAttribute("data-val");
        if (val === "" || val == null) { hide(); return; }
        const label = hitEl.getAttribute("data-label");
        tip.textContent = (label ? label + ": " : "") + val;
        let px, py;
        if (hitEl.hasAttribute("cx")) {
          px = parseFloat(hitEl.getAttribute("cx"));
          py = parseFloat(hitEl.getAttribute("cy"));
        } else {
          px = parseFloat(hitEl.getAttribute("x")) + parseFloat(hitEl.getAttribute("width")) / 2;
          py = parseFloat(hitEl.getAttribute("y"));
        }
        const svgRect = svgEl.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const vb = svgEl.viewBox.baseVal;
        const scaleX = svgRect.width / vb.width, scaleY = svgRect.height / vb.height;
        tip.style.left = ((svgRect.left - containerRect.left) + px * scaleX) + "px";
        tip.style.top = ((svgRect.top - containerRect.top) + py * scaleY) + "px";
        tip.classList.add("show");
      }
      svgEl.addEventListener("click", (e) => {
        const hit = e.target.closest && e.target.closest(".chart-hit");
        if (hit) show(hit); else hide();
      });
      document.addEventListener("click", (e) => {
        if (!container.contains(e.target)) hide();
      });
      return { hide };
    }

    return { sparkLine, sparkBars, bigLine, bigBars, bigStacked, bigMultiLine, wireChartTooltip };
  }

  global.BioCommandShared = global.BioCommandShared || {};
  global.BioCommandShared.charts = { createChartHelpers };
})(window);
