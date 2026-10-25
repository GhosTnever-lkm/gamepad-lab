import {
  APP_VERSION,
  buildDiagnosticReport,
  createCalibration,
  finishCalibration,
  normalizeGamepadSnapshot,
  summarizeGamepads,
  updateCalibration,
} from './gamepad-core.js?v=1.0.4';

const $ = selector => document.querySelector(selector);
const els = {
  scan: $('#scan-button'), emptyScan: $('#empty-scan'), empty: $('#empty-state'), panel: $('#device-panel'),
  badge: $('#connection-badge'), label: $('#connection-label'), api: $('#api-support'),
  name: $('#device-name'), index: $('#device-index'), mapping: $('#device-mapping'), mappingTag: $('#mapping-tag'),
  buttonsCount: $('#button-count'), axesCount: $('#axis-count'), power: $('#device-power'), warning: $('#device-warning'),
  sticks: $('#stick-grid'), buttons: $('#button-grid'), pressed: $('#pressed-count'),
  triggerLeft: $('#trigger-left-value'), triggerRight: $('#trigger-right-value'),
  triggerLeftBar: $('#trigger-left-bar'), triggerRightBar: $('#trigger-right-bar'),
  deadzone: $('#deadzone-slider'), deadzoneValue: $('#deadzone-value'),
  calibrate: $('#calibrate-button'), cancelCalibration: $('#cancel-calibration'),
  calibrationState: $('#calibration-status'), calibrationProgress: $('#calibration-progress'),
  calibrationNote: $('#calibration-note'), drift: $('#drift-readings'),
  activity: $('#activity-list'), clearActivity: $('#clear-activity'), export: $('#export-button'), toast: $('#toast'),
};

const state = {
  running: false, frame: 0, previous: null, activeIndex: null, snapshot: null,
  calibration: null, calibrationStart: 0, activityAt: 0, activity: [],
  deadzone: Number(els.deadzone.value), toastTimer: 0,
};

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

function getPads() {
  if (!('getGamepads' in navigator)) return [];
  try { return Array.from(navigator.getGamepads() || []); }
  catch { return []; }
}

function setConnected(snapshot) {
  state.snapshot = snapshot;
  state.activeIndex = snapshot.index;
  els.empty.hidden = true;
  els.panel.hidden = false;
  els.badge.dataset.state = snapshot.connected ? 'connected' : 'waiting';
  els.label.textContent = snapshot.connected ? 'DEVICE CONNECTED' : 'WAITING FOR DEVICE';
  els.name.textContent = snapshot.id || `Controller ${snapshot.index + 1}`;
  els.index.textContent = `#${snapshot.index}`;
  els.mapping.textContent = snapshot.mapping || 'not reported';
  els.mappingTag.textContent = snapshot.mapping ? snapshot.mapping.toUpperCase() : 'UNMAPPED';
  els.buttonsCount.textContent = String(snapshot.buttons.length);
  els.axesCount.textContent = String(snapshot.axes.length);
  els.power.textContent = 'Not exposed';
  els.warning.hidden = snapshot.warnings.length === 0;
  els.warning.textContent = snapshot.warnings.map(item => item.replaceAll('-', ' ')).join(' · ');
  renderSticks(snapshot);
  renderButtons(snapshot);
}

function renderSticks(snapshot) {
  const pairs = [];
  for (let i = 0; i < snapshot.axes.length; i += 2) {
    pairs.push(snapshot.axes.slice(i, i + 2));
  }
  const names = ['LEFT STICK', 'RIGHT STICK', 'AUX STICK', 'AUX STICK'];
  els.sticks.replaceChildren();
  pairs.forEach((pair, pairIndex) => {
    const x = pair[0]?.filtered ?? 0;
    const y = pair[1]?.filtered ?? 0;
    const rawX = pair[0]?.raw ?? 0;
    const rawY = pair[1]?.raw ?? 0;
    const card = document.createElement('div');
    card.className = 'stick-card';
    card.innerHTML = `<div class="stick-card-head"><span></span><span>X ${rawX.toFixed(2)} · Y ${rawY.toFixed(2)}</span></div><div class="stick-visual" role="img" aria-label="Stick ${pairIndex + 1}: raw X ${rawX.toFixed(2)}, raw Y ${rawY.toFixed(2)}"><i class="stick-cross-x"></i><i class="stick-cross-y"></i><span class="stick-dot stick-dot-raw"></span><span class="stick-dot stick-dot-filtered"></span></div><div class="stick-values"><span>RAW <b>${rawX.toFixed(2)}, ${rawY.toFixed(2)}</b></span><span>FILTERED <b>${x.toFixed(2)}, ${y.toFixed(2)}</b></span></div>`;
    card.querySelector('.stick-card-head span').textContent = names[pairIndex] || `AXIS PAIR ${pairIndex + 1}`;
    const visual = card.querySelector('.stick-visual');
    for (const [selector, px, py] of [['.stick-dot-raw', rawX, rawY], ['.stick-dot-filtered', x, y]]) {
      const dot = card.querySelector(selector);
      dot.style.left = `${50 + clamp(px, -1, 1) * 40}%`;
      dot.style.top = `${50 - clamp(py, -1, 1) * 40}%`;
    }
    els.sticks.append(card);
  });
  if (!pairs.length) els.sticks.innerHTML = '<p class="activity-empty">No analog axes were reported by this device.</p>';
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function renderButtons(snapshot) {
  els.buttons.replaceChildren();
  snapshot.buttons.forEach(button => {
    const item = document.createElement('div');
    item.className = `button-cell${button.pressed ? ' is-pressed' : ''}`;
    item.setAttribute('aria-label', `Button ${button.index + 1}, ${button.pressed ? 'pressed' : 'released'}, value ${button.value.toFixed(2)}`);
    item.innerHTML = `<span>${String(button.index + 1).padStart(2, '0')}</span><i style="--pressure:${button.value}"></i>`;
    els.buttons.append(item);
  });
  const pressed = snapshot.buttons.filter(button => button.pressed).length;
  els.pressed.textContent = `${pressed} PRESSED`;
  const left = snapshot.buttons[6]?.value ?? 0;
  const right = snapshot.buttons[7]?.value ?? 0;
  els.triggerLeft.textContent = left.toFixed(2);
  els.triggerRight.textContent = right.toFixed(2);
  els.triggerLeftBar.style.width = `${left * 100}%`;
  els.triggerRightBar.style.width = `${right * 100}%`;
}

function addActivity(event) {
  const now = performance.now();
  if (event.type === 'axis' && now - state.activityAt < 180) return;
  state.activityAt = now;
  const labels = {
    connected: `Controller connected in slot ${event.index + 1}`,
    disconnected: `Controller disconnected from slot ${event.index + 1}`,
    button: `Button ${event.buttonIndex + 1} ${event.pressed ? 'pressed' : 'released'}`,
    axis: `Axis ${event.axisIndex + 1} moved to ${event.to.toFixed(2)}`,
  };
  const text = labels[event.type];
  if (!text) return;
  state.activity.unshift({ text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) });
  state.activity = state.activity.slice(0, 12);
  renderActivity();
}

function renderActivity() {
  els.activity.replaceChildren();
  if (!state.activity.length) {
    const empty = document.createElement('li');
    empty.className = 'activity-empty';
    empty.textContent = 'Button presses and stick movement will appear here.';
    els.activity.append(empty);
    return;
  }
  for (const entry of state.activity) {
    const item = document.createElement('li');
    item.innerHTML = `<span>${entry.text}</span><time>${entry.time}</time>`;
    els.activity.append(item);
  }
}

function updateCalibrationDisplay() {
  const calibration = state.calibration;
  if (!calibration) return;
  const duration = 3000;
  const progress = clamp(calibration.elapsedMs / duration, 0, 1);
  els.calibrationProgress.style.width = `${progress * 100}%`;
  if (calibration.state === 'collecting') {
    els.calibrationState.textContent = 'MEASURING';
    els.calibrationNote.textContent = `Keep the controller still · ${Math.max(0, (duration - calibration.elapsedMs) / 1000).toFixed(1)}s left · ${calibration.sampleCount} samples`;
    return;
  }
  els.cancelCalibration.hidden = true;
  els.calibrate.disabled = false;
  if (calibration.state === 'cancelled') {
    els.calibrationState.textContent = 'CANCELLED';
    els.calibrationNote.textContent = 'The controller disconnected. Reconnect it and start again.';
    return;
  }
  const result = finishCalibration(calibration);
  state.calibration = result;
  const enough = result.result?.facts?.sampleCount >= 24 && result.result?.facts?.elapsedMs >= 400;
  els.calibrationState.textContent = enough ? 'COMPLETE' : 'LIMITED DATA';
  const readings = result.result?.facts?.perAxis || [];
  const driftText = pairIndex => {
    const x = readings[pairIndex * 2];
    const y = readings[pairIndex * 2 + 1];
    return x ? `${x.mean.toFixed(3)} / ${(y?.mean ?? 0).toFixed(3)}` : '— / —';
  };
  els.drift.innerHTML = `<div><span>LEFT STICK MEAN X / Y</span><strong>${driftText(0)}</strong></div><div><span>RIGHT STICK MEAN X / Y</span><strong>${driftText(1)}</strong></div>`;
  els.calibrationNote.textContent = result.result?.recommendation || 'Measurement complete.';
}

function poll() {
  if (!state.running) return;
  const pads = getPads();
  const snapshots = pads.map(pad => pad ? normalizeGamepadSnapshot(pad, { deadzone: state.deadzone }) : null);
  const summary = summarizeGamepads(snapshots, state.previous);
  summary.events.forEach(addActivity);
  state.previous = summary;
  let selected = pads[state.activeIndex];
  if (!selected || selected.connected !== true) {
    const nextIndex = pads.findIndex(pad => pad?.connected === true);
    if (nextIndex >= 0) selected = pads[nextIndex];
  }
  if (selected?.connected === true) {
    const snapshot = normalizeGamepadSnapshot(selected, { deadzone: state.deadzone });
    setConnected(snapshot);
    if (state.calibration?.state === 'collecting') {
      const dt = Math.min(100, performance.now() - state.calibrationStart);
      state.calibrationStart = performance.now();
      state.calibration = updateCalibration(state.calibration, snapshot, dt);
      if (state.calibration.elapsedMs >= 3000) state.calibration = { ...state.calibration, state: 'ready' };
      updateCalibrationDisplay();
    }
  } else if (!state.snapshot) {
    els.badge.dataset.state = 'waiting';
    els.label.textContent = 'WAITING FOR DEVICE';
  } else if (state.snapshot.connected) {
    const disconnected = { ...state.snapshot, connected: false };
    setConnected(disconnected);
    if (state.calibration?.state === 'collecting') {
      state.calibration = updateCalibration(state.calibration, disconnected, 0);
      updateCalibrationDisplay();
    }
  }
  state.frame = requestAnimationFrame(poll);
}

function start() {
  if (!('getGamepads' in navigator)) {
    els.api.textContent = 'This browser does not expose the Gamepad API. Try a recent desktop browser over HTTPS or localhost.';
    showToast('Gamepad API is not available in this browser.');
    return;
  }
  state.running = true;
  state.previous = null;
  state.snapshot = null;
  els.api.textContent = 'Connect a controller, then press a button while this tab is focused.';
  cancelAnimationFrame(state.frame);
  state.frame = requestAnimationFrame(poll);
}

function stop() {
  state.running = false;
  cancelAnimationFrame(state.frame);
}

function downloadReport() {
  if (!state.snapshot) return showToast('Connect a controller first.');
  const report = buildDiagnosticReport(state.snapshot, state.calibration, { appVersion: APP_VERSION });
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'gamepad-lab-report.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Local JSON report downloaded.');
}

els.scan.addEventListener('click', start);
els.emptyScan.addEventListener('click', start);
els.deadzone.addEventListener('input', () => {
  state.deadzone = Number(els.deadzone.value);
  els.deadzoneValue.value = state.deadzone.toFixed(2);
  els.deadzoneValue.textContent = state.deadzone.toFixed(2);
  if (state.snapshot) setConnected(normalizeGamepadSnapshot(getPads()[state.activeIndex], { deadzone: state.deadzone }));
});
els.calibrate.addEventListener('click', () => {
  const pad = getPads()[state.activeIndex];
  if (!pad?.connected) return showToast('Connect a controller before calibration.');
  state.calibration = createCalibration(pad);
  state.calibrationStart = performance.now();
  state.calibration = { ...state.calibration, state: 'collecting' };
  els.calibrate.disabled = true;
  els.cancelCalibration.hidden = false;
  els.calibrationProgress.style.width = '0%';
  els.calibrationNote.textContent = 'Hold the controller still. Calibration uses local raw axis samples.';
});
els.cancelCalibration.addEventListener('click', () => {
  if (state.calibration) state.calibration = { ...state.calibration, state: 'cancelled', cancellationReason: 'user-cancelled' };
  updateCalibrationDisplay();
  els.calibrationState.textContent = 'CANCELLED';
  els.calibrationNote.textContent = 'Measurement cancelled.';
});
els.export.addEventListener('click', downloadReport);
els.clearActivity.addEventListener('click', () => { state.activity = []; renderActivity(); });
window.addEventListener('gamepadconnected', () => { if (!state.running) start(); });
window.addEventListener('gamepaddisconnected', event => {
  if (state.activeIndex === event.gamepad.index && state.calibration?.state === 'collecting') {
    state.calibration = { ...state.calibration, state: 'cancelled', cancellationReason: 'disconnected' };
    updateCalibrationDisplay();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelAnimationFrame(state.frame);
  else if (state.running) state.frame = requestAnimationFrame(poll);
});
window.addEventListener('pagehide', stop);

if (!('getGamepads' in navigator)) els.api.textContent = 'This browser does not support the Gamepad API.';
