"use strict";

const BAUD_RATE = 57600;
const CONTROL_PERIOD_MS = 20;
const PWM_MAX = 2133;
const ADC_MAX = 4095;
const HISTORY_LIMIT = 2000;
const CHART_POINTS = 800;
const HALL_EDGES_PER_OUTPUT_REV = 13 * 20.409 * 2;
const PROFILE_STORAGE_KEY = "mspm0-racer-gear-profiles-v8-g3-tuned";
const DEFAULT_GEAR_PROFILES = [
  null,
  { target: 100, speedKp: 4, speedKi: 0, trackKp: 1.75, trackKd: 1.20 },
  { target: 90, speedKp: 4, speedKi: 0, trackKp: 1.58, trackKd: 1.20 },
  { target: 80, speedKp: 4, speedKi: 0, trackKp: 0.85, trackKd: 3.50 },
  { target: 70, speedKp: 4, speedKi: 0, trackKp: 0.60, trackKd: 2.00 },
  { target: 60, speedKp: 4, speedKi: 0, trackKp: 0.55, trackKd: 2.00 },
  { target: 50, speedKp: 4, speedKi: 0, trackKp: 0.55, trackKd: 1.20 },
  { target: 40, speedKp: 4, speedKi: 0, trackKp: 0.70, trackKd: 1.20 }
];
const sensorRanges = {
  lt: [700, 2100],
  ll: [0, 3570],
  rt: [500, 1400],
  rl: [0, 3570]
};

const ui = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]));
let port;
let reader;
let keepReading = false;
let writeChain = Promise.resolve();
let lineBuffer = "";
let isConnected = false;
let telemetryReady = false;
let selectedRunMode = "track";
let selectedTestControl = "pwm";
let runningMode = "";
let selectedGear = 7;
let gearProfiles = loadGearProfiles();
let profileDirty = false;
let profileReadPending = false;
let pendingProfileGear = 0;
let buildInfoConfirmed = false;
let sessionNumber = 1;
let sessionStartedAt = Date.now();
let sensorHistory = [];
const rpmLeftHistory = [];
const rpmRightHistory = [];

function setMessage(text, error = false) {
  ui.message.textContent = text;
  ui.message.classList.toggle("error", error);
}

function profileIsValid(profile) {
  return profile && Number.isFinite(profile.target) && profile.target >= 40 && profile.target <= 150 &&
    Number.isFinite(profile.speedKp) && profile.speedKp >= 0 && profile.speedKp <= 20 &&
    Number.isFinite(profile.speedKi) && profile.speedKi >= 0 && profile.speedKi <= 2 &&
    Number.isFinite(profile.trackKp) && profile.trackKp >= 0 && profile.trackKp <= 2 &&
    Number.isFinite(profile.trackKd) && profile.trackKd >= 0 && profile.trackKd <= 5;
}

function cloneDefaultProfiles() {
  return DEFAULT_GEAR_PROFILES.map((profile) => profile ? { ...profile } : null);
}

function loadGearProfiles() {
  try {
    const stored = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY));
    if (Array.isArray(stored) && stored.length === 8 && stored.slice(1).every(profileIsValid)) {
      return stored.map((profile) => profile ? { ...profile } : null);
    }
  } catch (_) { }
  return cloneDefaultProfiles();
}

function persistGearProfiles() {
  try { localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(gearProfiles)); }
  catch (_) { setMessage("浏览器无法保存 PID 档案，本次页面关闭后参数会丢失", true); }
}

function setProfileState(text, dirty = false) {
  ui.profileState.textContent = text;
  ui.profileState.classList.toggle("dirty", dirty);
}

function profileCommand(gear) {
  const profile = gearProfiles[gear];
  return `PROFILE ${gear} ${Math.round(profile.target * 100)} ${Math.round(profile.speedKp * 100)} ${Math.round(profile.speedKi * 100)} ${Math.round(profile.trackKp * 100)} ${Math.round(profile.trackKd * 100)}`;
}

function renderGearButtons() {
  [ui.trackGears, ui.motorGears].forEach((container) => {
    container.replaceChildren();
    for (let gear = 1; gear <= 7; gear += 1) {
      const button = document.createElement("button");
      const name = document.createElement("strong");
      const speed = document.createElement("small");
      button.type = "button";
      button.dataset.gear = String(gear);
      button.classList.toggle("selected", gear === selectedGear);
      name.textContent = `G${gear}`;
      speed.textContent = `${gearProfiles[gear].target}`;
      button.append(name, speed);
      button.addEventListener("click", () => selectGear(gear));
      container.append(button);
    }
  });
  ui.profileTitle.textContent = `G${selectedGear} 独立 PID 档案`;
  ui.saveProfileButton.textContent = `保存 G${selectedGear} 并同步`;
  updateControlSummary();
}

function loadSelectedProfileInputs() {
  const profile = gearProfiles[selectedGear];
  ui.profileTarget.value = profile.target;
  ui.profileSpeedKp.value = profile.speedKp;
  ui.profileSpeedKi.value = profile.speedKi;
  ui.profileTrackKp.value = profile.trackKp;
  ui.profileTrackKd.value = profile.trackKd;
  profileDirty = false;
  setProfileState(`G${selectedGear} 已保存；${isConnected ? "已准备同步到固件" : "连接后自动同步到固件"}`);
}

function selectGear(gear) {
  if (gear === selectedGear) return;
  if (profileDirty && !window.confirm(`G${selectedGear} 有未保存修改，放弃并切换到 G${gear}？`)) return;
  selectedGear = gear;
  renderGearButtons();
  loadSelectedProfileInputs();
}

function profileFromInputs() {
  const profile = {
    target: numberValue(ui.profileTarget.value),
    speedKp: numberValue(ui.profileSpeedKp.value),
    speedKi: numberValue(ui.profileSpeedKi.value),
    trackKp: numberValue(ui.profileTrackKp.value),
    trackKd: numberValue(ui.profileTrackKd.value)
  };
  return profileIsValid(profile) ? profile : null;
}

async function saveSelectedProfile() {
  if (runningMode) {
    setProfileState(`G${selectedGear} 未保存：请先停车`, true);
    setMessage("请先停车，再修改 PID 档案", true);
    return;
  }
  const profile = profileFromInputs();
  if (!profile) {
    setProfileState(`G${selectedGear} 未保存：请检查输入范围`, true);
    setMessage("档案参数超出范围：目标 40–150、速度 P 0–20、速度 I 0–2、循迹 P 0–2、循迹 D 0–5", true);
    return;
  }
  if ((selectedGear > 1 && profile.target > gearProfiles[selectedGear - 1].target) ||
      (selectedGear < 7 && profile.target < gearProfiles[selectedGear + 1].target)) {
    setProfileState(`G${selectedGear} 未保存：目标轮速顺序不正确`, true);
    setMessage("轮速必须保持 G1 最高、依次降低到 G7", true);
    return;
  }
  gearProfiles[selectedGear] = profile;
  persistGearProfiles();
  profileDirty = false;
  renderGearButtons();
  if (isConnected) {
    const gearBeingSaved = selectedGear;
    pendingProfileGear = gearBeingSaved;
    setProfileState(`G${gearBeingSaved} 已保存到浏览器，正在同步固件…`);
    await send(profileCommand(gearBeingSaved), false);
  } else {
    setProfileState(`G${selectedGear} 已保存到本浏览器；连接后自动同步`);
  }
  setMessage(`G${selectedGear} 参数已保存`);
}

function applyFirmwareProfile(line) {
  const values = parseTelemetryValues(line);
  const gear = numberValue(values.gear);
  const profile = {
    target: numberValue(values.speed) / 100,
    speedKp: numberValue(values.skp) / 100,
    speedKi: numberValue(values.ski) / 100,
    trackKp: numberValue(values.tkp) / 100,
    trackKd: numberValue(values.tkd) / 100
  };
  if (!Number.isInteger(gear) || gear < 1 || gear > 7 || !profileIsValid(profile)) {
    addLog(`< 无法解析档案：${line}`);
    return;
  }
  const confirmedPendingSave = gear === pendingProfileGear;
  gearProfiles[gear] = profile;
  persistGearProfiles();
  renderGearButtons();
  if (gear === selectedGear && !profileDirty) loadSelectedProfileInputs();
  if (confirmedPendingSave) {
    pendingProfileGear = 0;
    if (gear === selectedGear) setProfileState(`G${gear} 已保存并由固件确认`);
    setMessage(`G${gear} 参数已保存并同步`);
  }
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
  }
  updateMotorStartAvailability();
}

function updateMotorStartAvailability() {
  ui.motorStartButton.disabled = !isConnected;
  if (!isConnected) ui.motorStartButton.textContent = "先连接 BT04-A";
  else ui.motorStartButton.textContent = selectedRunMode === "track" ? "▶ 启动循迹" : "▶ 启动测试";
  ui.motorStopButton.textContent = "■ 立即停车";
}

function setTelemetryState(text, ready) {
  telemetryReady = ready;
  ui.telemetryState.textContent = `数据：${text}`;
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
    addLog(`发送失败：${error.message}`);
    setMessage(`发送失败：${error.message}`, true);
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
    gear: v.gear ?? "",
    speed_kp: Number.isFinite(numberValue(v.skp)) ? numberValue(v.skp) / 100 : "",
    speed_ki: Number.isFinite(numberValue(v.ski)) ? numberValue(v.ski) / 100 : "",
    track_kp: Number.isFinite(numberValue(v.tkp)) ? numberValue(v.tkp) / 100 : "",
    track_kd: Number.isFinite(numberValue(v.tkd)) ? numberValue(v.tkd) / 100 : "",
    battery_raw: v.bat ?? "",
    battery_v: Number.isFinite(derived.batteryV) ? derived.batteryV : "",
    lt_raw: v.lt ?? "",
    ll_raw: v.ll ?? "",
    rl_raw: v.rl ?? "",
    rt_raw: v.rt ?? "",
    calibrate_left: v.calL ?? "",
    calibrate_right: v.calR ?? "",
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
    total_right: v.totalR ?? ""
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
  setTelemetryState("正在接收 · 50 ms", true);
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
  if (v.mode === "STOP") runningMode = "";

  if (line.startsWith("T ")) captureTelemetry(v, derived);
  return true;
}

function handleLine(line) {
  if (!line) return;
  if (line.startsWith("ERR PROFILE")) {
    const gear = pendingProfileGear;
    pendingProfileGear = 0;
    if (gear) setProfileState(`G${gear} 已保存到浏览器，但固件拒绝同步`, true);
    setMessage(`档案同步失败：${line}`, true);
    addLog(`< ${line}`);
    return;
  }
  if (line.startsWith("PROFILE ")) {
    applyFirmwareProfile(line);
    addLog(`< ${line}`);
    return;
  }
  if (line === "OK PROFILES") {
    profileReadPending = false;
    setProfileState("7 档参数已由固件返回并保存到本浏览器");
    addLog(`< ${line}`);
    return;
  }
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
  if (line.includes("track_lost")) {
    runningMode = "";
    setMessage("循迹已因丢线停车", true);
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
    runningMode = "";
    setTelemetryState("等待传感器数据", false);
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
      if ((port === connectedPort) && ui.firmwareBuildBadge.textContent.includes("正在读取")) {
        ui.firmwareBuildBadge.textContent = "固件编译：未返回（不影响启动）";
      }
    }, 1200);
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    await send("TELEM 50", false);
  } catch (error) {
    port = undefined;
    setConnected(false);
    setMessage(`连接失败：${error.message}`, true);
  }
}

async function disconnectSerial() {
  runningMode = "";
  if (!port) return;
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
  runningMode = "";
  send("STOP");
  if (wasTracking) addHistoryEvent("END");
}

function armMotion(command, mode, message) {
  runningMode = mode;
  send(command);
  setMessage(message);
  return true;
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
  ["模式", "mode"], ["档位", "gear"], ["速度P", "speed_kp"], ["速度I", "speed_ki"],
  ["循迹P", "track_kp"], ["循迹D", "track_kd"],
  ["电池ADC_PA27", "battery_raw"], ["电池电压V", "battery_v"],
  ["左横_PA26", "lt_raw"], ["左竖_PA25", "ll_raw"], ["右竖_PB19", "rl_raw"], ["右横_PB18", "rt_raw"],
  ["启动标定左横", "calibrate_left"], ["启动标定右横", "calibrate_right"],
  ["左横相对值", "lt_pct"], ["左竖相对值", "ll_pct"], ["右竖相对值", "rl_pct"], ["右横相对值", "rt_pct"],
  ["误差x100", "error_x100"], ["十字", "cross"], ["线路状态", "state"],
  ["左目标x100", "target_left_x100"], ["右目标x100", "target_right_x100"],
  ["左边沿20ms", "enc_left"], ["右边沿20ms", "enc_right"], ["左RPM", "rpm_left"], ["右RPM", "rpm_right"],
  ["左PWM", "pwm_left"], ["右PWM", "pwm_right"], ["修正x100", "correction_x100"],
  ["左累计", "total_left"], ["右累计", "total_right"]
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
      calibrate_left: firstValue(source, ["启动标定左横", "calibrate_left"]),
      calibrate_right: firstValue(source, ["启动标定右横", "calibrate_right"]),
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
      total_right: firstValue(source, ["右累计", "total_right"])
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
ui.motorStopButton.addEventListener("click", stopCar);

function updateControlSummary() {
  const target = gearProfiles[selectedGear].target;
  if (selectedRunMode === "track") {
    ui.selectedControlSummary.textContent = `循迹 · G${selectedGear} · 目标 ${target} 边沿/20 ms`;
  } else if (selectedTestControl === "speed") {
    ui.selectedControlSummary.textContent = `双轮闭环 · G${selectedGear} · 目标 ${target} 边沿/20 ms`;
  } else {
    const percent = Number(ui.powerRange.value);
    ui.selectedControlSummary.textContent = `架空开环 · ${percent}% · PWM ${Math.round(percent * PWM_MAX / 100)}`;
  }
}

function selectRunMode(mode) {
  selectedRunMode = mode;
  document.querySelectorAll("#runModeSwitch .mode-button").forEach((button) => button.classList.toggle("selected", button.dataset.mode === mode));
  document.querySelectorAll("[data-mode-panel]").forEach((panel) => { panel.hidden = panel.dataset.modePanel !== mode; });
  selectTab(mode === "track" ? "sensor" : "motor");
  updateControlSummary();
  updateMotorStartAvailability();
}

document.querySelectorAll("#runModeSwitch .mode-button").forEach((button) => button.addEventListener("click", () => selectRunMode(button.dataset.mode)));

function selectTestControl(control) {
  selectedTestControl = control;
  document.querySelectorAll("#speedControlSwitch .test-type-button").forEach((button) => button.classList.toggle("selected", button.dataset.control === control));
  document.querySelectorAll("[data-control-panel]").forEach((panel) => { panel.hidden = panel.dataset.controlPanel !== control; });
  updateControlSummary();
}

document.querySelectorAll("#speedControlSwitch .test-type-button").forEach((button) => button.addEventListener("click", () => selectTestControl(button.dataset.control)));

function updatePowerOutput() {
  const percent = Number(ui.powerRange.value);
  ui.powerOutput.textContent = `${percent}% · PWM ${Math.round(percent * PWM_MAX / 100)}`;
  updateControlSummary();
}
ui.powerRange.addEventListener("input", updatePowerOutput);
ui.motorStartButton.addEventListener("click", async () => {
  if (selectedRunMode === "track") {
    await send(profileCommand(selectedGear), false);
    if (armMotion(`TRACK ${selectedGear}`, "track", `已启动循迹：G${selectedGear}，目标 ${gearProfiles[selectedGear].target} 边沿/20 ms`)) addHistoryEvent("START");
    return;
  }
  if (selectedTestControl === "speed") {
    await send(profileCommand(selectedGear), false);
    armMotion(`GEAR ${selectedGear}`, "speed", `双轮闭环测速已启动：G${selectedGear}`);
    return;
  }
  const pwm = Math.round(Number(ui.powerRange.value) * PWM_MAX / 100);
  if (pwm <= 0) {
    setMessage("PWM 为 0，没有启动电机", true);
    return;
  }
  armMotion(`PWM ${pwm} ${pwm}`, "pwm", `架空 PWM 测试已启动：${pwm}/${PWM_MAX}`);
});

[ui.profileTarget, ui.profileSpeedKp, ui.profileSpeedKi, ui.profileTrackKp, ui.profileTrackKd].forEach((input) => {
  input.addEventListener("input", () => {
    profileDirty = true;
    setProfileState(`G${selectedGear} 有未保存修改`, true);
  });
});
ui.saveProfileButton.addEventListener("click", saveSelectedProfile);
ui.readProfilesButton.addEventListener("click", () => {
  if (!isConnected) {
    gearProfiles = loadGearProfiles();
    renderGearButtons();
    loadSelectedProfileInputs();
    setMessage("已读取本浏览器保存的 7 档参数");
    return;
  }
  if (runningMode) {
    setMessage("请先停车，再读取或修改 PID 档案", true);
    return;
  }
  profileReadPending = true;
  setProfileState("正在读取固件中的 7 档参数…");
  send("PROFILES", false);
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
setConnected(false);
setTelemetryState("尚未连接", false);
renderGearButtons();
loadSelectedProfileInputs();
updateCaptureStatus();
updatePowerOutput();
