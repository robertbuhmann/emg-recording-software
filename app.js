const connectBtn = document.getElementById("connectBtn");
const statusEl = document.getElementById("status");
const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");

let device;
let notifyCharacteristic;
let lineBuffer = "";

const UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const UART_NOTIFY_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

const MAX_POINTS = 300;
const SMOOTH_WINDOW = 10;

let sensors = [createChannel(), createChannel(), createChannel()];

function createChannel() {
  return { raw: [], rect: [], smooth: [], norm: [] };
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

connectBtn.addEventListener("click", async () => {
  try {
    if (!navigator.bluetooth) {
      throw new Error("Web Bluetooth unavailable. Use Chrome/Edge on HTTPS (or localhost).");
    }

    setStatus("Opening Bluetooth device picker...");

    // Keep a broad picker so non-NUS BLE modules can still be selected.
    // We still prefer Nordic UART after connecting.
    device = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: "UniSC" },
        { services: [UART_SERVICE_UUID] }
      ],
      optionalServices: [UART_SERVICE_UUID, "battery_service", "device_information"]

    device.addEventListener("gattserverdisconnected", onDisconnected);

    setStatus(`Connecting to ${device.name || "selected device"}...`);
    const server = await device.gatt.connect();

    notifyCharacteristic = await findNotifyCharacteristic(server);

    await notifyCharacteristic.startNotifications();
    notifyCharacteristic.addEventListener("characteristicvaluechanged", handleData);

    connectBtn.textContent = "Reconnect Bluetooth";
    setStatus(`Connected to ${device.name || "device"}. Streaming notifications...`);
  } catch (err) {
    console.error(err);
    setStatus(`Connection failed: ${err.message}`, true);
  }
});

async function findNotifyCharacteristic(server) {
  // Preferred path: Nordic UART notify characteristic.
  try {
    const service = await server.getPrimaryService(UART_SERVICE_UUID);
    const characteristic = await service.getCharacteristic(UART_NOTIFY_UUID);
    return characteristic;
  } catch (_) {
    // Fallback path handled below.
  }

  // Fallback: scan all services/characteristics and choose first notify-capable char.
  const services = await server.getPrimaryServices();
  for (const service of services) {
    const characteristics = await service.getCharacteristics();
    for (const characteristic of characteristics) {
      if (characteristic.properties.notify || characteristic.properties.indicate) {
        setStatus(`Connected. Using notify characteristic ${characteristic.uuid}.`);
        return characteristic;
      }
    }
  }

  throw new Error("No notify/indicate characteristic found on selected device.");
}

function onDisconnected() {
  setStatus("Device disconnected. Click reconnect to try again.", true);
}

function handleData(event) {
  const decoder = new TextDecoder();
  lineBuffer += decoder.decode(event.target.value);

  const lines = lineBuffer.split(/\r?\n/);
  lineBuffer = lines.pop() || "";

  lines.forEach((line) => {
    const parts = line.trim().split(",");
    if (parts.length === 3) {
      const vals = parts.map((v) => parseFloat(v));
      if (vals.every((v) => !isNaN(v))) {
        processSample(vals);
      }
    }
  });
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
