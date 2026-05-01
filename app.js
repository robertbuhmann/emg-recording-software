const connectBtn = document.getElementById("connectBtn");
const startVizBtn = document.getElementById("startVizBtn");
const stopVizBtn = document.getElementById("stopVizBtn");
const statusEl = document.getElementById("status");
const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");
const mvcInput = document.getElementById("mvcInput");
const applyMvcBtn = document.getElementById("applyMvcBtn");
const mvcLabel = document.getElementById("mvcLabel");

let bleDevice;
let bleNotifyCharacteristic;
let serialPort;
let serialReader;
let lineBuffer = "";
let activeTransport = null;
let mvcReferenceMv = parseFloat(mvcInput.value) || 100;
let vizRunning = true;

const UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const UART_NOTIFY_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

const WINDOW_SECONDS = 30;
const MIN_POINTS = 300;
const MAX_POINTS = 4000;
const RMS_WINDOW_SECONDS = 0.1;
const HP_ALPHA = 0.95;
const LP_ALPHA = 0.2;

let lastSampleTime = null;
let estimatedDtMs = 10;

let sensors = [createChannel(), createChannel(), createChannel()];

function createChannel() {
  return {
    raw: [],
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
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function updateMvcLabel() {
  mvcLabel.textContent = `Current MVC: ${mvcReferenceMv.toFixed(1)} mV`;
}

function getWindowPoints() {
  const points = Math.round((WINDOW_SECONDS * 1000) / estimatedDtMs);
  return Math.max(MIN_POINTS, Math.min(MAX_POINTS, points));
}

function trimToWindow(arr) {
  const target = getWindowPoints();
  while (arr.length > target) arr.shift();
}

applyMvcBtn?.addEventListener("click", () => {
  const value = parseFloat(mvcInput.value);
  if (!Number.isFinite(value) || value <= 0) {
    return setStatus("MVC must be > 0 mV.", true);
  }
  mvcReferenceMv = value;
  updateMvcLabel();
  setStatus(`MVC updated to ${mvcReferenceMv.toFixed(1)} mV.`);
});

startVizBtn?.addEventListener("click", () => {
  vizRunning = true;
  setStatus("Visualization running.");
});

stopVizBtn?.addEventListener("click", () => {
  vizRunning = false;
  setStatus("Visualization paused. Data still streaming.");
});

connectBtn?.addEventListener("click", async () => {
  try {
    await connectBluetooth();
  } catch (bleErr) {
    setStatus(`BLE failed: ${bleErr.message}. Trying Serial...`, true);
    try {
      await connectSerial();
    } catch (serialErr) {
      setStatus(`Serial failed: ${serialErr.message}`, true);
    }
  }
});

async function connectBluetooth() {
  if (!navigator.bluetooth) throw new Error("Web Bluetooth unavailable.");

  bleDevice = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [UART_SERVICE_UUID]
  });

  const server = await bleDevice.gatt.connect();
  bleNotifyCharacteristic = await findBleNotifyCharacteristic(server);

  await bleNotifyCharacteristic.startNotifications();
  bleNotifyCharacteristic.addEventListener("characteristicvaluechanged", handleBleData);

  activeTransport = "ble";
  setStatus(`BLE connected to ${bleDevice.name || "device"}.`);
}

async function findBleNotifyCharacteristic(server) {
  try {
    const service = await server.getPrimaryService(UART_SERVICE_UUID);
    return await service.getCharacteristic(UART_NOTIFY_UUID);
  } catch (_) {}

  const services = await server.getPrimaryServices();
  for (const service of services) {
    for (const ch of await service.getCharacteristics()) {
      if (ch.properties.notify || ch.properties.indicate) return ch;
    }
  }

  throw new Error("No notify/indicate characteristic found.");
}

function handleBleData(event) {
  lineBuffer += new TextDecoder().decode(event.target.value, { stream: true });
  processBufferedLines();
}

async function connectSerial() {
  if (!navigator.serial) throw new Error("Web Serial unavailable.");

  serialPort = await navigator.serial.requestPort();
  await serialPort.open({ baudRate: 115200 });
  serialReader = serialPort.readable.getReader();

  activeTransport = "serial";
  setStatus("Serial connected (115200 baud). Streaming...");
  readSerialLoop();
}

async function readSerialLoop() {
  const decoder = new TextDecoder();

  while (activeTransport === "serial" && serialReader) {
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

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const parts = line.split(",");
    if (parts.length === 3) {
      const vals = parts.map((v) => parseFloat(v));
      if (vals.every((v) => !Number.isNaN(v))) processSample(vals);
    } else if (parts.length === 1) {
      const v = parseFloat(parts[0]);
      if (!Number.isNaN(v)) processSample([v, v, v]);
    }
  }
}

function processSample(vals) {
  const now = performance.now();
  if (lastSampleTime !== null) {
    const dt = now - lastSampleTime;
    if (dt > 0 && dt < 200) estimatedDtMs = 0.95 * estimatedDtMs + 0.05 * dt;
  }
  lastSampleTime = now;

  const rmsWindowSamples = Math.max(
    1,
    Math.round((RMS_WINDOW_SECONDS * 1000) / estimatedDtMs)
  );

  vals.forEach((rawMv, i) => {
    const ch = sensors[i];

    ch.raw.push(rawMv);
    trimToWindow(ch.raw);

    const hp = HP_ALPHA * (ch.hpState + rawMv - ch.prevInput);
    ch.hpState = hp;
    ch.prevInput = rawMv;

    const bandpass = ch.lpState + LP_ALPHA * (hp - ch.lpState);
    ch.lpState = bandpass;

    ch.bandpass.push(bandpass);
    trimToWindow(ch.bandpass);

    const rectified = Math.abs(bandpass);
    ch.rectified.push(rectified);
    trimToWindow(ch.rectified);

    const recentRect = ch.rectified.slice(-rmsWindowSamples);
    const rms = Math.sqrt(
      recentRect.reduce((sum, v) => sum + v * v, 0) / recentRect.length
    );

    ch.smoothed.push(rms);
    trimToWindow(ch.smoothed);

    const normalized = (rms / mvcReferenceMv) * 100;
    ch.normalized.push(normalized);
    trimToWindow(ch.normalized);
  });

  if (vizRunning) draw();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  drawSection(
    `Raw EMG (Bandpass, mV) - ${WINDOW_SECONDS}s rolling window`,
    sensors.map((c) => c.bandpass),
    0,
    220,
    true
  );
  drawSection(
    "Rectified + RMS Smoothed (mV)",
    sensors.map((c) => c.smoothed),
    240,
    220
  );
  drawSection(
    "Normalized EMG (%MVC)",
    sensors.map((c) => c.normalized),
    480,
    220,
    false,
    0,
    150
  );
}

function drawSection(
  title,
  channelData,
  top,
  height,
  symmetric = false,
  forcedMin = null,
  forcedMax = null
) {
  const left = 70;
  const right = canvas.width - 20;
  const bottom = top + height - 25;

  ctx.fillStyle = "#003c5a";
  ctx.font = "16px Arial";
  ctx.fillText(title, left, top + 18);

  ctx.strokeStyle = "#d0d7de";
  ctx.strokeRect(left, top + 25, right - left, bottom - (top + 25));

  const allVals = channelData.flat();
  let yMin = forcedMin ?? (allVals.length ? Math.min(...allVals) : -1);
  let yMax = forcedMax ?? (allVals.length ? Math.max(...allVals) : 1);

  if (symmetric) {
    const m = Math.max(Math.abs(yMin), Math.abs(yMax), 1);
    yMin = -m;
    yMax = m;
  }

  if (Math.abs(yMax - yMin) < 1e-6) {
    yMin -= 1;
    yMax += 1;
  }

  const unit = forcedMax !== null ? "%MVC" : "mV";
  ctx.fillStyle = "#334155";
  ctx.font = "11px Arial";
  ctx.fillText(`${yMax.toFixed(1)} ${unit}`, 8, top + 35);
  ctx.fillText(`${((yMax + yMin) / 2).toFixed(1)} ${unit}`, 8, (top + bottom) / 2);
  ctx.fillText(`${yMin.toFixed(1)} ${unit}`, 8, bottom);

  const colors = ["#d62828", "#1d4ed8", "#2b9348"];
  const points = getWindowPoints();
  channelData.forEach((data, idx) =>
    drawLineInBox(data, colors[idx], left, right, top + 25, bottom, yMin, yMax, points)
  );
}

function drawLineInBox(data, color, left, right, top, bottom, yMin, yMax, points) {
  if (!data.length) return;

  const start = Math.max(0, data.length - points);
  const visible = data.slice(start);

  ctx.beginPath();
  ctx.strokeStyle = color;
  visible.forEach((v, i) => {
    const x = left + (i / Math.max(1, visible.length - 1)) * (right - left);
    const y = bottom - ((v - yMin) / (yMax - yMin)) * (bottom - top);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

updateMvcLabel();
draw();
