import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDeadzone,
  buildDiagnosticReport,
  createCalibration,
  finishCalibration,
  normalizeGamepadSnapshot,
  summarizeGamepads,
  updateCalibration,
} from '../src/gamepad-core.js';

test('deadzone is symmetric, bounded, and leaves out-of-range input clamped', () => {
  assert.equal(applyDeadzone(0.1, 0.1), 0);
  assert.equal(applyDeadzone(-0.1, 0.1), 0);
  assert.equal(applyDeadzone(2, 0), 1);
  assert.equal(applyDeadzone(-2, 0), -1);
});

test('normalization preserves bounded raw values and reports truncated inputs', () => {
  const snapshot = normalizeGamepadSnapshot({
    id: 'Demo\u0000 pad',
    index: 0,
    mapping: 'standard',
    connected: true,
    axes: [0, 1.4, 0.2],
    buttons: [{ value: 0.6, pressed: false }, { pressed: true }],
  }, { deadzone: 0.1, timestamp: 42, maxAxes: 2, maxButtons: 1 });

  assert.equal(snapshot.id, 'Demo pad');
  assert.equal(snapshot.timestamp, 42);
  assert.deepEqual(snapshot.axes.map(axis => axis.raw), [0, 1]);
  assert.deepEqual(snapshot.axes.map(axis => axis.filtered), [0, 1]);
  assert.deepEqual(snapshot.buttons, [{ index: 0, raw: 0.6, value: 0.6, pressed: true }]);
  assert.ok(snapshot.warnings.includes('axes-truncated'));
  assert.ok(snapshot.warnings.includes('buttons-truncated'));
});

test('steady calibration finishes with bounded sample facts', () => {
  const pad = normalizeGamepadSnapshot({
    id: 'Synthetic controller', index: 0, mapping: 'standard', connected: true,
    axes: [0, 0], buttons: [],
  }, { timestamp: 1 });
  let calibration = createCalibration(pad);
  for (let i = 0; i < 24; i += 1) calibration = updateCalibration(calibration, pad, 20);
  const result = finishCalibration(calibration);
  assert.equal(result.result.facts.sampleCount, 24);
  assert.equal(result.result.facts.axisCount, 2);
  assert.match(result.result.recommendation, /No unusual variation/);
});

test('gamepad summaries report connect, button, axis, and disconnect events', () => {
  const pad = (button, axis) => normalizeGamepadSnapshot({
    id: 'Synthetic', index: 1, mapping: 'standard', connected: true,
    axes: [axis, 0], buttons: [{ value: button ? 1 : 0, pressed: button }],
  });
  const before = summarizeGamepads([pad(false, 0)], null, { timestamp: 10 });
  assert.ok(before.events.some(event => event.type === 'connected'));
  const after = summarizeGamepads([pad(true, 0.5)], before, { timestamp: 20 });
  assert.ok(after.events.some(event => event.type === 'button' && event.pressed));
  assert.ok(after.events.some(event => event.type === 'axis'));
  const disconnected = summarizeGamepads([], after, { timestamp: 30 });
  assert.ok(disconnected.events.some(event => event.type === 'disconnected' && event.index === 1));
});

test('diagnostic reports clamp arrays and omit unrecognized properties', () => {
  const report = buildDiagnosticReport({
    valid: true, id: 'Synthetic', index: 0, mapping: 'standard', connected: true,
    timestamp: 1,
    axes: Array.from({ length: 80 }, (_, index) => ({ index, raw: 2, filtered: -2 })),
    buttons: [], warnings: Array.from({ length: 80 }, () => 'warning'),
    secret: 'not exported',
  }, null, { generatedAt: '2026-10-11T00:00:00.000Z', appVersion: '1.0.1' });
  assert.equal(report.device.axes.length, 64);
  assert.equal(report.device.axes[0].raw, 1);
  assert.equal(report.device.axes[0].filtered, -1);
  assert.equal(report.device.warnings.length, 64);
  assert.equal(report.appVersion, '1.0.1');
  assert.equal(JSON.stringify(report).includes('not exported'), false);
});