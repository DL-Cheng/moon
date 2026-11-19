/* ============ LimbFit Stairs · game logic ============
 * Based on the original "Stair Stepping" game, with these differences:
 *  - Events come from four limbs (LH / RH / LF / RF) x three force levels, e.g. "LH2"
 *  - Every step is bound to one limb and shows a press (hand) or step (foot) cue
 *  - Battery level and the live force of all four limbs are displayed
 *  - The whole scene is scaled to fill an iPad held in portrait
 */

let steps = [];            // {limb:'LH', side:'L', level?}
let currentIndex = 0;      // 0 = ground, 1..10 = step number
let mqttClient = null;
let connected = false;

let appState = 'select';   // 'select' | 'ready' | 'playing' | 'end'
let endConfirmPending = false;
let selectIndex = 0;
let selectedMode = null;
let selectedLevel = null;
let startTime = null;
let timerInterval = null;
let timedEndAt = null;
let lastDeviceSeen = 0;
let lastHit = { limb: null, at: 0 };   // limb that just scored; later level events of the same press are ignored
let stageH = BASE_H;       // logical stage height, set by layout()

const stageEl = document.getElementById('stage');
const $ = id => document.getElementById(id);

/* ============ Layout: scale the scene to fill the screen ============ */
function layout() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const s = Math.min(vw / BASE_W, vh / BASE_H);
  const W = vw / s, H = vh / s;
  const root = $('scaleRoot');
  root.style.width = W + 'px';
  root.style.height = H + 'px';
  root.style.transform = `scale(${s})`;
  document.documentElement.style.setProperty('--s', String(s));
  stageH = H;
  updateCamera();
}
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', () => setTimeout(layout, 200));

/* ============ Icons: hand press / foot step ============ */
function limbIconSVG(limbKey, size) {
  const L = LIMBS[limbKey];
  size = size || 40;
  const flip = ' transform="translate(48 0) scale(-1 1)"';
  let body;
  if (L.kind === 'hand') {
    // palm pressing down (base = right hand with thumb on the left; left hand mirrored)
    body = `
      <g${L.side === 'L' ? flip : ''}>
        <rect x="13" y="25" width="22" height="18" rx="7"/>
        <rect x="13.2" y="17" width="4.2" height="14" rx="2.1"/>
        <rect x="18.9" y="14" width="4.2" height="17" rx="2.1"/>
        <rect x="24.6" y="14.5" width="4.2" height="16.5" rx="2.1"/>
        <rect x="30.3" y="18" width="4.2" height="13" rx="2.1"/>
        <rect x="9.2" y="28" width="4.6" height="11" rx="2.3" transform="rotate(-28 11.5 33.5)"/>
      </g>`;
  } else {
    // foot print (base = left foot with big toe on the right; right foot mirrored)
    body = `
      <g${L.side === 'R' ? flip : ''}>
        <path d="M24 22C30.5 22 33 26.5 32 31.5C31.4 34.6 29 36 29 39.2C29 43 26.6 45.6 23 45.6C19.4 45.6 17 43 17 39.2C17 36 15.4 34.2 15.4 30.2C15.4 25.4 18.6 22 24 22Z"/>
        <ellipse cx="29.4" cy="17.6" rx="3.2" ry="3.6"/>
        <ellipse cx="23.6" cy="16.6" rx="2.3" ry="2.5"/>
        <ellipse cx="19.3" cy="17.9" rx="2" ry="2.2"/>
        <ellipse cx="16" cy="20.2" rx="1.7" ry="1.9"/>
        <ellipse cx="13.9" cy="23.4" rx="1.4" ry="1.6"/>
      </g>`;
  }
  return `<svg class="limb-ico" viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true" fill="currentColor">
    <g class="press-arrow" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <path d="M24 2.5v8"/><path d="M19.5 7L24 11.5 28.5 7"/>
    </g>${body}</svg>`;
}

function limbPhrase(limbKey) {
  const L = LIMBS[limbKey];
  return `${L.name} · ${L.verb} down`;
}

/* ============ Step generation ============ */
function generateSteps() {
  // Every limb at least twice, the rest random; no limb twice in a row (avoids single-limb compensation)
  for (let attempt = 0; attempt < 200; attempt++) {
    const pool = [...LIMB_KEYS, ...LIMB_KEYS];
    while (pool.length < TOTAL_STEPS) pool.push(LIMB_KEYS[Math.floor(Math.random() * 4)]);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    let ok = true;
    for (let i = 1; i < pool.length; i++) if (pool[i] === pool[i - 1]) { ok = false; break; }
    if (ok) return pool.map(limb => ({ limb, side: LIMBS[limb].side }));
  }
  return LIMB_KEYS.concat(LIMB_KEYS, LIMB_KEYS.slice(0, 2)).map(limb => ({ limb, side: LIMBS[limb].side }));
}

function generateTimedSteps(count) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    const limb = TIMED_CYCLE[i % TIMED_CYCLE.length];
    const level = Math.min(3, Math.floor(i / TIMED_CYCLE.length) + 1);   // +1 level per round, capped at 3
    arr.push({ limb, side: LIMBS[limb].side, level });
  }
  return arr;
}

/* ============ Rendering ============ */
function render() {
  stageEl.querySelectorAll('.step, .character').forEach(n => n.remove());

  steps.forEach((step, i) => {
    const stepNum = i + 1;
    const el = document.createElement('div');
    el.className = 'step';
    el.id = 'step-' + stepNum;
    el.style.bottom = (64 + stepNum * STEP_GAP) + 'px';

    const isPast = stepNum <= currentIndex;
    const isNextTarget = stepNum === currentIndex + 1;

    if (isPast) {
      el.classList.add('done');
      el.style.transform = 'translateX(-50%)';
    } else {
      const offset = step.side === 'L' ? -SIDE_OFFSET : SIDE_OFFSET;
      el.style.transform = `translateX(calc(-50% + ${offset}px))`;
      if (isNextTarget) el.classList.add('active-target');
    }

    const label = document.createElement('div');
    label.className = 'step-num';
    label.textContent = stepNum;
    el.appendChild(label);

    // press / step cue above the next target step
    const cue = document.createElement('div');
    cue.className = 'step-cue ' + (step.side === 'L' ? 'cue-L' : 'cue-R') + (isNextTarget ? ' show' : '');
    cue.innerHTML = limbIconSVG(step.limb, 22) + `<span>${LIMBS[step.limb].short}</span>`;
    el.appendChild(cue);

    stageEl.appendChild(el);
  });

  const charEl = document.createElement('div');
  charEl.className = 'character';
  charEl.id = 'character';
  charEl.innerHTML =
    `<img class="char-stand" src="${ASSETS.stand}" alt="Character" draggable="false">` +
    `<img class="char-jump" src="${ASSETS.jump}" alt="Character jumping" draggable="false">`;
  charEl.style.bottom = (currentIndex === 0 ? 30 : (64 + currentIndex * STEP_GAP + 22)) + 'px';
  stageEl.appendChild(charEl);

  updateCamera();
  updateProgress();
  updateCueBar();
}

/* Keep the character about 28% above the bottom edge so the next steps are visible above it */
function updateCamera() {
  const focusIndex = Math.max(currentIndex, 0);
  const charWorldBottom = focusIndex === 0 ? 30 : (64 + focusIndex * STEP_GAP + 22);
  const desiredScreenBottom = stageH * 0.28;
  stageEl.style.transform = `translateY(${charWorldBottom - desiredScreenBottom}px)`;
}

function updateProgress() {
  if (selectedMode && selectedMode.type === 'timed') {
    $('progressLabel').textContent = `Completed: ${currentIndex}`;
    if (timedEndAt) {
      const frac = Math.max(0, Math.min(1, (timedEndAt - Date.now()) / TIMED_DURATION_MS));
      $('progressFill').style.width = (frac * 100) + '%';
    }
  } else {
    $('progressLabel').textContent = `Progress: ${currentIndex} / ${TOTAL_STEPS}`;
    $('progressFill').style.width = (currentIndex / TOTAL_STEPS * 100) + '%';
  }
}

/* Cue bar at the top: which limb and which force level comes next */
function updateCueBar(flashText) {
  const bar = $('cueBar');
  if (appState !== 'playing' || !steps[currentIndex]) {
    bar.classList.remove('show');
    return;
  }
  const step = steps[currentIndex];
  const isTimed = selectedMode.type === 'timed';
  const level = isTimed ? step.level : selectedLevel;
  bar.className = 'cue-bar show ' + (step.side === 'L' ? 'cue-L' : 'cue-R');
  $('cueIcon').innerHTML = limbIconSVG(step.limb, 38);
  $('cueMain').textContent = limbPhrase(step.limb);
  $('cueSub').textContent = flashText ||
    `${LEVEL_LABEL_BY_NUM[level]} force · Step ${currentIndex + 1}` + (isTimed ? '' : ` of ${TOTAL_STEPS}`);
}

function flashCue(kind, text) {
  const bar = $('cueBar');
  updateCueBar(text);
  bar.classList.remove('wrong', 'weak');
  void bar.offsetWidth;
  bar.classList.add(kind);
  setTimeout(() => { bar.classList.remove('wrong', 'weak'); updateCueBar(); }, 900);
}

/* ============ Message handling ============ */
const EVENT_RE = /^([LR])([HF])([123])$/;

function handleMessage(msg) {
  const text = String(msg).trim().toUpperCase();
  const m = EVENT_RE.exec(text);
  logLine('Received: ' + text);

  if (!m) {
    logLine('Unrecognised message, ignored: ' + msg);
    return;
  }
  const limb = m[1] + m[2];
  const level = parseInt(m[3], 10);
  const side = m[1];

  // "any sensor" screens accept any well-formed event
  if (appState === 'ready') { startGame(); return; }

  if (appState === 'end') {
    // two-step confirmation so the result is not skipped by accident
    if (!endConfirmPending) {
      endConfirmPending = true;
      $('endKeyPrompt').style.display = 'none';
      $('endConfirmHint').style.display = 'block';
      logLine('Press once more: right limb = leave, left limb = stay on results');
      return;
    }
    if (side === 'R') {
      logLine(`${text}: confirmed, back to mode selection`);
      resetEndConfirm();
      showSelectScreen();
    } else {
      logLine(`${text}: cancelled, staying on results`);
      resetEndConfirm();
    }
    return;
  }

  if (appState === 'select') { handleSelectMessage(side); return; }
  if (appState === 'playing') handleGameMessage(limb, level);
}

function resetEndConfirm() {
  endConfirmPending = false;
  $('endConfirmHint').style.display = 'none';
  $('endKeyPrompt').style.display = '';
}

function handleGameMessage(limb, level) {
  const isTimed = selectedMode.type === 'timed';
  if (!isTimed && currentIndex >= TOTAL_STEPS) { logLine('Already at the top, ignored'); return; }

  const nextStepNum = currentIndex + 1;
  const nextStep = steps[nextStepNum - 1];
  if (!nextStep) { logLine('No more steps in this round, ignored'); return; }

  // One hard press publishes level 1, 2 and 3 in a row: ignore later events of the limb that just scored
  if (limb === lastHit.limb && Date.now() - lastHit.at < SAME_LIMB_IGNORE_MS) {
    logLine(`${limb}${level} belongs to the same press, ignored`);
    return;
  }

  // 1) the limb must match the step
  if (limb !== nextStep.limb) {
    logLine(`Step ${nextStepNum} needs ${LIMBS[nextStep.limb].name}, got ${LIMBS[limb].name}`);
    flashCue('wrong', `Not ${LIMBS[limb].name}, use ${LIMBS[nextStep.limb].name}`);
    return;
  }

  // 2) the force level must match
  const requiredLevel = isTimed ? nextStep.level : selectedLevel;
  if (level !== requiredLevel) {
    logLine(`Need ${LEVEL_LABEL_BY_NUM[requiredLevel]} force, ${limb}${level} does not match, ignored`);
    if (level < requiredLevel) flashCue('weak', 'Not enough force, push a little harder');
    return;
  }

  // Hit: the step slides to the middle, then the character jumps up
  lastHit = { limb, at: Date.now() };
  const stepEl = $('step-' + nextStepNum);
  stepEl.classList.remove('active-target');
  stepEl.style.transform = 'translateX(-50%)';
  stepEl.classList.add('done');
  const cueEl = stepEl.querySelector('.step-cue');
  if (cueEl) cueEl.classList.remove('show');
  logLine(`Step ${nextStepNum} (${LIMBS[limb].name}) aligned, sliding to the centre`);

  setTimeout(() => {
    currentIndex = nextStepNum;
    const charEl = $('character');
    charEl.classList.add('jumping');
    charEl.style.bottom = (64 + currentIndex * STEP_GAP + 22) + 'px';
    updateCamera();
    updateProgress();
    setTimeout(() => charEl.classList.remove('jumping'), 400);

    const upcoming = $('step-' + (currentIndex + 1));
    if (upcoming) {
      upcoming.classList.add('active-target');
      const upCue = upcoming.querySelector('.step-cue');
      if (upCue) upCue.classList.add('show');
    }
    updateCueBar();

    if (!isTimed && currentIndex >= TOTAL_STEPS) {
      appState = 'end';
      resetEndConfirm();
      stopLiveTimer();
      updateCueBar();
      const elapsedMs = Date.now() - startTime;
      const timeText = formatDuration(elapsedMs);
      logLine(`Reached the top! Time ${timeText}`);
      $('winTitle').textContent = 'You reached the top!';
      $('winTimeText').textContent = timeText;
      $('winTimeLabel').textContent = 'YOUR TIME';
      $('historyTitle').textContent = `LAST 10 RESULTS · ${selectedMode.label.toUpperCase()}`;
      const history = addHistoryEntry(selectedMode.id, { mode: 'climb', ms: elapsedMs, levelLabel: selectedMode.label });
      renderHistory(history);
      $('winBanner').classList.add('show');
    }
  }, 520);
}

/* ============ Live timer ============ */
function startLiveTimer() {
  stopLiveTimer();
  const badge = $('liveTimer');
  badge.classList.add('show');
  if (selectedMode.type === 'timed') {
    timedEndAt = Date.now() + TIMED_DURATION_MS;
    badge.textContent = 'Left ' + formatDuration(TIMED_DURATION_MS);
    timerInterval = setInterval(() => {
      const remain = timedEndAt - Date.now();
      if (remain <= 0) {
        badge.textContent = 'Left ' + formatDuration(0);
        endTimedRound();
        return;
      }
      badge.textContent = 'Left ' + formatDuration(remain);
      updateProgress();
    }, 100);
  } else {
    badge.textContent = '0.0 s';
    timerInterval = setInterval(() => {
      badge.textContent = formatDuration(Date.now() - startTime);
    }, 100);
  }
}

function stopLiveTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  $('liveTimer').classList.remove('show');
}

/* ============ History (localStorage, last 10 per mode) ============ */
function loadHistoryStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch (e) { return {}; }
}
function loadHistoryForMode(modeId) {
  const store = loadHistoryStore();
  return Array.isArray(store[modeId]) ? store[modeId] : [];
}
function addHistoryEntry(modeId, entry) {
  const store = loadHistoryStore();
  const list = Array.isArray(store[modeId]) ? store[modeId] : [];
  list.unshift(entry);
  while (list.length > 10) list.pop();
  store[modeId] = list;
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }
  return list;
}
function renderHistory(list) {
  const el = $('historyList');
  if (!list || !list.length) {
    el.innerHTML = '<div class="history-empty">No results yet</div>';
    return;
  }
  el.innerHTML = list.map((item, i) => {
    const valueText = item.mode === 'timed' ? `${item.reps} steps` : formatDuration(item.ms);
    return `<div class="history-item">
      <span class="history-rank">${i + 1}</span>
      <span class="history-time">${valueText}</span>
      <span class="history-level">${item.levelLabel}</span>
    </div>`;
  }).join('');
}

function formatDuration(ms) {
  const totalSec = Math.max(0, ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = (totalSec % 60).toFixed(1);
  return min > 0 ? `${min} min ${sec} s` : `${sec} s`;
}

function logLine(text) {
  const log = $('log');
  if (!log) return;
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  log.textContent += `[${time}] ${text}\n`;
  if (log.textContent.length > 8000) log.textContent = log.textContent.slice(-6000);
  log.scrollTop = log.scrollHeight;
}

/* ============ Mode selection ============ */
function renderLevelList() {
  $('levelList').innerHTML = MODES.map(m =>
    `<div class="level-item">${m.label}<span class="level-sub">${m.sub}</span></div>`
  ).join('');
}

function handleSelectMessage(side) {
  if (side === 'L') {
    selectIndex = (selectIndex + 1) % MODES.length;
    updateLevelHighlight();
    logLine('Highlighted: ' + MODES[selectIndex].label);
  } else {
    confirmMode();
  }
}

function updateLevelHighlight() {
  document.querySelectorAll('.level-item').forEach((el, i) => el.classList.toggle('active', i === selectIndex));
  $('currentLevelText').textContent = 'Selected: ' + MODES[selectIndex].label;
}

function showSelectScreen() {
  stopLiveTimer();
  appState = 'select';
  selectIndex = 0;
  selectedMode = null;
  selectedLevel = null;
  $('levelDisplay').textContent = 'Not selected';
  $('readyBanner').classList.remove('show');
  $('winBanner').classList.remove('show');
  $('selectBanner').classList.add('show');
  updateLevelHighlight();
  updateCueBar();
  closeDrawer();
  logLine('Select a mode: left limb = next option, right limb = confirm');
}

function confirmMode() {
  selectedMode = MODES[selectIndex];
  selectedLevel = selectedMode.type === 'climb' ? selectedMode.level : null;
  $('selectBanner').classList.remove('show');
  $('levelDisplay').textContent = selectedMode.label;
  logLine(`Mode confirmed: ${selectedMode.label}`);
  prepareBoard();
  showReadyScreen();
}

function showReadyScreen() {
  stopLiveTimer();
  appState = 'ready';
  $('readyLevelText').textContent = 'Mode: ' + selectedMode.label;
  $('winBanner').classList.remove('show');
  $('readyBanner').classList.add('show');
  updateCueBar();
  logLine('Ready: press any sensor to start the timer and the round');
}

function startGame() {
  appState = 'playing';
  startTime = Date.now();
  $('readyBanner').classList.remove('show');
  startLiveTimer();
  updateCueBar();
  logLine('Round started, timer running');
}

/* ============ Reset ============ */
function restartRound() {
  closeDrawer();
  if (selectedMode) { prepareBoard(); showReadyScreen(); }
  else showSelectScreen();
}

function prepareBoard() {
  $('winBanner').classList.remove('show');
  $('log').textContent = '';
  lastHit = { limb: null, at: 0 };
  if (selectedMode.type === 'timed') {
    steps = generateTimedSteps(TIMED_STEP_COUNT);
    currentIndex = 0;
    render();
    logLine(`New round (${selectedMode.label}): 30 s, R Hand > L Foot > L Hand > R Foot, level rises every round`);
  } else {
    steps = generateSteps();
    currentIndex = 0;
    render();
    logLine(`New round (${selectedMode.label}): limbs shuffled across ${TOTAL_STEPS} steps`);
  }
}

function endTimedRound() {
  appState = 'end';
  resetEndConfirm();
  stopLiveTimer();
  updateCueBar();
  const reps = currentIndex;
  logLine(`Time is up! ${reps} steps in 30 s`);
  $('winTitle').textContent = "Time's up!";
  $('winTimeText').textContent = reps + ' steps';
  $('winTimeLabel').textContent = 'COMPLETED IN 30 SECONDS';
  $('historyTitle').textContent = `LAST 10 RESULTS · ${selectedMode.label.toUpperCase()}`;
  const history = addHistoryEntry(selectedMode.id, { mode: 'timed', reps, levelLabel: selectedMode.label });
  renderHistory(history);
  $('winBanner').classList.add('show');
}

/* ============ Battery, connection and live force ============ */
function updateBattery(pct, mv) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  $('batFill').setAttribute('width', String(Math.round(21 * p / 100)));
  $('batText').textContent = p + '%';
  const badge = $('batteryBadge');
  badge.classList.remove('bat-ok', 'bat-mid', 'bat-low');
  badge.classList.add(p > 50 ? 'bat-ok' : (p > 20 ? 'bat-mid' : 'bat-low'));
  $('batDetail').textContent = p + '%' + (mv ? ` (${(mv / 1000).toFixed(2)} V)` : '');
}

function setDeviceOnline(online) {
  $('devState').textContent = online ? 'Online' : 'Offline';
  $('devState').style.color = online ? 'var(--teal)' : 'var(--coral)';
  $('batteryBadge').classList.toggle('stale', !online);
  refreshConnChip();
}

function refreshConnChip() {
  const deviceOnline = $('devState').textContent === 'Online';
  const txt = !connected ? 'Offline' : (deviceOnline ? 'Device online' : 'Waiting for device');
  $('connText').textContent = txt;
}

function renderForceStrip() {
  $('forceStrip').innerHTML = LIMB_KEYS.map(k => {
    const L = LIMBS[k];
    return `<div class="fs-item ${L.side === 'L' ? 'cue-L' : 'cue-R'}">
      <div class="fs-top">${limbIconSVG(k, 18)}<span>${L.short}</span></div>
      <div class="fs-bar"><div class="fs-fill" id="ff-${k}"></div></div>
    </div>`;
  }).join('');
}

function updateForce(obj) {
  LIMB_KEYS.forEach(k => {
    const v = Math.max(0, Math.min(100, Number(obj[k]) || 0));
    $('ff-' + k).style.width = v + '%';
  });
}

function renderTestGrid() {
  $('testGrid').innerHTML = LIMB_KEYS.map(k =>
    [1, 2, 3].map(n =>
      `<button class="${LIMBS[k].side === 'L' ? 'btn-L' : 'btn-R'}" data-msg="${k}${n}">${k}${n}</button>`
    ).join('')
  ).join('');
  $('testGrid').addEventListener('click', e => {
    const b = e.target.closest('button[data-msg]');
    if (b) handleMessage(b.dataset.msg);
  });
}

/* ============ Drawer ============ */
function openDrawer() { $('drawer').classList.add('show'); $('drawerMask').classList.add('show'); $('drawer').setAttribute('aria-hidden', 'false'); }
function closeDrawer() { $('drawer').classList.remove('show'); $('drawerMask').classList.remove('show'); $('drawer').setAttribute('aria-hidden', 'true'); }

/* ============ Settings (broker URL and topic prefix are remembered) ============ */
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { /* ignore */ }
  $('brokerUrl').value = s.broker || DEFAULT_BROKER;
  $('topicBase').value = s.base || DEFAULT_TOPIC_BASE;
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ broker: $('brokerUrl').value.trim(), base: $('topicBase').value.trim() }));
  } catch (e) { /* ignore */ }
}

/* ============ MQTT ============ */
function topics() {
  const base = $('topicBase').value.trim().replace(/\/+$/, '') || DEFAULT_TOPIC_BASE;
  return {
    event: base + TOPIC_SUFFIX.event,
    force: base + TOPIC_SUFFIX.force,
    status: base + TOPIC_SUFFIX.status,
    cmd: base + TOPIC_SUFFIX.cmd
  };
}

function toggleConnect() {
  if (connected || mqttClient) disconnectMQTT('Disconnected manually');
  else connectMQTT();
}

function connectMQTT() {
  if (mqttClient) return;
  if (typeof mqtt === 'undefined') { logLine('MQTT library not loaded'); return; }
  saveSettings();
  const url = $('brokerUrl').value.trim() || DEFAULT_BROKER;
  const t = topics();
  const clientId = 'web_limbfit_' + Math.random().toString(16).slice(2, 10);

  logLine(`Connecting to ${url} ...`);
  let client;
  try {
    client = mqtt.connect(url, { clientId, clean: true, connectTimeout: 8000, reconnectPeriod: 3000 });
  } catch (e) {
    logLine('Connection failed: ' + e.message);
    return;
  }
  mqttClient = client;
  $('connectBtn').textContent = 'Disconnect';

  client.on('connect', () => {
    setConnected(true);
    logLine('Connected, subscribed to: ' + [t.event, t.force, t.status].join(', '));
    client.subscribe([t.event, t.force, t.status]);
  });

  client.on('message', (topic, payload) => {
    const text = payload.toString();
    if (topic === t.event) {
      lastDeviceSeen = Date.now();
      handleMessage(text);
    } else if (topic === t.force) {
      lastDeviceSeen = Date.now();
      try { updateForce(JSON.parse(text)); } catch (e) { /* ignore */ }
      setDeviceOnline(true);
    } else if (topic === t.status) {
      try {
        const s = JSON.parse(text);
        if (s.online === 0) { setDeviceOnline(false); return; }
        lastDeviceSeen = Date.now();
        setDeviceOnline(true);
        if (typeof s.bat === 'number') updateBattery(s.bat, s.mv);
      } catch (e) { /* ignore */ }
    }
  });

  client.on('error', err => logLine('Connection error: ' + err.message));
  client.on('close', () => setConnected(false));
}

function disconnectMQTT(reason) {
  if (mqttClient) { mqttClient.end(true); mqttClient = null; }
  setConnected(false);
  setDeviceOnline(false);
  $('connectBtn').textContent = 'Connect';
  logLine(reason || 'Disconnected');
}

function setConnected(state) {
  connected = state;
  $('statusDot').classList.toggle('connected', state);
  $('statusDot2').classList.toggle('connected', state);
  if (!state) $('connectBtn').textContent = mqttClient ? 'Disconnect' : 'Connect';
  refreshConnChip();
}

function sendTare() {
  if (!connected) { logLine('Not connected: cannot send the zero command'); return; }
  mqttClient.publish(topics().cmd, 'tare');
  logLine('Zero command sent (keep all four sensors unloaded)');
}

/* ============ Init ============ */
function init() {
  loadSettings();
  layout();
  renderLevelList();
  renderForceStrip();
  renderTestGrid();
  renderHistory(loadHistoryForMode(MODES[0].id));
  document.querySelector('[data-ico="hand"]').innerHTML = limbIconSVG('RH', 26);
  document.querySelector('[data-ico="foot"]').innerHTML = limbIconSVG('LF', 26);
  $('batText').textContent = '--%';
  $('batDetail').textContent = '--';
  setDeviceOnline(false);

  $('menuBtn').addEventListener('click', openDrawer);
  $('drawerClose').addEventListener('click', closeDrawer);
  $('drawerMask').addEventListener('click', closeDrawer);
  $('btnRestart').addEventListener('click', restartRound);
  $('btnChangeMode').addEventListener('click', showSelectScreen);
  $('connectBtn').addEventListener('click', toggleConnect);
  $('btnTare').addEventListener('click', sendTare);

  // device silent for 6 s -> treat as offline (battery shown dimmed with its last value)
  setInterval(() => {
    if (lastDeviceSeen && Date.now() - lastDeviceSeen > 6000) setDeviceOnline(false);
  }, 1500);

  window.assetsReady.then(() => {
    showSelectScreen();
    connectMQTT();   // connect to EMQX automatically when the page opens
  });
}
init();
