/* ===== helpers ===== */

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function pad2(n) { return String(Math.round(n)).padStart(2, "0"); }

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function formatDuration(totalSeconds) {
  totalSeconds = Math.round(totalSeconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

function formatDateTime(dateStr, timeStr) {
  if (!dateStr) return "—";
  const [y, mo, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, mo - 1, d);
  const dateLabel = dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  if (!timeStr) return dateLabel;
  return `${dateLabel}, ${timeStr}`;
}

/* ===== domain calculations =====
   Only distance / steps / avg heart rate are the required outputs.
   Calories and max speed are derived extras purely to mirror the
   reference watch-app layout (calories uses an optional body weight). */

function computeStats({ avgSpeedKmh, durationSeconds, weightKg }) {
  const durationHours = durationSeconds / 3600;
  const distanceKm = avgSpeedKmh * durationHours;

  // Faster running pace -> longer stride -> fewer steps per km.
  const stepsPerKm = clamp(1300 - (avgSpeedKmh - 8) * 40, 900, 1700);
  const steps = Math.round(distanceKm * stepsPerKm);

  // Speed -> heart rate zone mapping for running, plus a small "cardiac
  // drift" bump for longer runs (HR creeps up over time at constant pace).
  const durationMinutes = durationSeconds / 60;
  const cardiacDrift = clamp((durationMinutes - 15) * 0.15, 0, 12);
  const avgHeartRate = Math.round(clamp(108 + avgSpeedKmh * 4.5 + cardiacDrift, 95, 195));
  const maxHeartRate = Math.round(clamp(avgHeartRate + 14 + avgSpeedKmh * 0.6, avgHeartRate + 5, 205));

  const maxSpeedKmh = Math.round(avgSpeedKmh * 1.28 * 100) / 100;

  // MET estimate scaling with running speed, used only for the calorie extra.
  const met = clamp(avgSpeedKmh * 1.05, 4, 18);
  const calories = Math.round(met * weightKg * durationHours);

  return { distanceKm, steps, avgHeartRate, maxHeartRate, maxSpeedKmh, calories };
}

/* ===== chart series generation =====
   Speed and heart rate behave differently over a run, so each gets its
   own envelope instead of sharing one shape scaled to different units:
   speed reacts instantly (quick ramp, jagged, sharp peak, drops off
   fast when you stop) while heart rate lags behind effort (slower
   climb, smoother, stays elevated after you slow down). */

function smooth(values, window = 3) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    let sum = 0, count = 0;
    for (let k = -window; k <= window; k++) {
      const j = i + k;
      if (j >= 0 && j < values.length) { sum += values[j]; count++; }
    }
    out.push(sum / count);
  }
  return out;
}

function generateSpeedSeries({ avg, max, seed, points }) {
  const rand = mulberry32(seed);
  const rampEnd = Math.round(points * 0.08);
  const cooldownStart = Math.round(points * 0.88);
  const peakIdx = Math.round(points * (0.2 + rand() * 0.25));

  const values = [];
  for (let i = 0; i < points; i++) {
    let base;
    if (i < rampEnd) {
      base = (avg * 0.9) * (i / Math.max(1, rampEnd));
    } else if (i < cooldownStart) {
      base = avg;
    } else {
      const t = (i - cooldownStart) / Math.max(1, points - 1 - cooldownStart);
      base = avg * (1 - 0.85 * t); // sharp drop-off once the run ends
    }
    const noise = (rand() - 0.5) * avg * 0.4; // jagged, reacts every step
    let v = base + noise;
    if (Math.abs(i - peakIdx) <= 1) v = max * (0.9 + rand() * 0.1);
    values.push(clamp(v, 0, max * 1.05));
  }
  return values;
}

function generateHrSeries({ avg, max, floor, seed, points }) {
  const rand = mulberry32(seed);
  const rampEnd = Math.round(points * 0.22); // heart rate climbs slower than speed
  const cooldownStart = Math.round(points * 0.9);
  const bumpIdx = Math.round(points * (0.45 + rand() * 0.25)); // lags the speed peak

  const raw = [];
  for (let i = 0; i < points; i++) {
    let base;
    if (i < rampEnd) {
      base = floor + (avg - floor) * (i / Math.max(1, rampEnd));
    } else if (i < cooldownStart) {
      base = avg;
    } else {
      const t = (i - cooldownStart) / Math.max(1, points - 1 - cooldownStart);
      base = avg - (avg - avg * 0.82) * t; // stays elevated, only eases off
    }
    if (i >= bumpIdx - 2 && i <= bumpIdx + 2) base = avg + (max - avg) * 0.7;
    const noise = (rand() - 0.5) * (avg - floor) * 0.14; // smoother than speed
    raw.push(clamp(base + noise, floor * 0.85, max * 1.02));
  }
  return smooth(raw, 2);
}

function buildChart(svgEl, values, { color, maxY, minY = 0 }) {
  const W = 320, H = 140, padTop = 6, padBottom = 6;
  const usableH = H - padTop - padBottom;
  const step = W / (values.length - 1);
  const gradId = "grad-" + Math.random().toString(36).slice(2, 9);

  const toY = (v) => padTop + usableH - ((v - minY) / (maxY - minY || 1)) * usableH;

  let points = values.map((v, i) => `${(i * step).toFixed(1)},${toY(v).toFixed(1)}`).join(" ");
  let areaPoints = `0,${H} ${points} ${W},${H}`;

  svgEl.innerHTML = `
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="${areaPoints}" fill="url(#${gradId})"></polygon>
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>
  `;
}

function buildXAxis(el, durationSeconds, count = 4) {
  el.innerHTML = "";
  for (let i = 0; i <= count; i++) {
    const s = document.createElement("span");
    s.textContent = formatDuration((durationSeconds * i) / count);
    el.appendChild(s);
  }
}

/* ===== DOM wiring ===== */

const els = {
  photoInput: document.getElementById("photoInput"),
  avatarPicker: document.getElementById("avatarPicker"),
  avatarPreview: document.getElementById("avatarPreview"),
  avatarPlaceholder: document.getElementById("avatarPlaceholder"),

  nameInput: document.getElementById("nameInput"),
  dateInput: document.getElementById("dateInput"),
  timeInput: document.getElementById("timeInput"),
  durHours: document.getElementById("durHours"),
  durMinutes: document.getElementById("durMinutes"),
  durSeconds: document.getElementById("durSeconds"),
  speedInput: document.getElementById("speedInput"),
  weightInput: document.getElementById("weightInput"),
  deviceInput: document.getElementById("deviceInput"),
  calcBtn: document.getElementById("calcBtn"),
  backBtn: document.getElementById("backBtn"),

  formStep: document.getElementById("formStep"),
  resultStep: document.getElementById("resultStep"),
  stepDot1: document.getElementById("stepDot1"),
  stepDot2: document.getElementById("stepDot2"),

  resultAvatar: document.getElementById("resultAvatar"),
  resultAvatarPlaceholder: document.getElementById("resultAvatarPlaceholder"),
  outName: document.getElementById("outName"),
  outDateTime: document.getElementById("outDateTime"),
  outDistance: document.getElementById("outDistance"),
  paceFill: document.getElementById("paceFill"),
  outTime: document.getElementById("outTime"),
  outAvgSpeed: document.getElementById("outAvgSpeed"),
  outAvgHr: document.getElementById("outAvgHr"),
  outCalories: document.getElementById("outCalories"),
  outSteps: document.getElementById("outSteps"),
  outMaxSpeed: document.getElementById("outMaxSpeed"),
  outDevice: document.getElementById("outDevice"),

  chartAvgSpeed: document.getElementById("chartAvgSpeed"),
  chartMaxSpeed: document.getElementById("chartMaxSpeed"),
  chartAvgHr: document.getElementById("chartAvgHr"),
  chartMaxHr: document.getElementById("chartMaxHr"),
  speedChart: document.getElementById("speedChart"),
  hrChart: document.getElementById("hrChart"),
  speedXAxis: document.getElementById("speedXAxis"),
  hrXAxis: document.getElementById("hrXAxis"),
};

// default date = today
els.dateInput.value = new Date().toISOString().slice(0, 10);

els.avatarPicker.addEventListener("click", () => els.photoInput.click());

els.photoInput.addEventListener("change", () => {
  const file = els.photoInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const url = e.target.result;
    els.avatarPreview.src = url;
    els.avatarPreview.hidden = false;
    els.avatarPlaceholder.hidden = true;

    els.resultAvatar.src = url;
    els.resultAvatar.hidden = false;
    els.resultAvatarPlaceholder.hidden = true;
    render();
  };
  reader.readAsDataURL(file);
});

function getDurationSeconds() {
  const h = Number(els.durHours.value) || 0;
  const m = Number(els.durMinutes.value) || 0;
  const s = Number(els.durSeconds.value) || 0;
  return Math.max(0, h * 3600 + m * 60 + s);
}

function render() {
  const name = els.nameInput.value.trim() || "Runner";
  const deviceName = els.deviceInput.value.trim() || "Running Tracker";
  const dateStr = els.dateInput.value;
  const timeStr = els.timeInput.value;
  const durationSeconds = getDurationSeconds();
  const avgSpeedKmh = Math.max(0, Number(els.speedInput.value) || 0);
  const weightKg = Math.max(20, Number(els.weightInput.value) || 65);

  const stats = computeStats({ avgSpeedKmh, durationSeconds, weightKg });

  els.outName.textContent = name;
  els.outDevice.textContent = deviceName;
  els.outDateTime.textContent = formatDateTime(dateStr, timeStr);
  els.outDistance.textContent = stats.distanceKm.toFixed(2);
  els.outTime.textContent = formatDuration(durationSeconds);
  els.outAvgSpeed.textContent = avgSpeedKmh.toFixed(2);
  els.outAvgHr.textContent = stats.avgHeartRate;
  els.outCalories.textContent = stats.calories;
  els.outSteps.textContent = stats.steps.toLocaleString();
  els.outMaxSpeed.textContent = stats.maxSpeedKmh.toFixed(2);

  // pace bar marker: position by speed within a 0-20 km/h scale
  const pacePct = clamp((avgSpeedKmh / 20) * 100, 2, 98);
  els.paceFill.style.left = pacePct + "%";

  els.chartAvgSpeed.textContent = avgSpeedKmh.toFixed(2);
  els.chartMaxSpeed.textContent = stats.maxSpeedKmh.toFixed(2);
  els.chartAvgHr.textContent = stats.avgHeartRate;
  els.chartMaxHr.textContent = stats.maxHeartRate;

  // Include a fresh random nonce so the chart's wiggle/noise pattern
  // looks different on every calculation, even with identical inputs -
  // only the envelope (ramp/plateau/cooldown) stays tied to the stats.
  const seedBase = `${name}|${dateStr}|${timeStr}|${durationSeconds}|${avgSpeedKmh}|${Math.random()}`;
  const points = clamp(Math.round(durationSeconds / 20), 20, 90);

  const speedSeries = generateSpeedSeries({
    avg: avgSpeedKmh, max: stats.maxSpeedKmh, seed: hashStr(seedBase + "|speed"), points,
  });
  const hrSeries = generateHrSeries({
    avg: stats.avgHeartRate, max: stats.maxHeartRate, floor: 70, seed: hashStr(seedBase + "|hr"), points,
  });

  buildChart(els.speedChart, speedSeries, { color: "#3d8bff", maxY: Math.max(stats.maxSpeedKmh * 1.1, 1) });
  buildChart(els.hrChart, hrSeries, { color: "#ff5470", maxY: Math.max(stats.maxHeartRate * 1.1, 10), minY: 40 });

  buildXAxis(els.speedXAxis, durationSeconds);
  buildXAxis(els.hrXAxis, durationSeconds);
}

[
  els.nameInput, els.dateInput, els.timeInput,
  els.durHours, els.durMinutes, els.durSeconds,
  els.speedInput, els.weightInput, els.deviceInput,
].forEach((el) => el.addEventListener("input", render));

function goToStep(step) {
  const isResult = step === "result";
  els.formStep.classList.toggle("active", !isResult);
  els.resultStep.classList.toggle("active", isResult);
  els.stepDot1.classList.toggle("active", !isResult);
  els.stepDot2.classList.toggle("active", isResult);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

els.calcBtn.addEventListener("click", () => {
  render();
  goToStep("result");
});

els.backBtn.addEventListener("click", () => goToStep("form"));

render();
