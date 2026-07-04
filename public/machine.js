/* Machine detail page — /machine/:machineId
   Live view of one machine: full metrics, pressure trend with selectable
   range, bump profile table, utilization and raw PLC registers. */

const POLL_MS = 4000;
const HISTORY_POLL_MS = 15000;

const machineId = decodeURIComponent(window.location.pathname.split('/').pop() || '');

const detail = document.getElementById('detail');
const errorBanner = document.getElementById('error-banner');

let refs = null;
let lastSeenAt = null;
let historyMinutes = 15;
let historyTimer = null;

/* ── helpers (same conventions as the dashboard) ─────── */

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

function fmtDateTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

const has = (v) => v !== undefined && v !== null;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Fields already rendered by a dedicated widget; anything else the machine
// reports is shown dynamically in the "Other metrics" panel.
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

/* ── page skeleton ───────────────────────────────────── */

const RING_R = 50;
const RING_C = 2 * Math.PI * RING_R;

function buildPage() {
  detail.innerHTML = `
    <div class="panel detail-head-panel">
      <div class="detail-head">
        <div>
          <div class="detail-title" data-ref="title"></div>
          <div class="detail-sub">
            <span class="chip" data-ref="type"></span>
            <span class="chip dept" data-ref="dept"></span>
          </div>
          <div class="detail-updated" data-ref="updated"></div>
        </div>
        <span class="status-pill" data-ref="pill"><span class="dot"></span><span data-ref="pillText"></span></span>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="kpi-value mono" data-ref="kCycles">–</div><div class="kpi-label">Total cycles</div></div>
      <div class="kpi"><div class="kpi-value mono" data-ref="kSession">–</div><div class="kpi-label">Session cycles</div></div>
      <div class="kpi"><div class="kpi-value mono" data-ref="kCuring">–</div><div class="kpi-label">Curing time set</div></div>
      <div class="kpi"><div class="kpi-value mono" data-ref="kTarget">–</div><div class="kpi-label">Target pressure</div></div>
      <div class="kpi"><div class="kpi-value mono" data-ref="kPayloads">–</div><div class="kpi-label">Payloads received</div></div>
    </div>

    <div class="detail-grid">
      <div class="panel wide">
        <div class="panel-title">
          <span>Pressure trend</span>
          <span class="range-btns" data-ref="rangeBtns">
            <button class="range-btn active" data-minutes="15">15 min</button>
            <button class="range-btn" data-minutes="60">1 hr</button>
            <button class="range-btn" data-minutes="180">3 hr</button>
          </span>
        </div>
        <div data-ref="chart"><div class="chart-empty">Collecting data…</div></div>
      </div>

      <div class="panel" data-ref="heroPanel">
        <div class="panel-title"><span>Curing &amp; press</span></div>
        <div class="detail-hero" data-ref="hero">
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
      </div>

      <div class="panel">
        <div class="panel-title"><span>Bump profile</span></div>
        <table class="bump-table">
          <thead><tr><th>Bump</th><th>Pressure</th><th>Hold</th><th>Down</th></tr></thead>
          <tbody data-ref="bumpRows"></tbody>
        </table>
      </div>

      <div class="panel">
        <div class="panel-title"><span>Utilization (current session)</span></div>
        <div class="util-bar">
          <div class="util-run" data-ref="utilRun"></div>
          <div class="util-idle" data-ref="utilIdle"></div>
        </div>
        <div class="util-legend">
          <span><span class="k" style="background:var(--running)"></span>Running seconds <b class="mono" data-ref="runTime">–</b></span>
          <span><span class="k" style="background:#f0b64b"></span>Idle seconds <b class="mono" data-ref="idleTime">–</b></span>
        </div>
        <div class="info-list" style="margin-top:0.9rem">
          <div class="info-row"><span class="k">Running count</span><span class="v mono" data-ref="runCount">–</span></div>
          <div class="info-row"><span class="k">Idle count</span><span class="v mono" data-ref="idleCount">–</span></div>
        </div>
      </div>

      <div class="panel" data-ref="extraPanel" hidden>
        <div class="panel-title"><span>Other metrics</span></div>
        <div class="info-list" data-ref="extraRows"></div>
      </div>

      <div class="panel">
        <div class="panel-title"><span>Machine info</span></div>
        <div class="info-list">
          <div class="info-row"><span class="k">Machine ID</span><span class="v mono" data-ref="iId">–</span></div>
          <div class="info-row"><span class="k">Type</span><span class="v" data-ref="iType">–</span></div>
          <div class="info-row"><span class="k">Department</span><span class="v" data-ref="iDept">–</span></div>
          <div class="info-row"><span class="k">Registered</span><span class="v" data-ref="iReg">–</span></div>
          <div class="info-row"><span class="k">Last telemetry (server)</span><span class="v" data-ref="iSeen">–</span></div>
          <div class="info-row"><span class="k">Last telemetry (device)</span><span class="v" data-ref="iDevice">–</span></div>
          <div class="info-row"><span class="k">Metrics reported</span><span class="v mono" data-ref="iMetrics">–</span></div>
        </div>
      </div>

      <div class="panel wide">
        <div class="panel-title"><span>Telemetry history</span><span data-ref="telCount"></span></div>
        <div class="table-scroll">
          <table class="bump-table tel-table">
            <thead><tr>
              <th>Server time</th><th>Status</th><th>Pressure</th><th>Curing left</th>
              <th>Cycles</th><th>Session</th><th>Running s</th><th>Idle s</th>
            </tr></thead>
            <tbody data-ref="telRows"><tr><td colspan="8" style="color:var(--faint)">Loading…</td></tr></tbody>
          </table>
        </div>
      </div>

      <div class="panel wide" data-ref="regPanel">
        <div class="panel-title"><span>Raw PLC registers</span><span data-ref="regCount"></span></div>
        <div class="registers" data-ref="registers"></div>
      </div>
    </div>
  `;

  refs = {};
  detail.querySelectorAll('[data-ref]').forEach((n) => (refs[n.dataset.ref] = n));

  refs.rangeBtns.addEventListener('click', (e) => {
    const btn = e.target.closest('.range-btn');
    if (!btn) return;
    historyMinutes = parseInt(btn.dataset.minutes, 10);
    refs.rangeBtns.querySelectorAll('.range-btn').forEach((b) => b.classList.toggle('active', b === btn));
    refreshHistory();
  });
}

/* ── updates ─────────────────────────────────────────── */

function update(m) {
  const d = m.metrics || {};
  lastSeenAt = m.lastSeenAt;

  document.title = `${m.machineName} · Supreme Rubber Industries`;
  detail.dataset.status = m.status;

  refs.title.textContent = m.machineName;
  refs.type.textContent = m.machineType;
  refs.dept.textContent = d.dept ? `${d.dept} dept` : '';
  refs.dept.hidden = !d.dept;
  refs.pill.className = `status-pill ${m.status}`;
  refs.pillText.textContent = m.status;

  // Newer firmware reports curingTime instead of curingTimeSet.
  const curingSet = d.curingTimeSet ?? d.curingTime;

  refs.kCycles.textContent = fmtInt(d.cyclesCompleted);
  refs.kSession.textContent = fmtInt(d.cyclesSession);
  refs.kCuring.textContent = fmtInt(curingSet);
  refs.kTarget.textContent = has(d.finalPressure) ? fmtInt(d.finalPressure) : '–';
  refs.kPayloads.textContent = fmtInt(m.payloadCount);

  // curing ring (raw server values)
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

  // pressure
  refs.pressureNow.textContent = fmtInt(d.currentPressure);
  refs.pressureTarget.textContent = has(d.finalPressure) ? `/ ${fmtInt(d.finalPressure)}` : '';
  const pct = d.finalPressure > 0 ? Math.min(100, Math.round(((d.currentPressure || 0) / d.finalPressure) * 100)) : 0;
  refs.pressureBar.style.width = pct + '%';
  refs.pressurePct.textContent = d.finalPressure > 0 ? pct + '%' : '';
  refs.holdLine.hidden = !(has(d.pressHoldTime) || has(d.totalBumpsReq));
  refs.holdTime.textContent = fmtInt(d.pressHoldTime);
  refs.bumpsReq.textContent = fmtInt(d.totalBumpsReq);

  // bump table
  const rows = [];
  for (let i = 2; i <= 9; i++) {
    const p = d[`bump${i}Pressure`];
    if (!has(p)) continue;
    const hold = d[`bump${i}HoldTime`];
    const down = d[`bump${i}DownTime`];
    rows.push(`<tr>
      <td>Bump ${i}</td>
      <td class="num mono">${fmtInt(p)}</td>
      <td class="num mono">${has(hold) ? esc(hold) : '–'}</td>
      <td class="num mono">${has(down) ? esc(down) : '–'}</td>
    </tr>`);
  }
  refs.bumpRows.innerHTML = rows.join('') || '<tr><td colspan="4" style="color:var(--faint)">No bump data reported</td></tr>';

  // utilization
  const run = d.runningSeconds ?? 0;
  const idle = d.idleSeconds ?? 0;
  const total = run + idle;
  refs.utilRun.style.width = total > 0 ? (run / total) * 100 + '%' : '0%';
  refs.utilIdle.style.width = total > 0 ? (idle / total) * 100 + '%' : '0%';
  refs.runTime.textContent = fmtInt(run);
  refs.idleTime.textContent = fmtInt(idle);
  refs.runCount.textContent = fmtInt(d.runningCount);
  refs.idleCount.textContent = fmtInt(d.idleCount);

  // any metrics without a dedicated widget render as generic rows
  const extras = extraMetrics(d);
  refs.extraPanel.hidden = extras.length === 0;
  refs.extraRows.innerHTML = extras
    .map(([k, v]) => `<div class="info-row"><span class="k">${esc(humanize(k))}</span><span class="v mono">${fmtVal(v)}</span></div>`)
    .join('');

  // machine info
  refs.iId.textContent = m.machineId;
  refs.iType.textContent = m.machineType || '–';
  refs.iDept.textContent = d.dept || '–';
  refs.iReg.textContent = fmtDateTime(m.registeredAt);
  refs.iSeen.textContent = fmtDateTime(m.lastSeenAt);
  refs.iDevice.textContent = fmtDateTime(m.deviceTs);
  refs.iMetrics.textContent = (m.metricsSeen || []).length || '–';

  // raw registers, sorted by register number
  const regs = d.rawRegisters || {};
  const keys = Object.keys(regs).sort((a, b) => (parseInt(a.replace(/\D/g, ''), 10) || 0) - (parseInt(b.replace(/\D/g, ''), 10) || 0));
  refs.regPanel.hidden = keys.length === 0;
  refs.regCount.textContent = keys.length ? `${keys.length} registers` : '';
  refs.registers.innerHTML = keys
    .map((k) => `<div class="reg"><div class="reg-name mono">${esc(k)}</div><div class="reg-val mono">${fmtInt(regs[k])}</div></div>`)
    .join('');

  updateFreshness();
}

function updateFreshness() {
  if (!refs) return;
  refs.updated.textContent = `Last update ${fmtAgo(lastSeenAt)}`;
  const stale = !lastSeenAt || Date.now() - new Date(lastSeenAt).getTime() > 60000;
  refs.updated.classList.toggle('stale', stale);
}

/* ── chart with axes ─────────────────────────────────── */

function renderChart(points) {
  const wrap = refs.chart;
  const usable = points.filter((p) => p.pressure != null);
  if (usable.length < 2) {
    wrap.innerHTML = '<div class="chart-empty">Not enough data in this range yet</div>';
    return;
  }

  const W = 860, H = 240, L = 46, R = 12, T = 12, B = 26;
  const t0 = new Date(usable[0].t).getTime();
  const t1 = new Date(usable[usable.length - 1].t).getTime();
  const span = Math.max(1, t1 - t0);
  const rawMax = Math.max(...usable.map((p) => p.pressure));
  const max = Math.max(10, Math.ceil(rawMax * 1.1));

  const x = (t) => L + ((new Date(t).getTime() - t0) / span) * (W - L - R);
  const y = (v) => T + (1 - v / max) * (H - T - B);

  const pts = usable.map((p) => [x(p.t), y(p.pressure)]);
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${y(0)} L${pts[0][0].toFixed(1)},${y(0)} Z`;

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = Math.round(max * f);
    const gy = y(v);
    return `<line x1="${L}" y1="${gy}" x2="${W - R}" y2="${gy}" stroke="#eef1f6" stroke-width="1"></line>
            <text x="${L - 7}" y="${gy + 3.5}" text-anchor="end" font-size="10" fill="#8a97a8" font-family="JetBrains Mono, monospace">${v}</text>`;
  }).join('');

  const timeFmt = (t) => new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const xLabels = `
    <text x="${L}" y="${H - 8}" font-size="10" fill="#8a97a8" font-family="JetBrains Mono, monospace">${timeFmt(usable[0].t)}</text>
    <text x="${W - R}" y="${H - 8}" text-anchor="end" font-size="10" fill="#8a97a8" font-family="JetBrains Mono, monospace">${timeFmt(usable[usable.length - 1].t)}</text>`;

  wrap.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      ${gridLines}
      <path d="${area}" fill="rgba(47,111,228,0.10)"></path>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linejoin="round"></path>
      ${xLabels}
    </svg>`;
}

/* ── data loading ────────────────────────────────────── */

async function refresh() {
  try {
    const res = await fetch(`/api/machines/${encodeURIComponent(machineId)}`);
    if (res.status === 404) {
      detail.innerHTML = `
        <div class="panel detail-error">
          <h2>Machine not found</h2>
          <p>No machine with ID “${esc(machineId)}” is registered.</p>
        </div>`;
      refs = null;
      return;
    }
    if (!res.ok) throw new Error(`API ${res.status}`);
    const m = await res.json();

    errorBanner.hidden = true;
    const loading = document.getElementById('loading');
    if (loading) { loading.remove(); buildPage(); refreshHistory(); refreshTelemetry(); }
    if (refs) update(m);
  } catch (err) {
    errorBanner.textContent = `Cannot reach plant data API — retrying… (${err.message})`;
    errorBanner.hidden = false;
  }
}

async function refreshHistory() {
  if (!refs) return;
  try {
    const res = await fetch(`/api/machines/${encodeURIComponent(machineId)}/history?minutes=${historyMinutes}`);
    if (!res.ok) return;
    const { points } = await res.json();
    renderChart(points);
  } catch { /* keep last chart */ }
}

/* ── telemetry history table ─────────────────────────── */

function fmtTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

async function refreshTelemetry() {
  if (!refs || !refs.telRows) return;
  try {
    const res = await fetch(`/api/machines/${encodeURIComponent(machineId)}/telemetry?limit=30`);
    if (!res.ok) return;
    const { records } = await res.json();
    if (!records.length) {
      refs.telRows.innerHTML = '<tr><td colspan="8" style="color:var(--faint)">No telemetry recorded yet</td></tr>';
      refs.telCount.textContent = '';
      return;
    }
    refs.telCount.textContent = `last ${records.length} records`;
    refs.telRows.innerHTML = records.map((r) => `<tr>
      <td class="mono">${fmtTime(r.serverTs)}</td>
      <td><span class="status-pill mini ${esc(r.status || 'unknown')}"><span class="dot"></span>${esc(r.status || '–')}</span></td>
      <td class="num mono">${fmtInt(r.currentPressure)}</td>
      <td class="num mono">${fmtInt(r.curingTimeLeft)}</td>
      <td class="num mono">${fmtInt(r.cyclesCompleted)}</td>
      <td class="num mono">${fmtInt(r.cyclesSession)}</td>
      <td class="num mono">${fmtInt(r.runningSeconds)}</td>
      <td class="num mono">${fmtInt(r.idleSeconds)}</td>
    </tr>`).join('');
  } catch { /* keep last table */ }
}

refresh();
setInterval(refresh, POLL_MS);
historyTimer = setInterval(refreshHistory, HISTORY_POLL_MS);
setInterval(refreshTelemetry, HISTORY_POLL_MS);
setInterval(updateFreshness, 1000);
