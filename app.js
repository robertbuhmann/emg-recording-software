const connectBtn = document.getElementById("connectBtn");
const statusEl = document.getElementById("status");
const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");

let bleDevice;
let bleNotifyCharacteristic;
let serialPort;
let serialReader;
let lineBuffer = "";
let activeTransport = null; // "ble" | "serial" | null

const UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const UART_NOTIFY_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

const MAX_POINTS = 300;
const SMOOTH_WINDOW = 10;

let sensors = [createChannel(), createChannel(), createChannel()];

function createChannel() {
  return { raw: [], rect: [], smooth: [], norm: [] };
}

function setStatus(message, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function resetBuffer() {
  lineBuffer = "";
}

function stopCurrentTransport() {
  // BLE cleanup
  if (bleNotifyCharacteristic) {
    bleNotifyCharacteristic.removeEventListener("characteristicvaluechanged", handleBleData);
    bleNotifyCharacteristic = null;
  }
  if (bleDevice?.gatt?.connected) {
    bleDevice.gatt.disconnect();
  }
  bleDevice = null;

  // Serial cleanup
  if (serialReader) {
    try { serialReader.cancel(); } catch (_) {}
    serialReader = null;
  }
  if (serialPort) {
    try { serialPort.close(); } catch (_) {}
    serialPort = null;
  }

  activeTransport = null;
  resetBuffer();
}

connectBtn?.addEventListener("click", async () => {
  // Default button behavior: try BLE first, fall back to Serial.
  try {
    await connectBluetooth();
  } catch (bleErr) {
    console.warn("BLE failed, trying Serial...", bleErr);
    setStatus(`BLE failed: ${bleErr.message}. Trying Serial...`, true);
    try {
      await connectSerial();
    } catch (serialErr) {
      console.error(serialErr);
      setStatus(`Serial failed: ${serialErr.message}`, true);
    }
  }
});

// Expose optional functions for extra buttons in HTML.
window.connectBluetooth = connectBluetooth;
window.connectSerial = connectSerial;

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    throw new Error("Web Bluetooth unavailable. Use Chrome/Edge on HTTPS (or localhost).");
  }

  stopCurrentTransport();
  setStatus("Opening Bluetooth device picker...");

  // Broad picker for compatibility. You can tighten this later if needed.
  bleDevice = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [UART_SERVICE_UUID, "battery_service", "device_information"]
  });

  bleDevice.addEventListener("gattserverdisconnected", onBleDisconnected);

  setStatus(`Connecting to BLE device ${bleDevice.name || "(unnamed)"}...`);
  const server = await bleDevice.gatt.connect();

  bleNotifyCharacteristic = await findBleNotifyCharacteristic(server);
  await bleNotifyCharacteristic.startNotifications();
  bleNotifyCharacteristic.addEventListener("characteristicvaluechanged", handleBleData);

  activeTransport = "ble";
  resetBuffer();
  setStatus(`BLE connected to ${bleDevice.name || "device"}. Streaming...`);
}

async function findBleNotifyCharacteristic(server) {
  // Preferred: Nordic UART notify characteristic.
  try {
    const service = await server.getPrimaryService(UART_SERVICE_UUID);
    const characteristic = await service.getCharacteristic(UART_NOTIFY_UUID);
    return characteristic;
  } catch (_) {
    // fallback below
  }

  // Fallback: find any notify/indicate characteristic.
  const services = await server.getPrimaryServices();
  for (const service of services) {
    const characteristics = await service.getCharacteristics();
    for (const characteristic of characteristics) {
      if (characteristic.properties.notify || characteristic.properties.indicate) {
        setStatus(`BLE connected. Using notify characteristic ${characteristic.uuid}.`);
        return characteristic;
      }
    }
  }

  throw new Error("No notify/indicate characteristic found on selected BLE device.");
}

function onBleDisconnected() {
  if (activeTransport === "ble") {
    setStatus("BLE device disconnected. Reconnect to continue.", true);
    activeTransport = null;
  }
}

function handleBleData(event) {
  const decoder = new TextDecoder();
  lineBuffer += decoder.decode(event.target.value, { stream: true });
  processBufferedLines();
}

async function connectSerial() {
  if (!navigator.serial) {
    throw new Error("Web Serial unavailable. Use Chrome/Edge desktop.");
  }

  stopCurrentTransport();
  setStatus("Opening Serial port picker...");

  serialPort = await navigator.serial.requestPort();
  await serialPort.open({ baudRate: 115200 });

  if (!serialPort.readable) {
    throw new Error("Selected serial port is not readable.");
  }

  serialReader = serialPort.readable.getReader();
  activeTransport = "serial";
  resetBuffer();
  setStatus("Serial connected at 115200 baud. Streaming...");

  readSerialLoop().catch((err) => {
    console.error(err);
    if (activeTransport === "serial") {
      setStatus(`Serial read error: ${err.message}`, true);
      activeTransport = null;
    }
  });
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

  // cleanup path
  if (serialReader) {
    try { serialReader.releaseLock(); } catch (_) {}
    serialReader = null;
  }
}

function processBufferedLines() {
  const lines = lineBuffer.split(/\r?\n/);
  lineBuffer = lines.pop() || "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Supported input formats:
    // 1) "v1,v2,v3"
    // 2) single value "v" (replicated to 3 channels)
    const parts = line.split(",");

    if (parts.length === 3) {
      const vals = parts.map((v) => parseFloat(v));
      if (vals.every((v) => !Number.isNaN(v))) {
        processSample(vals);
      }
    } else if (parts.length === 1) {
      const v = parseFloat(parts[0]);
      if (!Number.isNaN(v)) {
        processSample([v, v, v]); // replicate single-channel input
      }
    }
  }
}

function processSample(vals) {
  vals.forEach((val, i) => {
    const ch = sensors[i];

    ch.raw.push(val);
    if (ch.raw.length > MAX_POINTS) ch.raw.shift();

    const rect = Math.abs(val);
    ch.rect.push(rect);
    if (ch.rect.length > MAX_POINTS) ch.rect.shift();

    const smooth = movingAverage(ch.rect, SMOOTH_WINDOW);
    ch.smooth.push(smooth);
    if (ch.smooth.length > MAX_POINTS) ch.smooth.shift();

    const maxVal = Math.max(...ch.smooth, 1);
    const norm = smooth / maxVal;
    ch.norm.push(norm);
    if (ch.norm.length > MAX_POINTS) ch.norm.shift();
  });

  draw();
}

function movingAverage(arr, window) {
  const start = Math.max(0, arr.length - window);
  const subset = arr.slice(start);
  const sum = subset.reduce((a, b) => a + b, 0);
  return sum / subset.length;
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const colors = ["red", "blue", "green"];

  sensors.forEach((ch, i) => {
    drawLine(ch.raw, colors[i], 0);
    drawLine(ch.smooth, colors[i], 150);
    drawLine(ch.norm.map((v) => v * 100), colors[i], 300);
  });
}

function drawLine(data, color, yOffset) {
  ctx.beginPath();
  ctx.strokeStyle = color;

  data.forEach((v, i) => {
    const x = (i / MAX_POINTS) * canvas.width;
    const y = canvas.height - v - yOffset;

    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.stroke();
}
