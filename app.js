"use strict";

const SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
const CHARACTERISTIC_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";
const $ = (id) => document.getElementById(id);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ui = {
  connectionState: $("connectionState"), connectionText: $("connectionText"),
  connectButton: $("connectButton"), disconnectButton: $("disconnectButton"),
  connectionType: $("connectionType"), deviceNameFilter: $("deviceNameFilter"),
  deviceName: $("deviceName"), message: $("message"),
  modeValue: $("modeValue"), motionValue: $("motionValue"), voltageValue: $("voltageValue"),
  remoteLock: $("remoteLock"), sensorLock: $("sensorLock"),
  joystickPad: $("joystickPad"), joystickKnob: $("joystickKnob"), joystickValue: $("joystickValue"),
  turn90Status: $("turn90Status"), calibrateLeftButton: $("calibrateLeftButton"),
  calibrateRightButton: $("calibrateRightButton"), finishTurnCalibrationButton: $("finishTurnCalibrationButton"),
  turnCalibrationResult: $("turnCalibrationResult"), saveTurnCalibrationButton: $("saveTurnCalibrationButton"),
  distanceValue: $("distanceValue"), routeValue: $("routeValue"), thresholdValue: $("thresholdValue"),
  servoValue: $("servoValue"), servoControlValue: $("servoControlValue"),
  leftDistanceValue: $("leftDistanceValue"), rightDistanceValue: $("rightDistanceValue"),
  lineLeftTransValue: $("lineLeftTransValue"), lineLeftLongValue: $("lineLeftLongValue"),
  lineRightTransValue: $("lineRightTransValue"), lineRightLongValue: $("lineRightLongValue"),
  lineErrorValue: $("lineErrorValue"), trackStateValue: $("trackStateValue"),
  trackRunValue: $("trackRunValue"), avoidanceValue: $("avoidanceValue"),
  avoidanceStatus: $("avoidanceStatus"), trackStartButton: $("trackStartButton"),
  trackStopButton: $("trackStopButton"), trackPeakValue: $("trackPeakValue"),
  trackEndValue: $("trackEndValue"), trackPValue: $("trackPValue"), trackIValue: $("trackIValue"),
  trackDValue: $("trackDValue"), trackTrimValue: $("trackTrimValue"),
  lineCalibrationValue: $("lineCalibrationValue"), lineCalibrationButton: $("lineCalibrationButton"),
  copySensorButton: $("copySensorButton"),
  servoAngle: $("servoAngle"), servoAngleValue: $("servoAngleValue"), sendServoButton: $("sendServoButton"),
  tuningStatus: $("tuningStatus"), readParamsButton: $("readParamsButton"),
  applyParamsButton: $("applyParamsButton"), cancelParamsButton: $("cancelParamsButton"),
  runNote: $("runNote"), sampleInterval: $("sampleInterval"), sampleNowButton: $("sampleNowButton"),
  recordButton: $("recordButton"), recordStatus: $("recordStatus"),
  exportLogButton: $("exportLogButton"), clearLogButton: $("clearLogButton"), logWindow: $("logWindow"),
  logTitle: $("logTitle"), logProfileHint: $("logProfileHint")
};

const state = {
  connected: false, mode: "standby", motion: "stop", gear: "HIGH",
  trackGear: "LOW", trackRunning: false, trackState: "LOST", avoidance: false,
  lineCalibrated: false, lineCalibrating: false, trackEnd: "NONE"
};
const telemetry = {
  leftCps: null, rightCps: null, targetLeft: null, targetRight: null,
  pwmLeft: null, pwmRight: null, error: null, trim: null, voltageMv: null,
  distance: null, route: "NONE", servo: null, servoControl: "AUTO",
  leftDistance: null, rightDistance: null,
  lineLeftTrans: null, lineLeftLong: null, lineRightTrans: null, lineRightLong: null,
  lineLeftTransPct: null, lineLeftLongPct: null, lineRightTransPct: null, lineRightLongPct: null,
  lineErrorX100: null, lineTrim: null, trackBase: null,
  trackP: null, trackI: null, trackD: null,
  trackPeakErrorX100: null, trackPeakState: "LOST", trackPeakMs: null,
  trackPeakP: null, trackPeakI: null, trackPeakD: null, trackPeakTrim: null,
  trackPeakPercent: [null, null, null, null], trackEndMs: null,
  trackEndPercent: [null, null, null, null]
};

const knownParams = {};
const sampleRecords = [];
let paramsLoaded = false;
let bluetoothDevice = null;
let lastGrantedBleDevice = null;
let uartCharacteristic = null;
let serialPort = null;
let lastGrantedSerialPort = null;
let serialReader = null;
let serialWriter = null;
let serialReadTask = null;
let activeTransport = null;
let receiveBuffer = "";
let writeQueue = Promise.resolve();
let intentionalDisconnect = false;
let sampleTimer = null;
let recording = false;
let recordingMode = null;
let sampleCapturePending = false;
let sampleCaptureMode = null;
let lastFailureSignature = "";
let lastSampleMode = "sensor";
let sampleStartedAt = null;
let joystickPointerId = null;
let joystickX = 0;
let joystickY = 0;
let joystickTimer = null;
let joystickLastSentAt = 0;
let joystickLastCommand = "";
let calibrationDirection = null;
let calibrationSuggestion = null;
let linePollTimer = null;

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
    route: telemetry.route, servo_deg: telemetry.servo, servo_control: telemetry.servoControl,
    line_left_trans: telemetry.lineLeftTrans, line_left_long: telemetry.lineLeftLong,
    line_right_trans: telemetry.lineRightTrans, line_right_long: telemetry.lineRightLong,
    line_left_trans_pct: telemetry.lineLeftTransPct, line_left_long_pct: telemetry.lineLeftLongPct,
    line_right_trans_pct: telemetry.lineRightTransPct, line_right_long_pct: telemetry.lineRightLongPct,
    line_error_x100: telemetry.lineErrorX100, line_trim_cps: telemetry.lineTrim,
    line_calibrated: state.lineCalibrated, track_base_cps: telemetry.trackBase,
    track_p_cps: telemetry.trackP, track_i_cps: telemetry.trackI, track_d_cps: telemetry.trackD,
    track_end: state.trackEnd, track_end_ms: telemetry.trackEndMs,
    track_peak_error_x100: telemetry.trackPeakErrorX100,
    track_peak_p_cps: telemetry.trackPeakP, track_peak_i_cps: telemetry.trackPeakI,
    track_peak_d_cps: telemetry.trackPeakD, track_peak_trim_cps: telemetry.trackPeakTrim,
    track_peak_state: telemetry.trackPeakState, track_peak_ms: telemetry.trackPeakMs,
    peak_left_trans_pct: telemetry.trackPeakPercent[0], peak_left_long_pct: telemetry.trackPeakPercent[1],
    peak_right_trans_pct: telemetry.trackPeakPercent[2], peak_right_long_pct: telemetry.trackPeakPercent[3],
    end_left_trans_pct: telemetry.trackEndPercent[0], end_left_long_pct: telemetry.trackEndPercent[1],
    end_right_trans_pct: telemetry.trackEndPercent[2], end_right_long_pct: telemetry.trackEndPercent[3],
    track_state: state.trackState, track_running: state.trackRunning,
    avoidance: state.avoidance ? "ON" : "OFF",
    remote_speed_gear: state.gear, track_speed_gear: state.trackGear
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

}

function currentLogMode() {
  if (state.mode === "remote" || state.mode === "sensor") return state.mode;
  return lastSampleMode;
}

function recordsForMode(mode = currentLogMode()) {
  return sampleRecords.filter((record) => record.mode === mode);
}

function updateLogProfile() {
  const mode = recordingMode || currentLogMode();
  const count = recordsForMode(mode).length;
  const sensor = mode === "sensor";
  ui.logTitle.textContent = sensor ? "巡线日志" : "遥控日志";
  ui.logProfileHint.textContent = sensor ?
    "记录 PID、四路传感器、失败原因和峰值误差现场。" :
    "记录运动、编码器、直线误差与修正结果。";
  ui.recordStatus.textContent = recording ? `采样中 · ${count}` : `${count} 条`;
  ui.exportLogButton.disabled = count === 0;
}

function captureSample(mode, text) {
  lastSampleMode = mode;
  sampleRecords.push({
    time: new Date().toISOString(),
    elapsed_ms: sampleStartedAt ? Date.now() - sampleStartedAt : 0,
    sample_type: mode, text, ...snapshot(), mode
  });
  updateLogProfile();
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
  if (name === "logs") updateLogProfile();
}

function drawJoystick(x, y) {
  joystickX = x;
  joystickY = y;
  ui.joystickValue.textContent = `X ${x} · Y ${y}`;
  ui.joystickKnob.style.left = `${50 + x * 0.36}%`;
  ui.joystickKnob.style.top = `${50 - y * 0.36}%`;
}

function queueJoystick(x, y, force = false) {
  drawJoystick(x, y);
  if (!state.connected || state.mode !== "remote") return;

  const command = `JOY ${x} ${y}`;
  const now = performance.now();
  const wait = 80 - (now - joystickLastSentAt);
  const transmit = () => {
    joystickTimer = null;
    if (!force && command === joystickLastCommand) return;
    joystickLastCommand = command;
    joystickLastSentAt = performance.now();
    sendCommand(command);
  };

  if (joystickTimer) clearTimeout(joystickTimer);
  if (force || wait <= 0) transmit();
  else joystickTimer = setTimeout(transmit, wait);
}

function centerJoystick(sendStop = false) {
  joystickPointerId = null;
  if (joystickTimer) clearTimeout(joystickTimer);
  joystickTimer = null;
  drawJoystick(0, 0);
  if (sendStop && state.connected && state.mode === "remote") {
    joystickLastCommand = "";
    queueJoystick(0, 0, true);
    setMotion("stop");
  }
}

function joystickFromPointer(event) {
  const rect = ui.joystickPad.getBoundingClientRect();
  const radius = Math.max(1, Math.min(rect.width, rect.height) * 0.36);
  let dx = event.clientX - (rect.left + rect.width / 2);
  let dy = event.clientY - (rect.top + rect.height / 2);
  const distance = Math.hypot(dx, dy);
  if (distance > radius) {
    dx = dx * radius / distance;
    dy = dy * radius / distance;
  }
  let x = Math.round(dx / radius * 100);
  let y = Math.round(-dy / radius * 100);
  if (Math.abs(x) <= 12) x = 0;
  if (Math.abs(y) <= 12) y = 0;
  queueJoystick(x, y);
}

function updateTurn90Status() {
  const left = knownParams.TURN90_L_COUNT || 0;
  const right = knownParams.TURN90_R_COUNT || 0;
  if (left && right) ui.turn90Status.textContent = `左 ${left} · 右 ${right}`;
  else if (left || right) ui.turn90Status.textContent = left ? `左 ${left} · 右未标定` : `左未标定 · 右 ${right}`;
  else ui.turn90Status.textContent = "未标定";
}

function setMotion(motion) {
  state.motion = motion;
  ui.motionValue.textContent = motion.toUpperCase();
}

function setGear(gear) {
  state.gear = gear;
  document.querySelectorAll(".gear-choice").forEach((button) => {
    button.classList.toggle("selected", button.dataset.gear === gear);
  });
}

function setTrackGear(gear) {
  state.trackGear = gear;
  document.querySelectorAll(".track-gear-choice").forEach((button) => {
    button.classList.toggle("selected", button.dataset.trackGear === gear);
  });
}

function setTrackState(trackState) {
  const labels = { LOST: "丢线", STRAIGHT: "直线", LEFT: "左转", RIGHT: "右转", CROSS: "十字" };
  state.trackState = trackState;
  ui.trackStateValue.textContent = labels[trackState] || trackState;
  ui.trackStateValue.dataset.state = trackState;
}

function setTrackRunning(running) {
  state.trackRunning = running;
  ui.trackRunValue.textContent = running ? "循迹中" : "已停止";
  updateAvailability();
}

function setAvoidance(enabled) {
  state.avoidance = enabled;
  ui.avoidanceValue.textContent = enabled ? "开启" : "关闭";
  ui.avoidanceStatus.textContent = enabled ? "避障开启" : "避障关闭";
  document.querySelectorAll(".avoid-choice").forEach((button) => {
    button.classList.toggle("selected", button.dataset.avoid === (enabled ? "ON" : "OFF"));
  });
}

function setLineCalibrated(calibrated) {
  state.lineCalibrated = calibrated;
  ui.lineCalibrationValue.textContent = calibrated ? "百分比已标定" : "百分比未标定";
  ui.lineCalibrationValue.classList.toggle("ready", calibrated);
  updateAvailability();
}

function setLineCalibrating(calibrating) {
  state.lineCalibrating = calibrating;
  ui.lineCalibrationButton.textContent = calibrating ? "完成并保存标定" : "开始范围标定";
  ui.lineCalibrationButton.classList.toggle("stop-button", calibrating);
  updateAvailability();
}

function stopLinePolling() {
  if (linePollTimer) clearInterval(linePollTimer);
  linePollTimer = null;
}

function startLinePolling() {
  stopLinePolling();
  if (!state.connected || state.mode !== "sensor") return;
  linePollTimer = setInterval(() => {
    if (state.connected && state.mode === "sensor") sendCommand("LINE");
  }, 350);
}

function setMode(mode) {
  if (state.mode === "sensor" && mode !== "sensor") stopLinePolling();
  state.mode = mode;
  if (recording && recordingMode !== mode) stopSampling();
  joystickLastCommand = "";
  if (mode !== "remote") {
    setMotion("stop");
    centerJoystick(false);
  }
  if (mode !== "sensor") {
    setTrackRunning(false);
    setAvoidance(false);
    setLineCalibrating(false);
  }
  updateAvailability();
  if (mode === "sensor") startLinePolling();
}

function updateAvailability() {
  const remoteReady = state.connected && state.mode === "remote";
  const sensorReady = state.connected && state.mode === "sensor";

  document.querySelectorAll(".requires-connection").forEach((element) => { element.disabled = !state.connected; });
  document.querySelectorAll(".remote-only").forEach((element) => { element.disabled = !remoteReady; });
  document.querySelectorAll(".sensor-only").forEach((element) => { element.disabled = !sensorReady; });
  document.querySelectorAll(".mode-entry-button[data-mode]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.mode === state.mode);
    button.textContent = button.dataset.mode === state.mode ? "当前模式" :
                         button.dataset.mode === "remote" ? "进入遥控" : "进入巡线";
  });

  ui.modeValue.textContent = state.mode.toUpperCase();
  ui.saveTurnCalibrationButton.disabled = !state.connected || !calibrationSuggestion;
  ui.remoteLock.textContent = remoteReady ? "已就绪" : "需进入遥控模式";
  ui.sensorLock.textContent = sensorReady ? "传感已就绪" : "需进入传感模式";
  ui.trackStartButton.disabled = !sensorReady || state.trackRunning || !state.lineCalibrated || state.lineCalibrating;
  ui.trackStopButton.disabled = !sensorReady || !state.trackRunning;
  ui.lineCalibrationButton.disabled = !sensorReady || state.trackRunning;
  updateLogProfile();
}

function selectedConnectionType() {
  return ui.connectionType.value;
}

function selectedLastDevice() {
  return selectedConnectionType() === "serial" ? lastGrantedSerialPort : lastGrantedBleDevice;
}

function lastDeviceLabel() {
  if (selectedConnectionType() === "serial") return lastGrantedSerialPort ? "上次：已授权的 SPP 设备" : "--";
  return lastGrantedBleDevice ? `上次：${lastGrantedBleDevice.name || "未命名设备"}` : "--";
}

function updateConnectionControls() {
  const serialSelected = selectedConnectionType() === "serial";
  ui.deviceNameFilter.hidden = serialSelected;
  ui.connectionType.disabled = state.connected;
  ui.deviceNameFilter.disabled = state.connected;
  ui.connectButton.textContent = serialSelected ? "连接" : "搜索设备";
  ui.disconnectButton.disabled = !state.connected && !selectedLastDevice();
  ui.disconnectButton.textContent = state.connected ? "断开" : "上次设备";
  if (!state.connected) ui.deviceName.textContent = lastDeviceLabel();
}

function setConnected(connected) {
  state.connected = connected;
  ui.connectionState.classList.toggle("connected", connected);
  ui.connectionText.textContent = connected ? "已连接" : "未连接";
  ui.connectButton.disabled = connected;
  updateConnectionControls();
  if (!connected) {
    stopLinePolling();
    state.mode = "standby";
    state.motion = "stop";
    setTrackRunning(false);
    setAvoidance(false);
    setLineCalibrated(false);
    setLineCalibrating(false);
    joystickLastCommand = "";
    calibrationDirection = null;
    calibrationSuggestion = null;
    ui.turnCalibrationResult.textContent = "选择方向，看到 90° 时停车";
    centerJoystick(false);
    stopSampling();
  }
  updateAvailability();
}

function receiveBytes(value) {
  receiveBuffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
  const lines = receiveBuffer.split("\n");
  receiveBuffer = lines.pop() || "";
  lines.map((line) => line.trim()).filter(Boolean).forEach(processLine);
}

async function readSerialPort(port) {
  const reader = port.readable.getReader();
  serialReader = reader;
  try {
    while (serialPort === port) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) receiveBytes(value);
    }
  } catch (error) {
    if (serialPort === port && !intentionalDisconnect) addLog(`串口读取失败：${error.message}`, "error");
  } finally {
    try { reader.releaseLock(); } catch (_) { /* 已释放 */ }
    if (serialReader === reader) serialReader = null;
    if (serialPort === port) {
      serialPort = null;
      if (serialWriter) {
        try { serialWriter.releaseLock(); } catch (_) { /* 已释放 */ }
      }
      serialWriter = null;
      activeTransport = null;
      handleDisconnected();
    }
  }
}

async function connectSerialPort(port) {
  setMessage("正在连接 JDY-31 串口…");
  await port.open({ baudRate: 9600, bufferSize: 1024 });
  serialPort = port;
  serialWriter = port.writable.getWriter();
  activeTransport = "serial";
  lastGrantedSerialPort = port;
  intentionalDisconnect = false;
  ui.deviceName.textContent = "JDY-31 · SPP";
  setConnected(true);
  addLog("CONNECTED JDY-31 SPP");
  serialReadTask = readSerialPort(port);
  await sendCommand("CHECK");
  setMessage("串口蓝牙连接成功");
}

async function connectBleDevice(device) {
  bluetoothDevice = device;
  bluetoothDevice.addEventListener("gattserverdisconnected", handleDisconnected);
  setMessage("正在连接 BLE…");
  const server = await bluetoothDevice.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  uartCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
  if (uartCharacteristic.properties.notify || uartCharacteristic.properties.indicate) {
    await uartCharacteristic.startNotifications();
    uartCharacteristic.addEventListener("characteristicvaluechanged", handleNotification);
  }

  activeTransport = "ble";
  lastGrantedBleDevice = device;
  localStorage.setItem("smartCarDeviceId", device.id);
  intentionalDisconnect = false;
  ui.deviceName.textContent = bluetoothDevice.name || "未命名设备";
  setConnected(true);
  addLog(`CONNECTED ${bluetoothDevice.name || "UNKNOWN"}`);
  await sendCommand("CHECK");
  setMessage("连接成功");
}

async function connectSerial() {
  if (!navigator.serial) {
    setMessage("此浏览器不支持网页串口；Android 请使用 Chrome 137 或更高版本", true);
    return;
  }

  try {
    setMessage("请选择已配对的 JDY-31 / HC-05…");
    const selectedPort = await navigator.serial.requestPort({
      filters: [{ bluetoothServiceClassId: "00001101-0000-1000-8000-00805f9b34fb" }]
    });
    await connectSerialPort(selectedPort);
  } catch (error) {
    if (error.name === "NotFoundError") {
      setMessage("未选择设备；请先在系统蓝牙中完成配对");
      return;
    }
    serialPort = null;
    serialWriter = null;
    activeTransport = null;
    setConnected(false);
    setMessage(`串口连接失败：${error.message}`, true);
    addLog(error.message, "error");
  }
}

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    setMessage("浏览器不支持 BLE 网页连接", true);
    return;
  }

  try {
    const namePrefix = ui.deviceNameFilter.value.trim();
    const requestOptions = { optionalServices: [SERVICE_UUID] };
    if (namePrefix) requestOptions.filters = [{ namePrefix }];
    else requestOptions.acceptAllDevices = true;
    localStorage.setItem("smartCarDevicePrefix", namePrefix);
    setMessage(namePrefix ? `只显示名称以 ${namePrefix} 开头的设备…` : "显示附近全部蓝牙设备…");
    const selectedDevice = await navigator.bluetooth.requestDevice(requestOptions);
    await connectBleDevice(selectedDevice);
  } catch (error) {
    if (error.name === "NotFoundError") {
      setMessage("未选择设备；可修改前缀或留空重试");
      return;
    }
    uartCharacteristic = null;
    setConnected(false);
    setMessage(`连接失败：${error.message}`, true);
    addLog(error.message, "error");
  }
}

function connectSelectedDevice() {
  return selectedConnectionType() === "serial" ? connectSerial() : connectBluetooth();
}

async function connectLastDevice() {
  const device = selectedLastDevice();
  if (!device) return;
  try {
    if (selectedConnectionType() === "serial") {
      setMessage("正在连接上次授权的 SPP 设备…");
      await connectSerialPort(device);
    } else {
      setMessage(`连接上次设备：${device.name || "未命名设备"}…`);
      await connectBleDevice(device);
    }
  } catch (error) {
    uartCharacteristic = null;
    serialPort = null;
    serialWriter = null;
    activeTransport = null;
    setConnected(false);
    setMessage(`上次设备连接失败：${error.message}`, true);
    addLog(error.message, "error");
  }
}

async function loadGrantedDevices() {
  if (navigator.serial?.getPorts) {
    try {
      const ports = await navigator.serial.getPorts();
      const sppPorts = ports.filter((port) => port.getInfo().bluetoothServiceClassId);
      if (sppPorts.length === 1) lastGrantedSerialPort = sppPorts[0];
    } catch (_) { /* 使用手动连接 */ }
  }

  if (navigator.bluetooth?.getDevices) {
    try {
      const devices = await navigator.bluetooth.getDevices();
      const savedId = localStorage.getItem("smartCarDeviceId");
      lastGrantedBleDevice = devices.find((device) => device.id === savedId) ||
                             (devices.length === 1 ? devices[0] : null);
    } catch (_) { /* 使用手动连接 */ }
  }

  updateConnectionControls();
  if (selectedLastDevice()) setMessage("可直接连接上次设备，或重新选择");
}

async function disconnectCurrentDevice() {
  if (!state.connected) return;
  intentionalDisconnect = true;
  await sendCommand("STOP");
  if (activeTransport === "serial") {
    const port = serialPort;
    serialPort = null;
    try { await serialReader?.cancel(); } catch (_) { /* 已断开 */ }
    try { await serialReadTask; } catch (_) { /* 读取循环已结束 */ }
    if (serialWriter) {
      try { serialWriter.releaseLock(); } catch (_) { /* 已释放 */ }
    }
    serialWriter = null;
    serialReadTask = null;
    activeTransport = null;
    try { await port?.close(); } catch (_) { /* 设备已经关闭 */ }
    handleDisconnected();
    return;
  }
  bluetoothDevice?.gatt?.disconnect();
}

function handleDisconnected() {
  const planned = intentionalDisconnect;
  intentionalDisconnect = false;
  uartCharacteristic = null;
  bluetoothDevice = null;
  activeTransport = null;
  receiveBuffer = "";
  setConnected(false);
  ui.deviceName.textContent = lastDeviceLabel();
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
  if (!state.connected) {
    setMessage("请先连接蓝牙", true);
    return false;
  }
  try {
    const data = encoder.encode(`${command}\n`);
    if (activeTransport === "serial" && serialWriter) {
      await serialWriter.write(data);
    } else if (activeTransport === "ble" && uartCharacteristic?.properties.write && uartCharacteristic.writeValueWithResponse) {
      await uartCharacteristic.writeValueWithResponse(data);
    } else if (activeTransport === "ble" && uartCharacteristic?.properties.writeWithoutResponse && uartCharacteristic.writeValueWithoutResponse) {
      await uartCharacteristic.writeValueWithoutResponse(data);
    } else if (activeTransport === "ble" && uartCharacteristic?.writeValue) {
      await uartCharacteristic.writeValue(data);
    } else {
      throw new Error("当前连接不可写");
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
  receiveBytes(event.target.value);
}

function showDistance(value) {
  return value === "OUT" || value === null ? "--" : String(value);
}

function showLineSensor(raw, percent) {
  if (raw === null) return "--";
  return state.lineCalibrated ? `${raw} · ${percent}%` : `${raw} · 未标定`;
}

function processLine(line) {
  const modeMatch = line.match(/(?:MODE=|OK MODE |OK STOPPED MODE )(STANDBY|REMOTE|SENSOR)\b/i);
  if (modeMatch) setMode(modeMatch[1].toLowerCase());
  if (/^OK STOPPED MODE\b/i.test(line)) {
    setMotion("stop");
    if (/SENSOR$/i.test(line)) setTrackRunning(false);
    centerJoystick(false);
  }

  const motionMatch = line.match(/MOTION=(STOP|FORWARD|BACKWARD|LEFT|RIGHT|JOYSTICK|TURN90_LEFT|TURN90_RIGHT)\b/i);
  if (motionMatch) setMotion(motionMatch[1].toLowerCase());

  const gearMatch = line.match(/^(?:GEAR=|OK GEAR )(LOW|MEDIUM|HIGH)$/i);
  if (gearMatch) setGear(gearMatch[1].toUpperCase());

  const trackGearMatch = line.match(/^(?:TRACK_GEAR=|OK TRACK GEAR )(LOW|MEDIUM|HIGH)$/i);
  if (trackGearMatch) setTrackGear(trackGearMatch[1].toUpperCase());

  const trace = line.match(/^TRACE M=(\w+) L=([+-]?\d+) R=([+-]?\d+) TL=([+-]?\d+) TR=([+-]?\d+) PL=([+-]?\d+) PR=([+-]?\d+) E=([+-]?\d+) C=([+-]?\d+) V=(\d+)$/i);
  if (trace) {
    setMotion(trace[1].toLowerCase());
    [telemetry.leftCps, telemetry.rightCps, telemetry.targetLeft, telemetry.targetRight,
      telemetry.pwmLeft, telemetry.pwmRight, telemetry.error, telemetry.trim, telemetry.voltageMv] = trace.slice(2).map(Number);
    ui.voltageValue.textContent = `${(telemetry.voltageMv / 1000).toFixed(2)}V`;
    if (sampleCapturePending && sampleCaptureMode === "remote") {
      captureSample("remote", line);
      sampleCapturePending = false;
    }
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

  if (line.startsWith("LINE ")) {
    const fields = Object.fromEntries(line.slice(5).split(/\s+/).map((token) => {
      const split = token.indexOf("=");
      return [token.slice(0, split), token.slice(split + 1)];
    }));
    setLineCalibrated(fields.CAL === "1");
    setTrackState((fields.STATE || "LOST").toUpperCase());
    setAvoidance(fields.AVOID === "ON");
    state.trackEnd = (fields.END || "NONE").toUpperCase();
    if (state.trackEnd === "NONE") lastFailureSignature = "";
    telemetry.trackBase = Number(fields.BASE);
    telemetry.trackP = Number(fields.P);
    telemetry.trackI = Number(fields.I);
    telemetry.trackD = Number(fields.D);
    telemetry.lineTrim = Number(fields.TRIM);
    telemetry.lineLeftTrans = Number(fields.LT);
    telemetry.lineLeftLong = Number(fields.LL);
    telemetry.lineRightTrans = Number(fields.RT);
    telemetry.lineRightLong = Number(fields.RL);
    telemetry.lineLeftTransPct = Number(fields.NLT);
    telemetry.lineLeftLongPct = Number(fields.NLL);
    telemetry.lineRightTransPct = Number(fields.NRT);
    telemetry.lineRightLongPct = Number(fields.NRL);
    telemetry.lineErrorX100 = Number(fields.ERR_X100);
    telemetry.trackPeakErrorX100 = Number(fields.PEAK_X100);
    telemetry.trackPeakP = Number(fields.PKP);
    telemetry.trackPeakI = Number(fields.PKI);
    telemetry.trackPeakD = Number(fields.PKD);
    telemetry.trackPeakTrim = Number(fields.PKTRIM);
    telemetry.trackPeakState = (fields.PEAK_STATE || "LOST").toUpperCase();
    telemetry.trackPeakMs = Number(fields.PEAK_MS);
    telemetry.trackPeakPercent = [fields.PKLT, fields.PKLL, fields.PKRT, fields.PKRL].map(Number);
    telemetry.trackEndMs = Number(fields.END_MS);
    telemetry.trackEndPercent = [fields.ENLT, fields.ENLL, fields.ENRT, fields.ENRL].map(Number);
    setTrackRunning(fields.RUN === "1");
    ui.lineLeftTransValue.textContent = showLineSensor(telemetry.lineLeftTrans, telemetry.lineLeftTransPct);
    ui.lineLeftLongValue.textContent = showLineSensor(telemetry.lineLeftLong, telemetry.lineLeftLongPct);
    ui.lineRightTransValue.textContent = showLineSensor(telemetry.lineRightTrans, telemetry.lineRightTransPct);
    ui.lineRightLongValue.textContent = showLineSensor(telemetry.lineRightLong, telemetry.lineRightLongPct);
    ui.lineErrorValue.textContent = state.lineCalibrated ? `误差 ${(telemetry.lineErrorX100 / 100).toFixed(2)}` : "仅显示原始 ADC";
    ui.trackPValue.textContent = telemetry.trackP;
    ui.trackIValue.textContent = telemetry.trackI;
    ui.trackDValue.textContent = telemetry.trackD;
    ui.trackTrimValue.textContent = telemetry.lineTrim;
    const stateLabels = { LOST: "丢线", STRAIGHT: "直线", LEFT: "左转", RIGHT: "右转", CROSS: "十字" };
    ui.trackPeakValue.textContent = state.lineCalibrated ? `${(telemetry.trackPeakErrorX100 / 100).toFixed(2)} · ${stateLabels[telemetry.trackPeakState] || telemetry.trackPeakState} · 输出 ${telemetry.trackPeakTrim}` : "--";
    const endLabels = { NONE: "--", MANUAL: "手动停止", LOST: "丢线超时", NO_LINE: "启动时无线" };
    ui.trackEndValue.textContent = endLabels[state.trackEnd] || state.trackEnd;

    const failureSignature = `${state.trackEnd}:${telemetry.trackEndMs}:${telemetry.trackPeakErrorX100}`;
    const isFailure = state.trackEnd === "LOST" || state.trackEnd === "NO_LINE";
    if (sampleCapturePending && sampleCaptureMode === "sensor") {
      captureSample("sensor", line);
      sampleCapturePending = false;
      if (isFailure) lastFailureSignature = failureSignature;
    } else if (isFailure && failureSignature !== lastFailureSignature) {
      captureSample("sensor", line);
      lastFailureSignature = failureSignature;
    }
  }

  const cps = line.match(/ENC CPS L=([+-]?\d+) R=([+-]?\d+)/i);
  if (cps) {
    telemetry.leftCps = Number(cps[1]);
    telemetry.rightCps = Number(cps[2]);
  }

  const counts = line.match(/^ENC COUNT L=([+-]?\d+) R=([+-]?\d+)$/i);
  if (counts && calibrationDirection) {
    const average = Math.round((Math.abs(Number(counts[1])) + Math.abs(Number(counts[2]))) / 2);
    const key = calibrationDirection === "left" ? "TURN90_L_COUNT" : "TURN90_R_COUNT";
    calibrationSuggestion = { key, value: average, direction: calibrationDirection };
    paramInputs.get(key).value = average;
    ui.turnCalibrationResult.textContent = `${calibrationDirection === "left" ? "左转" : "右转"}建议 ${average} count`;
    ui.saveTurnCalibrationButton.disabled = average === 0;
    ui.turn90Status.textContent = "待保存";
  }

  const straight = line.match(/STRAIGHT ERR=([+-]?\d+) TRIM=([+-]?\d+) CPS/i);
  if (straight) {
    telemetry.error = Number(straight[1]);
    telemetry.trim = Number(straight[2]);
  }

  const param = line.match(/^(?:(ACTIVE|STAGED) )?([A-Z0-9_]+)=(\d+)/);
  if (param) {
    const source = param[1] || "ACTIVE";
    const key = param[2];
    const value = Number(param[3]);
    if (source !== "STAGED") knownParams[key] = value;
    if (paramInputs.has(key)) paramInputs.get(key).value = param[3];
    if (key === "TURN90_L_COUNT" || key === "TURN90_R_COUNT") updateTurn90Status();
    if (key === "LINE_CAL" && source !== "STAGED") setLineCalibrated(value === 1);
  }
  if (/^PENDING=YES$/i.test(line)) ui.tuningStatus.textContent = "有暂存";
  if (/^PENDING=NO$/i.test(line)) ui.tuningStatus.textContent = "已同步";
  if (/^PARAMS END$/i.test(line)) {
    paramsLoaded = true;
    ui.tuningStatus.textContent = "已读取";
  }
  if (/^OK SAVED TO FLASH$/i.test(line)) ui.tuningStatus.textContent = "已保存";
  if (/^OK LINE CAL START$/i.test(line)) {
    setLineCalibrating(true);
    setMessage("保持电机停止，手动让四个探头经过赛道与空白区域");
  }
  if (/^OK LINE CAL READY$/i.test(line)) {
    setLineCalibrating(false);
    setMessage("范围已采集，正在保存…");
    setTimeout(() => sendCommand("APPLY"), 180);
  }
  if (/^ERR LINE CAL RANGE TOO SMALL$/i.test(line)) {
    setLineCalibrating(false);
    setMessage("标定范围太小：请让每个探头都经过赛道和空白", true);
  }
  if (/^OK TURN90 DONE$/i.test(line)) {
    setMotion("stop");
    ui.turn90Status.textContent = "转弯完成";
  }
  if (/^ERR TURN90 NOT CALIBRATED$/i.test(line)) {
    ui.turn90Status.textContent = "请先标定";
    setMotion("stop");
    centerJoystick(false);
  }
  if (/^OK TRACK STARTED$/i.test(line)) setTrackRunning(true);
  if (/^OK TRACK STOPPED$/i.test(line)) setTrackRunning(false);
  if (/^ERR TRACK NO LINE$/i.test(line)) {
    setTrackRunning(false);
    setTrackState("LOST");
    setMessage("未检测到赛道，循迹没有启动", true);
  }
  else if (/^ERR TRACK NOT CALIBRATED$/i.test(line)) {
    setMessage("请先完成四路传感器范围标定", true);
  }
  else if (/^ERR LINE CAL RANGE TOO SMALL$/i.test(line)) {
    /* 上面已经给出可操作的中文提示。 */
  }
  else if (/^ERR\b/i.test(line)) setMessage(line, true);

  addLog(line, /^ERR\b/i.test(line) ? "error" : "rx");
}

function updateServoReadout() {
  ui.servoAngleValue.textContent = `${ui.servoAngle.value}°`;
  ui.sendServoButton.textContent = `转到 ${ui.servoAngle.value}°`;
}

async function startTurnCalibration(direction) {
  calibrationDirection = direction;
  calibrationSuggestion = null;
  ui.saveTurnCalibrationButton.disabled = true;
  ui.turnCalibrationResult.textContent = `${direction === "left" ? "左转" : "右转"}中；到 90° 就停车`;
  await sendCommand("STOP");
  await delay(120);
  await sendCommand("ENC RESET");
  await delay(120);
  await sendCommand(direction === "left" ? "LEFT" : "RIGHT");
  setMotion(direction);
}

async function finishTurnCalibration() {
  if (!calibrationDirection) {
    setMessage("请先选择测左转或测右转", true);
    return;
  }
  await sendCommand("STOP");
  setMotion("stop");
  centerJoystick(false);
  await delay(140);
  ui.turnCalibrationResult.textContent = "正在读取编码器…";
  await sendCommand("ENC");
}

async function saveTurnCalibration() {
  if (!calibrationSuggestion) return;
  const { key, value } = calibrationSuggestion;
  if (!(await sendCommand(`SET ${key} ${value}`))) return;
  await delay(140);
  if (!(await sendCommand("APPLY"))) return;
  ui.turnCalibrationResult.textContent = `已提交 ${value} count`;
  ui.saveTurnCalibrationButton.disabled = true;
  calibrationDirection = null;
  calibrationSuggestion = null;
}

function changedParameterEntries() {
  const entries = [];
  for (const [key, input] of paramInputs) {
    if (!input.reportValidity()) return null;
    const value = Number(input.value);
    if (!Number.isInteger(value)) return null;
    if (knownParams[key] !== value) entries.push({ key, value });
  }

  const valueOf = (key) => Number(paramInputs.get(key)?.value);
  if (valueOf("TRACK_MIN_CPS") > valueOf("TRACK_BASE_CPS")) {
    setMessage("低档基础速度不能高于高档基础速度", true);
    return null;
  }
  if (valueOf("TRACK_DETECT_PCT") > valueOf("TRACK_BRANCH_PCT")) {
    setMessage("有线阈值不能高于分支阈值", true);
    return null;
  }
  const calibrationPairs = [
    ["MIN_L_TRANS", "MAX_L_TRANS"], ["MIN_L_LONG", "MAX_L_LONG"],
    ["MIN_R_TRANS", "MAX_R_TRANS"], ["MIN_R_LONG", "MAX_R_LONG"]
  ];
  for (const [minimumKey, maximumKey] of calibrationPairs) {
    if (valueOf(minimumKey) >= valueOf(maximumKey)) {
      setMessage("每路传感器的最小值必须低于最大值", true);
      return null;
    }
  }
  const calibrationKeys = new Set(calibrationPairs.flat());
  if (entries.some((entry) => calibrationKeys.has(entry.key)) && Number(knownParams.LINE_CAL) !== 1) {
    entries.push({ key: "LINE_CAL", value: 1 });
  }
  const priority = new Map();
  calibrationPairs.forEach(([minimumKey, maximumKey]) => {
    const newMinimum = valueOf(minimumKey);
    const newMaximum = valueOf(maximumKey);
    if (newMinimum >= Number(knownParams[maximumKey])) priority.set(maximumKey, -1);
    if (newMaximum <= Number(knownParams[minimumKey])) priority.set(minimumKey, -1);
  });
  if (priority.size) {
    entries.sort((a, b) => (priority.get(a.key) || 0) - (priority.get(b.key) || 0));
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
  if (!state.connected || (state.mode !== "remote" && state.mode !== "sensor")) return;
  sampleCapturePending = true;
  sampleCaptureMode = state.mode;
  if (state.mode === "remote") await sendCommand("TRACE");
  else await sendCommand("SENSOR");
}

function startSampling() {
  if (recording || !state.connected) return;
  if (state.mode !== "remote" && state.mode !== "sensor") {
    setMessage("请先进入巡线或遥控模式", true);
    return;
  }
  recording = true;
  recordingMode = state.mode;
  sampleStartedAt = Date.now();
  ui.recordButton.textContent = "停止采样";
  updateLogProfile();
  sampleNow();
  sampleTimer = setInterval(sampleNow, Number(ui.sampleInterval.value));
}

function stopSampling() {
  if (sampleTimer) clearInterval(sampleTimer);
  sampleTimer = null;
  recording = false;
  recordingMode = null;
  sampleCapturePending = false;
  if (ui.recordButton) ui.recordButton.textContent = "连续采样";
  updateLogProfile();
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv() {
  const mode = currentLogMode();
  const records = recordsForMode(mode);
  const remoteColumns = ["time", "elapsed_ms", "note", "motion", "remote_speed_gear", "left_cps", "right_cps", "target_left", "target_right", "pwm_left", "pwm_right", "straight_error", "straight_trim", "voltage_mv"];
  const sensorColumns = ["time", "elapsed_ms", "note", "track_running", "track_state", "track_speed_gear", "avoidance", "distance_cm", "route", "line_calibrated", "track_base_cps", "line_error_x100", "track_p_cps", "track_i_cps", "track_d_cps", "line_trim_cps", "line_left_trans", "line_left_long", "line_right_trans", "line_right_long", "line_left_trans_pct", "line_left_long_pct", "line_right_trans_pct", "line_right_long_pct", "track_end", "track_end_ms", "track_peak_error_x100", "track_peak_state", "track_peak_ms", "track_peak_p_cps", "track_peak_i_cps", "track_peak_d_cps", "track_peak_trim_cps", "peak_left_trans_pct", "peak_left_long_pct", "peak_right_trans_pct", "peak_right_long_pct", "end_left_trans_pct", "end_left_long_pct", "end_right_trans_pct", "end_right_long_pct"];
  const columns = mode === "sensor" ? sensorColumns : remoteColumns;
  const rows = [columns.join(",")];
  for (const record of records) {
    const row = { ...record, note: ui.runNote.value };
    rows.push(columns.map((column) => csvCell(row[column])).join(","));
  }
  const blob = new Blob(["\ufeff", rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `smart-car-${mode === "sensor" ? "track" : "remote"}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

ui.connectButton.addEventListener("click", connectSelectedDevice);
ui.disconnectButton.addEventListener("click", () => state.connected ? disconnectCurrentDevice() : connectLastDevice());
ui.connectionType.addEventListener("change", () => {
  updateConnectionControls();
  if (selectedConnectionType() === "serial") {
    setMessage(navigator.serial ? "选择已配对的 JDY-31 / HC-05" : "Android 请使用 Chrome 137 或更高版本", !navigator.serial);
  } else {
    setMessage("可按 BLE 设备名前缀筛选");
  }
});
document.querySelectorAll(".tab-button").forEach((button) => button.addEventListener("click", () => selectTab(button.dataset.tab)));

document.querySelectorAll(".mode-entry-button[data-mode]").forEach((button) => {
  button.addEventListener("click", async () => {
    if (!(await sendCommand(button.dataset.command))) return;
    setMode(button.dataset.mode);
    if (button.dataset.mode === "remote" || button.dataset.mode === "sensor") selectTab(button.dataset.mode);
    if (button.dataset.mode === "sensor") {
      await delay(120);
      await sendCommand("SENSOR");
    }
  });
});

document.querySelectorAll("button[data-command]:not([data-mode])").forEach((button) => {
  button.addEventListener("click", async () => {
    if (!(await sendCommand(button.dataset.command))) return;
    const motions = { FORWARD: "forward", BACKWARD: "backward", LEFT: "left", RIGHT: "right", STOP: "stop", "TURN90 LEFT": "turn90_left", "TURN90 RIGHT": "turn90_right" };
    if (motions[button.dataset.command]) setMotion(motions[button.dataset.command]);
    if (button.dataset.command === "STOP") centerJoystick(false);
  });
});

document.querySelectorAll(".gear-choice").forEach((button) => {
  button.addEventListener("click", async () => {
    if (await sendCommand(`GEAR ${button.dataset.gear}`)) setGear(button.dataset.gear);
  });
});

document.querySelectorAll(".track-gear-choice").forEach((button) => {
  button.addEventListener("click", async () => {
    if (await sendCommand(`TRACK GEAR ${button.dataset.trackGear}`)) setTrackGear(button.dataset.trackGear);
  });
});

document.querySelectorAll(".avoid-choice").forEach((button) => {
  button.addEventListener("click", async () => {
    if (await sendCommand(`AVOID ${button.dataset.avoid}`)) setAvoidance(button.dataset.avoid === "ON");
  });
});

ui.joystickPad.addEventListener("pointerdown", (event) => {
  if (!state.connected || state.mode !== "remote") return;
  event.preventDefault();
  joystickPointerId = event.pointerId;
  ui.joystickPad.setPointerCapture(event.pointerId);
  joystickFromPointer(event);
});
ui.joystickPad.addEventListener("pointermove", (event) => {
  if (event.pointerId !== joystickPointerId) return;
  event.preventDefault();
  joystickFromPointer(event);
});
const releaseJoystick = (event) => {
  if (event.pointerId !== joystickPointerId) return;
  event.preventDefault();
  centerJoystick(true);
};
ui.joystickPad.addEventListener("pointerup", releaseJoystick);
ui.joystickPad.addEventListener("pointercancel", releaseJoystick);

ui.calibrateLeftButton.addEventListener("click", () => startTurnCalibration("left"));
ui.calibrateRightButton.addEventListener("click", () => startTurnCalibration("right"));
ui.finishTurnCalibrationButton.addEventListener("click", finishTurnCalibration);
ui.saveTurnCalibrationButton.addEventListener("click", saveTurnCalibration);

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

ui.lineCalibrationButton.addEventListener("click", async () => {
  if (state.lineCalibrating) {
    await sendCommand("LINE CAL STOP");
  } else if (await sendCommand("LINE CAL START")) {
    setLineCalibrating(true);
  }
});

ui.copySensorButton.addEventListener("click", async () => {
  const values = [telemetry.lineLeftTrans, telemetry.lineLeftLong, telemetry.lineRightTrans, telemetry.lineRightLong];
  if (values.some((value) => value === null)) {
    setMessage("请先读取一次四路数据", true);
    return;
  }
  const percent = state.lineCalibrated ?
    `；百分比 ${telemetry.lineLeftTransPct}/${telemetry.lineLeftLongPct}/${telemetry.lineRightTransPct}/${telemetry.lineRightLongPct}` :
    "；百分比未标定";
  const text = `左横 ${values[0]}，左竖 ${values[1]}，右横 ${values[2]}，右竖 ${values[3]}${percent}`;
  try {
    await navigator.clipboard.writeText(text);
    setMessage("四路数据已复制，可以直接发给我");
  } catch {
    setMessage(text);
  }
});

ui.readParamsButton.addEventListener("click", () => {
  ui.tuningStatus.textContent = "读取中…";
  sendCommand("CHECK");
});
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
  const mode = currentLogMode();
  for (let index = sampleRecords.length - 1; index >= 0; index--) {
    if (sampleRecords[index].mode === mode) sampleRecords.splice(index, 1);
  }
  sampleStartedAt = recording ? Date.now() : null;
  ui.logWindow.innerHTML = '<p class="muted">日志已清空</p>';
  updateLogProfile();
});

ui.deviceNameFilter.value = localStorage.getItem("smartCarDevicePrefix") ?? "JDY";
setConnected(false);
loadGrantedDevices();
selectTab("sensor");
drawJoystick(0, 0);
setGear("HIGH");
setTrackGear("LOW");
setTrackState("LOST");
setAvoidance(false);
setLineCalibrated(false);
setLineCalibrating(false);
updateTurn90Status();
updateServoReadout();
updateLogProfile();
