/* ============ Global settings ============ */

/* Limb codes: L/R = Left/Right, H/F = Hand/Foot.
 * The ESP32 (limbfit.ino) publishes events as <limb><level>, e.g. LH1, RF3. */
const LIMBS = {
  LH: { side: 'L', kind: 'hand', name: 'Left Hand',  short: 'L Hand', verb: 'Press' },
  RH: { side: 'R', kind: 'hand', name: 'Right Hand', short: 'R Hand', verb: 'Press' },
  LF: { side: 'L', kind: 'foot', name: 'Left Foot',  short: 'L Foot', verb: 'Step' },
  RF: { side: 'R', kind: 'foot', name: 'Right Foot', short: 'R Foot', verb: 'Step' }
};
const LIMB_KEYS = ['LH', 'RH', 'LF', 'RF'];
const LEVEL_LABEL_BY_NUM = { 1: 'Light', 2: 'Medium', 3: 'Heavy' };

/* Game parameters (logical pixels; the whole scene is scaled to fit the screen) */
const BASE_W = 360;          // logical stage width used to compute the scale factor
const BASE_H = 520;          // logical stage height used to compute the scale factor
const TOTAL_STEPS = 10;
const STEP_GAP = 78;
const SIDE_OFFSET = 82;
const TIMED_DURATION_MS = 30000;
const TIMED_STEP_COUNT = 80;
const SAME_LIMB_IGNORE_MS = 1000;   // ignore later level events of the same press

/* 30-second challenge cycle: Right Hand > Left Foot > Left Hand > Right Foot.
 * The required force level goes up by one after every round of four. */
const TIMED_CYCLE = ['RH', 'LF', 'LH', 'RF'];

const MODES = [
  { id: 'light',   type: 'climb', level: 1, label: 'Light Force',  sub: 'A gentle press or step triggers it (Level 1)' },
  { id: 'medium',  type: 'climb', level: 2, label: 'Medium Force', sub: 'A firm effort is needed (Level 2)' },
  { id: 'heavy',   type: 'climb', level: 3, label: 'Heavy Force',  sub: 'High-intensity strengthening (Level 3)' },
  { id: 'timed30', type: 'timed', level: null, label: '30-Second Challenge', sub: 'R Hand > L Foot > L Hand > R Foot, force level rises every round' }
];

/* MQTT topics: must match limbfit.ino */
const DEFAULT_BROKER = 'wss://broker.emqx.io:8084/mqtt';
const DEFAULT_TOPIC_BASE = 'DL/limbfit';
const TOPIC_SUFFIX = { event: '/event', force: '/force', status: '/status', cmd: '/cmd' };
const HISTORY_KEY = 'limbFitHistory_v2';
const SETTINGS_KEY = 'limbFitSettings_v1';
