const connectBtn = document.getElementById("connectBtn");
const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");

let device, characteristic;

const MAX_POINTS = 300;
const SMOOTH_WINDOW = 10;

// Data arrays for 3 sensors
let sensors = [
  createChannel(),
  createChannel(),
  createChannel()
];

function createChannel() {
  return {
    raw: [],
    rect: [],
    smooth: [],
    norm: []
  };
}

connectBtn.addEventListener("click", async () => {
  device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: ['6e400001-b5a3-f393-e0a9-e50e24dcca9e'] // Nordic UART
  });

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService('6e400001-b5a3-f393-e0a9-e50e24dcca9e');

  characteristic = await service.getCharacteristic('6e400003-b5a3-f393-e0a9-e50e24dcca9e');

  await characteristic.startNotifications();
  characteristic.addEventListener('characteristicvaluechanged', handleData);
});

function handleData(event) {
  const decoder = new TextDecoder();
  const value = decoder.decode(event.target.value);

  const lines = value.split("\n");

  lines.forEach(line => {
    const parts = line.trim().split(",");
    if (parts.length === 3) {
      const vals = parts.map(v => parseFloat(v));
      if (vals.every(v => !isNaN(v))) {
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
    drawLine(ch.smooth, colors[i], 150); // offset so they don’t overlap
    drawLine(ch.norm.map(v => v * 100), colors[i], 300);
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
