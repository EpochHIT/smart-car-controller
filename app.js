"use strict";

const SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
const CHARACTERISTIC_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";

const $ = (id) => document.getElementById(id);
const ui = {
  connectionState: $("connectionState"),
  connectionText: $("connectionText"),
  connectButton: $("connectButton"),
  disconnectButton: $("disconnectButton"),
  deviceName: $("deviceName"),
  message: $("message"),
  modeStatus: $("modeStatus"),
  modeValue: $("modeValue"),
  motionValue: $("motionValue"),
  remotePanel: $("remotePanel"),
  remoteLock: $("remoteLock"),
  sensorPanel: $("sensorPanel"),
  sensorLock: $("sensorLock"),
  leftPwm: $("leftPwm"),
  rightPwm: $("rightPwm"),
  leftPwmValue: $("leftPwmValue"),
  rightPwmValue: $("rightPwmValue"),
  sendPwmButton: $("sendPwmButton"),
  leftCpsValue: $("leftCpsValue"),
  rightCpsValue: $("rightCpsValue"),
  straightErrorValue: $("straightErrorValue"),
  straightTrimValue: $("straightTrimValue"),
  leftForwardPwmValue: $("leftForwardPwmValue"),
  leftBackwardPwmValue: $("leftBackwardPwmValue"),
  rightForwardPwmValue: $("rightForwardPwmValue"),
  rightBackwardPwmValue: $("rightBackwardPwmValue"),
  refreshButton: $("refreshButton"),
  logWindow: $("logWindow"),
  clearLogButton: $("clearLogButton")
};

const state = {
  connected: false,
  mode: "standby",
  motion: "stop"
};

const modeLabels = {
  standby: "待机",
  remote: "蓝牙遥控",
  sensor: "传感器台架"
};

let bluetoothDevice = null;
let uartCharacteristic = null;
let receiveBuffer = "";
let writeQueue = Promise.resolve();
let intentionalDisconnect = false;

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

function setMessage(text, isError = false) {
  ui.message.textContent = text;
  ui.message.classList.toggle("error", isError);
}

function addLog(text, kind = "rx") {
  const placeholder = ui.logWindow.querySelector(".muted");
  if (placeholder) placeholder.remove();

  const line = document.createElement("p");
  line.className = kind === "tx" ? "tx" : kind === "error" ? "error-line" : "";
  line.textContent = `${kind === "tx" ? "TX" : kind === "error" ? "ERR" : "RX"} › ${text}`;
  ui.logWindow.appendChild(line);

  while (ui.logWindow.children.length > 100) ui.logWindow.firstElementChild.remove();
  ui.logWindow.scrollTop = ui.logWindow.scrollHeight;
}

function setMode(mode) {
  state.mode = mode;
  if (mode !== "remote") state.motion = "stop";
  updateAvailability();
}

function setMotion(motion) {
  state.motion = motion;
  ui.motionValue.textContent = motion.toUpperCase();
}

function updateAvailability() {
  const remoteReady = state.connected && state.mode === "remote";
  const sensorReady = state.connected && state.mode === "sensor";

  document.querySelectorAll(".requires-connection").forEach((element) => {
    element.disabled = !state.connected;
  });
  document.querySelectorAll(".remote-only").forEach((element) => {
    element.disabled = !remoteReady;
  });
  document.querySelectorAll(".sensor-only").forEach((element) => {
    element.disabled = !sensorReady;
  });

  document.querySelectorAll(".mode-choice").forEach((button) => {
    button.classList.toggle("selected", button.dataset.mode === state.mode);
  });

  ui.modeStatus.textContent = modeLabels[state.mode];
  ui.modeStatus.className = `mode-status ${state.mode}`;
  ui.modeValue.textContent = state.mode.toUpperCase();
  ui.motionValue.textContent = state.motion.toUpperCase();

  ui.remotePanel.classList.toggle("is-locked", !remoteReady);
  ui.sensorPanel.classList.toggle("is-locked", !sensorReady);
  ui.remoteLock.textContent = remoteReady ? "遥控已就绪" : "请先进入遥控模式";
  ui.sensorLock.textContent = sensorReady ? "传感器已运行" : "请先进入传感器模式";
  ui.remoteLock.classList.toggle("ready", remoteReady);
  ui.sensorLock.classList.toggle("ready", sensorReady);
}

function setConnected(connected) {
  state.connected = connected;
  ui.connectionState.classList.toggle("connected", connected);
  ui.connectionText.textContent = connected ? "已连接" : "未连接";
  ui.connectButton.disabled = connected;
  ui.disconnectButton.disabled = !connected;

  if (!connected) {
    state.mode = "standby";
    state.motion = "stop";
  }
  updateAvailability();
}

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    setMessage("当前浏览器不支持网页蓝牙。iPhone 请用 Bluefy 打开本页。", true);
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

    setMessage(`正在连接 ${bluetoothDevice.name || "蓝牙设备"}…`);
    const server = await bluetoothDevice.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    uartCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);

    if (uartCharacteristic.properties.notify || uartCharacteristic.properties.indicate) {
      await uartCharacteristic.startNotifications();
      uartCharacteristic.addEventListener("characteristicvaluechanged", handleNotification);
    } else {
      addLog("FFE1 不支持通知，页面无法读取小车反馈", "error");
    }

    intentionalDisconnect = false;
    ui.deviceName.textContent = bluetoothDevice.name || "未命名设备";
    setConnected(true);
    addLog(`已连接 ${bluetoothDevice.name || "未命名设备"}`);
    const queried = await sendCommand("CHECK");
    setMessage(queried ? "连接成功，已查询小车状态" : "连接成功，但状态查询失败", !queried);
  } catch (error) {
    if (error.name === "NotFoundError") {
      setMessage("已取消选择蓝牙设备");
      return;
    }
    uartCharacteristic = null;
    setConnected(false);
    setMessage(`连接失败：${error.message}`, true);
    addLog(error.message, "error");
  }
}

async function disconnectBluetooth() {
  if (!bluetoothDevice?.gatt?.connected) {
    handleDisconnected();
    return;
  }

  intentionalDisconnect = true;
  await sendCommand("STOP");
  bluetoothDevice.gatt.disconnect();
}

function handleDisconnected() {
  const wasIntentional = intentionalDisconnect;
  intentionalDisconnect = false;
  uartCharacteristic = null;
  receiveBuffer = "";
  setConnected(false);
  ui.deviceName.textContent = "--";

  if (wasIntentional) {
    setMessage("已停车并断开蓝牙");
    addLog("已断开蓝牙");
  } else {
    setMessage("蓝牙意外断开，无法确认小车是否已停车", true);
    addLog("蓝牙意外断开，无法发送停车命令", "error");
  }
}

function sendCommand(command) {
  const normalized = command.trim().toUpperCase();
  const operation = () => writeCommand(normalized);
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function writeCommand(command) {
  if (!uartCharacteristic || !bluetoothDevice?.gatt?.connected) {
    setMessage("请先连接蓝牙设备", true);
    return false;
  }

  try {
    const data = encoder.encode(`${command}\n`);
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
    setMessage(`命令 ${command} 已发送`);
    return true;
  } catch (error) {
    setMessage(`发送失败：${error.message}`, true);
    addLog(error.message, "error");
    return false;
  }
}

function handleNotification(event) {
  receiveBuffer += decoder.decode(event.target.value, { stream: true }).replace(/\r/g, "");
  const lines = receiveBuffer.split("\n");
  receiveBuffer = lines.pop() || "";
  lines.map((line) => line.trim()).filter(Boolean).forEach(processLine);
}

function processLine(line) {
  addLog(line);

  const modeMatch = line.match(/(?:MODE=|OK MODE |OK STOPPED MODE )(STANDBY|REMOTE|SENSOR)\b/i);
  if (modeMatch) setMode(modeMatch[1].toLowerCase());

  const motionMatch = line.match(/MOTION=(STOP|FORWARD|BACKWARD|LEFT|RIGHT|PWM)\b/i);
  if (motionMatch) setMotion(motionMatch[1].toLowerCase());

  const cpsMatch = line.match(/ENC CPS L=([+-]?\d+) R=([+-]?\d+)/i);
  if (cpsMatch) {
    ui.leftCpsValue.textContent = cpsMatch[1];
    ui.rightCpsValue.textContent = cpsMatch[2];
  }

  const straightMatch = line.match(/STRAIGHT ERR=([+-]?\d+) TRIM=([+-]?\d+) CPS/i);
  if (straightMatch) {
    ui.straightErrorValue.textContent = straightMatch[1];
    ui.straightTrimValue.textContent = straightMatch[2];
  }

  const pwmMatch = line.match(/^PWM L=(\d+) R=(\d+)$/i);
  if (pwmMatch) {
    setMotion("pwm");
    ui.leftForwardPwmValue.textContent = pwmMatch[1];
    ui.leftBackwardPwmValue.textContent = "0";
    ui.rightForwardPwmValue.textContent = pwmMatch[2];
    ui.rightBackwardPwmValue.textContent = "0";
  }

  const motorMatch = line.match(/MOTOR (LF|LB|RF|RB)_PWM=(\d+)/i);
  if (motorMatch) {
    const fields = {
      LF: ui.leftForwardPwmValue,
      LB: ui.leftBackwardPwmValue,
      RF: ui.rightForwardPwmValue,
      RB: ui.rightBackwardPwmValue
    };
    fields[motorMatch[1].toUpperCase()].textContent = motorMatch[2];
  }

  if (/^ERR\b/i.test(line)) setMessage(line, true);
}

function updatePwmReadout() {
  const left = Number(ui.leftPwm.value);
  const right = Number(ui.rightPwm.value);
  ui.leftPwmValue.textContent = `${left}%`;
  ui.rightPwmValue.textContent = `${right}%`;
  ui.sendPwmButton.textContent = `发送 PWM L=${left} / R=${right}`;
}

ui.connectButton.addEventListener("click", connectBluetooth);
ui.disconnectButton.addEventListener("click", disconnectBluetooth);

document.querySelectorAll(".mode-choice").forEach((button) => {
  button.addEventListener("click", async () => {
    if (await sendCommand(button.dataset.command)) setMode(button.dataset.mode);
  });
});

document.querySelectorAll("button[data-command]:not(.mode-choice)").forEach((button) => {
  button.addEventListener("click", async () => {
    if (!(await sendCommand(button.dataset.command))) return;

    const motionCommands = {
      FORWARD: "forward",
      BACKWARD: "backward",
      LEFT: "left",
      RIGHT: "right",
      STOP: "stop"
    };
    if (motionCommands[button.dataset.command]) setMotion(motionCommands[button.dataset.command]);
  });
});

[ui.leftPwm, ui.rightPwm].forEach((slider) => slider.addEventListener("input", updatePwmReadout));

ui.sendPwmButton.addEventListener("click", async () => {
  const left = Number(ui.leftPwm.value);
  const right = Number(ui.rightPwm.value);
  if (await sendCommand(`PWM ${left} ${right}`)) {
    setMotion("pwm");
    ui.leftForwardPwmValue.textContent = String(left);
    ui.leftBackwardPwmValue.textContent = "0";
    ui.rightForwardPwmValue.textContent = String(right);
    ui.rightBackwardPwmValue.textContent = "0";
  }
});

ui.refreshButton.addEventListener("click", async () => {
  await sendCommand("CHECK");
  if (state.mode !== "standby") await sendCommand("ENC");
  await sendCommand("MOTOR");
});

ui.clearLogButton.addEventListener("click", () => {
  ui.logWindow.innerHTML = '<p class="muted">日志已清空</p>';
});

setConnected(false);
updatePwmReadout();
