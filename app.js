const connectBtn = document.getElementById("connectBtn");
const startVizBtn = document.getElementById("startVizBtn");
const stopVizBtn = document.getElementById("stopVizBtn");
const statusEl = document.getElementById("status");
const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");
const mvcInputs = [
  document.getElementById("mvcInput1"),
  document.getElementById("mvcInput2")
];
const maxRmsEls = [
  document.getElementById("maxRms1"),
  document.getElementById("maxRms2")
];

let lineBuffer = "";
let serialPort;
let serialReader;
let vizRunning = true;
let estimatedDtMs = 10;
let lastSampleTime = null;

const WINDOW_SECONDS = 30;
const RMS_WINDOW_SECONDS = 0.1;
const MIN_POINTS = 300;
const MAX_POINTS = 4000;
const HP_ALPHA = 0.95;
const LP_ALPHA = 0.2;

let mvcReferenceMv = mvcInputs.map((i) => parseFloat(i.value) || 100);
let sensors = [createSensor(), createSensor()];

function createSensor() {
  return {
    bandpass: [],
    rectified: [],
    smoothed: [],
    normalized: [],
    hpState: 0,
    prevInput: 0,
    lpState: 0
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
  while (arr.length > n) arr.shift();
}

mvcInputs.forEach((input, idx) => {
  input.addEventListener("change", () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v) && v > 0) mvcReferenceMv[idx] = v;
  });
});

startVizBtn.addEventListener("click", () => {
  vizRunning = true;
  setStatus("Visualization running.");
  draw();
});

stopVizBtn.addEventListener("click", () => {
  vizRunning = false;
  setStatus("Visualization paused. Data still streaming.");
});

connectBtn.addEventListener("click", connectSerial);

async function connectSerial() {
  try {
    if (!navigator.serial) throw new Error("Web Serial unavailable.");
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({ baudRate: 115200 });
    serialReader = serialPort.readable.getReader();
    setStatus("Serial connected (115200). Streaming...");
    readSerialLoop();
  } catch (err) {
    setStatus(`Serial failed: ${err.message}`, true);
  }
}

async function readSerialLoop() {
  const decoder = new TextDecoder();
  while (serialReader) {
    const { value, done } = await serialReader.read();
    if (done) break;
    if (!value) continue;
    lineBuffer += decoder.decode(value, { stream: true });
    processBufferedLines();
  }
}

function processBufferedLines() {
  const lines = lineBuffer.split(/\r?\n/);
  lineBuffer = lines.pop() || "";

  lines.forEach((line) => {
    const parts = line
      .trim()
      .split(",")
      .map(Number)
      .filter((v) => !Number.isNaN(v));

    if (parts.length >= 2) processSample([parts[0], parts[1]]);
    else if (parts.length === 1) processSample([parts[0], parts[0]]);
  });
}

function processSample(vals) {
  const now = performance.now();
  if (lastSampleTime !== null) {
    const dt = now - lastSampleTime;
    if (dt > 0 && dt < 200) estimatedDtMs = 0.95 * estimatedDtMs + 0.05 * dt;
  }
  lastSampleTime = now;

  const rmsWindow = Math.max(
    1,
    Math.round((RMS_WINDOW_SECONDS * 1000) / estimatedDtMs)
  );

  vals.forEach((rawMv, i) => {
    const s = sensors[i];

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

    const r = s.rectified.slice(-rmsWindow);
    const rms = Math.sqrt(r.reduce((a, b) => a + b * b, 0) / r.length);
    s.smoothed.push(rms);
    trim(s.smoothed);

    const norm = (rms / mvcReferenceMv[i]) * 100;
    s.normalized.push(norm);
    trim(s.normalized);

    const maxRms = s.smoothed.length ? Math.max(...s.smoothed) : 0;
    maxRmsEls[i].textContent = `${maxRms.toFixed(1)} mV`;
  });

  if (vizRunning) draw();
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
    true
  );
  drawSection(
    `${label} Rectified + RMS (mV)`,
    sensors[idx].smoothed,
    xOffset,
    260,
    width,
    240,
    false
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
    150
  );
}

function drawSection(
  title,
  data,
  xOffset,
  top,
  width,
  height,
  symmetric = false,
  forcedMin = null,
  forcedMax = null
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

  const visible = data.slice(-getWindowPoints());
  ctx.beginPath();
  ctx.strokeStyle = "#1d4ed8";
  visible.forEach((v, i) => {
    const x = left + (i / Math.max(1, visible.length - 1)) * (right - left);
    const y = bottom - ((v - yMin) / (yMax - yMin)) * (bottom - (top + 22));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

draw();
