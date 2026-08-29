"use strict";

// JDY 模块使用的 BLE 服务和特征值 UUID。
const SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
const CHARACTERISTIC_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";

const $ = (id) => document.getElementById(id);
const ui = {
  connectionState: $("connectionState"), connectionText: $("connectionText"),
  connectButton: $("connectButton"), disconnectButton: $("disconnectButton"),
  deviceName: $("deviceName"), message: $("message"),
  distanceGauge: $("distanceGauge"), distanceValue: $("distanceValue"), distanceUnit: $("distanceUnit"),
  obstacleState: $("obstacleState"), obstacleChinese: $("obstacleChinese"), obstacleValue: $("obstacleValue"),
  speedSlider: $("speedSlider"), speedReadout: $("speedReadout"), speedPresets: $("speedPresets"),
  sensorOnButton: $("sensorOnButton"), sensorOffButton: $("sensorOffButton"),
  obstacleOnButton: $("obstacleOnButton"), obstacleOffButton: $("obstacleOffButton"),
  l1Value: $("l1Value"), l2Value: $("l2Value"), r1Value: $("r1Value"), r2Value: $("r2Value"),
  errorValue: $("errorValue"), mlValue: $("mlValue"), mrValue: $("mrValue"),
  aliveIndicator: $("aliveIndicator"), logWindow: $("logWindow"), clearLogButton: $("clearLogButton")
};

let bluetoothDevice = null;
let uartCharacteristic = null;
let receiveBuffer = "";
let aliveTimer = null;
const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

function setMessage(text, isError = false) {
  ui.message.textContent = text;
  ui.message.classList.toggle("error", isError);
}

function setConnected(connected) {
  ui.connectionState.classList.toggle("connected", connected);
  ui.connectionText.textContent = connected ? "已连接" : "未连接";
  ui.connectButton.disabled = connected;
  ui.disconnectButton.disabled = !connected;
  document.querySelectorAll(".control-button, #speedSlider, #speedPresets button")
    .forEach((element) => { element.disabled = !connected; });
}

function addLog(text, kind = "rx") {
  const placeholder = ui.logWindow.querySelector(".muted");
  if (placeholder) placeholder.remove();

  const line = document.createElement("p");
  line.className = kind === "tx" ? "tx" : kind === "error" ? "error-line" : "";
  const prefix = kind === "tx" ? "TX › " : kind === "error" ? "ERR › " : "RX › ";
  line.textContent = prefix + text;
  ui.logWindow.appendChild(line);

  while (ui.logWindow.children.length > 80) ui.logWindow.firstElementChild.remove();
  ui.logWindow.scrollTop = ui.logWindow.scrollHeight;
}

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    setMessage("当前浏览器不支持网页蓝牙。苹果手机请使用 Bluefy 打开本页。", true);
    addLog("浏览器不支持 Web Bluetooth", "error");
    return;
  }

  try {
    setMessage("正在打开蓝牙设备列表…");
    bluetoothDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [SERVICE_UUID]
    });
    bluetoothDevice.addEventListener("gattserverdisconnected", handleDisconnected);

    setMessage("正在连接 " + (bluetoothDevice.name || "蓝牙设备") + "…");
    const server = await bluetoothDevice.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    uartCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);

    if (uartCharacteristic.properties.notify || uartCharacteristic.properties.indicate) {
      await uartCharacteristic.startNotifications();
      uartCharacteristic.addEventListener("characteristicvaluechanged", handleNotification);
    } else {
      addLog("FFE1 不支持通知，只能发送命令", "error");
    }

    ui.deviceName.textContent = bluetoothDevice.name || "未命名设备";
    setConnected(true);
    setMessage("连接成功，可以控制小车");
    addLog("已连接 " + (bluetoothDevice.name || "未命名设备"));
  } catch (error) {
    if (error.name === "NotFoundError") {
      setMessage("已取消选择蓝牙设备");
      return;
    }
    uartCharacteristic = null;
    setConnected(false);
    setMessage("连接失败：" + error.message, true);
    addLog(error.message, "error");
  }
}

function disconnectBluetooth() {
  if (bluetoothDevice && bluetoothDevice.gatt && bluetoothDevice.gatt.connected) {
    bluetoothDevice.gatt.disconnect();
  } else {
    handleDisconnected();
  }
}

function handleDisconnected() {
  uartCharacteristic = null;
  receiveBuffer = "";
  setConnected(false);
  setMessage("蓝牙已断开");
  addLog("蓝牙已断开", "error");
}

async function sendCommand(command) {
  if (!uartCharacteristic || !bluetoothDevice?.gatt?.connected) {
    setMessage("请先连接蓝牙设备", true);
    return false;
  }

  try {
    const data = encoder.encode(command);
    if (uartCharacteristic.properties.write && uartCharacteristic.writeValueWithResponse) {
      await uartCharacteristic.writeValueWithResponse(data);
    } else if (uartCharacteristic.properties.writeWithoutResponse && uartCharacteristic.writeValueWithoutResponse) {
      await uartCharacteristic.writeValueWithoutResponse(data);
    } else if (uartCharacteristic.writeValue) {
      await uartCharacteristic.writeValue(data);
    } else {
      throw new Error("FFE1 不支持写入");
    }
    addLog(command, "tx");
    setMessage("命令 " + command + " 已发送");
    return true;
  } catch (error) {
    setMessage("发送失败：" + error.message, true);
    addLog(error.message, "error");
    return false;
  }
}

function handleNotification(event) {
  receiveBuffer += decoder.decode(event.target.value, { stream: true });
  receiveBuffer = receiveBuffer.replace(/\r/g, "");

  const lines = receiveBuffer.split("\n");
  receiveBuffer = lines.pop() || "";
  lines.map((line) => line.trim()).filter(Boolean).forEach(processLine);

  // 防止模块长期不发换行符时缓存无限增长。
  if (receiveBuffer.length > 500) {
    processLine(receiveBuffer.trim());
    receiveBuffer = "";
  }
}

function processLine(line) {
  if (!line) return;
  addLog(line);

  const sensorMatch = line.match(/L1\s*=\s*(\d+).*?L2\s*=\s*(\d+).*?R1\s*=\s*(\d+).*?R2\s*=\s*(\d+).*?ERROR\s*=\s*(-?\d+).*?ML\s*=\s*(\d+).*?MR\s*=\s*(\d+)/i);
  if (sensorMatch) {
    [ui.l1Value.textContent, ui.l2Value.textContent, ui.r1Value.textContent, ui.r2Value.textContent,
      ui.errorValue.textContent, ui.mlValue.textContent, ui.mrValue.textContent] = sensorMatch.slice(1);
  }

  const distanceMatch = line.match(/DIST\s*=\s*(OUT|\d+)\s*(?:CM)?/i);
  const obstacleMatch = line.match(/(?:OBSTACLE\s*=\s*|OBSTACLE\s+)(CLEAR|SLOW|STOP)/i);
  const avoidanceMatch = line.match(/(?:AVOID\s*=\s*|OBSTACLE\s+)(ON|OFF)\b/i);
  const sensorModeMatch = line.match(/SENSOR\s+(ON|OFF)\b/i);
  if (distanceMatch) updateDistance(distanceMatch[1]);
  if (obstacleMatch) updateObstacle(obstacleMatch[1].toUpperCase());
  if (avoidanceMatch) selectMode(ui.obstacleOnButton, ui.obstacleOffButton, avoidanceMatch[1].toUpperCase() === "ON");
  if (sensorModeMatch) selectMode(ui.sensorOnButton, ui.sensorOffButton, sensorModeMatch[1].toUpperCase() === "ON");

  if (/CAR\s+ALIVE/i.test(line)) markAlive();
}

function updateDistance(value) {
  const isOut = String(value).toUpperCase() === "OUT";
  ui.distanceValue.textContent = isOut ? "OUT" : value;
  ui.distanceUnit.textContent = isOut ? "" : "cm";
  const numeric = isOut ? 100 : Math.max(0, Math.min(Number(value), 100));
  ui.distanceGauge.style.setProperty("--progress", `${numeric * 3.6}deg`);
}

function updateObstacle(state) {
  const labels = {
    CLEAR: { chinese: "安全", symbol: "✓" },
    SLOW: { chinese: "减速", symbol: "!" },
    STOP: { chinese: "停车", symbol: "■" }
  };
  const selected = labels[state] || { chinese: "未知", symbol: "?" };
  ui.obstacleState.className = "obstacle-state " + state.toLowerCase();
  ui.obstacleState.querySelector(".shield").textContent = selected.symbol;
  ui.obstacleChinese.textContent = selected.chinese;
  ui.obstacleValue.textContent = state;
}

function markAlive() {
  ui.aliveIndicator.textContent = "通信正常";
  ui.aliveIndicator.classList.add("alive");
  clearTimeout(aliveTimer);
  aliveTimer = setTimeout(() => {
    ui.aliveIndicator.textContent = "等待心跳";
    ui.aliveIndicator.classList.remove("alive");
  }, 3500);
}

function selectSpeed(speed) {
  const value = Math.max(1, Math.min(9, Number(speed)));
  ui.speedSlider.value = String(value);
  ui.speedReadout.textContent = `${value * 10}%`;
  ui.speedPresets.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("selected", Number(button.dataset.speed) === value);
  });
}

function selectMode(onButton, offButton, enabled) {
  onButton.classList.toggle("selected", enabled);
  offButton.classList.toggle("selected", !enabled);
}

ui.connectButton.addEventListener("click", connectBluetooth);
ui.disconnectButton.addEventListener("click", disconnectBluetooth);

document.querySelectorAll(".control-button").forEach((button) => {
  button.addEventListener("click", async () => {
    const sent = await sendCommand(button.dataset.command);
    if (!sent) return;
    if (button === ui.sensorOnButton || button === ui.sensorOffButton) {
      selectMode(ui.sensorOnButton, ui.sensorOffButton, button === ui.sensorOnButton);
    }
    if (button === ui.obstacleOnButton || button === ui.obstacleOffButton) {
      selectMode(ui.obstacleOnButton, ui.obstacleOffButton, button === ui.obstacleOnButton);
    }
  });
});

ui.speedSlider.addEventListener("input", () => selectSpeed(ui.speedSlider.value));
ui.speedSlider.addEventListener("change", () => sendCommand(ui.speedSlider.value));
ui.speedPresets.querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", () => {
    selectSpeed(button.dataset.speed);
    sendCommand(button.dataset.speed);
  });
});

ui.clearLogButton.addEventListener("click", () => {
  ui.logWindow.innerHTML = '<p class="muted">日志已清空</p>';
});

setConnected(false);
selectSpeed(3);
selectMode(ui.sensorOnButton, ui.sensorOffButton, false);
selectMode(ui.obstacleOnButton, ui.obstacleOffButton, true);
