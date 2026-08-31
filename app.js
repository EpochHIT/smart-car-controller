"use strict";

const $ = (id) => document.getElementById(id);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const EXPECTED_PROTOCOL_VERSION = 17;
const SERIAL_BUFFER_SIZE = 4096;
const BLUETOOTH_BAUD_RATE = 57600;
const nativeBluetooth = window.AndroidBluetooth || null;

const ui = {
  connectionState: $("connectionState"), connectionText: $("connectionText"),
  platformBadge: $("platformBadge"), webBuildBadge: $("webBuildBadge"),
  connectButton: $("connectButton"), disconnectButton: $("disconnectButton"),
  copyConnectionDiagnosticButton: $("copyConnectionDiagnosticButton"),
  deviceName: $("deviceName"), message: $("message"), firmwareBuildBadge: $("firmwareBuildBadge"),
  modeValue: $("modeValue"), motionValue: $("motionValue"), voltageValue: $("voltageValue"),
  remoteLock: $("remoteLock"), sensorLock: $("sensorLock"),
  joystickPad: $("joystickPad"), joystickKnob: $("joystickKnob"), joystickValue: $("joystickValue"),
  turn90Status: $("turn90Status"), calibrateLeftButton: $("calibrateLeftButton"),
  calibrateRightButton: $("calibrateRightButton"), finishTurnCalibrationButton: $("finishTurnCalibrationButton"),
  turnCalibrationResult: $("turnCalibrationResult"), saveTurnCalibrationButton: $("saveTurnCalibrationButton"),
  distanceValue: $("distanceValue"), routeValue: $("routeValue"), thresholdValue: $("thresholdValue"),
  lineLeftTransValue: $("lineLeftTransValue"), lineLeftLongValue: $("lineLeftLongValue"),
  lineRightTransValue: $("lineRightTransValue"), lineRightLongValue: $("lineRightLongValue"),
  lineLeftTransBar: $("lineLeftTransBar"), lineLeftLongBar: $("lineLeftLongBar"),
  lineRightTransBar: $("lineRightTransBar"), lineRightLongBar: $("lineRightLongBar"),
  lineLeftTransMeta: $("lineLeftTransMeta"), lineLeftLongMeta: $("lineLeftLongMeta"),
  lineRightTransMeta: $("lineRightTransMeta"), lineRightLongMeta: $("lineRightLongMeta"),
  lineErrorValue: $("lineErrorValue"), trackStateValue: $("trackStateValue"),
  trackRunValue: $("trackRunValue"), avoidanceValue: $("avoidanceValue"),
  avoidanceStatus: $("avoidanceStatus"), trackStartButton: $("trackStartButton"),
  trackStopButton: $("trackStopButton"), trackPeakValue: $("trackPeakValue"),
  trackEndValue: $("trackEndValue"), trackPValue: $("trackPValue"), trackIValue: $("trackIValue"),
  trackDValue: $("trackDValue"), trackTrimValue: $("trackTrimValue"),
  lineCalibrationValue: $("lineCalibrationValue"), lineCalibrationButton: $("lineCalibrationButton"),
  firmwareWarning: $("firmwareWarning"),
  copySensorButton: $("copySensorButton"),
  sensorChart: $("sensorChart"), sensorScenario: $("sensorScenario"),
  sensorSessionNote: $("sensorSessionNote"), sensorCaptureStatus: $("sensorCaptureStatus"),
  newSensorSessionButton: $("newSensorSessionButton"), copySensorSessionButton: $("copySensorSessionButton"),
  exportSensorSessionButton: $("exportSensorSessionButton"),
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
  lineCalibrated: false, lineCalibrating: false, firmwareCompatible: null, trackEnd: "NONE"
};
const telemetry = {
  leftCps: null, rightCps: null, targetLeft: null, targetRight: null,
  pwmLeft: null, pwmRight: null, error: null, trim: null, voltageMv: null,
  distance: null, route: "NONE",
  lineLeftTrans: null, lineLeftLong: null, lineRightTrans: null, lineRightLong: null,
  lineLeftTransPct: null, lineLeftLongPct: null, lineRightTransPct: null, lineRightLongPct: null,
  lineErrorX100: null, lineTrim: null, trackBase: null, lineSequence: null, lineFramesDropped: 0,
  trackP: null, trackI: null, trackD: null,
  trackPeakErrorX100: null, trackPeakState: "LOST", trackPeakMs: null,
  trackPeakP: null, trackPeakI: null, trackPeakD: null, trackPeakTrim: null,
  trackPeakPercent: [null, null, null, null], trackEndMs: null,
  trackEndPercent: [null, null, null, null]
};

const knownParams = {};
const sampleRecords = [];
const sensorHistory = [];
const SENSOR_HISTORY_LIMIT = 2000;
const SENSOR_CHART_POINTS = 120;
let paramsLoaded = false;
let serialPort = null;
let lastGrantedSerialPort = null;
let serialReader = null;
let serialWriter = null;
let serialReadTask = null;
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
let linePollTick = 0;
let pendingModeAck = null;
let resumePollingAfterParams = false;
let paramsRequestPending = false;
let lastLineSequence = null;
let sensorSessionStartedAt = Date.now();
let sensorSessionNumber = 1;
let nativeDeviceLabel = "";
let nativeHasLastDevice = false;
let receivedByteCount = 0;
let receivedLineCount = 0;
let receivedNewlineCount = 0;
let receivedNonAsciiCount = 0;
let recentRawBytes = [];
let recentReceivedLines = [];
let latestConnectionDiagnostic = "";

let decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();
const paramInputs = new Map(
  [...document.querySelectorAll(".param-input")].map((input) => [input.dataset.param, input])
);

function setMessage(text, isError = false) {
  ui.message.textContent = text;
  ui.message.classList.toggle("error", isError);
}

function resetReceiveDiagnostics() {
  receiveBuffer = "";
  receivedByteCount = 0;
  receivedLineCount = 0;
  receivedNewlineCount = 0;
  receivedNonAsciiCount = 0;
  recentRawBytes = [];
  recentReceivedLines = [];
  decoder = new TextDecoder("utf-8");
}

function receiveSnapshot() {
  return {
    bytes: receivedByteCount,
    lines: receivedLineCount,
    newlines: receivedNewlineCount,
    nonAscii: receivedNonAsciiCount
  };
}

function rawHexPreview() {
  return recentRawBytes.map((value) => value.toString(16).padStart(2, "0").toUpperCase()).join(" ") || "--";
}

function receiveSummarySince(before) {
  const bytes = receivedByteCount - before.bytes;
  const lines = receivedLineCount - before.lines;
  const newlines = receivedNewlineCount - before.newlines;
  const nonAscii = receivedNonAsciiCount - before.nonAscii;
  const received = recentReceivedLines.filter((item) => item.number > before.lines).map((item) => item.text);
  const preview = received.slice(-2).join(" | ");
  if (bytes === 0) return "RX=0 字节：手机没有收到小车回复";
  if (lines === 0) {
    return `RX=${bytes} 字节，但没有完整文本行（换行=${newlines}，非ASCII=${nonAscii}，HEX ${rawHexPreview()}）`;
  }
  return `RX=${bytes} 字节，完整行=${lines}，非ASCII=${nonAscii}${preview ? `，最近：${preview}` : ""}`;
}

function showConnectionDiagnostic(reason) {
  latestConnectionDiagnostic = [
    `原因：${reason}`,
    `设备：${nativeDeviceLabel || ui.deviceName.textContent || "--"}`,
    `${ui.webBuildBadge.textContent} · ${ui.firmwareBuildBadge.textContent}`,
    `连接=${state.connected ? "是" : "否"} 模式=${state.mode} 波特率=${BLUETOOTH_BAUD_RATE}`,
    `RX字节=${receivedByteCount} 完整行=${receivedLineCount} 换行=${receivedNewlineCount} 非ASCII=${receivedNonAsciiCount} 未成行字符=${receiveBuffer.length}`,
    `最近HEX：${rawHexPreview()}`,
    "最近完整行：",
    ...(recentReceivedLines.length ? recentReceivedLines.slice(-8).map((item) => item.text) : ["--"])
  ].join("\n");
  ui.copyConnectionDiagnosticButton.hidden = false;
}

function clearConnectionDiagnostic() {
  latestConnectionDiagnostic = "";
  ui.copyConnectionDiagnosticButton.hidden = true;
}

async function writeClipboardText(text) {
  if (nativeBluetooth?.copyText) return nativeBluetooth.copyText(text);
  await navigator.clipboard.writeText(text);
  return true;
}

function downloadText(fileName, text) {
  if (nativeBluetooth?.saveText) {
    nativeBluetooth.saveText(fileName, text);
    setMessage("请选择 CSV 保存位置");
    return;
  }
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function snapshot() {
  return {
    mode: state.mode, motion: state.motion,
    left_cps: telemetry.leftCps, right_cps: telemetry.rightCps,
    target_left: telemetry.targetLeft, target_right: telemetry.targetRight,
    pwm_left: telemetry.pwmLeft, pwm_right: telemetry.pwmRight,
    straight_error: telemetry.error, straight_trim: telemetry.trim,
    voltage_mv: telemetry.voltageMv, distance_cm: telemetry.distance, route: telemetry.route,
    line_left_trans: telemetry.lineLeftTrans, line_left_long: telemetry.lineLeftLong,
    line_right_trans: telemetry.lineRightTrans, line_right_long: telemetry.lineRightLong,
    line_left_trans_pct: telemetry.lineLeftTransPct, line_left_long_pct: telemetry.lineLeftLongPct,
    line_right_trans_pct: telemetry.lineRightTransPct, line_right_long_pct: telemetry.lineRightLongPct,
    line_error_x100: telemetry.lineErrorX100, line_trim_cps: telemetry.lineTrim,
    line_sequence: telemetry.lineSequence, line_frames_dropped: telemetry.lineFramesDropped,
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
    note: ui.runNote.value.trim(),
    scene: mode === "sensor" ? ui.sensorScenario.value : "",
    sample_type: mode, text, ...snapshot(), mode
  });
  updateLogProfile();
}

function sensorScenarioLabel() {
  return ui.sensorScenario.selectedOptions[0]?.textContent || ui.sensorScenario.value;
}

function sensorScenarioFileLabel(scene) {
  return ({
    straight: "直线",
    left_offset: "需右修正",
    right_offset: "需左修正",
    blank: "离开线路",
    cross: "十字",
    pin_test: "固定姿态换引脚",
    custom: "自定义"
  })[scene] || "未命名";
}

function localTimestamp(date = new Date(), fileName = false) {
  const pad = (value, length = 2) => String(value).padStart(length, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  if (fileName) return `${day}_${time.replace(/:/g, "-")}`;
  return `${day} ${time}.${pad(date.getMilliseconds(), 3)}`;
}

function sensorRange(key) {
  if (sensorHistory.length === 0) return null;
  let minimum = 4095;
  let maximum = 0;
  for (const record of sensorHistory) {
    const value = record[key];
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  return { minimum, maximum, span: maximum - minimum };
}

function updateSensorMeters() {
  const channels = [
    { value: telemetry.lineLeftTrans, percent: telemetry.lineLeftTransPct, key: "left_horizontal", output: ui.lineLeftTransValue, bar: ui.lineLeftTransBar, meta: ui.lineLeftTransMeta },
    { value: telemetry.lineLeftLong, percent: telemetry.lineLeftLongPct, key: "left_vertical", output: ui.lineLeftLongValue, bar: ui.lineLeftLongBar, meta: ui.lineLeftLongMeta },
    { value: telemetry.lineRightLong, percent: telemetry.lineRightLongPct, key: "right_vertical", output: ui.lineRightLongValue, bar: ui.lineRightLongBar, meta: ui.lineRightLongMeta },
    { value: telemetry.lineRightTrans, percent: telemetry.lineRightTransPct, key: "right_horizontal", output: ui.lineRightTransValue, bar: ui.lineRightTransBar, meta: ui.lineRightTransMeta }
  ];
  for (const channel of channels) {
    if (!Number.isFinite(channel.value)) {
      channel.output.textContent = "--";
      channel.bar.style.width = "0";
      channel.meta.textContent = "等待数据";
      continue;
    }
    channel.output.textContent = channel.value;
    channel.bar.style.width = `${Math.max(0, Math.min(100, channel.value * 100 / 4095)).toFixed(1)}%`;
    const range = sensorRange(channel.key);
    const relative = state.lineCalibrated && Number.isFinite(channel.percent) ? `标定相对值 ${channel.percent}%` : "未标定";
    const boundary = channel.value <= 5 ? " · 接近 0" : channel.value >= 4090 ? " · 接近满量程" : "";
    channel.meta.textContent = range ? `${relative} · 本组 ${range.minimum}–${range.maximum}（Δ${range.span}）${boundary}` : `${relative}${boundary}`;
  }
}

function drawSensorChart() {
  const canvas = ui.sensorChart;
  if (!canvas) return;
  const width = Math.max(280, canvas.clientWidth || 640);
  const height = Math.max(210, canvas.clientHeight || 250);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  const margin = { left: 42, right: 10, top: 13, bottom: 24 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  context.font = "10px ui-monospace, Consolas, monospace";
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (const tick of [0, 1024, 2048, 3072, 4095]) {
    const y = margin.top + chartHeight - tick / 4095 * chartHeight;
    context.strokeStyle = "rgba(145, 167, 187, .14)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(margin.left, y);
    context.lineTo(width - margin.right, y);
    context.stroke();
    context.fillStyle = "#70869a";
    context.fillText(String(tick), margin.left - 6, y);
  }
  const records = sensorHistory.slice(-SENSOR_CHART_POINTS);
  if (records.length === 0) {
    context.fillStyle = "#70869a";
    context.textAlign = "center";
    context.fillText("连接后自动记录四路原始值", margin.left + chartWidth / 2, margin.top + chartHeight / 2);
    return;
  }
  const series = [
    { key: "left_horizontal", color: "#43d5ff" },
    { key: "left_vertical", color: "#b38cff" },
    { key: "right_vertical", color: "#ffbd66" },
    { key: "right_horizontal", color: "#55e5a7" }
  ];
  for (const item of series) {
    context.strokeStyle = item.color;
    context.lineWidth = 1.7;
    context.lineJoin = "round";
    context.beginPath();
    records.forEach((record, index) => {
      const x = margin.left + (records.length === 1 ? chartWidth : index * chartWidth / (records.length - 1));
      const y = margin.top + chartHeight - record[item.key] / 4095 * chartHeight;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  }
  const elapsed = Math.round((records.at(-1).time_ms - records[0].time_ms) / 1000);
  context.fillStyle = "#70869a";
  context.textAlign = "left";
  context.textBaseline = "bottom";
  context.fillText(`最近 ${records.length} 条 · ${elapsed}s`, margin.left, height - 3);
}

function updateSensorCaptureStatus() {
  const count = sensorHistory.length;
  const elapsed = count ? Math.round((sensorHistory.at(-1).time_ms - sensorSessionStartedAt) / 1000) : 0;
  ui.sensorCaptureStatus.textContent = `第 ${sensorSessionNumber} 组 · 自动记录 ${count} 条 · ${elapsed}s · 当前：${sensorScenarioLabel()}`;
  ui.copySensorSessionButton.disabled = count === 0;
  ui.exportSensorSessionButton.disabled = count === 0;
  updateSensorMeters();
  drawSensorChart();
}

function captureSensorHistory() {
  const raw = [telemetry.lineLeftTrans, telemetry.lineLeftLong, telemetry.lineRightTrans, telemetry.lineRightLong];
  if (!raw.every(Number.isFinite)) return;
  const now = Date.now();
  sensorHistory.push({
    local_time: localTimestamp(new Date(now)), time: new Date(now).toISOString(), time_ms: now,
    session_number: sensorSessionNumber,
    elapsed_ms: now - sensorSessionStartedAt,
    scene: ui.sensorScenario.value, scene_label: sensorScenarioLabel(), note: ui.sensorSessionNote.value.trim(),
    sequence: telemetry.lineSequence,
    left_horizontal: raw[0], left_vertical: raw[1], right_horizontal: raw[2], right_vertical: raw[3],
    left_horizontal_pct: telemetry.lineLeftTransPct, left_vertical_pct: telemetry.lineLeftLongPct,
    right_horizontal_pct: telemetry.lineRightTransPct, right_vertical_pct: telemetry.lineRightLongPct,
    line_error_x100: telemetry.lineErrorX100, track_state: state.trackState, track_running: state.trackRunning ? 1 : 0,
    track_base_cps: telemetry.trackBase, track_p_cps: telemetry.trackP, track_i_cps: telemetry.trackI,
    track_d_cps: telemetry.trackD, line_trim_cps: telemetry.lineTrim,
    track_end: state.trackEnd, track_end_ms: telemetry.trackEndMs
  });
  if (sensorHistory.length > SENSOR_HISTORY_LIMIT) sensorHistory.splice(0, sensorHistory.length - SENSOR_HISTORY_LIMIT);
  updateSensorCaptureStatus();
}

function startNewSensorSession() {
  sensorHistory.length = 0;
  sensorSessionStartedAt = Date.now();
  sensorSessionNumber += 1;
  updateSensorCaptureStatus();
  setMessage(`已开始第 ${sensorSessionNumber} 组：${sensorScenarioLabel()}`);
}

function sensorSessionTable(separator) {
  const columns = [
    ["本地时间", "local_time"], ["UTC时间", "time"], ["组号", "session_number"], ["经过毫秒", "elapsed_ms"], ["场景", "scene_label"], ["备注", "note"], ["序号", "sequence"],
    ["左横_PA4", "left_horizontal"], ["左竖_PA5", "left_vertical"], ["右竖_PB0", "right_vertical"], ["右横_PB1", "right_horizontal"],
    ["左横相对值", "left_horizontal_pct"], ["左竖相对值", "left_vertical_pct"], ["右竖相对值", "right_vertical_pct"], ["右横相对值", "right_horizontal_pct"],
    ["误差x100", "line_error_x100"], ["直线状态", "track_state"], ["是否运行", "track_running"],
    ["基础速度CPS", "track_base_cps"], ["P项CPS", "track_p_cps"], ["I项CPS", "track_i_cps"],
    ["D项CPS", "track_d_cps"], ["实际修正CPS", "line_trim_cps"],
    ["结束原因", "track_end"], ["结束毫秒", "track_end_ms"]
  ];
  const encode = separator === "," ? csvCell : (value) => String(value ?? "").replace(/[\t\r\n]+/g, " ");
  return [columns.map(([label]) => encode(label)).join(separator),
    ...sensorHistory.map((record) => columns.map(([, key]) => encode(record[key])).join(separator))].join("\n");
}

async function copySensorSession() {
  if (sensorHistory.length === 0) return;
  const text = sensorSessionTable("\t");
  try {
    await writeClipboardText(text);
    setMessage(`已复制本组 ${sensorHistory.length} 条数据，可直接粘贴给我或放进表格`);
  } catch {
    setMessage("浏览器不能直接复制，请使用“导出 CSV”", true);
  }
}

function exportSensorSession() {
  if (sensorHistory.length === 0) return;
  const scenes = new Set(sensorHistory.map((record) => record.scene));
  const scene = scenes.size === 1 ? sensorScenarioFileLabel([...scenes][0]) : "多场景";
  const group = String(sensorSessionNumber).padStart(2, "0");
  const fileName = `传感器-${scene}-第${group}组-${localTimestamp(new Date(sensorSessionStartedAt), true)}.csv`;
  downloadText(fileName, `\ufeff${sensorSessionTable(",")}`);
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
  if (name === "sensor") drawSensorChart();
}

function beginModeAck(mode, timeoutMs = 1200) {
  if (pendingModeAck) {
    clearTimeout(pendingModeAck.timer);
    pendingModeAck.resolve(false);
  }
  let resolveAck;
  const promise = new Promise((resolve) => { resolveAck = resolve; });
  const timer = setTimeout(() => {
    if (pendingModeAck?.mode !== mode) return;
    pendingModeAck = null;
    resolveAck(false);
  }, timeoutMs);
  pendingModeAck = { mode, promise, resolve: resolveAck, timer };
  return promise;
}

function resolveModeAck(mode, success = true) {
  if (!pendingModeAck || pendingModeAck.mode !== mode) return;
  const request = pendingModeAck;
  pendingModeAck = null;
  clearTimeout(request.timer);
  request.resolve(success);
}

async function activateMode(mode, force = false) {
  if (!state.connected || (mode !== "sensor" && mode !== "remote")) return false;
  if (state.mode === mode && !force) return true;
  if (pendingModeAck?.mode === mode) return pendingModeAck.promise;
  const command = mode === "sensor" ? "MODE SENSOR" : "MODE REMOTE";
  const maxAttempts = 3;
  const ackTimeout = 1000;
  const retryDelay = 150;
  const receiveBeforeHandshake = receiveSnapshot();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    addLog(`${command} TRY ${attempt}/${maxAttempts}`, "tx");
    const acknowledgement = beginModeAck(mode, ackTimeout);
    if (!(await sendCommand(command, true))) {
      resolveModeAck(mode, false);
      return false;
    }
    if (await acknowledgement) {
      const summary = receiveSummarySince(receiveBeforeHandshake);
      addLog(`MODE ACK ${mode.toUpperCase()} ${summary}`);
      clearConnectionDiagnostic();
      if (mode === "sensor" && !force) await sendCommand("SENSOR", true);
      return true;
    }
    if (attempt < maxAttempts) await delay(retryDelay);
  }
  const diagnostic = receiveSummarySince(receiveBeforeHandshake);
  showConnectionDiagnostic(`${command} 没有合法模式确认；${diagnostic}`);
  addLog(`MODE ACK FAILED ${diagnostic}`, "error");
  setMessage(`小车没有确认${mode === "sensor" ? "巡线" : "遥控"}模式：${diagnostic}`, true);
  return false;
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
  ui.avoidanceStatus.textContent = enabled ? "避障开启，测距运行" : "避障关闭，测距运行";
  document.querySelectorAll(".avoid-choice").forEach((button) => {
    button.classList.toggle("selected", button.dataset.avoid === (enabled ? "ON" : "OFF"));
  });
}

function setLineCalibrated(calibrated) {
  state.lineCalibrated = calibrated;
  ui.lineCalibrationValue.textContent = calibrated ? "已加载每通道实测档案" : "固件未加载传感器档案";
  ui.lineCalibrationValue.classList.toggle("ready", calibrated);
  updateSensorMeters();
  updateAvailability();
}

function setLineCalibrating(calibrating) {
  state.lineCalibrating = calibrating;
  ui.lineCalibrationButton.textContent = calibrating ? "完成并保存标定" : "重新范围标定";
  ui.lineCalibrationButton.classList.toggle("stop-button", calibrating);
  updateAvailability();
}

function stopLinePolling() {
  if (linePollTimer) clearInterval(linePollTimer);
  linePollTimer = null;
  linePollTick = 0;
}

function startLinePolling() {
  stopLinePolling();
  if (!state.connected || state.mode !== "sensor") return;
  linePollTimer = setInterval(() => {
    if (!state.connected || state.mode !== "sensor") return;
    linePollTick += 1;
    /* 四路与巡线状态约 10 Hz；距离、轮速和电压约 2 Hz。 */
    sendCommand(linePollTick % 5 === 0 ? "SENSOR" : "LINE", true);
  }, 100);
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
    resumePollingAfterParams = false;
  }
  updateAvailability();
  if (mode === "sensor") startLinePolling();
}

function updateAvailability() {
  const remoteReady = state.connected && state.mode === "remote";
  const sensorReady = state.connected && state.mode === "sensor";

  document.querySelectorAll(".requires-connection").forEach((element) => { element.disabled = !state.connected; });
  document.querySelectorAll(".remote-only").forEach((element) => { element.disabled = !remoteReady; });
  document.querySelectorAll(".sensor-only").forEach((element) => { element.disabled = !sensorReady || paramsRequestPending; });
  ui.modeValue.textContent = state.mode.toUpperCase();
  ui.saveTurnCalibrationButton.disabled = !state.connected || !calibrationSuggestion;
  ui.remoteLock.textContent = remoteReady ? "遥控已就绪" : state.connected ? "正在切换…" : "连接后可用";
  ui.sensorLock.textContent = sensorReady ? "传感器读取中" : state.connected ? "正在切换…" : "连接后自动就绪";
  if (state.trackRunning) ui.trackStartButton.textContent = "巡线运行中";
  else if (state.lineCalibrating) ui.trackStartButton.textContent = "正在标定…";
  else if (!sensorReady || state.firmwareCompatible === null) ui.trackStartButton.textContent = "正在读取传感器…";
  else if (!state.firmwareCompatible) ui.trackStartButton.textContent = "需更新小车固件";
  else if (!state.lineCalibrated) ui.trackStartButton.textContent = "需先标定一次";
  else ui.trackStartButton.textContent = "▶ 启动巡线";
  ui.trackStartButton.disabled = !sensorReady || paramsRequestPending || state.trackRunning || state.firmwareCompatible !== true || !state.lineCalibrated || state.lineCalibrating;
  ui.trackStopButton.disabled = !sensorReady || !state.trackRunning;
  ui.lineCalibrationButton.disabled = !sensorReady || paramsRequestPending || state.trackRunning;
  ui.readParamsButton.disabled = !state.connected || paramsRequestPending;
  ui.applyParamsButton.disabled = !state.connected || paramsRequestPending;
  ui.cancelParamsButton.disabled = !state.connected || paramsRequestPending;
  ui.sampleNowButton.disabled = !state.connected || paramsRequestPending;
  ui.recordButton.disabled = !state.connected || paramsRequestPending;
  updateLogProfile();
}

function lastDeviceLabel() {
  if (nativeBluetooth) return nativeDeviceLabel || (nativeHasLastDevice ? "已记住上次蓝牙设备" : "--");
  return lastGrantedSerialPort ? "已记住上次授权的蓝牙设备" : "--";
}

function updateConnectionControls() {
  ui.connectButton.disabled = state.connected;
  ui.disconnectButton.disabled = !state.connected && !(nativeBluetooth ? nativeHasLastDevice : lastGrantedSerialPort);
  ui.disconnectButton.textContent = state.connected ? "断开" : "重连";
  if (!state.connected) ui.deviceName.textContent = lastDeviceLabel();
}

function setConnected(connected) {
  state.connected = connected;
  ui.connectionState.classList.toggle("connected", connected);
  ui.connectionText.textContent = connected ? "已连接" : "未连接";
  ui.connectButton.disabled = connected;
  updateConnectionControls();
  if (!connected) {
    if (pendingModeAck) resolveModeAck(pendingModeAck.mode, false);
    stopLinePolling();
    state.mode = "standby";
    state.motion = "stop";
    state.firmwareCompatible = null;
    lastLineSequence = null;
    telemetry.lineSequence = null;
    telemetry.lineFramesDropped = 0;
    paramsRequestPending = false;
    resumePollingAfterParams = false;
    ui.firmwareWarning.hidden = true;
    ui.firmwareWarning.textContent = "";
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
  receivedByteCount += value.byteLength;
  for (const byte of value) {
    if (byte === 10) receivedNewlineCount += 1;
    if (byte !== 9 && byte !== 10 && byte !== 13 && (byte < 32 || byte > 126)) receivedNonAsciiCount += 1;
    recentRawBytes.push(byte);
  }
  if (recentRawBytes.length > 48) recentRawBytes.splice(0, recentRawBytes.length - 48);
  receiveBuffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
  const lines = receiveBuffer.split("\n");
  receiveBuffer = lines.pop() || "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    receivedLineCount += 1;
    recentReceivedLines.push({ number: receivedLineCount, text: line.slice(0, 180) });
    if (recentReceivedLines.length > 12) recentReceivedLines.shift();
    processLine(line);
  }
}

window.onAndroidBluetoothData = (base64) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  receiveBytes(bytes);
};

window.onAndroidBluetoothNotice = (message, isError = false) => setMessage(message, isError);

window.onAndroidBluetoothState = async (info) => {
  if (info.connected) {
    resetReceiveDiagnostics();
    clearConnectionDiagnostic();
    nativeHasLastDevice = true;
    nativeDeviceLabel = `${info.name || "SPP 蓝牙"}${info.mac ? ` · ${info.mac}` : ""}`;
    intentionalDisconnect = false;
    ui.deviceName.textContent = nativeDeviceLabel;
    setConnected(true);
    addLog(`CONNECTED APP SPP ${info.mac || ""}`.trim());
    selectTab("sensor");
    await delay(350);
    if (await activateMode("sensor")) setMessage("连接成功：巡线待机，电机未启动");
    return;
  }

  const planned = Boolean(info.planned) || intentionalDisconnect;
  const wasConnected = state.connected;
  intentionalDisconnect = planned;
  nativeDeviceLabel = "";
  if (wasConnected || planned) handleDisconnected();
  else {
    intentionalDisconnect = false;
    setConnected(false);
  }
  if (info.message) {
    showConnectionDiagnostic(info.message);
    setMessage(info.message, true);
    addLog(info.message, "error");
  }
};

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
    if (serialPort === port && !intentionalDisconnect) {
      const diagnostic = `串口读取失败：${error.name || "Error"} · ${error.message}`;
      showConnectionDiagnostic(diagnostic);
      addLog(diagnostic, "error");
    }
  } finally {
    try { reader.releaseLock(); } catch (_) { /* 已释放 */ }
    if (serialReader === reader) serialReader = null;
    if (serialPort === port) {
      serialPort = null;
      if (serialWriter) {
        try { serialWriter.releaseLock(); } catch (_) { /* 已释放 */ }
      }
      serialWriter = null;
      handleDisconnected();
    }
  }
}

async function connectSerialPort(port) {
  setMessage("正在连接蓝牙串口…");
  await port.open({ baudRate: BLUETOOTH_BAUD_RATE, bufferSize: SERIAL_BUFFER_SIZE });
  resetReceiveDiagnostics();
  clearConnectionDiagnostic();
  serialPort = port;
  serialWriter = port.writable.getWriter();
  lastGrantedSerialPort = port;
  intentionalDisconnect = false;
  ui.deviceName.textContent = `SPP 蓝牙已连接 · ${BLUETOOTH_BAUD_RATE}`;
  setConnected(true);
  addLog(`CONNECTED SPP BAUD=${BLUETOOTH_BAUD_RATE} 8N1`);
  serialReadTask = readSerialPort(port);
  selectTab("sensor");
  await delay(350);
  if (await activateMode("sensor")) {
    setMessage("连接成功：巡线待机，电机未启动");
  }
}

async function connectSerial() {
  if (nativeBluetooth) {
    clearConnectionDiagnostic();
    setMessage("请选择已配对的小车蓝牙，可按名称或 MAC 搜索");
    nativeBluetooth.requestConnect();
    return;
  }
  if (!navigator.serial) {
    setMessage("当前浏览器没有提供网页串口接口，请换用之前已经连接成功的 Chrome/Edge 环境", true);
    return;
  }

  clearConnectionDiagnostic();
  try {
    setMessage("请选择已配对的 JDY-31-SPP…");
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
    setConnected(false);
    const diagnostic = `串口连接失败：${error.name || "Error"} · ${error.message}`;
    showConnectionDiagnostic(diagnostic);
    setMessage(diagnostic, true);
    addLog(error.message, "error");
  }
}

function connectSelectedDevice() {
  return connectSerial();
}

async function connectLastDevice() {
  if (nativeBluetooth) {
    clearConnectionDiagnostic();
    setMessage("正在连接上次使用的小车蓝牙…");
    nativeBluetooth.connectLast();
    return;
  }
  const device = lastGrantedSerialPort;
  if (!device) return;
  clearConnectionDiagnostic();
  try {
    setMessage("正在连接上次授权的蓝牙设备…");
    await connectSerialPort(device);
  } catch (error) {
    serialPort = null;
    serialWriter = null;
    setConnected(false);
    const diagnostic = `上次设备连接失败：${error.name || "Error"} · ${error.message}`;
    showConnectionDiagnostic(diagnostic);
    setMessage(diagnostic, true);
    addLog(error.message, "error");
  }
}

async function loadGrantedDevices() {
  if (nativeBluetooth) {
    nativeHasLastDevice = Boolean(nativeBluetooth.hasLastDevice());
    updateConnectionControls();
    if (nativeHasLastDevice) setMessage("可快速重连上次设备，也可以重新选择");
    return;
  }
  if (navigator.serial?.getPorts) {
    try {
      const ports = await navigator.serial.getPorts();
      const sppPorts = ports.filter((port) => port.getInfo().bluetoothServiceClassId);
      if (sppPorts.length === 1) lastGrantedSerialPort = sppPorts[0];
    } catch (_) { /* 使用手动连接 */ }
  }

  updateConnectionControls();
  if (lastGrantedSerialPort) setMessage("可快速重连上次设备，也可以重新选择");
}

async function disconnectCurrentDevice() {
  if (!state.connected) return;
  intentionalDisconnect = true;
  await sendCommand("STOP");
  if (nativeBluetooth) {
    nativeBluetooth.disconnect();
    return;
  }
  const port = serialPort;
  serialPort = null;
  try { await serialReader?.cancel(); } catch (_) { /* 已断开 */ }
  try { await serialReadTask; } catch (_) { /* 读取循环已结束 */ }
  if (serialWriter) {
    try { serialWriter.releaseLock(); } catch (_) { /* 已释放 */ }
  }
  serialWriter = null;
  serialReadTask = null;
  try { await port?.close(); } catch (_) { /* 设备已经关闭 */ }
  handleDisconnected();
}

function handleDisconnected() {
  const planned = intentionalDisconnect;
  intentionalDisconnect = false;
  receiveBuffer = "";
  setConnected(false);
  ui.deviceName.textContent = lastDeviceLabel();
  setMessage(planned ? "已停车并断开" : "意外断线，无法确认停车", !planned);
  addLog(planned ? "DISCONNECTED" : "UNEXPECTED DISCONNECT", planned ? "rx" : "error");
}

function sendCommand(command, quiet = false) {
  const normalized = command.trim().toUpperCase();
  const operation = () => writeCommand(normalized, quiet);
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function writeCommand(command, quiet = false) {
  if (!state.connected) {
    setMessage("请先连接蓝牙", true);
    return false;
  }
  try {
    if (nativeBluetooth) {
      if (!nativeBluetooth.write(`${command}\r\n`)) throw new Error("原生蓝牙串口不可写");
    } else {
      const data = encoder.encode(`${command}\r\n`);
      if (!serialWriter) throw new Error("蓝牙串口不可写");
      await serialWriter.write(data);
    }
    if (!quiet) {
      addLog(command, "tx");
      setMessage(`${command} 已发送`);
    }
    return true;
  } catch (error) {
    setMessage(`发送失败：${error.message}`, true);
    addLog(error.message, "error");
    return false;
  }
}

function showDistance(value) {
  return value === "OUT" || value === null ? "--" : String(value);
}

function numberField(fields, ...keys) {
  for (const key of keys) {
    if (fields[key] === undefined || fields[key] === "") continue;
    const value = Number(fields[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function numberList(value, expectedLength) {
  if (typeof value !== "string") return null;
  const values = value.split(",").map(Number);
  return values.length === expectedLength && values.every(Number.isFinite) ? values : null;
}

function shortBuildTime(value) {
  const match = String(value || "").match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  return match ? `${match[2]}-${match[3]} ${match[4]}:${match[5]}` : "--";
}

function browserBuildTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "--";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

async function loadWebBuildTime() {
  if (nativeBluetooth?.getBuildTime) {
    ui.webBuildBadge.textContent = `APP ${shortBuildTime(nativeBluetooth.getBuildTime())}`;
    return;
  }
  try {
    const response = await fetch(`app.js?build-time=${Date.now()}`, { method: "HEAD", cache: "no-store" });
    ui.webBuildBadge.textContent = `网页 ${browserBuildTime(new Date(response.headers.get("last-modified")))}`;
  } catch (_) {
    ui.webBuildBadge.textContent = "网页 本地版";
  }
}

function protocolCrc8(text) {
  let crc = 0;
  for (let index = 0; index < text.length; index++) {
    crc ^= text.charCodeAt(index) & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function parameterScale(input) {
  const scale = Number(input?.dataset.scale || 1);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function protocolParameterValue(input) {
  if (!input) return NaN;
  return Math.round(Number(input.value) * parameterScale(input));
}

function showParameterValue(input, value) {
  const scale = parameterScale(input);
  if (scale === 1) return String(value);
  if (value === 0) return "0";
  return (value / scale).toFixed(Math.round(Math.log10(scale)));
}

function processLine(line) {
  const firmwareBuild = line.match(/(?:^FW BUILD=|\sFW=)(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/i);
  if (firmwareBuild) ui.firmwareBuildBadge.textContent = `固件 ${shortBuildTime(firmwareBuild[1])}`;
  if (/^STANDBY - send MODE/i.test(line)) lastLineSequence = null;
  const modeMatch = line.match(/(?:MODE=|OK MODE |OK STOPPED MODE )(STANDBY|REMOTE|SENSOR)\b/i);
  if (modeMatch) {
    const reportedMode = modeMatch[1].toLowerCase();
    setMode(reportedMode);
    resolveModeAck(reportedMode);
  }
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

  if (line.startsWith("SENSOR D=")) {
    const fields = Object.fromEntries(line.slice(7).split(/\s+/).flatMap((token) => {
      const split = token.indexOf("=");
      return split > 0 ? [[token.slice(0, split).toUpperCase(), token.slice(split + 1)]] : [];
    }));
    telemetry.distance = fields.D === "OUT" ? null : numberField(fields, "D");
    telemetry.route = (fields.ROUTE || "NONE").toUpperCase();
    ui.distanceValue.textContent = showDistance(telemetry.distance);
    ui.thresholdValue.textContent = fields.TH || "--";
    const routeLabels = { NONE: "待机", LEFT: "向左绕", RIGHT: "向右绕", STRAIGHT: "绕行直行段" };
    ui.routeValue.textContent = routeLabels[telemetry.route] || telemetry.route;
    if (fields.AVOID === "ON" || fields.AVOID === "OFF") setAvoidance(fields.AVOID === "ON");
  }

  const sensorVoltage = line.match(/^SENSOR VBAT_MV=(\d+)/i);
  if (sensorVoltage) {
    telemetry.voltageMv = Number(sensorVoltage[1]);
    ui.voltageValue.textContent = `${(telemetry.voltageMv / 1000).toFixed(2)}V`;
  }

  const uartBaud = line.match(/^UART BAUD=(57600)$/i);
  if (uartBaud) {
    ui.deviceName.textContent = `SPP 蓝牙已连接 · 小车确认 ${uartBaud[1]}`;
  }

  if (line.startsWith("LINE ")) {
    const fields = Object.fromEntries(line.slice(5).split(/\s+/).flatMap((token) => {
      const split = token.indexOf("=");
      return split > 0 ? [[token.slice(0, split), token.slice(split + 1)]] : [];
    }));
    const protocolVersion = numberField(fields, "PROTO");
    const checksumMarker = line.lastIndexOf(" CS=");
    const checksumText = checksumMarker > 0 ? line.slice(checksumMarker + 4) : "";
    const checksumValid = /^[0-9A-F]{2}$/i.test(checksumText) &&
      protocolCrc8(line.slice(0, checksumMarker)) === Number.parseInt(checksumText, 16);
    let frameError = "";
    if (protocolVersion !== EXPECTED_PROTOCOL_VERSION) {
      frameError = `网页需要协议 ${EXPECTED_PROTOCOL_VERSION}，当前小车固件为${Number.isFinite(protocolVersion) ? ` ${protocolVersion}` : "旧版本"}。请烧录最新版 car_main.hex。`;
    } else if (!checksumValid) {
      frameError = checksumMarker < 0 ? "小车固件没有提供数据帧校验，请烧录最新版 car_main.hex。" :
        "数据帧 CRC 校验失败，已丢弃并等待下一帧。";
    }
    if (frameError) {
      showConnectionDiagnostic(frameError);
      if (protocolVersion !== EXPECTED_PROTOCOL_VERSION) state.firmwareCompatible = false;
      if (ui.firmwareWarning.textContent !== frameError) {
        setMessage(frameError, true);
        addLog(frameError, "error");
      }
      ui.firmwareWarning.textContent = frameError;
      ui.firmwareWarning.hidden = false;
      updateAvailability();
      return;
    }

    const raw = numberList(fields.RAW, 4);
    const normalized = numberList(fields.N, 4);
    const pid = numberList(fields.PID, 4);
    const peakPid = numberList(fields.PKPID, 4);
    const peakNormalized = numberList(fields.PKN, 4);
    const endNormalized = numberList(fields.ENDN, 4);
    const sequence = numberField(fields, "SEQ");
    if (!raw || !normalized || !pid || !peakPid || !peakNormalized || !endNormalized || !Number.isFinite(sequence)) {
      const error = "数据帧字段不完整，已丢弃并等待下一帧。";
      showConnectionDiagnostic(error);
      if (ui.firmwareWarning.textContent !== error) {
        setMessage(error, true);
        addLog(error, "error");
      }
      ui.firmwareWarning.textContent = error;
      ui.firmwareWarning.hidden = false;
      updateAvailability();
      return;
    }

    if (lastLineSequence !== null && sequence !== 1) {
      const missing = (sequence - lastLineSequence - 1 + 65536) % 65536;
      if (missing > 0) {
        telemetry.lineFramesDropped += missing;
        setMessage(`检测到 ${missing} 帧传感器数据丢失，已自动使用最新一帧`, true);
        addLog(`LINE GAP ${lastLineSequence}->${sequence}`, "error");
      }
    }
    lastLineSequence = sequence;
    telemetry.lineSequence = sequence;
    state.firmwareCompatible = true;
    ui.firmwareWarning.hidden = true;
    ui.firmwareWarning.textContent = "";
    updateAvailability();
    if (fields.CAL !== undefined) setLineCalibrated(fields.CAL === "1");
    if (fields.STATE) setTrackState(fields.STATE.toUpperCase());
    if (fields.AVOID) setAvoidance(fields.AVOID === "ON");
    if (fields.END) state.trackEnd = fields.END.toUpperCase();
    if (state.trackEnd === "NONE") lastFailureSignature = "";
    telemetry.trackBase = numberField(fields, "BASE");
    [telemetry.trackP, telemetry.trackI, telemetry.trackD, telemetry.lineTrim] = pid;
    [telemetry.lineLeftTrans, telemetry.lineLeftLong,
      telemetry.lineRightTrans, telemetry.lineRightLong] = raw;
    [telemetry.lineLeftTransPct, telemetry.lineLeftLongPct,
      telemetry.lineRightTransPct, telemetry.lineRightLongPct] = normalized;
    telemetry.lineErrorX100 = numberField(fields, "ERR_X100");
    telemetry.trackPeakErrorX100 = numberField(fields, "PKERR");
    [telemetry.trackPeakP, telemetry.trackPeakI, telemetry.trackPeakD, telemetry.trackPeakTrim] = peakPid;
    telemetry.trackPeakState = (fields.PKSTATE || "LOST").toUpperCase();
    telemetry.trackPeakMs = numberField(fields, "PKMS");
    telemetry.trackPeakPercent = peakNormalized;
    telemetry.trackEndMs = numberField(fields, "ENDMS");
    telemetry.trackEndPercent = endNormalized;
    if (fields.RUN !== undefined) setTrackRunning(fields.RUN === "1");
    captureSensorHistory();
    ui.lineErrorValue.textContent = state.lineCalibrated && Number.isFinite(telemetry.lineErrorX100) ?
      `误差 ${(telemetry.lineErrorX100 / 100).toFixed(2)}` : "原始 ADC";
    ui.trackPValue.textContent = telemetry.trackP ?? "--";
    ui.trackIValue.textContent = telemetry.trackI ?? "--";
    ui.trackDValue.textContent = telemetry.trackD ?? "--";
    ui.trackTrimValue.textContent = telemetry.lineTrim ?? "--";
    const stateLabels = { LOST: "丢线", STRAIGHT: "直线", LEFT: "左转", RIGHT: "右转", CROSS: "十字" };
    ui.trackPeakValue.textContent = state.lineCalibrated && Number.isFinite(telemetry.trackPeakErrorX100) ?
      `${(telemetry.trackPeakErrorX100 / 100).toFixed(2)} · ${stateLabels[telemetry.trackPeakState] || telemetry.trackPeakState} · 输出 ${telemetry.trackPeakTrim ?? "--"}` : "--";
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
    if (paramInputs.has(key)) {
      const input = paramInputs.get(key);
      input.value = showParameterValue(input, value);
    }
    if (key === "TURN90_L_COUNT" || key === "TURN90_R_COUNT") updateTurn90Status();
    if (key === "LINE_CAL" && source !== "STAGED") setLineCalibrated(value === 1);
  }
  if (/^PENDING=YES$/i.test(line)) ui.tuningStatus.textContent = "有暂存";
  if (/^PENDING=NO$/i.test(line)) ui.tuningStatus.textContent = "已同步";
  if (/^PARAMS END$/i.test(line)) {
    paramsRequestPending = false;
    paramsLoaded = true;
    ui.tuningStatus.textContent = "已读取";
    if (resumePollingAfterParams && state.mode === "sensor") startLinePolling();
    resumePollingAfterParams = false;
    updateAvailability();
  }
  if (/^OK SAVED TO FLASH$/i.test(line)) ui.tuningStatus.textContent = "已保存";
  if (/^OK LINE CAL START$/i.test(line)) {
    setLineCalibrating(true);
    setMessage("保持电机停止，手动让四个探头经过赛道与空白区域");
  }
  if (/^OK LINE CAL READY$/i.test(line)) {
    setLineCalibrating(false);
    if (recording) stopSampling();
    paramsRequestPending = true;
    resumePollingAfterParams = state.mode === "sensor";
    stopLinePolling();
    updateAvailability();
    setMessage("范围已采集，正在保存…");
    setTimeout(async () => {
      if (await sendCommand("APPLY")) return;
      paramsRequestPending = false;
      if (resumePollingAfterParams && state.mode === "sensor") startLinePolling();
      resumePollingAfterParams = false;
      updateAvailability();
    }, 180);
  }
  if (/^ERR LINE CAL RANGE TOO SMALL$/i.test(line)) {
    setLineCalibrating(false);
    paramsRequestPending = false;
    if (state.mode === "sensor") startLinePolling();
    updateAvailability();
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
  else if (/^ERR MODE NOT SENSOR$/i.test(line)) {
    setMode("standby");
    setMessage("小车尚未进入巡线模式，请点“巡线”重试", true);
  }
  else if (/^ERR FLASH WRITE FAILED$/i.test(line)) {
    paramsRequestPending = false;
    if (resumePollingAfterParams && state.mode === "sensor") startLinePolling();
    resumePollingAfterParams = false;
    updateAvailability();
    setMessage("参数保存失败，请重试", true);
  }
  else if (/^ERR LINE CAL RANGE TOO SMALL$/i.test(line)) {
    /* 上面已经给出可操作的中文提示。 */
  }
  else if (/^ERR\b/i.test(line)) setMessage(line, true);

  if (!line.startsWith("LINE ")) addLog(line, /^ERR\b/i.test(line) ? "error" : "rx");
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

async function requestParameters() {
  if (!state.connected) return false;
  if (paramsRequestPending) {
    setMessage("参数正在读取，请稍等几秒");
    return false;
  }
  if (recording) stopSampling();
  paramsRequestPending = true;
  resumePollingAfterParams = state.mode === "sensor";
  if (resumePollingAfterParams) stopLinePolling();
  ui.tuningStatus.textContent = "读取中…";
  updateAvailability();
  if (await sendCommand("CHECK")) return true;
  paramsRequestPending = false;
  if (resumePollingAfterParams) startLinePolling();
  resumePollingAfterParams = false;
  updateAvailability();
  return false;
}

function changedParameterEntries() {
  const entries = [];
  for (const [key, input] of paramInputs) {
    if (!input.reportValidity()) return null;
    const value = protocolParameterValue(input);
    if (!Number.isInteger(value)) return null;
    if (knownParams[key] !== value) entries.push({ key, value });
  }

  const valueOf = (key) => protocolParameterValue(paramInputs.get(key));
  if (valueOf("TRACK_MIN_CPS") > valueOf("TRACK_BASE_CPS")) {
    setMessage("低档基础速度不能高于高档基础速度", true);
    return null;
  }
  const calibrationPairs = [
    ["MIN_L_TRANS", "MAX_L_TRANS"], ["MIN_L_LONG", "MAX_L_LONG"],
    ["MIN_R_TRANS", "MAX_R_TRANS"], ["MIN_R_LONG", "MAX_R_LONG"]
  ].filter(([minimumKey, maximumKey]) => paramInputs.has(minimumKey) && paramInputs.has(maximumKey));
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
  if (paramsRequestPending) {
    setMessage("参数传输完成后再开始日志");
    return;
  }
  if (state.mode !== "remote" && state.mode !== "sensor") {
    setMessage("请先进入巡线或遥控模式", true);
    return;
  }
  recording = true;
  recordingMode = state.mode;
  if (recordingMode === "sensor") {
    stopLinePolling();
    if (Number(ui.sampleInterval.value) < 1000) {
      ui.sampleInterval.value = "1000";
      setMessage("传感器完整日志已自动使用 1 秒间隔，避免超过蓝牙带宽");
    }
  }
  sampleStartedAt = Date.now();
  ui.recordButton.textContent = "停止采样";
  updateLogProfile();
  sampleNow();
  sampleTimer = setInterval(sampleNow, Number(ui.sampleInterval.value));
}

function stopSampling() {
  const stoppedMode = recordingMode;
  if (sampleTimer) clearInterval(sampleTimer);
  sampleTimer = null;
  recording = false;
  recordingMode = null;
  sampleCapturePending = false;
  if (ui.recordButton) ui.recordButton.textContent = "连续采样";
  updateLogProfile();
  if (stoppedMode === "sensor" && state.connected && state.mode === "sensor" && !paramsRequestPending) {
    startLinePolling();
  }
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
  const sensorColumns = ["time", "elapsed_ms", "note", "scene", "line_sequence", "line_frames_dropped", "track_running", "track_state", "track_speed_gear", "avoidance", "distance_cm", "route", "line_calibrated", "track_base_cps", "line_error_x100", "track_p_cps", "track_i_cps", "track_d_cps", "line_trim_cps", "line_left_trans", "line_left_long", "line_right_trans", "line_right_long", "line_left_trans_pct", "line_left_long_pct", "line_right_trans_pct", "line_right_long_pct", "track_end", "track_end_ms", "track_peak_error_x100", "track_peak_state", "track_peak_ms", "track_peak_p_cps", "track_peak_i_cps", "track_peak_d_cps", "track_peak_trim_cps", "peak_left_trans_pct", "peak_left_long_pct", "peak_right_trans_pct", "peak_right_long_pct", "end_left_trans_pct", "end_left_long_pct", "end_right_trans_pct", "end_right_long_pct"];
  const columns = mode === "sensor" ? sensorColumns : remoteColumns;
  const rows = [columns.join(",")];
  for (const record of records) {
    rows.push(columns.map((column) => csvCell(record[column])).join(","));
  }
  const fileName = `小车-${mode === "sensor" ? "巡线" : "遥控"}-${localTimestamp(new Date(), true)}.csv`;
  downloadText(fileName, `\ufeff${rows.join("\n")}`);
}

ui.connectButton.addEventListener("click", connectSelectedDevice);
ui.disconnectButton.addEventListener("click", () => state.connected ? disconnectCurrentDevice() : connectLastDevice());
ui.copyConnectionDiagnosticButton.addEventListener("click", async () => {
  if (!latestConnectionDiagnostic) return;
  try {
    await writeClipboardText(latestConnectionDiagnostic);
    setMessage("通信诊断已复制，可以直接发给我");
  } catch {
    setMessage("复制失败，请截图通信诊断按钮上方的报错", true);
  }
});
document.querySelectorAll(".tab-button").forEach((button) => button.addEventListener("click", async () => {
  const tab = button.dataset.tab;
  if (paramsRequestPending && (tab === "sensor" || tab === "remote") && state.mode !== tab) {
    setMessage("参数传输完成后再切换模式，请稍等几秒");
    return;
  }
  selectTab(tab);
  if (tab === "sensor" || tab === "remote") await activateMode(tab);
  else if (tab === "tuning" && state.connected) await requestParameters();
}));

document.querySelectorAll("button[data-command]:not([data-mode])").forEach((button) => {
  button.addEventListener("click", async () => {
    if (!(await sendCommand(button.dataset.command))) return;
    const motions = { FORWARD: "forward", BACKWARD: "backward", LEFT: "left", RIGHT: "right", STOP: "stop", "TURN90 LEFT": "turn90_left", "TURN90 RIGHT": "turn90_right" };
    if (motions[button.dataset.command]) setMotion(motions[button.dataset.command]);
    if (button.dataset.command === "STOP") centerJoystick(false);
  });
});

ui.trackStartButton.addEventListener("click", async () => {
  if (!(await activateMode("sensor", true))) return;
  await sendCommand("TRACK START");
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

ui.lineCalibrationButton.addEventListener("click", async () => {
  if (state.lineCalibrating) {
    await sendCommand("LINE CAL STOP");
  } else if (await sendCommand("LINE CAL START")) {
    setLineCalibrating(true);
  }
});

ui.copySensorButton.addEventListener("click", async () => {
  const values = [telemetry.lineLeftTrans, telemetry.lineLeftLong, telemetry.lineRightLong, telemetry.lineRightTrans];
  if (values.some((value) => !Number.isFinite(value))) {
    setMessage("四路数据还没有全部收到，请重新读取", true);
    return;
  }
  const percentages = [telemetry.lineLeftTransPct, telemetry.lineLeftLongPct, telemetry.lineRightLongPct, telemetry.lineRightTransPct];
  const percent = state.lineCalibrated && percentages.every(Number.isFinite) ?
    `；标定相对值 ${percentages.join("/")}` :
    `；${state.lineCalibrated ? "标定相对值不完整" : "未标定"}`;
  const text = `左横 ${values[0]}，左竖 ${values[1]}，右竖 ${values[2]}，右横 ${values[3]}${percent}`;
  try {
    await writeClipboardText(text);
    setMessage("四路数据已复制，可以直接发给我");
  } catch {
    setMessage(text);
  }
});

ui.sensorScenario.addEventListener("change", updateSensorCaptureStatus);
ui.newSensorSessionButton.addEventListener("click", startNewSensorSession);
ui.copySensorSessionButton.addEventListener("click", copySensorSession);
ui.exportSensorSessionButton.addEventListener("click", exportSensorSession);
ui.sensorChart.closest("details")?.addEventListener("toggle", drawSensorChart);
window.addEventListener("resize", drawSensorChart);

ui.readParamsButton.addEventListener("click", requestParameters);
ui.applyParamsButton.addEventListener("click", async () => {
  const resumePolling = state.mode === "sensor";
  if (recording) stopSampling();
  paramsRequestPending = true;
  resumePollingAfterParams = resumePolling;
  if (resumePolling) stopLinePolling();
  updateAvailability();
  if (!(await stageChangedParameters(false))) {
    paramsRequestPending = false;
    resumePollingAfterParams = false;
    if (resumePolling) startLinePolling();
    updateAvailability();
    return;
  }
  await delay(180);
  if (await sendCommand("APPLY")) {
    ui.tuningStatus.textContent = "保存中…";
    return;
  }
  paramsRequestPending = false;
  resumePollingAfterParams = false;
  if (resumePolling) startLinePolling();
  updateAvailability();
});
ui.cancelParamsButton.addEventListener("click", async () => {
  if (!(await sendCommand("CANCEL"))) return;
  await delay(140);
  await requestParameters();
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

setConnected(false);
if (nativeBluetooth) {
  document.documentElement.classList.add("native-app");
  ui.platformBadge.textContent = "ANDROID APP";
}
loadWebBuildTime();
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
updateLogProfile();
updateSensorCaptureStatus();
