"use strict";

const SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
const CHARACTERISTIC_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";
const $ = (id) => document.getElementById(id);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ui = {
  connectionState: $("connectionState"), connectionText: $("connectionText"),
  connectButton: $("connectButton"), disconnectButton: $("disconnectButton"),
  deviceName: $("deviceName"), message: $("message"),
  modeValue: $("modeValue"), motionValue: $("motionValue"), voltageValue: $("voltageValue"),
  remoteLock: $("remoteLock"), sensorLock: $("sensorLock"),
  leftPwm: $("leftPwm"), rightPwm: $("rightPwm"),
  leftPwmValue: $("leftPwmValue"), rightPwmValue: $("rightPwmValue"), sendPwmButton: $("sendPwmButton"),
  leftCpsValue: $("leftCpsValue"), rightCpsValue: $("rightCpsValue"),
  leftTargetValue: $("leftTargetValue"), rightTargetValue: $("rightTargetValue"),
  leftMotorPwmValue: $("leftMotorPwmValue"), rightMotorPwmValue: $("rightMotorPwmValue"),
  straightErrorValue: $("straightErrorValue"), straightTrimValue: $("straightTrimValue"),
  distanceValue: $("distanceValue"), routeValue: $("routeValue"), thresholdValue: $("thresholdValue"),
  servoValue: $("servoValue"), servoControlValue: $("servoControlValue"),
  leftDistanceValue: $("leftDistanceValue"), rightDistanceValue: $("rightDistanceValue"),
  servoAngle: $("servoAngle"), servoAngleValue: $("servoAngleValue"), sendServoButton: $("sendServoButton"),
  tuningStatus: $("tuningStatus"), readParamsButton: $("readParamsButton"),
  stageParamsButton: $("stageParamsButton"), applyParamsButton: $("applyParamsButton"),
  cancelParamsButton: $("cancelParamsButton"),
  runNote: $("runNote"), sampleInterval: $("sampleInterval"), sampleNowButton: $("sampleNowButton"),
  recordButton: $("recordButton"), recordStatus: $("recordStatus"),
  exportLogButton: $("exportLogButton"), clearLogButton: $("clearLogButton"), logWindow: $("logWindow")
};

const state = { connected: false, mode: "standby", motion: "stop" };
const telemetry = {
  leftCps: null, rightCps: null, targetLeft: null, targetRight: null,
  pwmLeft: null, pwmRight: null, error: null, trim: null, voltageMv: null,
  distance: null, route: "NONE", servo: null, servoControl: "AUTO",
  leftDistance: null, rightDistance: null
};

const knownParams = {};
const motorChannels = { LF: 0, LB: 0, RF: 0, RB: 0 };
const logRecords = [];
let paramsLoaded = false;
let bluetoothDevice = null;
let uartCharacteristic = null;
let receiveBuffer = "";
let writeQueue = Promise.resolve();
let intentionalDisconnect = false;
let sampleTimer = null;
let recording = false;
let sampleStartedAt = null;

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();
const paramInputs = new Map(
  [...document.querySelectorAll(".param-input")].map((input) => [input.dataset.param, input])
);

function setMessage(text, isError = false) {
  ui.message.textContent = text;
  ui.message.classList.toggle("error", isError);
}

function snapshot() {
  return {
    mode: state.mode, motion: state.motion,
    left_cps: telemetry.leftCps, right_cps: telemetry.rightCps,
    target_left: telemetry.targetLeft, target_right: telemetry.targetRight,
    pwm_left: telemetry.pwmLeft, pwm_right: telemetry.pwmRight,
    straight_error: telemetry.error, straight_trim: telemetry.trim,
    voltage_mv: telemetry.voltageMv, distance_cm: telemetry.distance,
    route: telemetry.route, servo_deg: telemetry.servo, servo_control: telemetry.servoControl
  };
}

function addLog(text, kind = "rx") {
  const placeholder = ui.logWindow.querySelector(".muted");
  if (placeholder) placeholder.remove();

  const line = document.createElement("p");
  line.className = kind === "tx" ? "tx" : kind === "error" ? "error-line" : "";
  line.textContent = `${kind === "tx" ? "TX" : kind === "error" ? "ERR" : "RX"} › ${text}`;
  ui.logWindow.appendChild(line);
  while (ui.logWindow.children.length > 160) ui.logWindow.firstElementChild.remove();
  ui.logWindow.scrollTop = ui.logWindow.scrollHeight;

  logRecords.push({
    time: new Date().toISOString(),
    elapsed_ms: sampleStartedAt ? Date.now() - sampleStartedAt : 0,
    kind, text, ...snapshot()
  });
  ui.recordStatus.textContent = recording ? `采样中 · ${logRecords.length}` : `${logRecords.length} 条`;
  ui.exportLogButton.disabled = logRecords.length === 0;
}

function selectTab(name) {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === name);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    const active = panel.dataset.panel === name;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
}

function setMotion(motion) {
  state.motion = motion;
  ui.motionValue.textContent = motion.toUpperCase();
}

function setMode(mode) {
  state.mode = mode;
  if (mode !== "remote") setMotion("stop");
  updateAvailability();
}

function updateAvailability() {
  const remoteReady = state.connected && state.mode === "remote";
  const sensorReady = state.connected && state.mode === "sensor";

  document.querySelectorAll(".requires-connection").forEach((element) => { element.disabled = !state.connected; });
  document.querySelectorAll(".remote-only").forEach((element) => { element.disabled = !remoteReady; });
  document.querySelectorAll(".sensor-only").forEach((element) => { element.disabled = !sensorReady; });
  document.querySelectorAll(".mode-choice[data-mode]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.mode === state.mode);
  });

  ui.modeValue.textContent = state.mode.toUpperCase();
  ui.remoteLock.textContent = remoteReady ? "已就绪" : "需进入遥控模式";
  ui.sensorLock.textContent = sensorReady ? "已运行" : "需进入传感模式";
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
    stopSampling();
  }
  updateAvailability();
}

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    setMessage("浏览器不支持网页蓝牙；iPhone 请使用 Bluefy", true);
    return;
  }

  try {
    setMessage("选择蓝牙设备…");
    bluetoothDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [SERVICE_UUID]
    });
    bluetoothDevice.addEventListener("gattserverdisconnected", handleDisconnected);
    setMessage("正在连接…");
    const server = await bluetoothDevice.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    uartCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
    if (uartCharacteristic.properties.notify || uartCharacteristic.properties.indicate) {
      await uartCharacteristic.startNotifications();
      uartCharacteristic.addEventListener("characteristicvaluechanged", handleNotification);
    }

    intentionalDisconnect = false;
    ui.deviceName.textContent = bluetoothDevice.name || "未命名设备";
    setConnected(true);
    addLog(`CONNECTED ${bluetoothDevice.name || "UNKNOWN"}`);
    await sendCommand("CHECK");
    setMessage("连接成功");
  } catch (error) {
    if (error.name === "NotFoundError") {
      setMessage("已取消选择");
      return;
    }
    uartCharacteristic = null;
    setConnected(false);
    setMessage(`连接失败：${error.message}`, true);
    addLog(error.message, "error");
  }
}

async function disconnectBluetooth() {
  if (!bluetoothDevice?.gatt?.connected) return;
  intentionalDisconnect = true;
  await sendCommand("STOP");
  bluetoothDevice.gatt.disconnect();
}

function handleDisconnected() {
  const planned = intentionalDisconnect;
  intentionalDisconnect = false;
  uartCharacteristic = null;
  receiveBuffer = "";
  setConnected(false);
  ui.deviceName.textContent = "--";
  setMessage(planned ? "已停车并断开" : "意外断线，无法确认停车", !planned);
  addLog(planned ? "DISCONNECTED" : "UNEXPECTED DISCONNECT", planned ? "rx" : "error");
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
    setMessage("请先连接蓝牙", true);
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
    setMessage(`${command} 已发送`);
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

function updateMotorFromChannels() {
  telemetry.pwmLeft = motorChannels.LF - motorChannels.LB;
  telemetry.pwmRight = motorChannels.RF - motorChannels.RB;
  ui.leftMotorPwmValue.textContent = telemetry.pwmLeft;
  ui.rightMotorPwmValue.textContent = telemetry.pwmRight;
}

function showDistance(value) {
  return value === "OUT" || value === null ? "--" : String(value);
}

function processLine(line) {
  const modeMatch = line.match(/(?:MODE=|OK MODE |OK STOPPED MODE )(STANDBY|REMOTE|SENSOR)\b/i);
  if (modeMatch) setMode(modeMatch[1].toLowerCase());

  const motionMatch = line.match(/MOTION=(STOP|FORWARD|BACKWARD|LEFT|RIGHT|PWM)\b/i);
  if (motionMatch) setMotion(motionMatch[1].toLowerCase());

  const trace = line.match(/^TRACE M=(\w+) L=([+-]?\d+) R=([+-]?\d+) TL=([+-]?\d+) TR=([+-]?\d+) PL=([+-]?\d+) PR=([+-]?\d+) E=([+-]?\d+) C=([+-]?\d+) V=(\d+)$/i);
  if (trace) {
    setMotion(trace[1].toLowerCase());
    [telemetry.leftCps, telemetry.rightCps, telemetry.targetLeft, telemetry.targetRight,
      telemetry.pwmLeft, telemetry.pwmRight, telemetry.error, telemetry.trim, telemetry.voltageMv] = trace.slice(2).map(Number);
    ui.leftCpsValue.textContent = telemetry.leftCps;
    ui.rightCpsValue.textContent = telemetry.rightCps;
    ui.leftTargetValue.textContent = telemetry.targetLeft;
    ui.rightTargetValue.textContent = telemetry.targetRight;
    ui.leftMotorPwmValue.textContent = telemetry.pwmLeft;
    ui.rightMotorPwmValue.textContent = telemetry.pwmRight;
    ui.straightErrorValue.textContent = telemetry.error;
    ui.straightTrimValue.textContent = telemetry.trim;
    ui.voltageValue.textContent = `${(telemetry.voltageMv / 1000).toFixed(2)}V`;
  }

  const sensor = line.match(/^SENSOR D=(OUT|\d+) TH=(\d+) ROUTE=(NONE|LEFT|RIGHT|BLOCKED) SERVO=(\d+) CTRL=(AUTO|MANUAL) L=(OUT|\d+) R=(OUT|\d+)$/i);
  if (sensor) {
    telemetry.distance = sensor[1] === "OUT" ? null : Number(sensor[1]);
    telemetry.route = sensor[3].toUpperCase();
    telemetry.servo = Number(sensor[4]);
    telemetry.servoControl = sensor[5].toUpperCase();
    telemetry.leftDistance = sensor[6] === "OUT" ? null : Number(sensor[6]);
    telemetry.rightDistance = sensor[7] === "OUT" ? null : Number(sensor[7]);
    ui.distanceValue.textContent = showDistance(telemetry.distance);
    ui.thresholdValue.textContent = sensor[2];
    ui.routeValue.textContent = telemetry.route;
    ui.servoValue.textContent = `${telemetry.servo}°`;
    ui.servoControlValue.textContent = telemetry.servoControl;
    ui.leftDistanceValue.textContent = showDistance(telemetry.leftDistance);
    ui.rightDistanceValue.textContent = showDistance(telemetry.rightDistance);
  }

  const sensorVoltage = line.match(/^SENSOR VBAT_MV=(\d+)/i);
  if (sensorVoltage) {
    telemetry.voltageMv = Number(sensorVoltage[1]);
    ui.voltageValue.textContent = `${(telemetry.voltageMv / 1000).toFixed(2)}V`;
  }

  const cps = line.match(/ENC CPS L=([+-]?\d+) R=([+-]?\d+)/i);
  if (cps) {
    telemetry.leftCps = Number(cps[1]);
    telemetry.rightCps = Number(cps[2]);
    ui.leftCpsValue.textContent = telemetry.leftCps;
    ui.rightCpsValue.textContent = telemetry.rightCps;
  }

  const straight = line.match(/STRAIGHT ERR=([+-]?\d+) TRIM=([+-]?\d+) CPS/i);
  if (straight) {
    telemetry.error = Number(straight[1]);
    telemetry.trim = Number(straight[2]);
    ui.straightErrorValue.textContent = telemetry.error;
    ui.straightTrimValue.textContent = telemetry.trim;
  }

  const pwm = line.match(/^PWM L=(\d+) R=(\d+)$/i);
  if (pwm) {
    setMotion("pwm");
    telemetry.pwmLeft = Number(pwm[1]);
    telemetry.pwmRight = Number(pwm[2]);
    ui.leftMotorPwmValue.textContent = telemetry.pwmLeft;
    ui.rightMotorPwmValue.textContent = telemetry.pwmRight;
  }

  const motor = line.match(/MOTOR (LF|LB|RF|RB)_PWM=(\d+)/i);
  if (motor) {
    motorChannels[motor[1].toUpperCase()] = Number(motor[2]);
    updateMotorFromChannels();
  }

  const param = line.match(/^(?:(?:ACTIVE|STAGED) )?([A-Z0-9_]+)=(\d+)/);
  if (paramInputs.has(param?.[1])) {
    knownParams[param[1]] = Number(param[2]);
    paramInputs.get(param[1]).value = param[2];
  }
  if (/^PENDING=YES$/i.test(line)) ui.tuningStatus.textContent = "有暂存";
  if (/^PENDING=NO$/i.test(line)) ui.tuningStatus.textContent = "已同步";
  if (/^PARAMS END$/i.test(line)) {
    paramsLoaded = true;
    ui.tuningStatus.textContent = "已读取";
  }
  if (/^OK SAVED TO FLASH$/i.test(line)) ui.tuningStatus.textContent = "已保存";
  if (/^ERR\b/i.test(line)) setMessage(line, true);

  addLog(line, /^ERR\b/i.test(line) ? "error" : "rx");
}

function updatePwmReadout() {
  ui.leftPwmValue.textContent = `${ui.leftPwm.value}%`;
  ui.rightPwmValue.textContent = `${ui.rightPwm.value}%`;
  ui.sendPwmButton.textContent = `发送 ${ui.leftPwm.value} / ${ui.rightPwm.value}`;
}

function updateServoReadout() {
  ui.servoAngleValue.textContent = `${ui.servoAngle.value}°`;
  ui.sendServoButton.textContent = `转到 ${ui.servoAngle.value}°`;
}

function changedParameterEntries() {
  const entries = [];
  for (const [key, input] of paramInputs) {
    if (!input.reportValidity()) return null;
    const value = Number(input.value);
    if (!Number.isInteger(value)) return null;
    if (knownParams[key] !== value) entries.push({ key, value });
  }

  const ffIndex = entries.findIndex((entry) => entry.key === "SPEED_FF_PCT");
  const maxIndex = entries.findIndex((entry) => entry.key === "SPEED_MAX_PCT");
  if (ffIndex >= 0 && maxIndex >= 0) {
    const currentFf = knownParams.SPEED_FF_PCT;
    const newMax = entries[maxIndex].value;
    const firstKey = newMax < currentFf ? "SPEED_FF_PCT" : "SPEED_MAX_PCT";
    entries.sort((a, b) => (a.key === firstKey ? -1 : b.key === firstKey ? 1 : 0));
  }
  return entries;
}

async function stageChangedParameters(showEmptyMessage = true) {
  if (!paramsLoaded) {
    setMessage("请先读取当前参数", true);
    selectTab("tuning");
    return false;
  }
  const entries = changedParameterEntries();
  if (entries === null) return false;
  if (entries.length === 0) {
    if (showEmptyMessage) setMessage("参数没有变化");
    return true;
  }

  ui.tuningStatus.textContent = "暂存中…";
  for (const entry of entries) {
    if (!(await sendCommand(`SET ${entry.key} ${entry.value}`))) return false;
    await delay(140);
  }
  ui.tuningStatus.textContent = "已发送暂存";
  return true;
}

async function sampleNow() {
  if (!state.connected) return;
  if (state.mode === "remote") await sendCommand("TRACE");
  else if (state.mode === "sensor") await sendCommand("SENSOR");
  else await sendCommand("CHECK");
}

function startSampling() {
  if (recording || !state.connected) return;
  recording = true;
  sampleStartedAt = Date.now();
  ui.recordButton.textContent = "停止采样";
  ui.recordStatus.textContent = `采样中 · ${logRecords.length}`;
  sampleNow();
  sampleTimer = setInterval(sampleNow, Number(ui.sampleInterval.value));
}

function stopSampling() {
  if (sampleTimer) clearInterval(sampleTimer);
  sampleTimer = null;
  recording = false;
  if (ui.recordButton) ui.recordButton.textContent = "连续采样";
  if (ui.recordStatus) ui.recordStatus.textContent = `${logRecords.length} 条`;
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv() {
  const columns = ["time", "elapsed_ms", "kind", "mode", "motion", "left_cps", "right_cps", "target_left", "target_right", "pwm_left", "pwm_right", "straight_error", "straight_trim", "voltage_mv", "distance_cm", "route", "servo_deg", "servo_control", "note", "text"];
  const rows = [columns.join(",")];
  for (const record of logRecords) {
    const row = { ...record, note: ui.runNote.value };
    rows.push(columns.map((column) => csvCell(row[column])).join(","));
  }
  const blob = new Blob(["\ufeff", rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `smart-car-log-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

ui.connectButton.addEventListener("click", connectBluetooth);
ui.disconnectButton.addEventListener("click", disconnectBluetooth);
document.querySelectorAll(".tab-button").forEach((button) => button.addEventListener("click", () => selectTab(button.dataset.tab)));

document.querySelectorAll(".mode-choice[data-mode]").forEach((button) => {
  button.addEventListener("click", async () => {
    if (!(await sendCommand(button.dataset.command))) return;
    setMode(button.dataset.mode);
    if (button.dataset.mode === "remote" || button.dataset.mode === "sensor") selectTab(button.dataset.mode);
  });
});

document.querySelectorAll("button[data-command]:not([data-mode])").forEach((button) => {
  button.addEventListener("click", async () => {
    if (!(await sendCommand(button.dataset.command))) return;
    const motions = { FORWARD: "forward", BACKWARD: "backward", LEFT: "left", RIGHT: "right", STOP: "stop" };
    if (motions[button.dataset.command]) setMotion(motions[button.dataset.command]);
  });
});

[ui.leftPwm, ui.rightPwm].forEach((slider) => slider.addEventListener("input", updatePwmReadout));
ui.sendPwmButton.addEventListener("click", async () => {
  if (await sendCommand(`PWM ${ui.leftPwm.value} ${ui.rightPwm.value}`)) setMotion("pwm");
});

ui.servoAngle.addEventListener("input", updateServoReadout);
ui.sendServoButton.addEventListener("click", () => sendCommand(`SERVO ${ui.servoAngle.value}`));
document.querySelectorAll(".servo-preset").forEach((button) => {
  button.addEventListener("click", () => {
    const angle = knownParams[button.dataset.servoParam] ?? Number(paramInputs.get(button.dataset.servoParam).value);
    ui.servoAngle.value = angle;
    updateServoReadout();
    sendCommand(`SERVO ${angle}`);
  });
});

ui.readParamsButton.addEventListener("click", () => {
  ui.tuningStatus.textContent = "读取中…";
  sendCommand("CHECK");
});
ui.stageParamsButton.addEventListener("click", () => stageChangedParameters());
ui.applyParamsButton.addEventListener("click", async () => {
  if (!(await stageChangedParameters(false))) return;
  await delay(180);
  if (await sendCommand("APPLY")) ui.tuningStatus.textContent = "保存中…";
});
ui.cancelParamsButton.addEventListener("click", async () => {
  if (!(await sendCommand("CANCEL"))) return;
  await delay(140);
  await sendCommand("CHECK");
});

ui.sampleNowButton.addEventListener("click", sampleNow);
ui.recordButton.addEventListener("click", () => recording ? stopSampling() : startSampling());
ui.sampleInterval.addEventListener("change", () => {
  if (!recording) return;
  stopSampling();
  startSampling();
});
ui.exportLogButton.addEventListener("click", exportCsv);
ui.clearLogButton.addEventListener("click", () => {
  logRecords.length = 0;
  sampleStartedAt = recording ? Date.now() : null;
  ui.logWindow.innerHTML = '<p class="muted">日志已清空</p>';
  ui.exportLogButton.disabled = true;
  ui.recordStatus.textContent = recording ? "采样中 · 0" : "0 条";
});

setConnected(false);
selectTab("remote");
updatePwmReadout();
updateServoReadout();
