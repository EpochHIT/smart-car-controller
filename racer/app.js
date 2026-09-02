"use strict";

const BAUD_RATE = 57600;
const CONTROL_PERIOD_MS = 20;
const PWM_MAX = 2133;
const MOTION_HEARTBEAT_MS = 100;
const TELEMETRY_TIMEOUT_MS = 250;
const ADC_MAX = 4095;
const HISTORY_LIMIT = 2000;
const CHART_POINTS = 800;
const HALL_EDGES_PER_OUTPUT_REV = 13 * 20.409 * 2;
const sensorRanges = {
  lt: [700, 3430],
  ll: [0, 1600],
  rt: [1380, 4095],
  rl: [0, 1600]
};

const ui = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]));
let port;
let reader;
let keepReading = false;
let writeChain = Promise.resolve();
let lineBuffer = "";
let activeRepeatCommand = "";
let lastTelemetryAt = 0;
let safetyStopLatched = false;
let isConnected = false;
let telemetryReady = false;
let selectedRunMode = "track";
let selectedTestControl = "pwm";
let runningMode = "";
let encoderFaultActive = false;
let selectedTrackSpeed = 4000;
let selectedMotorGear = 1;
let buildInfoConfirmed = false;
let sessionNumber = 1;
let sessionStartedAt = Date.now();
let sensorHistory = [];
const rpmLeftHistory = [];
const rpmRightHistory = [];
const gearTargets = [0, 40, 43, 46, 49, 52, 55, 58];

function setMessage(text, error = false) {
  ui.message.textContent = text;
  ui.message.classList.toggle("error", error);
}

function addLog(text) {
  const stamp = new Date().toLocaleTimeString();
  const lines = `${ui.diagnosticLog.textContent}${stamp} ${text}\n`.split("\n");
  ui.diagnosticLog.textContent = lines.slice(-61).join("\n");
  ui.diagnosticLog.scrollTop = ui.diagnosticLog.scrollHeight;
}

function setConnected(connected) {
  isConnected = connected;
  ui.connectButton.disabled = connected;
  ui.disconnectButton.disabled = !connected;
  document.querySelectorAll(".requires-connection").forEach((node) => { node.disabled = !connected; });
  ui.connectionState.classList.toggle("connected", connected);
  ui.connectionText.textContent = connected ? "已连接" : "未连接";
  if (!connected) {
    telemetryReady = false;
    encoderFaultActive = false;
  }
  updateMotorStartAvailability();
}

function updateMotorStartAvailability() {
  ui.motorStartButton.disabled = !isConnected || !telemetryReady || encoderFaultActive;
  if (!isConnected) ui.motorStartButton.textContent = "先连接 BT04-A";
  else if (!telemetryReady) ui.motorStartButton.textContent = "等待遥测，暂不能启动";
  else if (encoderFaultActive) ui.motorStartButton.textContent = "先清除编码器故障";
  else ui.motorStartButton.textContent = "▶ 启动电机";
  ui.motorStopButton.textContent = encoderFaultActive ? "清除编码器故障" : "■ 立即停车";
}

function setTelemetryState(text, ready) {
  telemetryReady = ready;
  ui.telemetryState.textContent = `遥测：${text}`;
  ui.telemetryState.classList.toggle("ready", ready);
  updateMotorStartAvailability();
}

async function send(command, show = true) {
  if (!port?.writable) {
    if (show) setMessage(`未发送（未连接）：${command}`, true);
    return;
  }
  writeChain = writeChain.then(async () => {
    const writer = port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(`${command}\r\n`));
    } finally {
      writer.releaseLock();
    }
  }).catch((error) => {
    if (activeRepeatCommand) activeRepeatCommand = "";
    addLog(`发送失败：${error.message}`);
    setMessage(`发送失败：${error.message}；固件会在 400 ms 内停车`, true);
  });
  if (show) addLog(`> ${command}`);
  return writeChain;
}

function selectTab(name) {
  document.querySelectorAll(".tab-button").forEach((button) => button.classList.toggle("active", button.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    const active = panel.dataset.panel === name;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
  if (name === "sensor") drawSensorChart();
  if (name === "motor") drawMotorSpeedChart();
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizedPercent(raw, key) {
  const [minimum, maximum] = sensorRanges[key];
  return Math.max(0, Math.min(100, (raw - minimum) * 100 / (maximum - minimum)));
}

function updateSensorMeter(key, raw) {
  const output = ui[`${key}Value`];
  const bar = ui[`${key}Bar`];
  const meta = ui[`${key}Meta`];
  if (!Number.isFinite(raw)) {
    output.textContent = "--";
    bar.style.width = "0";
    meta.textContent = "等待数据";
    return NaN;
  }
  const percent = normalizedPercent(raw, key);
  output.textContent = raw;
  bar.style.width = `${Math.max(0, Math.min(100, raw * 100 / ADC_MAX)).toFixed(1)}%`;
  meta.textContent = `相对值 ${percent.toFixed(1)}%`;
  return percent;
}

function updateBatteryRaw(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return NaN;
  ui.batteryRawValue.textContent = Math.round(raw);
  return NaN;
}

function movingAverage(history, value) {
  history.push(value);
  if (history.length > 5) history.shift();
  return history.reduce((sum, item) => sum + item, 0) / history.length;
}

function parseTelemetryValues(line) {
  const values = {};
  line.split(/\s+/).slice(1).forEach((item) => {
    const split = item.indexOf("=");
    if (split > 0) values[item.slice(0, split)] = item.slice(split + 1);
  });
  return values;
}

function sceneLabel() {
  return ui.sensorScenario.options[ui.sensorScenario.selectedIndex]?.text || ui.sensorScenario.value;
}

function addHistoryEvent(event) {
  sensorHistory.push({
    record_type: "EVENT",
    event,
    event_label: event === "START" ? "巡线开始" : "巡线结束",
    time_ms: Date.now(),
    elapsed_ms: Date.now() - sessionStartedAt,
    scene: sceneLabel(),
    note: ui.sensorNote.value.trim()
  });
  trimHistory();
  updateCaptureStatus();
}

function captureTelemetry(v, derived) {
  const now = Date.now();
  sensorHistory.push({
    record_type: "SAMPLE",
    event: "",
    event_label: "",
    time_iso: new Date(now).toISOString(),
    local_time: new Date(now).toLocaleString(),
    time_ms: now,
    elapsed_ms: now - sessionStartedAt,
    session: sessionNumber,
    scene: sceneLabel(),
    note: ui.sensorNote.value.trim(),
    device_ms: v.ms ?? "",
    mode: v.mode ?? "",
    battery_raw: v.bat ?? "",
    battery_v: Number.isFinite(derived.batteryV) ? derived.batteryV : "",
    lt_raw: v.lt ?? "",
    ll_raw: v.ll ?? "",
    rl_raw: v.rl ?? "",
    rt_raw: v.rt ?? "",
    lt_pct: derived.ltPct,
    ll_pct: derived.llPct,
    rl_pct: derived.rlPct,
    rt_pct: derived.rtPct,
    error_x100: v.err ?? "",
    cross: v.cross ?? "",
    state: v.state ?? "",
    target_left_x100: v.spReqL ?? "",
    target_right_x100: v.spReqR ?? "",
    enc_left: v.encL ?? "",
    enc_right: v.encR ?? "",
    rpm_left: derived.rpmLeft,
    rpm_right: derived.rpmRight,
    pwm_left: v.pwmL ?? "",
    pwm_right: v.pwmR ?? "",
    correction_x100: v.corr ?? "",
    total_left: v.totalL ?? "",
    total_right: v.totalR ?? "",
    fault: v.fault ?? ""
  });
  trimHistory();
  updateCaptureStatus();
}

function trimHistory() {
  if (sensorHistory.length > HISTORY_LIMIT) sensorHistory.splice(0, sensorHistory.length - HISTORY_LIMIT);
}

function parseTelemetry(line) {
  if (!(line.startsWith("T ") || line.startsWith("STATUS "))) return false;
  const v = parseTelemetryValues(line);
  const lt = numberValue(v.lt);
  const ll = numberValue(v.ll);
  const rt = numberValue(v.rt);
  const rl = numberValue(v.rl);
  const encLeftValue = numberValue(v.encL);
  const encRightValue = numberValue(v.encR);
  const pwmLeftValue = numberValue(v.pwmL);
  const pwmRightValue = numberValue(v.pwmR);
  const requiredFields = [
    ["mode", typeof v.mode === "string"], ["bat", Number.isFinite(numberValue(v.bat))],
    ["lt", Number.isFinite(lt)], ["ll", Number.isFinite(ll)], ["rt", Number.isFinite(rt)], ["rl", Number.isFinite(rl)],
    ["encL", Number.isFinite(encLeftValue)], ["encR", Number.isFinite(encRightValue)],
    ["pwmL", Number.isFinite(pwmLeftValue)], ["pwmR", Number.isFinite(pwmRightValue)]
  ];
  const missingFields = requiredFields.filter(([, valid]) => !valid).map(([name]) => name);
  if (missingFields.length) {
    const reason = `字段不完整（缺少 ${missingFields.join("、")}）`;
    setTelemetryState(reason, false);
    addLog(`< ${reason}`);
    if (activeRepeatCommand) safetyStop(`收到的遥测${reason}`);
    return true;
  }
  lastTelemetryAt = Date.now();
  setTelemetryState("正常 · 50 ms", true);
  const encLeft = Number.isFinite(encLeftValue) ? encLeftValue : 0;
  const encRight = Number.isFinite(encRightValue) ? encRightValue : 0;
  const edgesPerRev = Math.max(1, numberValue(ui.edgesPerRev.value) || HALL_EDGES_PER_OUTPUT_REV);
  const rpmFactor = 60000 / CONTROL_PERIOD_MS / edgesPerRev;
  const rpmLeft = movingAverage(rpmLeftHistory, encLeft) * rpmFactor;
  const rpmRight = movingAverage(rpmRightHistory, encRight) * rpmFactor;
  const derived = {
    batteryV: updateBatteryRaw(numberValue(v.bat)),
    ltPct: updateSensorMeter("lt", lt),
    llPct: updateSensorMeter("ll", ll),
    rtPct: updateSensorMeter("rt", rt),
    rlPct: updateSensorMeter("rl", rl),
    rpmLeft,
    rpmRight
  };

  ui.trackModeValue.textContent = v.mode ?? "--";
  ui.trackStateValue.textContent = v.state ?? "--";
  ui.crossValue.textContent = v.cross === "1" ? "是" : "否";
  ui.lineErrorValue.textContent = Number.isFinite(numberValue(v.err)) ? (numberValue(v.err) / 100).toFixed(2) : "--";
  ui.trackTargetLeft.textContent = Number.isFinite(numberValue(v.spReqL)) ? (numberValue(v.spReqL) / 100).toFixed(2) : "--";
  ui.trackTargetRight.textContent = Number.isFinite(numberValue(v.spReqR)) ? (numberValue(v.spReqR) / 100).toFixed(2) : "--";
  ui.trackCorrection.textContent = v.corr ?? "--";
  ui.rpmLeft.textContent = Math.round(rpmLeft);
  ui.rpmRight.textContent = Math.round(rpmRight);
  ui.encLeft.textContent = encLeft;
  ui.encRight.textContent = encRight;
  ui.pwmLeft.textContent = v.pwmL ?? "--";
  ui.pwmRight.textContent = v.pwmR ?? "--";
  ui.motorTargetLeft.textContent = Number.isFinite(numberValue(v.spReqL)) ? (numberValue(v.spReqL) / 100).toFixed(2) : "--";
  ui.motorTargetRight.textContent = Number.isFinite(numberValue(v.spReqR)) ? (numberValue(v.spReqR) / 100).toFixed(2) : "--";
  ui.totalLeft.textContent = v.totalL ?? "--";
  ui.totalRight.textContent = v.totalR ?? "--";
  encoderFaultActive = v.fault === "1";
  ui.encoderFault.value = encoderFaultActive ? "有" : "无";
  updateMotorStartAvailability();
  if (activeRepeatCommand && encoderFaultActive) {
    safetyStop("固件报告编码器异常");
  }

  if (line.startsWith("T ")) captureTelemetry(v, derived);
  return true;
}

function handleLine(line) {
  if (!line) return;
  if (line.startsWith("INFO ")) {
    const match = line.match(/^INFO fw=(\S+) built=(.+)$/);
    const firmware = match?.[1] || "未知固件";
    const built = match?.[2] || line.slice(5);
    ui.firmwareBuildBadge.textContent = `固件编译：${built}`;
    addLog(`< ${line}`);
    if (!buildInfoConfirmed) {
      buildInfoConfirmed = true;
      const confirmed = window.confirm(`已连接 ${firmware}\n固件编译时间：${built}\n\n请确认这是准备测试的最新固件。`);
      setMessage(confirmed ? `已确认固件编译时间：${built}` : "尚未确认固件版本，请勿启动小车", !confirmed);
    }
    return;
  }
  const telemetryLine = parseTelemetry(line);
  if (!telemetryLine && line !== "PONG") addLog(`< ${line}`);
  if (line.includes("encoder_fault")) {
    encoderFaultActive = true;
    updateMotorStartAvailability();
    if (activeRepeatCommand) safetyStop("固件报告编码器异常");
    else setMessage("固件中保留了上次编码器故障；点击“清除编码器故障”后再测试", true);
  } else if (line.includes("track_lost") || line.includes("watchdog")) {
    if (activeRepeatCommand) safetyStop(`固件已停车：${line}`);
    else setMessage(`固件停车记录：${line}`, true);
  }
}

async function readLoop() {
  const decoder = new TextDecoder();
  keepReading = true;
  while (port?.readable && keepReading) {
    reader = port.readable.getReader();
    try {
      while (keepReading) {
        const result = await reader.read();
        if (result.done) break;
        lineBuffer += decoder.decode(result.value, { stream: true });
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop();
        lines.forEach(handleLine);
      }
    } catch (error) {
      if (keepReading) setMessage(`串口读取失败：${error.message}`, true);
    } finally {
      reader.releaseLock();
      reader = undefined;
    }
  }
}

async function connectSerial() {
  if (!("serial" in navigator)) {
    setMessage("当前浏览器不支持 Web Serial，请使用支持串口的 Chrome/Edge。", true);
    return;
  }
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: BAUD_RATE, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
    setConnected(true);
    lastTelemetryAt = Date.now();
    safetyStopLatched = false;
    runningMode = "";
    setTelemetryState("等待第一帧完整数据", false);
    buildInfoConfirmed = false;
    ui.firmwareBuildBadge.textContent = "固件编译：正在读取…";
    setMessage("已连接，正在以 50 ms 周期自动记录数据");
    addLog("串口已连接：57600 8N1");
    readLoop();
    const connectedPort = port;
    window.setTimeout(() => {
      if ((port === connectedPort) && isConnected && !telemetryReady) {
        setTelemetryState("未收到单片机返回", false);
        setMessage("BT04-A 已连接，但单片机没有返回数据：请烧录最新固件，并确认模块为 57600、TX/RX 交叉连接", true);
      }
    }, 1200);
    await send("INFO");
    await send("TELEM 50");
    await send("STATUS", false);
    await send("PING");
  } catch (error) {
    port = undefined;
    setConnected(false);
    setMessage(`连接失败：${error.message}`, true);
  }
}

async function disconnectSerial() {
  activeRepeatCommand = "";
  safetyStopLatched = false;
  runningMode = "";
  if (!port) return;
  try { await send("STOP", false); } catch (_) { }
  keepReading = false;
  if (reader) await reader.cancel().catch(() => {});
  await writeChain;
  await port.close().catch(() => {});
  port = undefined;
  setConnected(false);
  setTelemetryState("未连接", false);
  setMessage("串口已断开；已记录数据仍可导出");
}

function stopCar() {
  const wasTracking = runningMode === "track";
  activeRepeatCommand = "";
  safetyStopLatched = false;
  runningMode = "";
  send("STOP");
  if (wasTracking) addHistoryEvent("END");
}

function stopOrClearFault() {
  if (!encoderFaultActive) {
    stopCar();
    return;
  }
  activeRepeatCommand = "";
  runningMode = "";
  safetyStopLatched = false;
  send("CLEAR");
  setMessage("已请求停车并清除编码器故障，等待固件确认");
}

function armMotion(command, mode, message) {
  if (!telemetryReady || (Date.now() - lastTelemetryAt) > TELEMETRY_TIMEOUT_MS) {
    setTelemetryState("数据未就绪，已禁止启动", false);
    setMessage("没有收到最新的完整遥测，电机没有启动", true);
    return false;
  }
  safetyStopLatched = false;
  activeRepeatCommand = "PING";
  runningMode = mode;
  send(command);
  setMessage(message);
  return true;
}

function safetyStop(reason) {
  if (safetyStopLatched) return;
  safetyStopLatched = true;
  activeRepeatCommand = "";
  runningMode = "";
  send("STOP", false);
  addHistoryEvent("SAFETY_STOP");
  addLog(`安全停车：${reason}`);
  setMessage(`安全停车：${reason}`, true);
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
  const records = sensorHistory.slice(-CHART_POINTS);
  const samples = records.filter((record) => record.record_type === "SAMPLE");
  if (!samples.length) {
    context.fillStyle = "#70869a";
    context.textAlign = "center";
    context.fillText("连接后自动记录，或点击“读取 CSV”", margin.left + chartWidth / 2, margin.top + chartHeight / 2);
    return;
  }
  const series = [
    { key: "lt_raw", color: "#43d5ff" },
    { key: "ll_raw", color: "#b38cff" },
    { key: "rl_raw", color: "#ffbd66" },
    { key: "rt_raw", color: "#55e5a7" }
  ];
  const firstTime = numberValue(records[0].elapsed_ms) || 0;
  const lastTime = numberValue(records.at(-1).elapsed_ms) || firstTime + samples.length;
  const timeSpan = Math.max(1, lastTime - firstTime);
  const xFor = (record) => margin.left + ((numberValue(record.elapsed_ms) || firstTime) - firstTime) * chartWidth / timeSpan;
  for (const item of series) {
    context.strokeStyle = item.color;
    context.lineWidth = 1.7;
    context.lineJoin = "round";
    context.beginPath();
    let started = false;
    samples.forEach((record) => {
      const value = numberValue(record[item.key]);
      if (!Number.isFinite(value)) return;
      const x = xFor(record);
      const y = margin.top + chartHeight - value / 4095 * chartHeight;
      if (!started) { context.moveTo(x, y); started = true; }
      else context.lineTo(x, y);
    });
    context.stroke();
  }
  for (const record of records.filter((item) => item.record_type === "EVENT")) {
    const start = record.event === "START";
    const x = xFor(record);
    context.strokeStyle = start ? "#22c55e" : "#ef4444";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(x, margin.top);
    context.lineTo(x, margin.top + chartHeight);
    context.stroke();
  }
  context.fillStyle = "#70869a";
  context.textAlign = "left";
  context.textBaseline = "bottom";
  context.fillText(`最近 ${samples.length} 条`, margin.left, height - 3);
}

function drawMotorSpeedChart() {
  const canvas = ui.motorSpeedChart;
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
  const margin = { left: 42, right: 10, top: 20, bottom: 24 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  const records = sensorHistory.slice(-CHART_POINTS);
  const samples = records.filter((record) => record.record_type === "SAMPLE");
  context.font = "10px ui-monospace, Consolas, monospace";
  if (!samples.length) {
    context.fillStyle = "#70869a";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("连接后显示左右编码器返回值", margin.left + chartWidth / 2, margin.top + chartHeight / 2);
    return;
  }
  const values = samples.flatMap((record) => [numberValue(record.enc_left), numberValue(record.enc_right)])
    .filter((value) => Number.isFinite(value) && value >= 0);
  const yMax = Math.max(10, Math.ceil(Math.max(...values, 0) / 10) * 10);
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (let index = 0; index <= 4; index += 1) {
    const value = yMax * index / 4;
    const y = margin.top + chartHeight - index * chartHeight / 4;
    context.strokeStyle = "rgba(145, 167, 187, .14)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(margin.left, y);
    context.lineTo(width - margin.right, y);
    context.stroke();
    context.fillStyle = "#70869a";
    context.fillText(value.toFixed(value < 10 ? 1 : 0), margin.left - 6, y);
  }
  const firstTime = numberValue(records[0].elapsed_ms) || 0;
  const lastTime = numberValue(records.at(-1).elapsed_ms) || firstTime + samples.length;
  const timeSpan = Math.max(1, lastTime - firstTime);
  const xFor = (record) => margin.left + ((numberValue(record.elapsed_ms) || firstTime) - firstTime) * chartWidth / timeSpan;
  for (const item of [{ key: "enc_left", color: "#43d5ff" }, { key: "enc_right", color: "#ffbd66" }]) {
    context.strokeStyle = item.color;
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.beginPath();
    let started = false;
    samples.forEach((record) => {
      const value = numberValue(record[item.key]);
      if (!Number.isFinite(value)) return;
      const x = xFor(record);
      const y = margin.top + chartHeight - Math.max(0, value) / yMax * chartHeight;
      if (!started) { context.moveTo(x, y); started = true; }
      else context.lineTo(x, y);
    });
    context.stroke();
  }
  context.fillStyle = "#70869a";
  context.textAlign = "left";
  context.textBaseline = "top";
  context.fillText("边沿 / 20 ms", margin.left, 4);
  context.textBaseline = "bottom";
  context.fillText(`最近 ${samples.length} 条`, margin.left, height - 3);
}

function updateCaptureStatus() {
  const samples = sensorHistory.filter((record) => record.record_type === "SAMPLE").length;
  const events = sensorHistory.length - samples;
  ui.captureStatus.textContent = `第 ${sessionNumber} 组 · ${samples} 条${events ? ` · 事件 ${events}` : ""} · ${sceneLabel()}`;
  ui.copyCsvButton.disabled = sensorHistory.length === 0;
  ui.exportCsvButton.disabled = sensorHistory.length === 0;
  drawSensorChart();
  drawMotorSpeedChart();
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csvColumns = [
  ["本地时间", "local_time"], ["UTC时间", "time_iso"], ["组号", "session"], ["经过毫秒", "elapsed_ms"],
  ["场景", "scene"], ["备注", "note"], ["记录类型", "record_type"], ["事件", "event_label"], ["device_ms", "device_ms"],
  ["模式", "mode"], ["电池ADC_PA27", "battery_raw"], ["电池电压V", "battery_v"],
  ["左横_PA26", "lt_raw"], ["左竖_PA25", "ll_raw"], ["右竖_PB19", "rl_raw"], ["右横_PB18", "rt_raw"],
  ["左横相对值", "lt_pct"], ["左竖相对值", "ll_pct"], ["右竖相对值", "rl_pct"], ["右横相对值", "rt_pct"],
  ["误差x100", "error_x100"], ["十字", "cross"], ["线路状态", "state"],
  ["左目标x100", "target_left_x100"], ["右目标x100", "target_right_x100"],
  ["左边沿20ms", "enc_left"], ["右边沿20ms", "enc_right"], ["左RPM", "rpm_left"], ["右RPM", "rpm_right"],
  ["左PWM", "pwm_left"], ["右PWM", "pwm_right"], ["修正x100", "correction_x100"],
  ["左累计", "total_left"], ["右累计", "total_right"], ["编码器故障", "fault"]
];

function historyTable(separator = ",") {
  const encode = separator === "," ? csvCell : (value) => String(value ?? "").replace(/[\t\r\n]+/g, " ");
  return [
    csvColumns.map(([label]) => encode(label)).join(separator),
    ...sensorHistory.map((record) => csvColumns.map(([, key]) => encode(record[key])).join(separator))
  ].join("\r\n");
}

function downloadText(fileName, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}

function fileTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function exportCsv() {
  if (!sensorHistory.length) return;
  downloadText(`MSPM0赛车-第${String(sessionNumber).padStart(2, "0")}组-${fileTimestamp()}.csv`, `\ufeff${historyTable()}`);
  setMessage(`已导出 ${sensorHistory.length} 条记录`);
}

async function copyHistory() {
  if (!sensorHistory.length) return;
  try {
    await navigator.clipboard.writeText(historyTable("\t"));
    setMessage(`已复制 ${sensorHistory.length} 条，可直接粘贴到表格`);
  } catch {
    setMessage("浏览器不能直接复制，请使用导出 CSV", true);
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(cell); cell = ""; }
    else if (character === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += character;
  }
  if (cell.length || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

function firstValue(object, aliases) {
  for (const alias of aliases) {
    if (object[alias] !== undefined && object[alias] !== "") return object[alias];
  }
  return "";
}

function importCsv(text, fileName) {
  const rows = parseCsv(text.replace(/^\ufeff/, ""));
  if (rows.length < 2) throw new Error("CSV 没有数据行");
  const headers = rows[0].map((value) => value.trim());
  const imported = [];
  rows.slice(1).forEach((values, index) => {
    const source = Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ""]));
    const lt = firstValue(source, ["左横_PA26", "左横_PA4", "lt_raw", "left_horizontal"]);
    const ll = firstValue(source, ["左竖_PA25", "左竖_PA5", "ll_raw", "left_vertical"]);
    const rt = firstValue(source, ["右横_PB18", "右横_PB1", "rt_raw", "right_horizontal"]);
    const rl = firstValue(source, ["右竖_PB19", "右竖_PB0", "rl_raw", "right_vertical"]);
    if (![lt, ll, rt, rl].every((value) => Number.isFinite(numberValue(value)))) return;
    const elapsed = numberValue(firstValue(source, ["经过毫秒", "elapsed_ms"]));
    imported.push({
      record_type: firstValue(source, ["记录类型", "record_type"]) || "SAMPLE",
      event: firstValue(source, ["event"]),
      event_label: firstValue(source, ["事件", "event_label"]),
      time_iso: firstValue(source, ["UTC时间", "time_iso", "time"]),
      local_time: firstValue(source, ["本地时间", "local_time"]),
      time_ms: Date.now() + index * 50,
      elapsed_ms: Number.isFinite(elapsed) ? elapsed : index * 50,
      session: firstValue(source, ["组号", "session"]),
      scene: firstValue(source, ["场景", "scene", "scene_label"]) || "CSV 回放",
      note: firstValue(source, ["备注", "note"]),
      device_ms: firstValue(source, ["device_ms"]),
      mode: firstValue(source, ["模式", "mode"]),
      battery_raw: firstValue(source, ["电池ADC_PA27", "battery_raw"]),
      battery_v: firstValue(source, ["电池电压V", "battery_v"]),
      lt_raw: lt, ll_raw: ll, rt_raw: rt, rl_raw: rl,
      lt_pct: firstValue(source, ["左横相对值", "lt_pct", "left_horizontal_pct"]),
      ll_pct: firstValue(source, ["左竖相对值", "ll_pct", "left_vertical_pct"]),
      rt_pct: firstValue(source, ["右横相对值", "rt_pct", "right_horizontal_pct"]),
      rl_pct: firstValue(source, ["右竖相对值", "rl_pct", "right_vertical_pct"]),
      error_x100: firstValue(source, ["误差x100", "error_x100", "line_error_x100"]),
      cross: firstValue(source, ["十字", "cross"]),
      state: firstValue(source, ["线路状态", "state", "track_state"]),
      target_left_x100: firstValue(source, ["左目标x100", "target_left_x100"]),
      target_right_x100: firstValue(source, ["右目标x100", "target_right_x100"]),
      enc_left: firstValue(source, ["左边沿20ms", "enc_left"]),
      enc_right: firstValue(source, ["右边沿20ms", "enc_right"]),
      rpm_left: firstValue(source, ["左RPM", "rpm_left"]),
      rpm_right: firstValue(source, ["右RPM", "rpm_right"]),
      pwm_left: firstValue(source, ["左PWM", "pwm_left"]),
      pwm_right: firstValue(source, ["右PWM", "pwm_right"]),
      correction_x100: firstValue(source, ["修正x100", "correction_x100"]),
      total_left: firstValue(source, ["左累计", "total_left"]),
      total_right: firstValue(source, ["右累计", "total_right"]),
      fault: firstValue(source, ["编码器故障", "fault"])
    });
  });
  if (!imported.length) throw new Error("没有找到可识别的四路传感器列");
  sensorHistory = imported.slice(-HISTORY_LIMIT);
  sessionNumber += 1;
  sessionStartedAt = Date.now();
  updateCaptureStatus();
  setMessage(`已读取 ${fileName}：${imported.length} 条四路数据`);
}

function startNewSession() {
  sensorHistory = [];
  rpmLeftHistory.length = 0;
  rpmRightHistory.length = 0;
  sessionNumber += 1;
  sessionStartedAt = Date.now();
  updateCaptureStatus();
  setMessage(`已开始第 ${sessionNumber} 组：${sceneLabel()}`);
}

ui.connectButton.addEventListener("click", connectSerial);
ui.disconnectButton.addEventListener("click", disconnectSerial);
ui.motorStopButton.addEventListener("click", stopOrClearFault);
document.querySelectorAll(".tab-button").forEach((button) => button.addEventListener("click", () => selectTab(button.dataset.tab)));

function updateControlSummary() {
  if (selectedRunMode === "track") {
    ui.selectedControlSummary.textContent = `循迹 · 目标 ${selectedTrackSpeed / 100} 边沿/20 ms`;
  } else if (selectedTestControl === "speed") {
    ui.selectedControlSummary.textContent = `双轮闭环 · GEAR ${selectedMotorGear} · 目标 ${gearTargets[selectedMotorGear]}`;
  } else {
    const percent = Number(ui.powerRange.value);
    ui.selectedControlSummary.textContent = `架空开环 · ${percent}% · PWM ${Math.round(percent * PWM_MAX / 100)}`;
  }
}

function selectRunMode(mode) {
  selectedRunMode = mode;
  document.querySelectorAll("#runModeSwitch .mode-button").forEach((button) => button.classList.toggle("selected", button.dataset.mode === mode));
  document.querySelectorAll("[data-mode-panel]").forEach((panel) => { panel.hidden = panel.dataset.modePanel !== mode; });
  updateControlSummary();
}

document.querySelectorAll("#runModeSwitch .mode-button").forEach((button) => button.addEventListener("click", () => selectRunMode(button.dataset.mode)));

function selectTestControl(control) {
  selectedTestControl = control;
  document.querySelectorAll("#speedControlSwitch .test-type-button").forEach((button) => button.classList.toggle("selected", button.dataset.control === control));
  document.querySelectorAll("[data-control-panel]").forEach((panel) => { panel.hidden = panel.dataset.controlPanel !== control; });
  updateControlSummary();
}

document.querySelectorAll("#speedControlSwitch .test-type-button").forEach((button) => button.addEventListener("click", () => selectTestControl(button.dataset.control)));

document.querySelectorAll("#trackGears button").forEach((button) => button.addEventListener("click", () => {
  selectedTrackSpeed = Number(button.dataset.speed);
  document.querySelectorAll("#trackGears button").forEach((item) => item.classList.toggle("selected", item === button));
  updateControlSummary();
}));

document.querySelectorAll("#motorGears button").forEach((button) => button.addEventListener("click", () => {
  selectedMotorGear = Number(button.dataset.gear);
  document.querySelectorAll("#motorGears button").forEach((item) => item.classList.toggle("selected", item === button));
  updateControlSummary();
}));
function updatePowerOutput() {
  const percent = Number(ui.powerRange.value);
  ui.powerOutput.textContent = `${percent}% · PWM ${Math.round(percent * PWM_MAX / 100)}`;
  updateControlSummary();
}
ui.powerRange.addEventListener("input", updatePowerOutput);
ui.motorStartButton.addEventListener("click", () => {
  if (selectedRunMode === "track") {
    if (armMotion(`TRACK ${selectedTrackSpeed}`, "track", `已启动循迹：${selectedTrackSpeed / 100} 边沿/20 ms`)) addHistoryEvent("START");
    return;
  }
  if (selectedTestControl === "speed") {
    armMotion(`GEAR ${selectedMotorGear}`, "speed", `双轮闭环测速已启动：GEAR ${selectedMotorGear}`);
    return;
  }
  const pwm = Math.round(Number(ui.powerRange.value) * PWM_MAX / 100);
  if (pwm <= 0) {
    setMessage("PWM 为 0，没有启动电机", true);
    return;
  }
  armMotion(`PWM ${pwm} ${pwm}`, "pwm", `架空 PWM 测试已启动：${pwm}/${PWM_MAX}`);
});

ui.newSessionButton.addEventListener("click", startNewSession);
ui.exportCsvButton.addEventListener("click", exportCsv);
ui.copyCsvButton.addEventListener("click", copyHistory);
ui.readCsvButton.addEventListener("click", () => ui.csvFileInput.click());
ui.csvFileInput.addEventListener("change", async () => {
  const file = ui.csvFileInput.files?.[0];
  if (!file) return;
  try { importCsv(await file.text(), file.name); }
  catch (error) { setMessage(`读取 CSV 失败：${error.message}`, true); }
  finally { ui.csvFileInput.value = ""; }
});
window.addEventListener("resize", () => {
  drawSensorChart();
  drawMotorSpeedChart();
});
navigator.serial?.addEventListener("disconnect", disconnectSerial);
document.addEventListener("visibilitychange", () => {
  if (document.hidden && activeRepeatCommand) safetyStop("页面进入后台");
});
window.addEventListener("beforeunload", () => {
  activeRepeatCommand = "";
  if (port?.writable) send("STOP", false);
});
setInterval(() => {
  if (!activeRepeatCommand) return;
  if ((Date.now() - lastTelemetryAt) > TELEMETRY_TIMEOUT_MS) {
    setTelemetryState(`已中断，连续 ${TELEMETRY_TIMEOUT_MS} ms 无完整数据`, false);
    safetyStop(`连续 ${TELEMETRY_TIMEOUT_MS} ms（约 5 帧）没有收到完整遥测`);
    return;
  }
  send(activeRepeatCommand, false);
}, MOTION_HEARTBEAT_MS);

setConnected(false);
setTelemetryState("尚未连接", false);
updateCaptureStatus();
updatePowerOutput();
