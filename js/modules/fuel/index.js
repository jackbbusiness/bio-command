"use strict";

/**
 * Runtime dependencies supplied by app.js:
 * - dayKey()
 * - saveDB()
 * - genId()
 * - baselineFor()
 * - loadAI()
 * - armDangerButton()
 * - getDB() / getColors() — accessors rather than plain values, since
 *   DB and COLORS are both reassigned at runtime (import/reset/cloud
 *   sync for DB, theme toggle for COLORS) and the module must always
 *   read the current value rather than one captured at construction.
 */
(function (global) {
  function createFuelModule({ dayKey, saveDB, genId, baselineFor, loadAI, armDangerButton, getDB, getColors }) {
    const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack"];

    /* Evidence-based macro formulas per goal (research: 2.2g/kg protein for fat loss,
       1.8g/kg for muscle gain, all from meta-analyses cited in research pass). */
    const GOAL_CONFIGS = {
      fat_loss:    { label: "Fat Loss",    kcalDelta: -500, proteinGPerKg: 2.2, fatGPerKg: 0.8 },
      muscle_gain: { label: "Muscle Gain", kcalDelta: +300, proteinGPerKg: 1.8, fatGPerKg: 0.8 },
      maintain:    { label: "Maintain",    kcalDelta:    0, proteinGPerKg: 1.6, fatGPerKg: 0.8 },
      recomp:      { label: "Recomp",      kcalDelta: -200, proteinGPerKg: 2.4, fatGPerKg: 1.0 }
    };

    let barcodeScanner = null;
    let barcodeProduct = null;
    let barcodeLocked = false;
    let currentGoal = "fat_loss";
    let mealEditId = null;

    function weekStartKey(d) {
      const dt = d ? new Date(d) : new Date();
      const day = dt.getDay(); // 0 Sun .. 6 Sat
      const diff = (day === 0 ? -6 : 1) - day; // back up to Monday
      const monday = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + diff);
      return dayKey(monday);
    }

    function defaultFuelPlan() {
      const DB = getDB();
      const massKg = DB.operator.targetBodyMassKg || 84;
      const proteinG = Math.round(massKg * DB.operator.targetProteinPerKg);
      return {
        baseTargetKcal: 2400, proteinG, carbG: 260, fatG: 75,
        dynamicAdjustment: true, adjustmentCapPct: 15
      };
    }

    function getOrCreateFuelPlan() {
      const DB = getDB();
      const wk = weekStartKey();
      if (!DB.fuelPlans[wk]) DB.fuelPlans[wk] = defaultFuelPlan();
      return DB.fuelPlans[wk];
    }

    /* Protein stays fixed at plan target. Carb and fat absorb the
       kcal swing, scaled proportionally to the plan's own carb:fat
       gram ratio so the adjustment does not distort the diet shape. */
    function computeAdjustedTargets(plan) {
      const DB = getDB();
      const base = {
        kcal: plan.baseTargetKcal, proteinG: plan.proteinG,
        carbG: plan.carbG, fatG: plan.fatG, adjusted: false, note: ""
      };
      if (!plan.dynamicAdjustment) return base;

      const today = dayKey();
      const yesterday = dayKey(new Date(Date.now() - 86400000));
      const yesterdayRow = DB.telemetry[yesterday];
      const baseline = baselineFor("activeEnergyKcal", today, DB.operator.baselineWindowDays);
      if (!yesterdayRow || yesterdayRow.activeEnergyKcal == null || !baseline) {
        return { ...base, note: "No Garmin activity baseline yet. Using base targets." };
      }

      const capKcal = plan.baseTargetKcal * (plan.adjustmentCapPct / 100);
      const deltaKcal = Math.max(-capKcal, Math.min(capKcal, yesterdayRow.activeEnergyKcal - baseline));
      const adjustedKcal = Math.round(plan.baseTargetKcal + deltaKcal);

      const proteinKcal = plan.proteinG * 4;
      const remainingKcal = Math.max(0, adjustedKcal - proteinKcal);
      const baseCarbFatKcal = plan.carbG * 4 + plan.fatG * 9;
      const carbShare = baseCarbFatKcal > 0 ? (plan.carbG * 4) / baseCarbFatKcal : 0.6;

      const carbG = Math.round((remainingKcal * carbShare) / 4);
      const fatG = Math.round((remainingKcal * (1 - carbShare)) / 9);

      return {
        kcal: adjustedKcal, proteinG: plan.proteinG, carbG, fatG,
        adjusted: Math.abs(deltaKcal) > 5,
        note: deltaKcal > 5 ? "+" + Math.round(deltaKcal) + "kcal, active day yesterday"
            : deltaKcal < -5 ? Math.round(deltaKcal) + "kcal, quiet day yesterday" : ""
      };
    }

    function todaysConsumedTotals() {
      // Legacy function, now delegates to the fuelLog-based approach
      return todaysLoggedTotals();
    }

    function mealMacros(plannedMeal) {
      const DB = getDB();
      if (plannedMeal.templateId) {
        const t = DB.mealTemplates.find(x => x.id === plannedMeal.templateId);
        if (t) return { kcal: t.kcal, proteinG: t.proteinG, carbG: t.carbG, fatG: t.fatG };
      }
      return {
        kcal: plannedMeal.actualKcal || 0, proteinG: plannedMeal.actualProteinG || 0,
        carbG: plannedMeal.actualCarbG || 0, fatG: plannedMeal.actualFatG || 0
      };
    }

    function macroBarHtml(label, consumed, target, color) {
      const pct = target > 0 ? Math.min(100, Math.round(consumed / target * 100)) : 0;
      return '<div class="macro-bar-row"><div class="macro-bar-head"><span>' + label + '</span>' +
        '<span>' + Math.round(consumed) + ' / ' + Math.round(target) + '</span></div>' +
        '<div class="macro-bar-track"><div class="macro-bar-fill" style="width:' + pct +
        '%; background:' + color + ';"></div></div></div>';
    }

    function macroTileHtml(label, consumed, target, color) {
      const COLORS = getColors();
      const pct = target > 0 ? Math.min(100, Math.round(consumed / target * 100)) : 0;
      const col = pct >= 100 ? COLORS.green : pct >= 75 ? COLORS.amber : color;
      return '<div class="macro-ring-tile">' +
        '<span class="macro-ring-val" style="color:' + col + '">' + Math.round(consumed) + '</span>' +
        '<div class="macro-ring-lbl">' + label + '</div>' +
        '<div class="macro-ring-pct" style="color:' + COLORS.dim + '">' + pct + '% of ' + Math.round(target) + '</div>' +
        '</div>';
    }

    function todaysLoggedTotals() {
      const DB = getDB();
      const meals = DB.fuelLog ? DB.fuelLog.filter(m => m.dayKey === dayKey()) : [];
      return meals.reduce((acc, m) => {
        acc.kcal += m.kcal || 0; acc.proteinG += m.proteinG || 0;
        acc.carbG += m.carbG || 0; acc.fatG += m.fatG || 0;
        return acc;
      }, { kcal: 0, proteinG: 0, carbG: 0, fatG: 0 });
    }

    function renderFuelTab() {
      const DB = getDB();
      const COLORS = getColors();
      DB.fuelLog = DB.fuelLog || [];
      const plan = getOrCreateFuelPlan();
      const targets = computeAdjustedTargets(plan);
      const consumed = todaysLoggedTotals();

      document.getElementById("fuel-adjust-note").textContent = targets.note;
      document.getElementById("fuel-macro-tiles").innerHTML =
        macroTileHtml("KCAL", consumed.kcal, targets.kcal, COLORS.cyan) +
        macroTileHtml("PROTEIN", consumed.proteinG, targets.proteinG, COLORS.green) +
        macroTileHtml("CARB", consumed.carbG, targets.carbG, COLORS.amber) +
        macroTileHtml("FAT", consumed.fatG, targets.fatG, COLORS.red);

      const logHost = document.getElementById("meal-log-list");
      const todayMeals = DB.fuelLog.filter(m => m.dayKey === dayKey());
      logHost.innerHTML = todayMeals.length
        ? todayMeals.map((m, i) =>
            '<div class="logged-meal-row">' +
            '<span class="lm-name">' + m.name + '</span>' +
            '<span class="lm-macro">' + m.kcal + ' kcal &middot; ' + m.proteinG + 'p ' + m.carbG + 'c ' + m.fatG + 'f</span>' +
            '<button class="lm-del" data-logdel="' + i + '">&times;</button>' +
            '</div>')
          .join("")
        : '<div class="empty-hint">Nothing logged yet. Describe what you ate above.</div>';
    }

    /* ---------- AI Quick Log ---------- */
    async function aiLogMeal(description) {
      const DB = getDB();
      const COLORS = getColors();
      const status = document.getElementById("fuel-log-status");
      const cfg = loadAI();
      if (!cfg || !cfg.key) { status.textContent = "Set your Anthropic API key in SYS first."; status.style.color = COLORS.red; return; }
      const plan = getOrCreateFuelPlan();
      status.innerHTML = '<span class="ai-thinking">ANALYSING...</span>';
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": cfg.key, "anthropic-version": "2023-06-01",
            "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6", max_tokens: 200,
            messages: [{ role: "user", content:
              "Return ONLY valid JSON, no markdown, no explanation. User ate: \"" + description + "\". " +
              "Estimate: { \"name\": \"<brief label>\", \"kcal\": N, \"proteinG\": N, \"carbG\": N, \"fatG\": N }. " +
              "Use standard UK/restaurant portion sizes. Integers only." }]
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error((data.error && data.error.message) || "HTTP " + res.status);
        const raw = (data.content || []).map(b => b.text || "").join("").trim();
        const obj = JSON.parse(raw.replace(/```json|```/g, "").trim());
        DB.fuelLog = DB.fuelLog || [];
        DB.fuelLog.push({ dayKey: dayKey(), ...obj });
        saveDB(DB);
        renderFuelTab();
        document.getElementById("fuel-log-input").value = "";
        status.textContent = obj.name + " logged: " + obj.kcal + " kcal / " + obj.proteinG + "g protein";
        status.style.color = COLORS.green;
      } catch (e) {
        status.textContent = "Could not parse: " + e.message;
        status.style.color = COLORS.red;
      }
    }

    /* ---------- Barcode scanner + Open Food Facts ---------- */
    function barcodeSetStatus(message, color) {
      const COLORS = getColors();
      const el = document.getElementById("barcode-status");
      if (!el) return;
      el.textContent = message;
      el.style.color = color || COLORS.dim;
    }

    function numOrZero(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }

    function productNutrient(product, key) {
      const n = product && product.nutriments ? product.nutriments : {};
      return numOrZero(n[key + "_100g"] != null ? n[key + "_100g"] : n[key]);
    }

    function normalizeBarcodeProduct(code, product) {
      const servingQuantity = numOrZero(product.serving_quantity) || null;
      return {
        barcode: code,
        name: product.product_name || product.product_name_en || "Unknown product",
        brand: product.brands || "",
        image: product.image_front_small_url || product.image_front_url || "",
        servingQuantity,
        servingLabel: product.serving_size || (servingQuantity ? servingQuantity + " g" : ""),
        per100: {
          kcal: productNutrient(product, "energy-kcal"),
          proteinG: productNutrient(product, "proteins"),
          carbG: productNutrient(product, "carbohydrates"),
          fatG: productNutrient(product, "fat")
        }
      };
    }

    function barcodeCalculatedMacros() {
      if (!barcodeProduct) return null;
      const amountInput = document.getElementById("barcode-amount");
      const unit = document.getElementById("barcode-unit").value;
      const amount = Math.max(0, numOrZero(amountInput.value));
      const grams = unit === "serving"
        ? amount * (barcodeProduct.servingQuantity || 100)
        : amount;
      const factor = grams / 100;
      return {
        grams,
        kcal: Math.round(barcodeProduct.per100.kcal * factor),
        proteinG: Math.round(barcodeProduct.per100.proteinG * factor * 10) / 10,
        carbG: Math.round(barcodeProduct.per100.carbG * factor * 10) / 10,
        fatG: Math.round(barcodeProduct.per100.fatG * factor * 10) / 10
      };
    }

    function renderBarcodeMacros() {
      const host = document.getElementById("barcode-product-macros");
      const m = barcodeCalculatedMacros();
      if (!host || !m) return;
      host.innerHTML = [
        [m.kcal, "KCAL"], [m.proteinG + "g", "PROTEIN"],
        [m.carbG + "g", "CARB"], [m.fatG + "g", "FAT"]
      ].map(x => '<div class="barcode-macro"><strong>' + x[0] + '</strong><span>' + x[1] + '</span></div>').join("");
    }

    function showBarcodeProduct(product) {
      barcodeProduct = product;
      const result = document.getElementById("barcode-result");
      result.hidden = false;
      document.getElementById("barcode-product-name").textContent = product.name;
      document.getElementById("barcode-product-brand").textContent = [product.brand, product.barcode].filter(Boolean).join(" · ");
      const img = document.getElementById("barcode-product-image");
      if (product.image) {
        img.src = product.image;
        img.alt = product.name;
        img.hidden = false;
      } else {
        img.removeAttribute("src");
        img.hidden = true;
      }
      const unit = document.getElementById("barcode-unit");
      const servingOption = unit.querySelector('option[value="serving"]');
      servingOption.disabled = !product.servingQuantity;
      unit.value = product.servingQuantity ? "serving" : "g";
      document.getElementById("barcode-amount").value = product.servingQuantity ? "1" : "100";
      document.getElementById("barcode-serving-note").textContent = product.servingQuantity
        ? "Serving: " + (product.servingLabel || product.servingQuantity + " g") + ". Nutrition is calculated from values per 100 g."
        : "No serving size supplied. Enter the amount consumed in grams.";
      renderBarcodeMacros();
      result.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    async function lookupBarcode(code) {
      const COLORS = getColors();
      code = String(code || "").replace(/\D/g, "");
      if (code.length < 8 || code.length > 14) {
        barcodeSetStatus("Enter a valid 8 to 14 digit barcode.", COLORS.red);
        return;
      }
      if (barcodeLocked) return;
      barcodeLocked = true;
      barcodeSetStatus("Looking up " + code + "...", COLORS.cyan);
      try {
        const fields = ["code","product_name","product_name_en","brands","serving_size","serving_quantity","image_front_small_url","image_front_url","nutriments"].join(",");
        const url = "https://world.openfoodfacts.org/api/v2/product/" + encodeURIComponent(code) + ".json?fields=" + encodeURIComponent(fields);
        const res = await fetch(url, { headers: { "Accept": "application/json" } });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if (data.status !== 1 || !data.product) throw new Error("Product not found");
        const product = normalizeBarcodeProduct(code, data.product);
        if (!product.per100.kcal && !product.per100.proteinG && !product.per100.carbG && !product.per100.fatG) {
          throw new Error("Product found, but nutrition data is missing");
        }
        showBarcodeProduct(product);
        barcodeSetStatus("Product found. Check the amount, then add it.", COLORS.green);
        await stopBarcodeCamera();
      } catch (e) {
        barcodeSetStatus(e.message + ". You can enter another barcode or use Quick Log.", COLORS.red);
      } finally {
        barcodeLocked = false;
      }
    }

    async function stopBarcodeCamera() {
      if (!barcodeScanner) return;
      try {
        if (barcodeScanner.isScanning) await barcodeScanner.stop();
        await barcodeScanner.clear();
      } catch (e) {}
      barcodeScanner = null;
    }

    async function startBarcodeCamera() {
      const COLORS = getColors();
      const reader = document.getElementById("barcode-reader");
      reader.innerHTML = "";
      if (typeof Html5Qrcode === "undefined") {
        barcodeSetStatus("Scanner library could not load. Enter the barcode manually.", COLORS.amber);
        return;
      }
      barcodeSetStatus("Requesting camera access...", COLORS.cyan);
      barcodeScanner = new Html5Qrcode("barcode-reader", { formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.CODE_128
      ]});
      const config = {
        fps: 12,
        qrbox: function(viewWidth, viewHeight) {
          return { width: Math.min(320, Math.floor(viewWidth * 0.86)), height: Math.min(130, Math.floor(viewHeight * 0.42)) };
        },
        aspectRatio: 1.777,
        disableFlip: false
      };
      try {
        await barcodeScanner.start(
          { facingMode: "environment" },
          config,
          function(decodedText) {
            if (!barcodeLocked) {
              document.getElementById("barcode-manual").value = decodedText;
              if (navigator.vibrate) navigator.vibrate(80);
              lookupBarcode(decodedText);
            }
          },
          function() {}
        );
        barcodeSetStatus("Scanning. Hold the barcode steady inside the frame.", COLORS.dim);
      } catch (e) {
        barcodeSetStatus("Camera unavailable: " + e + ". Enter the barcode manually.", COLORS.amber);
      }
    }

    async function openBarcodeScanner() {
      barcodeProduct = null;
      barcodeLocked = false;
      document.getElementById("barcode-result").hidden = true;
      document.getElementById("barcode-manual").value = "";
      const overlay = document.getElementById("barcode-overlay");
      overlay.classList.add("open");
      overlay.setAttribute("aria-hidden", "false");
      document.body.style.overflow = "hidden";
      await startBarcodeCamera();
    }

    async function closeBarcodeScanner() {
      await stopBarcodeCamera();
      const overlay = document.getElementById("barcode-overlay");
      overlay.classList.remove("open");
      overlay.setAttribute("aria-hidden", "true");
      document.body.style.overflow = "";
    }

    /* ---------- AI Meal Planner ---------- */
    async function genMealPlan() {
      const DB = getDB();
      const status = document.getElementById("meal-plan-out");
      const cfg = loadAI();
      if (!cfg || !cfg.key) { status.innerHTML = '<div class="empty-hint">Set Anthropic API key in SYS first.</div>'; return; }
      const massKg = DB.operator.targetBodyMassKg || 84;
      const goalLabel = GOAL_CONFIGS[currentGoal].label;
      const plan = getOrCreateFuelPlan();
      const prefs = document.getElementById("meal-plan-prefs").value.trim();
      const lastHrv = (Object.values(DB.telemetry).sort((a,b)=>b.dayKey.localeCompare(a.dayKey))[0] || {}).hrvMs;
      status.innerHTML = '<div class="ai-thinking">GENERATING WEEK PLAN...</div>';
      try {
        const prompt = "Create a 7-day meal plan for a serious athlete. " +
          "Goal: " + goalLabel + ". Body mass: " + massKg + "kg. " +
          "Daily targets: " + plan.baseTargetKcal + " kcal, " + plan.proteinG + "g protein, " +
          plan.carbG + "g carbs, " + plan.fatG + "g fat. " +
          (prefs ? "Preferences: " + prefs + ". " : "") +
          (lastHrv ? "Current HRV: " + Math.round(lastHrv) + "ms. " : "") +
          "Format: Monday through Sunday. For each day, list Breakfast, Lunch, Dinner, Snack on separate lines. " +
          "Include rough macros per meal. Keep meals practical, whole-food focused, high protein. " +
          "UK English. Plain text, no markdown headers or bullets.";
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": cfg.key, "anthropic-version": "2023-06-01",
            "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1200, messages: [{ role: "user", content: prompt }] })
        });
        const data = await res.json();
        if (!res.ok) throw new Error((data.error && data.error.message) || "HTTP " + res.status);
        const text = (data.content || []).map(b => b.text || "").join("").trim();
        // Store the plan
        const wk = weekStartKey();
        DB.fuelPlans[wk] = DB.fuelPlans[wk] || {};
        DB.fuelPlans[wk].aiPlanText = text;
        DB.fuelPlans[wk].aiPlanGoal = goalLabel;
        saveDB(DB);
        renderMealPlanOut(text, goalLabel);
      } catch (e) {
        status.innerHTML = '<div class="empty-hint">Error: ' + e.message + '</div>';
      }
    }

    function renderMealPlanOut(text, goal) {
      const host = document.getElementById("meal-plan-out");
      if (!text) { host.innerHTML = ""; return; }
      const days = text.split(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i).filter(Boolean);
      let html = '<div class="telemetry cap t3" style="margin-bottom:10px;">' + (goal || "") + ' PLAN</div>';
      for (let i = 0; i < days.length; i += 2) {
        const dayName = days[i];
        const content = days[i + 1] || "";
        html += '<div class="meal-plan-day"><div class="meal-plan-day-head">' + dayName + '</div>';
        content.trim().split(/\n+/).filter(Boolean).forEach(line => {
          html += '<div class="meal-plan-item">' + line.trim() + '</div>';
        });
        html += '</div>';
      }
      host.innerHTML = html || '<div>' + text.split("\n").map(l => '<div class="meal-plan-item">' + l + '</div>').join("") + '</div>';
    }

    // Restore any saved plan on tab open
    function restoreSavedMealPlan() {
      const DB = getDB();
      const wk = weekStartKey();
      const plan = DB.fuelPlans[wk];
      if (plan && plan.aiPlanText) renderMealPlanOut(plan.aiPlanText, plan.aiPlanGoal);
    }

    function renderTemplateList() {
      const DB = getDB();
      const host = document.getElementById("template-list");
      if (!DB.mealTemplates.length) {
        host.innerHTML = '<div class="empty-hint">No templates yet. Tap New to add one.</div>';
        return;
      }
      host.innerHTML = DB.mealTemplates.map(t =>
        '<div class="template-row" data-editmeal="' + t.id + '">' +
        '<span class="tmpl-name">' + t.name + '</span>' +
        '<span class="tmpl-macro">' + t.kcal + 'kcal &middot; ' + t.proteinG + 'p ' + t.carbG + 'c ' + t.fatG + 'f</span>' +
        '</div>'
      ).join("");
    }

    function renderShoppingManifest() {
      const DB = getDB();
      const wk = weekStartKey();
      const weekKeys = [];
      for (let i = 0; i < 7; i++) weekKeys.push(dayKey(new Date(new Date(wk).getTime() + i * 86400000)));
      const meals = DB.plannedMeals.filter(m => weekKeys.includes(m.dayKey) && m.templateId);
      const lines = [];
      meals.forEach(m => {
        const t = DB.mealTemplates.find(x => x.id === m.templateId);
        if (t && t.ingredientsText) {
          t.ingredientsText.split("\n").map(l => l.trim()).filter(Boolean).forEach(l => lines.push(l));
        }
      });
      const host = document.getElementById("shopping-manifest");
      if (!lines.length) {
        host.innerHTML = '<div class="empty-hint">No ingredients yet. Assign templates with ingredients to this week\'s meals.</div>';
        return;
      }
      const counts = {};
      lines.forEach(l => { counts[l] = (counts[l] || 0) + 1; });
      host.innerHTML = Object.keys(counts).map(l =>
        '<div class="manifest-line">' + l + (counts[l] > 1 ? " &times;" + counts[l] : "") + '</div>'
      ).join("");
    }

    /* ---------- Meal template builder ---------- */
    function openMealBuilder(id) {
      const DB = getDB();
      mealEditId = id;
      document.getElementById("meal-builder-status").textContent = "";
      const delBtn = document.getElementById("btn-delete-meal");
      if (id) {
        const t = DB.mealTemplates.find(x => x.id === id);
        document.getElementById("meal-builder-title").textContent = "Edit Template";
        document.getElementById("ml-name").value = t.name;
        document.getElementById("ml-kcal").value = t.kcal;
        document.getElementById("ml-protein").value = t.proteinG;
        document.getElementById("ml-carb").value = t.carbG;
        document.getElementById("ml-fat").value = t.fatG;
        document.getElementById("ml-ingredients").value = t.ingredientsText || "";
        delBtn.style.display = "block";
      } else {
        document.getElementById("meal-builder-title").textContent = "New Template";
        document.getElementById("ml-name").value = "";
        document.getElementById("ml-kcal").value = "";
        document.getElementById("ml-protein").value = "";
        document.getElementById("ml-carb").value = "";
        document.getElementById("ml-fat").value = "";
        document.getElementById("ml-ingredients").value = "";
        delBtn.style.display = "none";
      }
      document.getElementById("meal-builder-overlay").classList.add("open");
    }

    function renderFuel() {
      renderFuelTab();
      renderTemplateList();
      renderShoppingManifest();
      restoreSavedMealPlan();
    }

    function init() {
      document.getElementById("meal-log-list").addEventListener("click", (ev) => {
        const DB = getDB();
        if (ev.target.dataset.logdel == null) return;
        const today = dayKey();
        const todayIdxs = DB.fuelLog.reduce((arr, m, i) => { if (m.dayKey === today) arr.push(i); return arr; }, []);
        const globalIdx = todayIdxs[Number(ev.target.dataset.logdel)];
        if (globalIdx != null) DB.fuelLog.splice(globalIdx, 1);
        saveDB(DB);
        renderFuelTab();
      });

      document.getElementById("btn-fuel-log").addEventListener("click", () => {
        const v = document.getElementById("fuel-log-input").value.trim();
        if (v) aiLogMeal(v);
      });
      document.getElementById("fuel-log-input").addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); const v = ev.target.value.trim(); if (v) aiLogMeal(v); }
      });

      document.getElementById("btn-barcode-scan").addEventListener("click", openBarcodeScanner);
      document.getElementById("btn-barcode-close").addEventListener("click", closeBarcodeScanner);
      document.getElementById("btn-barcode-lookup").addEventListener("click", function() {
        lookupBarcode(document.getElementById("barcode-manual").value);
      });
      document.getElementById("barcode-manual").addEventListener("keydown", function(ev) {
        if (ev.key === "Enter") { ev.preventDefault(); lookupBarcode(ev.target.value); }
      });
      document.getElementById("barcode-amount").addEventListener("input", renderBarcodeMacros);
      document.getElementById("barcode-unit").addEventListener("change", renderBarcodeMacros);
      document.getElementById("btn-barcode-add").addEventListener("click", async function() {
        const DB = getDB();
        const COLORS = getColors();
        const macros = barcodeCalculatedMacros();
        if (!barcodeProduct || !macros || macros.grams <= 0) return;
        DB.fuelLog = DB.fuelLog || [];
        DB.fuelLog.push({
          dayKey: dayKey(),
          name: barcodeProduct.name,
          kcal: macros.kcal,
          proteinG: macros.proteinG,
          carbG: macros.carbG,
          fatG: macros.fatG,
          source: "barcode",
          barcode: barcodeProduct.barcode,
          amountG: Math.round(macros.grams)
        });
        saveDB(DB);
        renderFuelTab();
        const status = document.getElementById("fuel-log-status");
        status.textContent = barcodeProduct.name + " logged: " + macros.kcal + " kcal / " + macros.proteinG + "g protein";
        status.style.color = COLORS.green;
        await closeBarcodeScanner();
      });

      /* ---------- Goal chips + plan auto-calculator ---------- */
      document.getElementById("goal-chips").addEventListener("click", (ev) => {
        const btn = ev.target.closest(".goal-chip");
        if (!btn) return;
        currentGoal = btn.dataset.goal;
        document.querySelectorAll(".goal-chip").forEach(b => b.classList.toggle("active", b.dataset.goal === currentGoal));
      });

      document.getElementById("btn-fuel-goal").addEventListener("click", () => {
        const DB = getDB();
        const massKg = DB.operator.targetBodyMassKg || 84;
        const baseline = baselineFor("activeEnergyKcal", dayKey(), DB.operator.baselineWindowDays);
        const basal = (DB.operator.basalKcal || null);
        const tdee = baseline ? Math.round(baseline + (basal || 1800)) : 2400;
        const cfg = GOAL_CONFIGS[currentGoal] || GOAL_CONFIGS.maintain;
        const kcal = Math.max(1200, tdee + cfg.kcalDelta);
        const proteinG = Math.round(massKg * cfg.proteinGPerKg);
        const fatG = Math.round(massKg * cfg.fatGPerKg);
        const carbG = Math.max(50, Math.round((kcal - proteinG * 4 - fatG * 9) / 4));
        const plan = getOrCreateFuelPlan();
        plan.baseTargetKcal = kcal; plan.proteinG = proteinG; plan.carbG = carbG; plan.fatG = fatG;
        saveDB(DB);
        renderFuelTab();
        document.getElementById("fuel-adjust-note").textContent =
          cfg.label + " plan set: " + kcal + " kcal, " + proteinG + "g P / " + carbG + "g C / " + fatG + "g F";
      });

      document.getElementById("btn-gen-plan").addEventListener("click", genMealPlan);

      document.getElementById("template-list").addEventListener("click", (ev) => {
        const id = ev.target.closest("[data-editmeal]");
        if (id) openMealBuilder(id.dataset.editmeal);
      });

      /* ---------- Fuel plan overlay ---------- */
      document.getElementById("btn-edit-fuel-plan") && document.getElementById("btn-edit-fuel-plan").addEventListener("click", () => {
        const plan = getOrCreateFuelPlan();
        document.getElementById("fp-kcal").value = plan.baseTargetKcal;
        document.getElementById("fp-protein").value = plan.proteinG;
        document.getElementById("fp-carb").value = plan.carbG;
        document.getElementById("fp-fat").value = plan.fatG;
        document.getElementById("fp-dynamic").checked = plan.dynamicAdjustment;
        document.getElementById("fp-cap").value = plan.adjustmentCapPct;
        document.getElementById("fuel-plan-overlay").classList.add("open");
      });
      document.getElementById("btn-cancel-fuel-plan").addEventListener("click", () => {
        document.getElementById("fuel-plan-overlay").classList.remove("open");
      });
      document.getElementById("btn-save-fuel-plan").addEventListener("click", () => {
        const DB = getDB();
        const plan = getOrCreateFuelPlan();
        plan.baseTargetKcal = Number(document.getElementById("fp-kcal").value) || plan.baseTargetKcal;
        plan.proteinG = Number(document.getElementById("fp-protein").value) || plan.proteinG;
        plan.carbG = Number(document.getElementById("fp-carb").value) || plan.carbG;
        plan.fatG = Number(document.getElementById("fp-fat").value) || plan.fatG;
        plan.dynamicAdjustment = document.getElementById("fp-dynamic").checked;
        plan.adjustmentCapPct = Number(document.getElementById("fp-cap").value) || 0;
        saveDB(DB);
        document.getElementById("fuel-plan-overlay").classList.remove("open");
        renderFuelTab();
      });

      /* ---------- Meal template builder ---------- */
      document.getElementById("btn-new-meal").addEventListener("click", () => openMealBuilder(null));
      document.getElementById("btn-cancel-meal").addEventListener("click", () => {
        document.getElementById("meal-builder-overlay").classList.remove("open");
      });
      document.getElementById("btn-save-meal").addEventListener("click", () => {
        const DB = getDB();
        const COLORS = getColors();
        const status = document.getElementById("meal-builder-status");
        const name = document.getElementById("ml-name").value.trim();
        if (!name) { status.textContent = "Name the meal first."; status.style.color = COLORS.red; return; }
        const data = {
          name,
          kcal: Number(document.getElementById("ml-kcal").value) || 0,
          proteinG: Number(document.getElementById("ml-protein").value) || 0,
          carbG: Number(document.getElementById("ml-carb").value) || 0,
          fatG: Number(document.getElementById("ml-fat").value) || 0,
          ingredientsText: document.getElementById("ml-ingredients").value
        };
        if (mealEditId) {
          const t = DB.mealTemplates.find(x => x.id === mealEditId);
          Object.assign(t, data);
        } else {
          DB.mealTemplates.push({ id: genId("meal-t"), ...data });
        }
        saveDB(DB);
        document.getElementById("meal-builder-overlay").classList.remove("open");
        renderTemplateList();
        renderFuelTab();
        renderShoppingManifest();
      });
      document.getElementById("btn-delete-meal").addEventListener("click", (ev) => {
        const DB = getDB();
        if (!mealEditId) return;
        armDangerButton(ev.currentTarget, "Delete", () => {
          DB.mealTemplates = DB.mealTemplates.filter(t => t.id !== mealEditId);
          DB.plannedMeals.forEach(m => { if (m.templateId === mealEditId) m.templateId = null; });
          saveDB(DB);
          document.getElementById("meal-builder-overlay").classList.remove("open");
          renderTemplateList();
          renderFuelTab();
          renderShoppingManifest();
        });
      });
    }

    return { init, render: renderFuel };
  }

  global.BioCommandFuel = { createFuelModule };
})(window);
