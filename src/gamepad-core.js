/**
 * Pure, dependency-free Gamepad API normalization and diagnostics.
 * Raw values are kept separate from local filters; nothing is uploaded.
 */
export const SCHEMA_VERSION = '1.0.0';

const DEFAULT_DEADZONE = 0.12;
const MAX_DEADZONE = 0.4;
const CALIBRATION_LIMITS = Object.freeze({
  maxSamples: 512,
  maxDurationMs: 5000,
  minSamples: 24,
  minDurationMs: 400,
  motionThreshold: 0.2,
  driftThreshold: 0.08,
});
const LIMITATIONS = Object.freeze([
  'Some browsers expose controllers only after a user gesture.',
  'Controller state is sampled while this page is active; polling may pause in background tabs.',
  'Button and axis mapping depends on the browser and controller.',
  'The Gamepad API does not provide a stable serial number or unique hardware identity.',
]);

const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const safeText = (value, limit = 128) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit)
  : '';
const safeTimestamp = value => finite(value) && value >= 0 ? value : Date.now();
const clone = value => {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value)) result[key] = clone(value[key]);
    return result;
  }
  return value;
};

function normalizeDeadzone(value) {
  return finite(value) ? clamp(value, 0, MAX_DEADZONE) : DEFAULT_DEADZONE;
}

/** Apply a continuous scalar deadzone. Pairwise stick filtering is radial. */
export function applyDeadzone(value, deadzone = DEFAULT_DEADZONE) {
  if (!finite(value)) return 0;
  const axis = clamp(value, -1, 1);
  const zone = normalizeDeadzone(deadzone);
  const magnitude = Math.abs(axis);
  if (magnitude <= zone) return 0;
  return Math.sign(axis) * ((magnitude - zone) / (1 - zone));
}

function applyRadialDeadzone(x, y, deadzone) {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= deadzone || magnitude === 0) return [0, 0];
  const outputMagnitude = Math.min(1, (magnitude - deadzone) / (1 - deadzone));
  const scale = outputMagnitude / magnitude;
  return [clamp(x * scale, -1, 1), clamp(y * scale, -1, 1)];
}

/**
 * Convert a Gamepad-like object to a bounded, JSON-safe snapshot.
 * @param {object|null} gamepad
 * @param {{deadzone?:number,timestamp?:number,maxAxes?:number,maxButtons?:number}} options
 */
export function normalizeGamepadSnapshot(gamepad, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const deadzone = normalizeDeadzone(opts.deadzone);
  const timestamp = safeTimestamp(opts.timestamp);
  const warnings = [];
  if (!gamepad || typeof gamepad !== 'object') {
    return { valid: false, id: '', index: -1, mapping: '', connected: false, timestamp, deadzone, axes: [], buttons: [], warnings: ['gamepad-missing'] };
  }

  const rawIndex = gamepad.index;
  const index = Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : -1;
  if (index < 0) warnings.push('index-invalid');
  if (index > 255) warnings.push('index-unusually-large');
  const id = safeText(gamepad.id);
  const mapping = safeText(gamepad.mapping, 32);
  const connected = gamepad.connected === true;
  if (!mapping) warnings.push('mapping-unspecified');

  const sourceAxes = Array.isArray(gamepad.axes) ? gamepad.axes : [];
  if (!Array.isArray(gamepad.axes)) warnings.push('axes-unavailable');
  const axisLimit = finite(opts.maxAxes) ? clamp(Math.trunc(opts.maxAxes), 0, 64) : 32;
  const rawAxes = [];
  const axes = [];
  for (let i = 0; i < Math.min(sourceAxes.length, axisLimit); i += 1) {
    const source = sourceAxes[i];
    if (!finite(source)) {
      rawAxes.push(0);
      warnings.push(`axis-${i}-invalid`);
    } else rawAxes.push(clamp(source, -1, 1));
  }
  for (let i = 0; i < rawAxes.length; i += 2) {
    let filteredPair;
    if (i + 1 < rawAxes.length) filteredPair = applyRadialDeadzone(rawAxes[i], rawAxes[i + 1], deadzone);
    else filteredPair = [applyDeadzone(rawAxes[i], deadzone)];
    for (let pairIndex = 0; pairIndex < filteredPair.length; pairIndex += 1) {
      axes.push({ index: i + pairIndex, raw: rawAxes[i + pairIndex], filtered: filteredPair[pairIndex] });
    }
  }

  const sourceButtons = Array.isArray(gamepad.buttons) ? gamepad.buttons : [];
  if (!Array.isArray(gamepad.buttons)) warnings.push('buttons-unavailable');
  const buttonLimit = finite(opts.maxButtons) ? clamp(Math.trunc(opts.maxButtons), 0, 512) : 256;
  const buttons = [];
  for (let i = 0; i < Math.min(sourceButtons.length, buttonLimit); i += 1) {
    const source = sourceButtons[i];
    const button = source && typeof source === 'object' ? source : {};
    const raw = finite(button.value) ? clamp(button.value, 0, 1) : (button.pressed === true ? 1 : 0);
    if (source == null) warnings.push(`button-${i}-missing`);
    buttons.push({ index: i, raw, value: raw, pressed: button.pressed === true || raw >= 0.5 });
  }
  if (sourceAxes.length > axisLimit) warnings.push('axes-truncated');
  if (sourceButtons.length > buttonLimit) warnings.push('buttons-truncated');

  return { valid: true, id, index, mapping, connected, timestamp, deadzone, axes, buttons, warnings };
}

/** Start a user-requested neutral-position measurement. dt is supplied in ms. */
export function createCalibration(gamepad) {
  const snapshot = gamepad && gamepad.valid === true
    ? gamepad
    : normalizeGamepadSnapshot(gamepad, { deadzone: 0 });
  const axisCount = clamp(snapshot.axes.length, 0, 32);
  return {
    id: safeText(snapshot.id), index: Number.isInteger(snapshot.index) ? snapshot.index : -1,
    axisCount, state: snapshot.connected === false ? 'cancelled' : 'collecting',
    startedAt: Date.now(), elapsedMs: 0, sampleCount: 0, skippedMotionCount: 0,
    samples: [], lastSample: null, limits: { ...CALIBRATION_LIMITS }, warnings: [],
    result: null, cancellationReason: snapshot.connected === false ? 'disconnected' : null,
  };
}

function safeCalibration(calibration) {
  if (!calibration || typeof calibration !== 'object') return null;
  const limits = calibration.limits && typeof calibration.limits === 'object' ? calibration.limits : CALIBRATION_LIMITS;
  return {
    ...calibration,
    axisCount: finite(calibration.axisCount) ? clamp(Math.trunc(calibration.axisCount), 0, 32) : 0,
    elapsedMs: finite(calibration.elapsedMs) && calibration.elapsedMs >= 0 ? calibration.elapsedMs : 0,
    samples: Array.isArray(calibration.samples) ? calibration.samples.slice(0, CALIBRATION_LIMITS.maxSamples) : [],
    warnings: Array.isArray(calibration.warnings) ? calibration.warnings.filter(item => typeof item === 'string').slice(0, 64) : [],
    limits: {
      maxSamples: finite(limits.maxSamples) ? clamp(Math.trunc(limits.maxSamples), 1, CALIBRATION_LIMITS.maxSamples) : CALIBRATION_LIMITS.maxSamples,
      maxDurationMs: finite(limits.maxDurationMs) ? clamp(limits.maxDurationMs, 100, CALIBRATION_LIMITS.maxDurationMs) : CALIBRATION_LIMITS.maxDurationMs,
      minSamples: finite(limits.minSamples) ? clamp(Math.trunc(limits.minSamples), 1, CALIBRATION_LIMITS.maxSamples) : CALIBRATION_LIMITS.minSamples,
      minDurationMs: finite(limits.minDurationMs) ? clamp(limits.minDurationMs, 0, CALIBRATION_LIMITS.maxDurationMs) : CALIBRATION_LIMITS.minDurationMs,
      motionThreshold: finite(limits.motionThreshold) ? clamp(limits.motionThreshold, 0, 1) : CALIBRATION_LIMITS.motionThreshold,
      driftThreshold: finite(limits.driftThreshold) ? clamp(limits.driftThreshold, 0, 1) : CALIBRATION_LIMITS.driftThreshold,
    },
  };
}

/** Return a new calibration state; invalid or negative dt is ignored safely. */
export function updateCalibration(calibration, snapshot, dt) {
  const current = safeCalibration(calibration);
  if (!current || current.state !== 'collecting') return current ? clone(current) : null;
  const next = clone(current);
  const delta = finite(dt) && dt >= 0 ? dt : 0;
  if (!finite(dt) || dt < 0) next.warnings.push('dt-invalid-or-negative');
  next.elapsedMs = Math.min(next.limits.maxDurationMs, next.elapsedMs + delta);
  if (!snapshot || typeof snapshot !== 'object' || snapshot.valid !== true) {
    next.warnings.push('snapshot-invalid');
    return next;
  }
  if (snapshot.connected !== true || snapshot.index !== current.index) {
    next.state = 'cancelled';
    next.cancellationReason = snapshot.connected !== true ? 'disconnected' : 'device-changed';
    next.warnings.push('calibration-cancelled');
    return next;
  }
  if (next.elapsedMs >= next.limits.maxDurationMs || next.samples.length >= next.limits.maxSamples) {
    next.state = 'ready';
    return next;
  }
  const sample = Array.from({ length: next.axisCount }, (_, i) => {
    const axis = snapshot.axes?.[i];
    return axis && finite(axis.raw) ? clamp(axis.raw, -1, 1) : 0;
  });
  const moved = next.lastSample && sample.some((value, i) => Math.abs(value - next.lastSample[i]) > next.limits.motionThreshold);
  if (moved) {
    next.skippedMotionCount += 1;
    if (!next.warnings.includes('motion-detected-sample-skipped')) next.warnings.push('motion-detected-sample-skipped');
  } else {
    next.samples.push(sample);
    next.sampleCount = next.samples.length;
    next.lastSample = sample;
  }
  if (next.elapsedMs >= next.limits.maxDurationMs || next.samples.length >= next.limits.maxSamples) next.state = 'ready';
  return next;
}

/** Finish once and return facts separately from the heuristic recommendation. */
export function finishCalibration(calibration) {
  const current = safeCalibration(calibration);
  if (!current) return { state: 'cancelled', result: null, warnings: ['calibration-invalid'] };
  if (current.result) return clone(current);
  const samples = current.samples;
  const perAxis = Array.from({ length: current.axisCount }, (_, axis) => {
    const values = samples.map(sample => finite(sample?.[axis]) ? clamp(sample[axis], -1, 1) : 0);
    const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    return {
      axis, mean,
      maxDrift: values.reduce((max, value) => Math.max(max, Math.abs(value - mean)), 0),
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 0,
    };
  });
  const enoughData = samples.length >= current.limits.minSamples && current.elapsedMs >= current.limits.minDurationMs;
  const driftDetected = enoughData && perAxis.some(axis => axis.maxDrift >= current.limits.driftThreshold);
  const result = {
    facts: { sampleCount: samples.length, elapsedMs: current.elapsedMs, axisCount: current.axisCount, perAxis },
    recommendation: !enoughData ? 'More steady samples are needed for a useful estimate.'
      : driftDetected ? 'Some axes varied during this measurement; repeat while leaving the sticks untouched.'
        : 'No unusual variation was observed during this short measurement.',
    warnings: current.warnings.slice(0, 64),
  };
  return { ...clone(current), state: current.state === 'cancelled' ? 'cancelled' : 'finished', result: clone(result), finishedAt: Date.now() };
}

function asSnapshot(gamepad, options) {
  return gamepad && gamepad.valid === true ? clone(gamepad) : normalizeGamepadSnapshot(gamepad, options);
}

/** Compare a sparse Gamepad array with the previous summary and report events. */
export function summarizeGamepads(gamepads, previous = null, options = {}) {
  const list = Array.isArray(gamepads) ? gamepads : [];
  const oldSlots = previous?.slots && typeof previous.slots === 'object' ? previous.slots : {};
  const slots = {};
  const events = [];
  const seen = new Set();
  for (let sourceIndex = 0; sourceIndex < list.length; sourceIndex += 1) {
    if (!(sourceIndex in list) || list[sourceIndex] == null) continue;
    const snapshot = asSnapshot(list[sourceIndex], options);
    if (!snapshot.valid || snapshot.index < 0) {
      events.push({ type: 'anomaly', sourceIndex, reason: 'invalid-index-or-gamepad' });
      continue;
    }
    if (seen.has(snapshot.index)) {
      events.push({ type: 'anomaly', index: snapshot.index, reason: 'duplicate-index' });
      continue;
    }
    seen.add(snapshot.index);
    if (!snapshot.connected) continue;
    const key = String(snapshot.index);
    const slot = {
      index: snapshot.index, id: snapshot.id, connected: true,
      buttons: snapshot.buttons.map(button => button.pressed),
      axes: snapshot.axes.map(axis => axis.filtered),
    };
    slots[key] = slot;
    const old = oldSlots[key];
    if (!old || old.connected !== true) events.push({ type: 'connected', index: snapshot.index });
    if (!old) continue;
    const buttonCount = Math.max(old.buttons?.length || 0, slot.buttons.length);
    for (let i = 0; i < buttonCount; i += 1) {
      if ((old.buttons?.[i] === true) !== (slot.buttons[i] === true)) events.push({ type: 'button', index: snapshot.index, buttonIndex: i, pressed: slot.buttons[i] === true });
    }
    const axisCount = Math.max(old.axes?.length || 0, slot.axes.length);
    const threshold = finite(options?.axisChangeThreshold) ? clamp(options.axisChangeThreshold, 0, 1) : 0.08;
    for (let i = 0; i < axisCount; i += 1) {
      const before = finite(old.axes?.[i]) ? old.axes[i] : 0;
      const after = finite(slot.axes[i]) ? slot.axes[i] : 0;
      if (Math.abs(after - before) >= threshold) events.push({ type: 'axis', index: snapshot.index, axisIndex: i, from: before, to: after });
    }
  }
  for (const [key, old] of Object.entries(oldSlots)) {
    if (old?.connected === true && !Object.prototype.hasOwnProperty.call(slots, key)) events.push({ type: 'disconnected', index: old.index });
  }
  return { timestamp: safeTimestamp(options?.timestamp), slots, events, total: Object.keys(slots).length };
}

function toIso(value) {
  try {
    const date = value instanceof Date ? value : value == null ? new Date() : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function safeCalibrationFacts(value) {
  if (!value || typeof value !== 'object') return {};
  const numeric = key => finite(value[key]) ? value[key] : 0;
  const perAxis = Array.isArray(value.perAxis) ? value.perAxis.slice(0, 32).map((axis, index) => ({
    axis: Number.isInteger(axis?.axis) ? clamp(axis.axis, 0, 31) : index,
    mean: finite(axis?.mean) ? clamp(axis.mean, -1, 1) : 0,
    maxDrift: finite(axis?.maxDrift) ? clamp(axis.maxDrift, 0, 2) : 0,
    min: finite(axis?.min) ? clamp(axis.min, -1, 1) : 0,
    max: finite(axis?.max) ? clamp(axis.max, -1, 1) : 0,
  })) : [];
  return {
    sampleCount: clamp(Math.trunc(numeric('sampleCount')), 0, CALIBRATION_LIMITS.maxSamples),
    elapsedMs: clamp(numeric('elapsedMs'), 0, CALIBRATION_LIMITS.maxDurationMs),
    axisCount: clamp(Math.trunc(numeric('axisCount')), 0, 32),
    perAxis,
  };
}

/** Build a bounded, JSON-safe report containing only local Gamepad API data. */
export function buildDiagnosticReport(snapshot, calibration = null, metadata = {}) {
  const source = snapshot && typeof snapshot === 'object' && snapshot.valid === true ? snapshot : null;
  const device = source ? {
    available: true, id: safeText(source.id), index: Number.isInteger(source.index) ? source.index : -1,
    mapping: safeText(source.mapping, 32), connected: source.connected === true,
    timestamp: finite(source.timestamp) ? source.timestamp : null,
    axes: Array.isArray(source.axes) ? source.axes.slice(0, 64).map(axis => ({
      index: Number.isInteger(axis?.index) ? axis.index : -1,
      raw: finite(axis?.raw) ? clamp(axis.raw, -1, 1) : 0,
      filtered: finite(axis?.filtered) ? clamp(axis.filtered, -1, 1) : 0,
    })) : [],
    buttons: Array.isArray(source.buttons) ? source.buttons.slice(0, 512).map(button => ({
      index: Number.isInteger(button?.index) ? button.index : -1,
      raw: finite(button?.raw) ? clamp(button.raw, 0, 1) : 0,
      pressed: button?.pressed === true,
    })) : [],
    warnings: Array.isArray(source.warnings) ? source.warnings.filter(item => typeof item === 'string').slice(0, 64) : [],
  } : { available: false };
  let calibrationReport = { available: false };
  if (calibration && typeof calibration === 'object') {
    const safeResult = calibration.result && typeof calibration.result === 'object' ? calibration.result : null;
    calibrationReport = {
      available: true,
      state: safeText(calibration.state, 24) || 'unknown',
      result: safeResult ? {
        facts: safeCalibrationFacts(safeResult.facts),
        recommendation: safeText(safeResult.recommendation, 256),
        warnings: Array.isArray(safeResult.warnings) ? safeResult.warnings.filter(item => typeof item === 'string').slice(0, 64) : [],
      } : null,
    };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: toIso(metadata?.generatedAt),
    appVersion: safeText(metadata?.appVersion, 32) || '1.0.1',
    device,
    calibration: calibrationReport,
    limitations: [...LIMITATIONS],
  };
}
