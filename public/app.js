/* Sanmati Machine Monitor — dynamic machine cards driven by /api/machines.
   One card is rendered per machine returned by the API; sections appear only
   when the machine actually reports those metrics, so different machine types
   (press, JCI, EKC, …) can share this same UI. */

const POLL_MS = 4000;          // live metrics refresh
const HISTORY_POLL_MS = 20000; // sparkline refresh
const HISTORY_MINUTES = 15;

const grid = document.getElementById('grid');
const errorBanner = document.getElementById('error-banner');
const cards = new Map(); // machineId -> { el, refs }

/* ── helpers ─────────────────────────────────────────── */

const fmtInt = (n) => (n == null || isNaN(n) ? '–' : Number(n).toLocaleString('en-IN'));

function fmtAgo(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

const has = (v) => v !== undefined && v !== null;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Fields already rendered by a dedicated widget; anything else the machine
// reports is shown dynamically in the "Other metrics" section.
const KNOWN_KEYS = new Set([
  'type', 'dept', 'status', 'machineRunning',
  'curingTimeSet', 'curingTime', 'curingTimeLeft',
  'currentPressure', 'finalPressure', 'pressHoldTime', 'totalBumpsReq',
  'cyclesCompleted', 'cyclesSession',
  'runningSeconds', 'idleSeconds', 'runningCount', 'idleCount',
  'rawRegisters',
]);
const isBumpKey = (k) => /^bump\d+(Pressure|HoldTime|DownTime)$/.test(k);
const humanize = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
const fmtVal = (v) => (typeof v === 'number' ? fmtInt(v) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : esc(v));

function extraMetrics(d) {
  return Object.entries(d).filter(([k, v]) => !KNOWN_KEYS.has(k) && !isBumpKey(k) && typeof v !== 'object' && has(v));
}

/* ── card construction ───────────────────────────────── */

const RING_R = 50;
const RING_C = 2 * Math.PI * RING_R;

function buildCard(machine) {
  const el = document.createElement('a');
  el.className = 'card';
  el.href = `/machine/${encodeURIComponent(machine.machineId)}`;
  el.setAttribute('aria-label', `Open details for ${machine.machineName || machine.machineId}`);
  el.dataset.status = machine.status;

  el.innerHTML = `
    <div class="card-head">
      <div>
        <div class="card-title" data-ref="title"></div>
        <div class="card-meta">
          <span class="chip" data-ref="type"></span>
          <span class="chip dept" data-ref="dept"></span>
        </div>
      </div>
      <span class="status-pill" data-ref="pill"><span class="dot"></span><span data-ref="pillText"></span></span>
    </div>

    <div class="card-hero" data-ref="hero">
      <div class="ring-wrap">
        <svg width="118" height="118" viewBox="0 0 118 118">
          <circle class="ring-track" cx="59" cy="59" r="${RING_R}"></circle>
          <circle class="ring-bar" cx="59" cy="59" r="${RING_R}"
            stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}" data-ref="ringBar"></circle>
        </svg>
        <div class="ring-center">
          <div class="ring-value mono" data-ref="curingLeft">–</div>
          <div class="ring-label">Curing left</div>
          <div class="ring-sub mono" data-ref="curingSet"></div>
        </div>
      </div>

      <div class="hero-right">
        <div class="metric-block">
          <div class="metric-label"><span>Pressure</span><span data-ref="pressurePct"></span></div>
          <div class="pressure-line">
            <span class="pressure-now mono" data-ref="pressureNow">–</span>
            <span class="pressure-target mono" data-ref="pressureTarget"></span>
          </div>
          <div class="bar"><div class="bar-fill" data-ref="pressureBar"></div></div>
        </div>
        <div class="hold-line" data-ref="holdLine">Press hold&nbsp;<b class="mono" data-ref="holdTime">–</b>&nbsp;·&nbsp;Bumps required&nbsp;<b class="mono" data-ref="bumpsReq">–</b></div>
      </div>
    </div>

    <div class="tiles">
      <div class="tile"><div class="tile-value mono" data-ref="cyclesTotal">–</div><div class="tile-label">Total cycles</div></div>
      <div class="tile"><div class="tile-value mono" data-ref="cyclesSession">–</div><div class="tile-label">Session cycles</div></div>
      <div class="tile"><div class="tile-value mono" data-ref="payloads">–</div><div class="tile-label">Payloads</div></div>
    </div>

    <div class="section" data-ref="extraSection" hidden>
      <div class="section-title"><span>Other metrics</span></div>
      <div class="tiles-inline" data-ref="extras"></div>
    </div>

    <div class="section" data-ref="bumpSection">
      <div class="section-title"><span>Bump profile</span></div>
      <div class="bumps" data-ref="bumps"></div>
    </div>

    <div class="section" data-ref="utilSection">
      <div class="section-title"><span>Utilization (current session)</span></div>
      <div class="util-bar">
        <div class="util-run" data-ref="utilRun"></div>
        <div class="util-idle" data-ref="utilIdle"></div>
      </div>
      <div class="util-legend">
        <span><span class="k" style="background:var(--running)"></span>Running seconds <b class="mono" data-ref="runTime">–</b></span>
        <span><span class="k" style="background:var(--idle)"></span>Idle seconds <b class="mono" data-ref="idleTime">–</b></span>
      </div>
    </div>

    <div class="section">
      <div class="section-title"><span>Pressure trend</span><span>last ${HISTORY_MINUTES} min</span></div>
      <div class="spark-wrap" data-ref="sparkWrap">
        <div class="spark-empty">Collecting data…</div>
      </div>
    </div>

    <div class="card-foot">
      <span class="fresh" data-ref="fresh">–</span>
      <span class="card-cta">View details <span class="arrow">→</span></span>
    </div>
  `;

  const refs = {};
  el.querySelectorAll('[data-ref]').forEach((n) => (refs[n.dataset.ref] = n));
  return { el, refs, lastSeenAt: null };
}

/* ── card updates ────────────────────────────────────── */

function updateCard(entry, m) {
  const { el, refs } = entry;
  const d = m.metrics || {};
  entry.lastSeenAt = m.lastSeenAt;

  el.dataset.status = m.status;
  refs.title.textContent = m.machineName;
  refs.type.textContent = m.machineType;
  refs.dept.textContent = d.dept ? `${d.dept} dept` : '';
  refs.dept.hidden = !d.dept;

  refs.pill.className = `status-pill ${m.status}`;
  refs.pillText.textContent = m.status;

  // Curing ring — fraction of set curing time remaining (raw server values).
  // Newer firmware reports curingTime instead of curingTimeSet.
  const curingSet = d.curingTimeSet ?? d.curingTime;
  if (has(curingSet) && curingSet > 0) {
    const left = Math.min(d.curingTimeLeft ?? 0, curingSet);
    refs.curingLeft.textContent = fmtInt(left);
    refs.curingSet.textContent = `of ${fmtInt(curingSet)}`;
    refs.ringBar.style.strokeDashoffset = RING_C * (1 - left / curingSet);
  } else {
    refs.curingLeft.textContent = '–';
    refs.curingSet.textContent = '';
    refs.ringBar.style.strokeDashoffset = RING_C;
  }

  // Pressure — current vs final target
  if (has(d.currentPressure) || has(d.finalPressure)) {
    refs.pressureNow.textContent = fmtInt(d.currentPressure);
    refs.pressureTarget.textContent = has(d.finalPressure) ? `/ ${fmtInt(d.finalPressure)}` : '';
    const pct = d.finalPressure > 0 ? Math.min(100, Math.round(((d.currentPressure || 0) / d.finalPressure) * 100)) : 0;
    refs.pressureBar.style.width = pct + '%';
    refs.pressurePct.textContent = d.finalPressure > 0 ? pct + '%' : '';
  }

  refs.holdLine.hidden = !(has(d.pressHoldTime) || has(d.totalBumpsReq));
  refs.holdTime.textContent = fmtInt(d.pressHoldTime);
  refs.bumpsReq.textContent = fmtInt(d.totalBumpsReq);

  // Any metrics without a dedicated widget render as generic tiles
  const extras = extraMetrics(d);
  refs.extraSection.hidden = extras.length === 0;
  refs.extras.innerHTML = extras
    .map(([k, v]) => `<div class="tile"><div class="tile-value mono">${fmtVal(v)}</div><div class="tile-label">${esc(humanize(k))}</div></div>`)
    .join('');

  refs.cyclesTotal.textContent = fmtInt(d.cyclesCompleted);
  refs.cyclesSession.textContent = fmtInt(d.cyclesSession);
  refs.payloads.textContent = fmtInt(m.payloadCount);

  // Bump profile — render whichever bumpNPressure fields the machine reports
  const bumpHtml = [];
  for (let i = 2; i <= 9; i++) {
    const p = d[`bump${i}Pressure`];
    if (!has(p)) continue;
    const hold = d[`bump${i}HoldTime`];
    const down = d[`bump${i}DownTime`];
    const extra = [has(hold) ? `hold ${hold}` : null, has(down) ? `down ${down}` : null].filter(Boolean).join('<br>');
    bumpHtml.push(`
      <div class="bump">
        <div class="bump-name">B${i}</div>
        <div class="bump-val mono">${fmtInt(p)}</div>
        ${extra ? `<div class="bump-extra mono">${extra}</div>` : ''}
      </div>`);
  }
  refs.bumpSection.hidden = bumpHtml.length === 0;
  refs.bumps.innerHTML = bumpHtml.join('');

  // Utilization split
  const run = d.runningSeconds ?? 0;
  const idle = d.idleSeconds ?? 0;
  const total = run + idle;
  refs.utilSection.hidden = !(has(d.runningSeconds) || has(d.idleSeconds));
  if (total > 0) {
    refs.utilRun.style.width = (run / total) * 100 + '%';
    refs.utilIdle.style.width = (idle / total) * 100 + '%';
  } else {
    refs.utilRun.style.width = '0%';
    refs.utilIdle.style.width = '0%';
  }
  refs.runTime.textContent = fmtInt(run);
  refs.idleTime.textContent = fmtInt(idle);

  updateFreshness(entry);
}

function updateFreshness(entry) {
  const { refs, lastSeenAt } = entry;
  refs.fresh.textContent = `updated ${fmtAgo(lastSeenAt)}`;
  const stale = !lastSeenAt || Date.now() - new Date(lastSeenAt).getTime() > 60000;
  refs.fresh.classList.toggle('stale', stale);
}

/* ── sparkline ───────────────────────────────────────── */

function renderSparkline(entry, points) {
  const wrap = entry.refs.sparkWrap;
  const usable = points.filter((p) => p.pressure != null);
  if (usable.length < 2) {
    wrap.innerHTML = '<div class="spark-empty">Not enough data yet</div>';
    return;
  }

  const W = 320, H = 52, PAD = 4;
  const t0 = new Date(usable[0].t).getTime();
  const t1 = new Date(usable[usable.length - 1].t).getTime();
  const span = Math.max(1, t1 - t0);
  const max = Math.max(...usable.map((p) => p.pressure), 1);

  const pts = usable.map((p) => {
    const x = PAD + ((new Date(p.t).getTime() - t0) / span) * (W - PAD * 2);
    const y = H - PAD - (p.pressure / max) * (H - PAD * 2);
    return [x, y];
  });

  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${H - PAD} L${pts[0][0].toFixed(1)},${H - PAD} Z`;

  wrap.innerHTML = `
    <svg class="spark-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path d="${area}" fill="rgba(77,163,255,0.14)"></path>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round"></path>
    </svg>`;
}

async function refreshHistory() {
  await Promise.all(
    [...cards.entries()].map(async ([machineId, entry]) => {
      try {
        const res = await fetch(`/api/machines/${encodeURIComponent(machineId)}/history?minutes=${HISTORY_MINUTES}`);
        if (!res.ok) return;
        const { points } = await res.json();
        renderSparkline(entry, points);
      } catch { /* keep last sparkline */ }
    })
  );
}

/* ── polling loop ────────────────────────────────────── */

async function refresh() {
  try {
    const res = await fetch('/api/machines');
    if (!res.ok) throw new Error(`API ${res.status}`);
    const { machines } = await res.json();

    errorBanner.hidden = true;
    const loading = document.getElementById('loading');
    if (loading) loading.remove();

    const seen = new Set();
    let firstLoad = false;

    for (const m of machines) {
      seen.add(m.machineId);
      let entry = cards.get(m.machineId);
      if (!entry) {
        entry = buildCard(m);
        cards.set(m.machineId, entry);
        grid.appendChild(entry.el);
        firstLoad = true;
      }
      updateCard(entry, m);
    }

    // drop cards for machines no longer registered
    for (const [id, entry] of cards) {
      if (!seen.has(id)) { entry.el.remove(); cards.delete(id); }
    }

    document.getElementById('stat-total').textContent = machines.length;
    document.getElementById('stat-online').textContent = machines.filter((m) => m.online).length;
    document.getElementById('stat-refresh').textContent = 'live · auto-refresh';

    if (firstLoad) refreshHistory();
  } catch (err) {
    errorBanner.textContent = `Cannot reach plant data API — retrying… (${err.message})`;
    errorBanner.hidden = false;
    document.getElementById('stat-refresh').textContent = 'reconnecting…';
  }
}

function tickClock() {
  document.getElementById('stat-clock').textContent = new Date().toLocaleTimeString('en-IN', { hour12: false });
  for (const entry of cards.values()) updateFreshness(entry);
}

refresh();
setInterval(refresh, POLL_MS);
setInterval(refreshHistory, HISTORY_POLL_MS);
setInterval(tickClock, 1000);
tickClock();
