const connectBtns = [
  document.getElementById("connectSensor1Btn"),
  document.getElementById("connectSensor2Btn")
];
const startVizBtn = document.getElementById("startVizBtn");
const stopVizBtn = document.getElementById("stopVizBtn");
const startTrialBtn = document.getElementById("startTrialBtn");
const stopTrialBtn = document.getElementById("stopTrialBtn");
const statusEl = document.getElementById("status");
const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");
const mvcInputs = [document.getElementById("mvcInput1"), document.getElementById("mvcInput2")];
const maxRmsEls = [document.getElementById("maxRms1"), document.getElementById("maxRms2")];

const WINDOW_SECONDS = 30;
const RMS_WINDOW_SECONDS = 0.1;
const MIN_POINTS = 300;
const MAX_POINTS = 4000;
const HP_ALPHA = 0.95;
const LP_ALPHA = 0.2;
const MAX_FPS = 25;

let vizRunning = true;
let estimatedDtMs = 10;
let lastSampleTime = null;
let mvcReferenceMv = mvcInputs.map((i) => parseFloat(i.value) || 100);
let sensors = [createSensor(), createSensor()];
let ports = [null, null];
let readers = [null, null];
let lineBuffers = ["", ""];
let latest = [0, 0];
let trialActive = false;
let trialStart = 0;
let trialRows = [];
let needsRedraw = false;
let lastDrawTs = 0;

function createSensor() {
  return {
    bandpass: [],
    rectified: [],
    smoothed: [],
    normalized: [],
    hpState: 0,
    prevInput: 0,
    lpState: 0,
    lastMaxUpdate: 0
  };
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function getWindowPoints() {
  const points = Math.round((WINDOW_SECONDS * 1000) / estimatedDtMs);
  return Math.max(MIN_POINTS, Math.min(MAX_POINTS, points));
}

function trim(arr) {
  const n = getWindowPoints();
  if (arr.length > n) arr.splice(0, arr.length - n);
}

function scheduleDraw() {
  needsRedraw = true;
}

function drawLoop(ts) {
  if (vizRunning && needsRedraw && ts - lastDrawTs > 1000 / MAX_FPS) {
    draw();
    needsRedraw = false;
    lastDrawTs = ts;
  }
  requestAnimationFrame(drawLoop);
}
requestAnimationFrame(drawLoop);

mvcInputs.forEach((input, idx) =>
  input.addEventListener("change", () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v) && v > 0) mvcReferenceMv[idx] = v;
  })
);

connectBtns.forEach((btn, idx) =>
  btn.addEventListener("click", () => connectSerial(idx))
);

startVizBtn.addEventListener("click", () => {
  vizRunning = true;
  scheduleDraw();
  setStatus("Visualization running.");
});

stopVizBtn.addEventListener("click", () => {
  vizRunning = false;
  setStatus("Visualization paused.");
});

startTrialBtn.addEventListener("click", startTrial);
stopTrialBtn.addEventListener("click", stopTrialAndDownload);

async function connectSerial(sensorIdx) {
  try {
    if (!navigator.serial) throw new Error("Web Serial unavailable.");
    if (readers[sensorIdx]) throw new Error("Already connected.");

    ports[sensorIdx] = await navigator.serial.requestPort();
    await ports[sensorIdx].open({ baudRate: 115200 });
    readers[sensorIdx] = ports[sensorIdx].readable.getReader();

    setStatus(`Sensor ${sensorIdx + 1} connected.`);
    readSerialLoop(sensorIdx);
  } catch (err) {
    setStatus(`Sensor ${sensorIdx + 1} failed: ${err.message}`, true);
  }
}

async function readSerialLoop(sensorIdx) {
  const decoder = new TextDecoder();

  while (readers[sensorIdx]) {
    const { value, done } = await readers[sensorIdx].read();
    if (done) break;
    if (!value) continue;

    lineBuffers[sensorIdx] += decoder.decode(value, { stream: true });
    processBufferedLines(sensorIdx);
  }
}

function processBufferedLines(sensorIdx) {
  const lines = lineBuffers[sensorIdx].split(/\r?\n/);
  lineBuffers[sensorIdx] = lines.pop() || "";

  for (const line of lines) {
    const nums = line.trim().split(",").map(Number);
    if (nums.length && Number.isFinite(nums[0])) processSample(sensorIdx, nums[0]);
  }
}

function processSample(sensorIdx, rawMv) {
  const now = performance.now();
  if (lastSampleTime !== null) {
    const dt = now - lastSampleTime;
    if (dt > 0 && dt < 200) estimatedDtMs = 0.95 * estimatedDtMs + 0.05 * dt;
  }
  lastSampleTime = now;
  latest[sensorIdx] = rawMv;

  const s = sensors[sensorIdx];

  const hp = HP_ALPHA * (s.hpState + rawMv - s.prevInput);
  s.hpState = hp;
  s.prevInput = rawMv;

  const bp = s.lpState + LP_ALPHA * (hp - s.lpState);
  s.lpState = bp;
  s.bandpass.push(bp);
  trim(s.bandpass);

  const rect = Math.abs(bp);
  s.rectified.push(rect);
  trim(s.rectified);

  const rmsWindow = Math.max(1, Math.round((RMS_WINDOW_SECONDS * 1000) / estimatedDtMs));
  const recent = s.rectified.slice(-rmsWindow);
  const rms = Math.sqrt(recent.reduce((a, b) => a + b * b, 0) / recent.length);
  s.smoothed.push(rms);
  trim(s.smoothed);

  const norm = (rms / mvcReferenceMv[sensorIdx]) * 100;
  s.normalized.push(norm);
  trim(s.normalized);

  // Update displayed max RMS at lower rate to reduce UI overhead
  if (now - s.lastMaxUpdate > 250) {
    s.lastMaxUpdate = now;
    let max = 0;
    for (let i = 0; i < s.smoothed.length; i++) {
      if (s.smoothed[i] > max) max = s.smoothed[i];
    }
    maxRmsEls[sensorIdx].textContent = `${max.toFixed(1)} mV`;
  }

  if (trialActive) {
    const t = Math.round(now - trialStart);
    trialRows.push([
      t,
      latest[0],
      sensors[0].smoothed.at(-1) || 0,
      sensors[0].normalized.at(-1) || 0,
      latest[1],
      sensors[1].smoothed.at(-1) || 0,
      sensors[1].normalized.at(-1) || 0
    ]);
  }

  scheduleDraw();
}

function startTrial() {
  trialActive = true;
  trialStart = performance.now();
  trialRows = [];
  stopTrialBtn.disabled = false;
  setStatus("Trial recording started.");
}

function stopTrialAndDownload() {
  trialActive = false;
  stopTrialBtn.disabled = true;

  const header = [
    "time_ms",
    "s1_raw_mV",
    "s1_rms_mV",
    "s1_norm_pctMVC",
    "s2_raw_mV",
    "s2_rms_mV",
    "s2_norm_pctMVC"
  ];

  const csv = [header, ...trialRows].map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `emg_trial_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);

  setStatus("Trial stopped and CSV downloaded.");
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawSensorColumn(0, 0, "Sensor 1");
  drawSensorColumn(1, canvas.width / 2, "Sensor 2");
}

function drawSensorColumn(idx, xOffset, label) {
  const width = canvas.width / 2;
  drawSection(
    `${label} Raw (Bandpass, mV)`,
    sensors[idx].bandpass,
    xOffset,
    0,
    width,
    240,
    true,
    null,
    null,
    "mV"
  );
  drawSection(
    `${label} Rectified + RMS (mV)`,
    sensors[idx].smoothed,
    xOffset,
    260,
    width,
    240,
    false,
    null,
    null,
    "mV"
  );
  drawSection(
    `${label} Normalized (%MVC)`,
    sensors[idx].normalized,
    xOffset,
    520,
    width,
    240,
    false,
    0,
    150,
    "%MVC"
  );
}

function drawSection(
  title,
  data,
  xOffset,
  top,
  width,
  height,
  symmetric,
  forcedMin,
  forcedMax,
  unit
) {
  const left = xOffset + 55;
  const right = xOffset + width - 15;
  const bottom = top + height - 20;

  ctx.fillStyle = "#003c5a";
  ctx.font = "14px Arial";
  ctx.fillText(title, left, top + 16);

  ctx.strokeStyle = "#d0d7de";
  ctx.strokeRect(left, top + 22, right - left, bottom - (top + 22));

  let yMin = forcedMin ?? (data.length ? Math.min(...data) : -1);
  let yMax = forcedMax ?? (data.length ? Math.max(...data) : 1);

  if (symmetric) {
    const m = Math.max(Math.abs(yMin), Math.abs(yMax), 1);
    yMin = -m;
    yMax = m;
  }
  if (Math.abs(yMax - yMin) < 1e-6) {
    yMin -= 1;
    yMax += 1;
  }

  ctx.fillStyle = "#334155";
  ctx.font = "11px Arial";
  ctx.fillText(`${yMax.toFixed(1)} ${unit}`, xOffset + 4, top + 35);
  ctx.fillText(`${((yMax + yMin) / 2).toFixed(1)} ${unit}`, xOffset + 4, (top + bottom) / 2);
  ctx.fillText(`${yMin.toFixed(1)} ${unit}`, xOffset + 4, bottom);

  const visible = data.slice(-getWindowPoints());
  ctx.beginPath();
  ctx.strokeStyle = "#1d4ed8";

  for (let i = 0; i < visible.length; i++) {
    const v = visible[i];
    const x = left + (i / Math.max(1, visible.length - 1)) * (right - left);
    const y = bottom - ((v - yMin) / (yMax - yMin)) * (bottom - (top + 22));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

scheduleDraw();
