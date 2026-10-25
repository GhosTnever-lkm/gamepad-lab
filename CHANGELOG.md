# Changelog

## 1.0.4 - 2026-10-25

- Cancel a stick-center measurement when a different controller replaces the device in the same browser slot.
- Add a regression test for same-slot controller replacement.

## 1.0.3 - 2026-10-24

- Report exports now identify the current Gamepad Lab release (`1.0.3`) instead of the stale `1.0.1` value.
- Version the browser module and stylesheet URLs so cached clients load the current interface and report logic.

## 1.0.2 - 2026-10-13

- Remove the external Google Fonts import and use system font stacks so the app makes no third-party font requests.

## 1.0.1 - 2026-10-11

- Add deterministic tests for deadzone filtering, normalization, calibration, event summaries, and report bounds.
- Add a CI workflow and versioned local test commands.

## 1.0.0 - 2026-10-11

- Initial controller diagnostics app with local deadzone visualization, drift sampling, and JSON export.
