// CLIO admin console: vanilla JS, sidebar shell, header-authenticated API.
// Sections: overview, departments, whatsapp, brand, report,
// delivery, schedule, archive, project.
(() => {
  'use strict';

  // ── State ─────────────────────────────────────────────────
  const state = {
    pw: sessionStorage.getItem('clio_admin_pw') || '',
    today: null,          // server-local today (from /api/status)
    viewDate: null,       // date shown on the overview
    status: null,         // last /api/status payload
    settings: null,       // last /api/admin/settings payload
    pmEmails: [],
    reportConfig: {},
    logsLoaded: false,
    overviewTimer: null,
    departments: [],          // last /api/admin/departments payload (Departments section)
    previewData: null,        // last /api/admin/report-preview-data payload
    trueImages: [],           // rendered slide image URLs (True preview tab)
    trueIdx: 0,               // selected slide in the filmstrip
    waTimer: null,            // WhatsApp inbox poll (10s while section visible)
    waThreads: [],            // last /api/admin/whatsapp/threads payload
    waActiveId: null,         // open thread id, null when nothing selected
    waSearch: '',             // client-side thread filter
    archiveCache: new Map(),  // date -> /api/archive/{date} payload (drawer data)
    drawerDept: null,         // department row shown in the detail drawer
    drawerReturnFocus: null   // element to refocus when the drawer closes
  };

  // ── DOM utils ─────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function timeOnly(stamp) {
    if (!stamp) return '';
    const m = String(stamp).match(/(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : '';
  }

  function longDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  function shortDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).toUpperCase();
  }

  function shiftDate(iso, days) {
    // Format locally: toISOString would shift the day in non-UTC timezones.
    const d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + days);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // ── Toasts ────────────────────────────────────────────────
  function toast(msg, opts = {}) {
    const el = document.createElement('div');
    el.className = 'toast' + (opts.err ? ' err' : '');
    el.innerHTML = `<span class="t-dot"></span><span>${escapeHtml(msg)}</span>`;
    if (opts.action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 't-act';
      btn.textContent = opts.action.label;
      btn.addEventListener('click', () => { opts.action.fn(); dismiss(); });
      el.appendChild(btn);
    }
    $('toast-stack').appendChild(el);
    let gone = false;
    function dismiss() {
      if (gone) return; gone = true;
      el.classList.add('out');
      setTimeout(() => el.remove(), 260);
    }
    setTimeout(dismiss, opts.action ? 9000 : 4000);
    el.addEventListener('click', e => { if (e.target === el || e.target.tagName === 'SPAN') dismiss(); });
  }

  // ── API (header auth everywhere; archive photo URLs excepted) ──
  async function api(path, opts = {}) {
    const headers = { 'x-admin-password': state.pw, ...(opts.headers || {}) };
    let body = opts.body;
    if (body !== undefined && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const res = await fetch(path, { method: opts.method || 'GET', headers, body });
    if (res.status === 401) {
      logout();
      throw new Error('unauthorized');
    }
    return res;
  }

  async function apiJson(path, opts = {}) {
    const res = await api(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function fetchSettings() {
    state.settings = await apiJson('/api/admin/settings');
    return state.settings;
  }

  async function fetchStatus() {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('status fetch failed');
    state.status = await res.json();
    return state.status;
  }

  // ── Auth ──────────────────────────────────────────────────
  async function verify(pw) {
    const res = await fetch('/api/admin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    return res.ok;
  }

  function logout() {
    if (state.overviewTimer) { clearInterval(state.overviewTimer); state.overviewTimer = null; }
    if (state.waTimer) { clearInterval(state.waTimer); state.waTimer = null; }
    sessionStorage.removeItem('clio_admin_pw');
    state.pw = '';
    $('shell').hidden = true;
    $('gate').style.display = 'flex';
  }

  async function tryLogin() {
    const pw = $('gate-pw').value;
    if (!pw) return;
    const btn = $('gate-btn');
    btn.disabled = true;
    const ok = await verify(pw).catch(() => false);
    btn.disabled = false;
    if (!ok) { $('gate-err').classList.add('show'); return; }
    $('gate-err').classList.remove('show');
    state.pw = pw;
    sessionStorage.setItem('clio_admin_pw', pw);
    enterConsole();
  }

  async function enterConsole() {
    $('gate').style.display = 'none';
    $('shell').hidden = false;
    await refreshChrome();
    state.viewDate = state.today;
    try { await fetchSettings(); } catch {}
    loadOverview();
    clearInterval(state.overviewTimer);
    state.overviewTimer = setInterval(() => {
      if ($('sec-overview').classList.contains('on')) loadOverview({ quiet: true });
    }, 60000);
  }

  // Sidebar lockup + env line, from public status (brand-driven)
  async function refreshChrome() {
    try {
      const s = await fetchStatus();
      state.today = s.date;
      applyLockup(s);
    } catch {
      state.today = new Date().toISOString().slice(0, 10);
    }
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    $('env-line').textContent = local ? '● LOCAL' : '● LIVE';
  }

  function applyLockup(s) {
    const company = (s.brand && s.brand.company_name) || '';
    for (const [markId, nameId] of [['side-mark', 'side-name'], ['gate-mark', 'gate-name']]) {
      const mark = $(markId);
      if (s.logo_url) mark.innerHTML = `<img src="${escapeHtml(s.logo_url)}" alt="" />`;
      else mark.textContent = (company || 'C').slice(0, 1).toUpperCase();
      $(nameId).textContent = company || 'CLIO';
    }
    $('side-sub').textContent = s.event_name || 'Admin Console';
  }

  // ── Navigation ────────────────────────────────────────────
  const loaders = {
    overview: () => loadOverview(),
    departments: () => loadDepartments(),
    whatsapp: () => loadWhatsapp(),
    brand: () => loadBrand(),
    report: () => loadReport(),
    delivery: () => loadDelivery(),
    schedule: () => loadSchedule(),
    archive: () => loadArchive(),
    project: () => loadProject()
  };

  function initNav() {
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('on', n === item));
        document.querySelectorAll('.admin-section').forEach(sec =>
          sec.classList.toggle('on', sec.id === `sec-${item.dataset.sec}`));
        const load = loaders[item.dataset.sec];
        if (load) load();
      });
    });
  }

  // ══════════════════════════════════════════════════════════
  // OVERVIEW
  // ══════════════════════════════════════════════════════════
  async function loadOverview(opts = {}) {
    if (!state.viewDate) state.viewDate = state.today;
    const date = state.viewDate;
    refreshWaBadge(); // keep the sidebar WhatsApp unread count fresh

    let depts = [], subs = [];
    try {
      [depts, subs] = await Promise.all([
        apiJson('/api/admin/departments'),
        apiJson(`/api/report/${date}`)
      ]);
    } catch (err) {
      if (!opts.quiet) toast('Failed to load overview: ' + err.message, { err: true });
      return;
    }

    const isToday = date === state.today;
    $('ov-title').textContent = (isToday ? 'Tonight · ' : '') + longDate(date);
    $('ov-date').textContent = date;
    $('date-next').disabled = date >= state.today;
    $('date-next').style.opacity = date >= state.today ? 0.3 : 1;

    // Fresh overview data invalidates the drawer's archive cache for this date.
    state.archiveCache.delete(date);

    const byDept = new Map(subs.map(r => [r.department_id, r]));
    const withContact = depts.filter(d => (d.head_email || '').trim() || (d.head_whatsapp || '').trim());
    // Denominator is every department: the report covers all streams,
    // whether or not the HOD has contact details on file.
    const denom = depts.length;
    const submitted = subs.length;
    const pendingWithContact = withContact.filter(d => !byDept.has(d.id));
    const unreachable = depts.filter(d => !byDept.has(d.id) && !withContact.includes(d));

    // KPI: submitted
    const kSub = $('kpi-submitted');
    kSub.querySelector('.k-val').innerHTML = `${submitted}<small>/${denom}</small>`;
    const pendingNames = depts.filter(d => !byDept.has(d.id)).map(d => d.name);
    kSub.querySelector('.k-hint').textContent = pendingNames.length
      ? `${pendingNames.slice(0, 2).map(cap).join(' + ')}${pendingNames.length > 2 ? ` +${pendingNames.length - 2}` : ''} pending`
      : 'All streams filed';
    kSub.className = 'kpi' + (submitted >= denom && denom > 0 ? ' good' : '');

    // KPI: avg progress
    const avg = subs.length ? Math.round(subs.reduce((a, r) => a + (r.overall_progress || 0), 0) / subs.length) : 0;
    $('kpi-progress').querySelector('.k-val').innerHTML = subs.length ? `${avg}<small>%</small>` : '·';
    $('kpi-progress').querySelector('.k-hint').textContent = subs.length ? `Across ${subs.length} submitted stream${subs.length !== 1 ? 's' : ''}` : 'No submissions yet';

    // KPI: blockers
    const blocked = subs.filter(r => ((r.polished_blockers || r.blockers) || '').trim());
    const kBlk = $('kpi-blockers');
    kBlk.querySelector('.k-val').textContent = String(blocked.length);
    kBlk.querySelector('.k-hint').textContent = blocked.length
      ? blocked.slice(0, 3).map(r => cap(r.department_name)).join(', ')
      : 'Nothing reported';
    kBlk.className = 'kpi' + (blocked.length ? ' warn' : '');

    // KPI: report
    const reportTime = (state.status && state.status.report_time) || '23:00';
    const kRep = $('kpi-report');
    kRep.querySelector('.k-val').textContent = `Runs ${reportTime}`;
    const dc = (state.settings && state.settings.delivery_config) || {};
    const pmCount = ((state.settings && state.settings.pm_emails) || []).length;
    kRep.querySelector('.k-hint').textContent = dc.auto_email
      ? `Auto-email: ${pmCount} recipient${pmCount !== 1 ? 's' : ''}`
      : 'Auto-email off';

    renderStreams(depts, byDept);
    renderDonut(depts, submitted, pendingWithContact.length, unreachable.length, denom);

    $('ov-report-title').textContent = isToday ? "Tonight's Report" : `Report · ${shortDate(date)}`;
    $('act-remind-kbd').textContent = pendingWithContact.length ? `${pendingWithContact.length} PENDING` : 'ALL FILED';
    $('act-download-kbd').textContent = shortDate(date);
  }

  function cap(s) {
    return String(s || '').toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
  }

  function streamRow(d, byDept, opts) {
    const sub = byDept.get(d.id);
    const row = document.createElement('div');
    row.className = 'sub-row rowlink' + (sub ? '' : ' missing') + ((opts && opts.indent) ? ' sub-row-child' : '');
    const pct = sub ? (sub.overall_progress || 0) : 0;
    row.innerHTML = `
      <span class="swatch-dot" style="background:${escapeHtml(sub ? d.stream_color : 'var(--muted)')}"></span>
      <span class="sd-name">${escapeHtml(d.name)}</span>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <span class="pct">${sub ? pct + '%' : '·'}</span>
      ${sub
        ? `<span class="time">${escapeHtml(timeOnly(sub.submitted_at))}</span>`
        : `<button type="button" class="nudge" data-id="${d.id}" data-name="${escapeHtml(d.name)}">NUDGE</button>`}
    `;
    // Whole row opens the submission drawer; keyboard reachable.
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `${d.name}: open submission details`);
    row.addEventListener('click', () => openStreamDrawer(d));
    row.addEventListener('keydown', e => {
      if (e.target !== row) return; // let the NUDGE button keep its own keys
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStreamDrawer(d); }
    });
    return row;
  }

  // Group departments one level deep. Orphaned parent_id (target missing)
  // falls back to top-level rendering.
  function groupByParent(depts) {
    const ids = new Set(depts.map(d => d.id));
    const parents = depts.filter(d => !d.parent_id || !ids.has(d.parent_id));
    const childrenOf = (pid) => depts.filter(d => d.parent_id === pid);
    return { parents, childrenOf };
  }

  function renderStreams(depts, byDept) {
    const box = $('ov-streams');
    box.innerHTML = '';
    if (!depts.length) {
      box.innerHTML = '<p class="panel-note">No departments configured yet.</p>';
      return;
    }
    const { parents, childrenOf } = groupByParent(depts);
    parents.forEach(p => {
      const kids = childrenOf(p.id);
      if (!kids.length) {
        box.appendChild(streamRow(p, byDept));
        return;
      }
      const header = document.createElement('div');
      header.className = 'sub-row-group-header';
      header.innerHTML = `<span class="swatch-dot" style="background:${escapeHtml(p.stream_color || '#3B82F6')}"></span>${escapeHtml(p.name)}`;
      box.appendChild(header);
      if (byDept.has(p.id)) box.appendChild(streamRow(p, byDept, { indent: true }));
      kids.forEach(k => box.appendChild(streamRow(k, byDept, { indent: true })));
    });
    box.querySelectorAll('.nudge').forEach(btn => {
      // stopPropagation keeps the row click (drawer) from firing on NUDGE.
      btn.addEventListener('click', (e) => { e.stopPropagation(); nudge(btn); });
    });
  }

  async function nudge(btn) {
    const name = btn.dataset.name;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const data = await apiJson('/api/admin/send-reminders', {
        method: 'POST',
        body: { department_id: Number(btn.dataset.id) }
      });
      if ((data.reminded || []).length) toast(`Reminder sent to ${cap(name)}`);
      else toast(`No reminder went out for ${cap(name)}. Check the HOD contact details.`, { err: true });
    } catch (err) {
      toast('Reminder failed: ' + err.message, { err: true });
    }
    btn.disabled = false;
    btn.textContent = 'NUDGE';
  }

  function renderDonut(depts, submitted, pending, unreachable, denom) {
    const total = depts.length || 1;
    const g = (submitted / total) * 360;
    const a = ((submitted + pending) / total) * 360;
    $('ov-donut').style.background =
      `conic-gradient(var(--green) 0 ${g}deg, var(--amber) ${g}deg ${a}deg, var(--border) ${a}deg 360deg)`;
    $('ov-donut-pct').textContent = denom ? `${Math.round((submitted / denom) * 100)}%` : '·';
    const legend = $('ov-legend');
    legend.innerHTML = `
      <div class="l-row"><span class="l-dot" style="background:var(--green)"></span>${submitted} submitted</div>
      <div class="l-row"><span class="l-dot" style="background:var(--amber)"></span>${pending} pending</div>
      <div class="l-row"><span class="l-dot" style="background:var(--border)"></span>${unreachable} no contact</div>
    `;
  }

  // ── Submission detail drawer ──────────────────────────────
  async function fetchArchiveDate(date) {
    if (state.archiveCache.has(date)) return state.archiveCache.get(date);
    const data = await apiJson(`/api/archive/${date}`);
    state.archiveCache.set(date, data);
    return data;
  }

  function openStreamDrawer(d) {
    state.drawerDept = d;
    state.drawerReturnFocus = document.activeElement;
    $('drawer-dot').style.background = d.stream_color || 'var(--muted)';
    $('drawer-title').textContent = cap(d.name);
    $('drawer-body').innerHTML = '<p class="panel-note">Loading&hellip;</p>';
    $('drawer-overlay').hidden = false;
    $('drawer-close').focus();
    renderDrawer(d);
  }

  function closeDrawer() {
    if ($('drawer-overlay').hidden) return;
    $('drawer-overlay').hidden = true;
    state.drawerDept = null;
    const back = state.drawerReturnFocus;
    state.drawerReturnFocus = null;
    if (back && document.contains(back)) back.focus();
  }

  async function renderDrawer(d) {
    const date = state.viewDate;
    const body = $('drawer-body');
    let arch;
    try { arch = await fetchArchiveDate(date); }
    catch (err) {
      if (state.drawerDept !== d) return;
      body.innerHTML = `<p class="panel-note">Could not load details: ${escapeHtml(err.message)}</p>`;
      return;
    }
    if (state.drawerDept !== d) return; // drawer moved on or closed mid-flight

    const row = (arch.departments || []).find(x => x.department === d.name);
    const sub = row && row.submission;
    if (!sub) { renderDrawerPending(d, date); return; }

    const fields = [
      ['Status', sub.status_text],
      ['Highlights', sub.highlights],
      ['Blockers', sub.blockers, true]
    ].filter(([, v]) => (v || '').trim())
      .map(([label, v, danger]) =>
        `<div class="arch-field"><div class="af-label${danger ? ' blocked' : ''}">${label}</div><div class="af-text">${escapeHtml(v)}</div></div>`
      ).join('');

    const sched = (sub.schedule_updates || []).map(r =>
      `<div class="af-text" style="font-size:11.5px;"><span style="font-family:var(--mono);color:var(--accent-2);">${escapeHtml(r.time || '')}</span> ${escapeHtml(r.activity || '')} <span style="color:var(--muted);font-family:var(--mono);font-size:9.5px;">${escapeHtml((r.status || '').toUpperCase())}</span></div>`
    ).join('');

    // Photo URLs carry the password: <img> tags cannot send headers.
    const photos = (row.photos || []).map(p => {
      const base = String(p.url || '').split('?')[0];
      const src = `${base}?password=${encodeURIComponent(state.pw)}`;
      return `<a href="${escapeHtml(src)}" target="_blank" rel="noopener"><img src="${escapeHtml(src)}" alt="${escapeHtml(p.filename || '')}" loading="lazy" /></a>`;
    }).join('');

    const pct = sub.overall_progress || 0;
    body.innerHTML = `
      <div class="drawer-meta">
        <span class="st ok">SUBMITTED ${escapeHtml(timeOnly(sub.submitted_at))}</span>
        <span class="pill">${escapeHtml(date)}</span>
      </div>
      <div class="arch-field" style="margin-top:0;">
        <div class="af-label">Progress</div>
        <div class="ro-progress"><div class="bar"><i style="width:${pct}%"></i></div><span class="pct">${pct}%</span></div>
      </div>
      ${fields}
      ${sched ? `<div class="arch-field"><div class="af-label">Schedule</div>${sched}</div>` : ''}
      ${photos ? `<div class="arch-field"><div class="af-label">Photos</div><div class="arch-photos">${photos}</div></div>` : ''}
    `;
  }

  function renderDrawerPending(d, date) {
    const body = $('drawer-body');
    const contact = [
      d.head_name ? `<b>${escapeHtml(d.head_name)}</b>` : '<span style="color:var(--muted)">No HOD name set</span>',
      d.head_email ? escapeHtml(d.head_email) : null,
      d.head_whatsapp ? escapeHtml(d.head_whatsapp) : null
    ].filter(Boolean).join('<br>');
    const reachable = (d.head_email || '').trim() || (d.head_whatsapp || '').trim();
    body.innerHTML = `
      <div class="drawer-pending">No submission yet for ${escapeHtml(date)}.</div>
      <div class="arch-field">
        <div class="af-label">HOD contact</div>
        <div class="af-text">${contact}</div>
      </div>
      ${reachable
        ? `<button type="button" class="nudge" data-id="${d.id}" data-name="${escapeHtml(d.name)}">NUDGE</button>`
        : '<p class="panel-note" style="margin-top:14px;">No email or WhatsApp on file, so a nudge cannot reach this HOD. Add contact details under Departments.</p>'}
    `;
    const btn = body.querySelector('.nudge');
    if (btn) btn.addEventListener('click', () => nudge(btn));
  }

  async function generateReport() {
    const date = state.viewDate;
    const btn = $('act-generate');
    btn.disabled = true;
    const prev = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span> Generating…<span class="kbd">PPTX</span>';
    try {
      await apiJson('/api/generate-report', { method: 'POST', body: { date } });
      toast(`Report generated for ${date}`, {
        action: { label: 'Download', fn: () => downloadReport(date) }
      });
    } catch (err) {
      toast('Generation failed: ' + err.message, { err: true });
    }
    btn.disabled = false;
    btn.innerHTML = prev;
  }

  async function downloadReport(date) {
    try {
      const res = await api(`/api/admin/download/${date}`);
      if (!res.ok) {
        toast(`No report generated for ${date} yet.`, { err: true });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `CLIO_${date}.pptx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      toast('Download failed: ' + err.message, { err: true });
    }
  }

  async function remindAll() {
    const btn = $('act-remind');
    btn.disabled = true;
    try {
      const data = await apiJson('/api/admin/send-reminders', { method: 'POST', body: {} });
      const names = data.reminded || [];
      toast(names.length ? `Reminders sent: ${names.map(cap).join(', ')}` : 'Nobody to remind. All streams filed or no contacts set.');
    } catch (err) {
      toast('Reminders failed: ' + err.message, { err: true });
    }
    btn.disabled = false;
  }

  async function loadLogs() {
    try {
      const rows = await apiJson('/api/admin/logs');
      $('log-rows').innerHTML = rows.length
        ? rows.map(r =>
            `<div><time>${escapeHtml(r.timestamp || '')}</time><b>${escapeHtml(r.department_name || 'SYSTEM')}</b> · ${escapeHtml(r.action || '')}</div>`
          ).join('')
        : '<p class="panel-note">No activity yet.</p>';
      state.logsLoaded = true;
    } catch (err) {
      $('log-rows').innerHTML = `<p class="panel-note">Could not load the log: ${escapeHtml(err.message)}</p>`;
    }
  }

  // ══════════════════════════════════════════════════════════
  // DEPARTMENTS
  // ══════════════════════════════════════════════════════════
  async function loadDepartments() {
    let depts;
    try { depts = await apiJson('/api/admin/departments'); }
    catch (err) { toast('Failed to load departments: ' + err.message, { err: true }); return; }
    state.departments = depts;
    const list = $('dept-list');
    list.innerHTML = '';
    if (!depts.length) { list.innerHTML = '<p class="panel-note">No departments yet. Add the first one.</p>'; return; }

    const { parents, childrenOf } = groupByParent(depts);
    parents.forEach(p => {
      list.appendChild(deptRow(p, depts));
      childrenOf(p.id).forEach(c => list.appendChild(deptRow(c, depts, { indent: true })));
    });
  }

  function deptRow(d, allDepts, opts) {
    const row = document.createElement('div');
    row.className = 'dept-admin-row' + ((opts && opts.indent) ? ' dept-admin-row-child' : '');
    row.innerHTML = `
      <div class="dept-admin-head">
        <span class="swatch-dot" style="background:${escapeHtml(d.stream_color || '#3B82F6')}"></span>
        <span class="da-name">${escapeHtml(d.name)}</span>
        <span class="da-meta"><b>${escapeHtml(d.head_name || 'No HOD')}</b>
          ${d.head_email ? ' · ' + escapeHtml(d.head_email) : ''}
          ${d.head_whatsapp ? ' · ' + escapeHtml(d.head_whatsapp) : ''}
          ${(d.has_credentials && d.username) ? ' · @' + escapeHtml(d.username) : ''}</span>
        <span class="da-actions">
          <button type="button" class="btn-sm edit">Edit</button>
          <button type="button" class="btn-sm danger del">Delete</button>
        </span>
      </div>
    `;
    row.querySelector('.edit').addEventListener('click', () => {
      const open = row.querySelector('.dept-editor');
      if (open) { open.remove(); return; }
      document.querySelectorAll('.dept-editor').forEach(e => e.remove());
      row.appendChild(deptEditor(d, allDepts));
    });
    row.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`Delete department "${d.name}"? This cannot be undone.`)) return;
      try {
        await apiJson(`/api/admin/departments/${d.id}`, { method: 'DELETE' });
        toast(`${cap(d.name)} deleted`);
        loadDepartments();
      } catch (err) { toast('Delete failed: ' + err.message, { err: true }); }
    });
    return row;
  }

  function deptEditor(d, allDepts) {
    const isNew = !d.id;
    const wrap = document.createElement('div');
    wrap.className = 'dept-editor';
    const color = d.stream_color || '#3B82F6';

    // Parent selector: only top-level departments (excluding self) qualify.
    // A department that already has children of its own cannot take a parent.
    const depts = allDepts || [];
    const isParentOfSomeone = depts.some(x => x.parent_id === d.id);
    const parentChoices = depts.filter(x => !x.parent_id && x.id !== d.id);
    const parentField = isParentOfSomeone
      ? `<div class="field"><label>Parent department</label>
           <p class="panel-note" style="margin:0;">This department has children, so it cannot itself be nested.</p></div>`
      : `<div class="field"><label>Parent department <span class="opt">optional</span></label>
           <select class="input" data-f="parent_id">
             <option value="">None (top level)</option>
             ${parentChoices.map(p => `<option value="${p.id}" ${d.parent_id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
           </select></div>`;

    // Credentials block (existing departments only: a new one has no id yet).
    // Mirrors the server's default username pattern: slug, lowercased, dots.
    const defaultUsername = (d.name || '')
      .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')
      .toLowerCase().replace(/_/g, '.');
    const credBlock = isNew ? '' : `
      <div class="cred-block">
        <div class="cred-title">Portal login</div>
        ${d.has_credentials ? `
          <div class="cred-row">
            <span class="cred-user">${escapeHtml(d.username || '')}</span>
            <button type="button" class="btn-sm cred-regen">Regenerate password</button>
            <button type="button" class="btn-sm danger cred-revoke">Revoke</button>
          </div>` : `
          <div class="cred-row">
            <input type="text" class="input cred-username" value="${escapeHtml(defaultUsername)}" aria-label="Portal username" autocapitalize="none" spellcheck="false" />
            <button type="button" class="btn-sm solid cred-gen">Generate login</button>
          </div>`}
        <p class="cred-err" hidden></p>
        <p class="panel-note" style="margin-top:8px;">The HOD signs in to the portal with these credentials. The password is shown once at generation.</p>
      </div>`;

    wrap.innerHTML = `
      <div class="form-cols">
        <div class="field"><label>Department name</label>
          <input type="text" class="input" data-f="name" value="${escapeHtml(d.name || '')}" placeholder="e.g. CATERING" /></div>
        <div class="field"><label>HOD name</label>
          <input type="text" class="input" data-f="head_name" value="${escapeHtml(d.head_name || '')}" placeholder="e.g. Sara M." /></div>
        <div class="field"><label>HOD email</label>
          <input type="email" class="input" data-f="head_email" value="${escapeHtml(d.head_email || '')}" placeholder="hod@company.com" /></div>
        <div class="field"><label>HOD WhatsApp</label>
          <input type="text" class="input" data-f="head_whatsapp" value="${escapeHtml(d.head_whatsapp || '')}" placeholder="+9665xxxxxxxx" /></div>
      </div>
      ${parentField}
      <div class="field"><label>Stream color</label>
        <div class="color-field">
          <input type="color" data-f="color-pick" value="${escapeHtml(color)}" />
          <input type="text" class="input hex" data-f="stream_color" value="${escapeHtml(color)}" />
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:4px;">
        <button type="button" class="btn-sm solid save">${isNew ? 'Create department' : 'Save changes'}</button>
        <button type="button" class="btn-sm cancel">Cancel</button>
      </div>
      ${credBlock}
    `;
    initCredBindings(wrap, d, isNew);
    const pick = wrap.querySelector('[data-f="color-pick"]');
    const hex = wrap.querySelector('[data-f="stream_color"]');
    pick.addEventListener('input', () => { hex.value = pick.value.toUpperCase(); });
    hex.addEventListener('change', () => {
      if (/^#[0-9a-f]{6}$/i.test(hex.value.trim())) pick.value = hex.value.trim();
    });
    wrap.querySelector('.cancel').addEventListener('click', () => wrap.remove());
    wrap.querySelector('.save').addEventListener('click', async () => {
      const parentSel = wrap.querySelector('[data-f="parent_id"]');
      const payload = {
        name: wrap.querySelector('[data-f="name"]').value.trim(),
        head_name: wrap.querySelector('[data-f="head_name"]').value.trim(),
        head_email: wrap.querySelector('[data-f="head_email"]').value.trim(),
        head_whatsapp: wrap.querySelector('[data-f="head_whatsapp"]').value.trim(),
        stream_color: /^#[0-9a-f]{6}$/i.test(hex.value.trim()) ? hex.value.trim() : pick.value,
        parent_id: parentSel && parentSel.value ? Number(parentSel.value) : null
      };
      if (!payload.name) { toast('Department name is required', { err: true }); return; }
      try {
        await apiJson(isNew ? '/api/admin/departments' : `/api/admin/departments/${d.id}`, {
          method: isNew ? 'POST' : 'PUT',
          body: payload
        });
        toast(isNew ? `${cap(payload.name)} created` : `${cap(payload.name)} saved`);
        loadDepartments();
      } catch (err) { toast('Save failed: ' + err.message, { err: true }); }
    });
    return wrap;
  }

  function addDepartment() {
    document.querySelectorAll('.dept-editor').forEach(e => e.remove());
    $('dept-list').prepend(deptEditor({}, state.departments || []));
  }

  // ── Portal credentials (per department) ───────────────────
  function initCredBindings(wrap, d, isNew) {
    if (isNew) return;
    const errEl = wrap.querySelector('.cred-err');
    const showCredErr = (msg) => { errEl.textContent = msg; errEl.hidden = false; };
    const hideCredErr = () => { errEl.hidden = true; };

    const gen = wrap.querySelector('.cred-gen');
    if (gen) gen.addEventListener('click', async () => {
      hideCredErr();
      const username = wrap.querySelector('.cred-username').value.trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
        showCredErr('Usernames are 3 to 40 characters: lowercase letters, digits, dots, dashes.');
        return;
      }
      gen.disabled = true;
      try {
        const data = await apiJson(`/api/admin/departments/${d.id}/credentials`, {
          method: 'POST', body: { username }
        });
        showCredModal(d.name, data.username, data.password);
        loadDepartments();
      } catch (err) {
        showCredErr(/in use/i.test(err.message)
          ? `The username "${username}" is already taken. Pick another.`
          : 'Could not create the login: ' + err.message);
        gen.disabled = false;
      }
    });

    const regen = wrap.querySelector('.cred-regen');
    if (regen) regen.addEventListener('click', async () => {
      hideCredErr();
      regen.disabled = true;
      try {
        const data = await apiJson(`/api/admin/departments/${d.id}/credentials`, {
          method: 'POST', body: {}
        });
        showCredModal(d.name, data.username, data.password);
        loadDepartments();
      } catch (err) {
        showCredErr('Could not regenerate the password: ' + err.message);
        regen.disabled = false;
      }
    });

    const revoke = wrap.querySelector('.cred-revoke');
    if (revoke) revoke.addEventListener('click', async () => {
      hideCredErr();
      if (!confirm(`Revoke the portal login for "${d.name}"? The HOD is signed out immediately and can no longer submit.`)) return;
      revoke.disabled = true;
      try {
        await apiJson(`/api/admin/departments/${d.id}/credentials`, { method: 'DELETE' });
        toast(`Login revoked for ${cap(d.name)}`);
        loadDepartments();
      } catch (err) {
        showCredErr('Could not revoke the login: ' + err.message);
        revoke.disabled = false;
      }
    });
  }

  // One-time password modal. Only the Done button closes it: the password
  // cannot be recovered after dismissal, so no accidental click-away.
  function showCredModal(deptName, username, password) {
    $('cred-modal-dept').textContent = `${cap(deptName)} · save these before closing`;
    $('cred-modal-user').textContent = username;
    $('cred-modal-pass').textContent = password;
    $('cred-modal').hidden = false;
    $('cred-copy').focus();
  }

  async function copyCredentials() {
    const text = `Username: ${$('cred-modal-user').textContent}\nPassword: ${$('cred-modal-pass').textContent}\nPortal: ${location.origin}/`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Credentials copied to the clipboard');
    } catch {
      toast('Copy failed. Select the text manually.', { err: true });
    }
  }

  // ══════════════════════════════════════════════════════════
  // WHATSAPP INBOX
  // ══════════════════════════════════════════════════════════
  // Threaded per-HOD inbox over the Meta Cloud API log. Polls every
  // 10 seconds while the section is visible; the poll also feeds the
  // sidebar unread badge. Takeover flips a thread between agent and
  // human mode; the composer only unlocks in human mode.

  function waDigits(n) { return String(n || '').replace(/\D/g, ''); }

  function waFmtNumber(n) {
    const d = waDigits(n);
    return d ? '+' + d : '';
  }

  function waMaskNumber(n) {
    const d = waDigits(n);
    if (d.length < 7) return waFmtNumber(n);
    return `+${d.slice(0, 3)} ${d.slice(3, 4)}• ••• ••${d.slice(-2)}`;
  }

  function waInitials(t) {
    const name = (t.display_name || '').trim();
    if (name) {
      const parts = name.split(/\s+/);
      return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
    }
    return waDigits(t.wa_number).slice(-2) || '?';
  }

  // Stream color drives the avatar; invalid or missing colors fall
  // back to the token-accent gradient baked into .avatar.
  function waAvatarStyle(t) {
    const c = t.stream_color || '';
    if (!/^#[0-9a-fA-F]{6}$/.test(c)) return '';
    return `background: linear-gradient(135deg, ${c}, color-mix(in srgb, ${c} 55%, #000))`;
  }

  function waRelTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    if ((now - d) / 1000 < 60) return 'now';
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }
    const yd = new Date(now); yd.setDate(yd.getDate() - 1);
    if (d.toDateString() === yd.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  function waClock(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function waDayLabel(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
  }

  async function loadWhatsapp() {
    if (!state.settings || !state.settings.whatsapp) {
      try { await fetchSettings(); } catch {}
    }
    await refreshWaThreads();
    if (state.waActiveId != null) await refreshWaMessages({ quiet: true });
    clearInterval(state.waTimer);
    state.waTimer = setInterval(async () => {
      if (!$('sec-whatsapp').classList.contains('on')) return;
      await refreshWaThreads({ quiet: true });
      if (state.waActiveId != null) await refreshWaMessages({ quiet: true });
    }, 10000);
  }

  function updateWaNavBadge(threads) {
    const total = (threads || []).reduce((sum, t) => sum + (t.unread_count || 0), 0);
    const badge = $('wa-nav-badge');
    badge.hidden = !total;
    badge.textContent = total > 99 ? '99+' : String(total);
  }

  // Lightweight badge refresh usable from outside the section.
  async function refreshWaBadge() {
    if (!state.pw) return;
    try { updateWaNavBadge(await apiJson('/api/admin/whatsapp/threads')); } catch {}
  }

  async function refreshWaThreads(opts = {}) {
    let threads;
    try { threads = await apiJson('/api/admin/whatsapp/threads'); }
    catch (err) {
      if (!opts.quiet) toast('Failed to load WhatsApp threads: ' + err.message, { err: true });
      return;
    }
    state.waThreads = threads;
    updateWaNavBadge(threads);
    renderWaThreads();
    if (state.waActiveId != null) renderWaChatHead(); // mode may have changed server-side
  }

  function renderWaThreads() {
    const threads = state.waThreads || [];
    const hasAny = threads.length > 0;
    $('wa-panel').hidden = !hasAny;
    $('wa-none').hidden = hasAny;
    if (!hasAny) { renderWaConfigPills(); return; }

    const q = state.waSearch.trim().toLowerCase();
    const qd = q.replace(/\D/g, '');
    const shown = !q ? threads : threads.filter(t =>
      (t.display_name || '').toLowerCase().includes(q) ||
      (t.department_name || '').toLowerCase().includes(q) ||
      (qd !== '' && waDigits(t.wa_number).includes(qd))
    );

    const box = $('wa-threads');
    box.innerHTML = '';
    if (!shown.length) {
      box.innerHTML = '<p class="panel-note" style="padding:14px;">No conversations match.</p>';
      return;
    }
    shown.forEach(t => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wa-thread-item' + (t.id === state.waActiveId ? ' on' : '');
      const name = t.display_name || waFmtNumber(t.wa_number);
      const human = t.mode === 'human';
      btn.innerHTML = `
        <div class="avatar" style="${waAvatarStyle(t)}">${escapeHtml(waInitials(t))}</div>
        <div class="wt-main">
          <div class="wt-name">${escapeHtml(name)} <time>${escapeHtml(waRelTime(t.last_message_at))}</time></div>
          <div class="wt-tags">
            ${t.department_name ? `<span class="wt-dept">${escapeHtml(t.department_name)}</span>` : ''}
            <span class="mode-chip ${human ? 'human' : 'agent'}">&#9679; ${human ? 'HUMAN' : 'AGENT'}</span>
          </div>
          <div class="wt-prev">${escapeHtml(t.last_body || '')}</div>
        </div>
        ${t.unread_count ? '<span class="unread-dot"></span>' : ''}
      `;
      btn.addEventListener('click', () => openWaThread(t.id));
      box.appendChild(btn);
    });
  }

  function renderWaConfigPills() {
    const wa = (state.settings && state.settings.whatsapp) || {};
    const pill = (ok, onLabel, offLabel) =>
      `<span class="pill${ok ? '' : ' warn'}">${ok ? onLabel : offLabel}</span>`;
    $('wa-config-pills').innerHTML =
      pill(wa.enabled, 'WHATSAPP ENABLED', 'WHATSAPP DISABLED') +
      pill(wa.configured, 'META CREDENTIALS SET', 'META CREDENTIALS MISSING');
  }

  async function openWaThread(id) {
    state.waActiveId = id;
    $('wa-body').classList.add('chat-open'); // mobile drill-in
    const t = state.waThreads.find(x => x.id === id);
    if (t) t.unread_count = 0; // server marks read on the messages fetch
    renderWaThreads();
    updateWaNavBadge(state.waThreads);
    renderWaChatHead();
    $('wa-nosel').hidden = true;
    $('wa-chat-head').hidden = false;
    $('wa-msgs').hidden = false;
    $('wa-msgs').innerHTML = '';
    await refreshWaMessages({ scroll: 'bottom' });
  }

  function renderWaChatHead() {
    const t = state.waThreads.find(x => x.id === state.waActiveId);
    if (!t) return;
    const av = $('wa-ch-avatar');
    av.textContent = waInitials(t);
    av.style.cssText = waAvatarStyle(t);
    $('wa-ch-name').textContent = t.display_name || waFmtNumber(t.wa_number);
    $('wa-ch-num').textContent =
      (t.department_name ? t.department_name + ' · ' : '') + waMaskNumber(t.wa_number);
    const waCfg = (state.settings && state.settings.whatsapp) || {};
    $('wa-test-badge').hidden = !waCfg.enabled;
    const human = t.mode === 'human';
    $('wa-takeover').hidden = human;
    $('wa-return').hidden = !human;
    $('wa-agent-bar').hidden = human;
    $('wa-human-bar').hidden = !human;
  }

  async function refreshWaMessages(opts = {}) {
    const id = state.waActiveId;
    if (id == null) return;
    let msgs;
    try { msgs = await apiJson(`/api/admin/whatsapp/threads/${id}/messages`); }
    catch (err) {
      if (!opts.quiet) toast('Failed to load messages: ' + err.message, { err: true });
      return;
    }
    if (id !== state.waActiveId) return; // thread switched mid-flight
    renderWaMessages(msgs, opts);
  }

  function renderWaMessages(msgs, opts = {}) {
    const box = $('wa-msgs');
    // Stay pinned to the bottom unless the admin has scrolled up to read.
    const pinned = opts.scroll === 'bottom' ||
      box.scrollTop + box.clientHeight >= box.scrollHeight - 60;
    let html = '';
    let lastDay = '';
    msgs.forEach(m => {
      const day = waDayLabel(m.created_at);
      if (day && day !== lastDay) {
        html += `<div class="day-divider">${escapeHtml(day)}</div>`;
        lastDay = day;
      }
      html += waBubble(m);
    });
    if (!msgs.length) html = '<p class="panel-note" style="align-self:center;">No messages in this thread yet.</p>';
    box.innerHTML = html;
    if (pinned) box.scrollTop = box.scrollHeight;
  }

  function waBubble(m) {
    const out = m.direction === 'out';
    let tag = '';
    if (m.message_type === 'template') {
      tag = `<span class="tpl-tag">Template &middot; ${escapeHtml(m.template_name || 'unnamed')}</span>`;
    } else if (out && m.sent_by === 'agent') {
      tag = '<span class="tpl-tag agent">CLIO Agent &middot; auto-reply</span>';
    } else if (out && m.sent_by === 'human') {
      tag = '<span class="tpl-tag human">Sent by admin</span>';
    }
    let ticks = '';
    if (out) {
      if (m.pending) ticks = '<span class="ticks t-sent">&#8230;</span>';
      else if (m.status === 'read') ticks = '<span class="ticks">&#10003;&#10003;</span>';
      else if (m.status === 'delivered') ticks = '<span class="ticks t-delivered">&#10003;&#10003;</span>';
      else if (m.status === 'failed') ticks = '<span class="ticks t-failed">failed</span>';
      else ticks = '<span class="ticks t-sent">&#10003;</span>';
    }
    return `<div class="bubble ${out ? 'out' : 'in'}${m.pending ? ' pending' : ''}">
      ${tag}${escapeHtml(m.body || '')}
      <div class="meta">${escapeHtml(waClock(m.created_at))} ${ticks}</div>
    </div>`;
  }

  async function sendWaReply() {
    const id = state.waActiveId;
    const input = $('wa-input');
    const text = input.value.trim();
    if (!text || id == null) return;
    input.value = '';
    $('wa-send').disabled = true;
    // Optimistic append; the refetch below reconciles against the DB row.
    const box = $('wa-msgs');
    box.insertAdjacentHTML('beforeend', waBubble({
      direction: 'out', body: text, sent_by: 'human',
      message_type: 'text', created_at: new Date().toISOString(), pending: true
    }));
    box.scrollTop = box.scrollHeight;
    try {
      const res = await apiJson(`/api/admin/whatsapp/threads/${id}/reply`, {
        method: 'POST', body: { text }
      });
      if (!res.success) {
        toast('WhatsApp send failed. Meta rejected the message; it is logged as failed.', { err: true });
      }
    } catch (err) {
      toast('Reply failed: ' + err.message, { err: true });
    } finally {
      $('wa-send').disabled = false;
    }
    await refreshWaMessages({ quiet: true, scroll: 'bottom' });
    refreshWaThreads({ quiet: true });
  }

  async function setWaMode(mode) {
    const id = state.waActiveId;
    if (id == null) return;
    try {
      await apiJson(`/api/admin/whatsapp/threads/${id}/mode`, { method: 'POST', body: { mode } });
    } catch (err) {
      toast('Mode change failed: ' + err.message, { err: true });
      return;
    }
    const t = state.waThreads.find(x => x.id === id);
    if (t) t.mode = mode;
    renderWaChatHead();
    renderWaThreads();
    if (mode === 'human') $('wa-input').focus();
    toast(mode === 'human'
      ? 'You have taken over this conversation. The agent stays silent until you hand it back.'
      : 'Thread handed back to the CLIO Agent.');
  }

  function initWaBindings() {
    $('wa-search').addEventListener('input', () => {
      state.waSearch = $('wa-search').value;
      renderWaThreads();
    });
    $('wa-back').addEventListener('click', () => $('wa-body').classList.remove('chat-open'));
    $('wa-takeover').addEventListener('click', () => setWaMode('human'));
    $('wa-return').addEventListener('click', () => setWaMode('agent'));
    $('wa-send').addEventListener('click', sendWaReply);
    $('wa-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendWaReply(); });
  }

  // ══════════════════════════════════════════════════════════
  // BRAND
  // ══════════════════════════════════════════════════════════
  const COLOR_KEYS = ['background_color', 'primary_color', 'label_color', 'text_color', 'muted_color', 'panel_color'];
  const COLOR_DEFAULTS = {
    background_color: '#0F172A', primary_color: '#3B82F6', label_color: '#FACC15',
    text_color: '#E2E8F0', muted_color: '#64748B', panel_color: '#1E293B'
  };

  async function loadBrand() {
    try { await fetchSettings(); } catch (err) { toast('Failed to load settings: ' + err.message, { err: true }); return; }
    const bc = state.settings.brand_config || {};
    $('brand-company').value = bc.company_name || '';
    $('brand-subtitle').value = bc.company_subtitle || '';
    // font_family is authoritative; font_name is the legacy read fallback
    $('brand-font').value = bc.font_family || bc.font_name || '';
    COLOR_KEYS.forEach(k => {
      const v = normHex(bc[k]) || COLOR_DEFAULTS[k];
      $(`col-${k}`).value = v;
      $(`hex-${k}`).value = v.toUpperCase();
    });
    if (bc.logo_path) {
      $('logo-preview').src = '/uploads/brand/logo.png?' + Date.now();
      $('logo-preview').hidden = false;
      $('logo-empty').hidden = true;
    }
    renderBrandPreview();
  }

  function normHex(v) {
    const s = String(v || '').trim();
    return /^#[0-9a-f]{6}$/i.test(s) ? s : null;
  }

  function brandValues() {
    const out = {};
    COLOR_KEYS.forEach(k => { out[k] = normHex($(`hex-${k}`).value) || $(`col-${k}`).value; });
    return out;
  }

  function renderBrandPreview() {
    const c = brandValues();
    const sw = $('swatch-row');
    sw.innerHTML = COLOR_KEYS.map(k => {
      const label = k.replace('_color', '').replace('_', ' ');
      return `<div class="swatch" style="background:${c[k]};color:${contrastText(c[k])}">${escapeHtml(label)}</div>`;
    }).join('');
    const mock = $('brand-mock');
    mock.style.background = c.background_color;
    mock.style.fontFamily = `"${$('brand-font').value.trim() || 'Sora'}", "Sora", sans-serif`;
    $('bm-kicker').style.color = c.label_color;
    const ev = $('bm-event');
    ev.style.color = c.text_color;
    ev.textContent = (state.settings && state.settings.event_name) || 'Your Event';
    const card = $('bm-card');
    card.style.background = c.panel_color;
    card.style.border = `1px solid ${c.primary_color}44`;
    card.querySelector('.n').style.color = c.text_color;
    $('bm-hod').style.color = c.muted_color;
    $('bm-status').style.color = 'var(--green)';
  }

  function contrastText(hex) {
    const n = parseInt(hex.slice(1), 16);
    const luma = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return luma > 140 ? 'rgba(15,23,42,0.8)' : 'rgba(255,255,255,0.75)';
  }

  async function saveBrand() {
    const prev = (state.settings && state.settings.brand_config) || {};
    const bc = {
      ...prev,
      company_name: $('brand-company').value.trim(),
      company_subtitle: $('brand-subtitle').value.trim(),
      font_family: $('brand-font').value.trim() || 'Sora',
      ...brandValues()
    };
    delete bc.font_name; // legacy key retired on save; font_family is canonical
    try {
      await apiJson('/api/admin/settings', { method: 'PUT', body: { brand_config: bc } });
      if (state.settings) state.settings.brand_config = bc;
      toast('Brand settings saved');
      refreshChrome();
    } catch (err) { toast('Save failed: ' + err.message, { err: true }); }
  }

  async function uploadLogo() {
    const file = $('logo-file').files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('logo', file);
    try {
      const res = await api('/api/admin/brand-logo', { method: 'POST', body: fd });
      if (!res.ok) throw new Error('upload rejected');
      $('logo-preview').src = '/uploads/brand/logo.png?' + Date.now();
      $('logo-preview').hidden = false;
      $('logo-empty').hidden = true;
      toast('Logo uploaded');
      fetchSettings().catch(() => {});
      refreshChrome();
    } catch (err) { toast('Logo upload failed: ' + err.message, { err: true }); }
    $('logo-file').value = '';
  }

  function initBrandBindings() {
    COLOR_KEYS.forEach(k => {
      const pick = $(`col-${k}`), hex = $(`hex-${k}`);
      pick.addEventListener('input', () => { hex.value = pick.value.toUpperCase(); renderBrandPreview(); });
      hex.addEventListener('input', () => {
        const v = normHex(hex.value);
        if (v) { pick.value = v; renderBrandPreview(); }
      });
    });
    $('brand-font').addEventListener('input', renderBrandPreview);
    $('logo-btn').addEventListener('click', () => $('logo-file').click());
    $('logo-drop').addEventListener('click', () => $('logo-file').click());
    $('logo-file').addEventListener('change', uploadLogo);
    $('brand-save').addEventListener('click', saveBrand);
  }

  // ══════════════════════════════════════════════════════════
  // REPORT STRUCTURE
  // ══════════════════════════════════════════════════════════
  const SLIDE_TYPES = [
    {
      key: 'overview', name: 'Master Overview',
      desc: 'Event summary with all departments, progress grid, and overall average.',
      options: [
        { key: 'show_average', label: 'Show overall average completion', default: true },
        { key: 'show_badges', label: 'Show status badges (On Track / At Risk)', default: true }
      ]
    },
    {
      key: 'dept_overview', name: 'Department Overview',
      desc: 'Per-department slide: progress %, status summary, highlights, and blockers.',
      options: [
        { key: 'show_highlights', label: 'Show highlights section', default: true },
        { key: 'show_blockers', label: 'Show blockers section', default: true }
      ]
    },
    {
      key: 'dept_schedule', name: 'Schedule & Chart',
      desc: 'Per-department schedule table with activity status and a donut chart.',
      options: [
        { key: 'show_donut', label: 'Show completion donut chart', default: true }
      ]
    },
    {
      key: 'dept_photos', name: 'Photo Wall',
      desc: 'Grid of progress photos uploaded by the HOD, with captions.',
      options: [
        { key: 'photos_per_page', label: 'Photos per page', default: 6, type: 'select', choices: [4, 6, 9] },
        { key: 'show_timestamps', label: 'Show photo timestamps', default: true }
      ]
    },
    {
      key: 'no_submission', name: 'No Submission Notice',
      desc: 'Placeholder slide for departments that did not submit.',
      options: []
    }
  ];

  async function loadReport() {
    try { await fetchSettings(); } catch (err) { toast('Failed to load settings: ' + err.message, { err: true }); return; }
    state.reportConfig = state.settings.report_config || {};
    $('report-dimensions').value = state.reportConfig.slide_dimensions || '16:9';
    try { state.previewData = await apiJson('/api/admin/report-preview-data'); }
    catch (err) { state.previewData = null; }
    if (!$('rb-date').value) {
      $('rb-date').value = (state.previewData && state.previewData.latest && state.previewData.latest.date) || state.today || '';
    }
    renderTemplateCard();
    renderSlides();
    renderLivePreview();
  }

  function slideOrder() {
    const known = SLIDE_TYPES.map(s => s.key);
    const stored = Array.isArray(state.reportConfig.slide_order) ? state.reportConfig.slide_order : [];
    const order = stored.filter(k => known.includes(k));
    known.forEach(k => { if (!order.includes(k)) order.push(k); });
    return order;
  }

  function renderSlides() {
    const list = $('slide-list');
    list.innerHTML = '';
    const order = slideOrder();
    order.forEach((key, idx) => {
      const type = SLIDE_TYPES.find(t => t.key === key);
      const cfg = state.reportConfig[key] || {};
      const enabled = cfg.enabled !== false;

      const card = document.createElement('div');
      card.className = 'slide-card' + (enabled ? '' : ' off');
      card.dataset.key = key;

      const opts = type.options.map(opt => {
        if (opt.type === 'select') {
          const val = cfg[opt.key] !== undefined ? cfg[opt.key] : opt.default;
          const choices = opt.choices.map(c => `<option value="${c}" ${c == val ? 'selected' : ''}>${c}</option>`).join('');
          return `<span class="opt-line">${escapeHtml(opt.label)} <select data-opt="${opt.key}">${choices}</select></span>`;
        }
        const checked = cfg[opt.key] !== undefined ? cfg[opt.key] : opt.default;
        return `<label class="opt-line"><input type="checkbox" data-opt="${opt.key}" ${checked ? 'checked' : ''} /> ${escapeHtml(opt.label)}</label>`;
      }).join('');

      card.innerHTML = `
        <div class="sc-head">
          <span class="sc-order">
            <button type="button" data-dir="up" ${idx === 0 ? 'disabled' : ''} aria-label="Move up">&#9650;</button>
            <button type="button" data-dir="down" ${idx === order.length - 1 ? 'disabled' : ''} aria-label="Move down">&#9660;</button>
          </span>
          <span class="sc-name">${escapeHtml(type.name)}<small>${escapeHtml(type.desc)}</small></span>
          <label class="switch"><input type="checkbox" class="sc-enable" ${enabled ? 'checked' : ''} /><span class="track"></span></label>
        </div>
        ${opts ? `<div class="sc-opts">${opts}</div>` : ''}
      `;

      card.querySelectorAll('.sc-order button').forEach(btn => {
        btn.addEventListener('click', () => {
          syncReportConfigFromDom();
          const ord = slideOrder();
          const i = ord.indexOf(key);
          const j = btn.dataset.dir === 'up' ? i - 1 : i + 1;
          if (j < 0 || j >= ord.length) return;
          [ord[i], ord[j]] = [ord[j], ord[i]];
          state.reportConfig.slide_order = ord;
          renderSlides();
          previewRefresh();
        });
      });
      card.querySelector('.sc-enable').addEventListener('change', e => {
        card.classList.toggle('off', !e.target.checked);
      });
      // Any option or toggle change redraws the live preview (change bubbles)
      card.addEventListener('change', previewRefresh);
      list.appendChild(card);
    });
  }

  function syncReportConfigFromDom() {
    const cfg = { ...state.reportConfig };
    cfg.slide_dimensions = $('report-dimensions').value;
    cfg.slide_order = slideOrder();
    // Template keys: mode lives in state (seg buttons), colors in the DOM.
    // Unknown keys (template_path, template_filename, ...) ride along via the spread.
    cfg.template_mode = cfg.template_path ? (state.reportConfig.template_mode || 'tokens') : 'tokens';
    cfg.template_colors = !!($('tpl-colors') && $('tpl-colors').checked);
    document.querySelectorAll('.slide-card').forEach(card => {
      const key = card.dataset.key;
      const entry = { ...(cfg[key] || {}), enabled: card.querySelector('.sc-enable').checked };
      card.querySelectorAll('[data-opt]').forEach(el => {
        const k = el.dataset.opt;
        if (el.type === 'checkbox') entry[k] = el.checked;
        else entry[k] = isNaN(el.value) ? el.value : Number(el.value);
      });
      cfg[key] = entry;
    });
    state.reportConfig = cfg;
    return cfg;
  }

  async function saveReport() {
    const cfg = syncReportConfigFromDom();
    try {
      await apiJson('/api/admin/settings', { method: 'PUT', body: { report_config: cfg } });
      if (state.settings) state.settings.report_config = cfg;
      toast('Report settings saved');
    } catch (err) { toast('Save failed: ' + err.message, { err: true }); }
  }

  // Persist any pending report changes so True renders and test decks match
  // what is on screen. No-op when nothing changed.
  async function savePendingReportConfig() {
    const cfg = syncReportConfigFromDom();
    const stored = JSON.stringify((state.settings && state.settings.report_config) || {});
    if (JSON.stringify(cfg) === stored) return;
    await apiJson('/api/admin/settings', { method: 'PUT', body: { report_config: cfg } });
    if (state.settings) state.settings.report_config = cfg;
  }

  // ── Template card ─────────────────────────────────────────
  function renderTemplateCard() {
    const cfg = state.reportConfig || {};
    const box = $('tpl-state');
    const hasTemplate = !!cfg.template_path;
    if (hasTemplate) {
      const name = cfg.template_filename || 'report_template.pptx';
      const when = cfg.template_uploaded_at ? ` · imported ${cfg.template_uploaded_at.slice(0, 10)}` : '';
      box.innerHTML = `
        <div class="tpl-file-row">
          <span class="tpl-icon">&#9639;</span>
          <span class="tpl-name">${escapeHtml(name)}<small>${escapeHtml(when.replace(' · ', ''))}</small></span>
          <span class="tpl-actions">
            <button type="button" class="btn-sm" id="tpl-replace">Replace</button>
            <button type="button" class="btn-sm danger" id="tpl-remove">Remove</button>
          </span>
        </div>`;
      box.querySelector('#tpl-replace').addEventListener('click', () => $('tpl-file').click());
      box.querySelector('#tpl-remove').addEventListener('click', removeTemplate);
    } else {
      box.innerHTML = `
        <div class="tpl-file-row empty">
          <span class="tpl-name muted">No template imported</span>
          <span class="tpl-actions"><button type="button" class="btn-sm" id="tpl-import">Import .pptx</button></span>
        </div>`;
      box.querySelector('#tpl-import').addEventListener('click', () => $('tpl-file').click());
    }

    const mode = hasTemplate && cfg.template_mode === 'template' ? 'template' : 'tokens';
    $('tpl-mode').querySelectorAll('button').forEach(b => {
      b.classList.toggle('on', b.dataset.mode === mode);
      if (b.dataset.mode === 'template') b.disabled = !hasTemplate;
    });
    $('tpl-colors-row').hidden = mode !== 'template';
    $('tpl-colors').checked = !!cfg.template_colors;
    $('report-dimensions').disabled = mode === 'template';
    $('report-dimensions-hint').hidden = mode !== 'template';
  }

  async function uploadTemplate() {
    const file = $('tpl-file').files[0];
    if (!file) return;
    if (!/\.pptx$/i.test(file.name)) {
      toast('The template must be a .pptx file.', { err: true });
      $('tpl-file').value = '';
      return;
    }
    const fd = new FormData();
    fd.append('template', file);
    try {
      const res = await api('/api/admin/report-template', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'upload rejected');
      toast(`Template imported: ${data.filename}`);
      await fetchSettings();
      state.reportConfig = { ...(state.settings.report_config || {}), template_mode: 'template' };
      renderTemplateCard();
      renderLivePreview();
    } catch (err) { toast('Template import failed: ' + err.message, { err: true }); }
    $('tpl-file').value = '';
  }

  async function removeTemplate() {
    if (!confirm('Remove the imported template? The deck falls back to brand tokens.')) return;
    try {
      await apiJson('/api/admin/report-template', { method: 'DELETE' });
      await fetchSettings();
      state.reportConfig = state.settings.report_config || {};
      toast('Template removed');
      renderTemplateCard();
      renderLivePreview();
    } catch (err) { toast('Remove failed: ' + err.message, { err: true }); }
  }

  function setTemplateMode(mode) {
    if (mode === 'template' && !state.reportConfig.template_path) return;
    state.reportConfig.template_mode = mode;
    renderTemplateCard();
    renderLivePreview();
  }

  // ── Live preview (HTML/CSS approximation of the deck) ─────
  let previewTimer = null;
  function previewRefresh() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      syncReportConfigFromDom();
      renderLivePreview();
    }, 80);
  }

  // Fixed semantic colors, mirrored from the generator
  const PV_GREEN = '#4ADE80', PV_AMBER = '#FB923C', PV_RED = '#F87171';

  function pvBadge(pct) {
    if (pct >= 80) return { text: 'ON TRACK', color: PV_GREEN };
    if (pct >= 50) return { text: 'IN PROGRESS', color: PV_AMBER };
    return { text: 'AT RISK', color: PV_RED };
  }

  function pvSample() {
    const data = state.previewData;
    const depts = (data && data.departments) || [];
    const subs = (data && data.latest && data.latest.submissions) || [];
    let dept = null, sub = null;
    for (const s of subs) {
      const d = depts.find(x => x.id === s.department_id);
      if (d) { dept = d; sub = s; break; }
    }
    if (!dept) dept = depts[0] || { name: 'DEPARTMENT', stream_color: '#3B82F6' };
    if (!sub) {
      sub = {
        overall_progress: 65,
        status_text: 'Main stage deck complete, LED wall rigged and tested. Crew moves to FOH calibration tomorrow morning.',
        highlights: 'LED wall signed off ahead of schedule.',
        blockers: 'Awaiting generator delivery for the north compound.',
        photo_count: 4,
        captions: []
      };
    }
    return { dept, sub };
  }

  function renderLivePreview() {
    const box = $('pv-boards');
    if (!box) return;
    const data = state.previewData;
    if (!data) {
      box.innerHTML = '<p class="panel-note">Preview data unavailable. Reload the section.</p>';
      return;
    }
    const cfg = state.reportConfig || {};
    const b = data.brand || {};
    const vars = [
      `--pv-bg:${b.background_color || '#0F172A'}`,
      `--pv-panel:${b.panel_color || '#1E293B'}`,
      `--pv-text:${b.text_color || '#E2E8F0'}`,
      `--pv-muted:${b.muted_color || '#64748B'}`,
      `--pv-accent:${b.primary_color || '#3B82F6'}`,
      `--pv-font:"${(b.font_family || 'Sora').replace(/"/g, '')}", "Sora", sans-serif`,
      `--pv-ratio:${cfg.slide_dimensions === '4:3' && cfg.template_mode !== 'template' ? '4 / 3' : '16 / 9'}`
    ].join(';');

    const order = slideOrder().filter(key => (cfg[key] || {}).enabled !== false);
    const boards = order.map((key, i) => {
      const type = SLIDE_TYPES.find(t => t.key === key);
      let inner = '';
      if (key === 'overview') inner = pvOverview(data, cfg);
      else if (key === 'dept_overview') inner = pvDeptOverview(data, cfg);
      else if (key === 'dept_schedule') inner = pvDeptSchedule(data, cfg);
      else if (key === 'dept_photos') inner = pvDeptPhotos(data, cfg);
      else if (key === 'no_submission') inner = pvNoSubmission(data);
      return `
        <div class="pv-slot">
          <div class="pv-slot-label"><span>${String(i + 1).padStart(2, '0')}</span>${escapeHtml(type ? type.name : key)}</div>
          <div class="pv-board" style="${vars}">${inner}</div>
        </div>`;
    }).join('');

    const modeNote = cfg.template_mode === 'template'
      ? '<p class="panel-note">Template mode: the live preview shows content and layout only. The imported design (masters, backgrounds, theme) appears in the true preview.</p>'
      : '';
    box.innerHTML = (boards || '<p class="panel-note">All slide types are off. Enable at least one.</p>') + modeNote;
  }

  function pvLogo(data) {
    const url = data.brand && data.brand.logo_url;
    return url ? `<img class="pv-logo" src="${escapeHtml(url)}" alt="" />` : '';
  }

  function pvOverview(data, cfg) {
    const rcfg = cfg.overview || {};
    const showBadges = rcfg.show_badges !== false;
    const showAvg = rcfg.show_average !== false;
    const subs = (data.latest && data.latest.submissions) || [];
    const ids = new Set((data.departments || []).map(d => d.id));
    // Same ordering as the generator: each parent, then its children
    const sortKey = (d) => (d.parent_id != null && ids.has(d.parent_id))
      ? [d.parent_id, 1, d.id] : [d.id, 0, d.id];
    const depts = [...(data.departments || [])].sort((a, b) => {
      const ka = sortKey(a), kb = sortKey(b);
      for (let i = 0; i < 3; i++) { if (ka[i] !== kb[i]) return ka[i] - kb[i]; }
      return 0;
    });
    const byDept = new Map(subs.map(s => [s.department_id, s]));
    const title = [data.event_name, data.event_edition].filter(Boolean).join('  ·  ') || 'Event';
    const company = (data.brand && data.brand.company_name) || '';

    const rows = depts.map(d => {
      const isChild = d.parent_id != null && ids.has(d.parent_id);
      const sub = byDept.get(d.id);
      const pct = sub ? (sub.overall_progress || 0) : null;
      const badge = (showBadges && sub) ? pvBadge(pct) : null;
      return `
        <div class="pvo-row">
          <i style="background:${escapeHtml(d.stream_color || '#3B82F6')}"></i>
          <span class="pvo-name" style="color:${escapeHtml(d.stream_color || '#3B82F6')}">${isChild ? '&middot; ' : ''}${escapeHtml(d.name)}</span>
          ${sub
            ? `<span class="pvo-pct">${pct}%</span>${badge ? `<span class="pvo-badge" style="color:${badge.color}">${badge.text}</span>` : ''}`
            : '<span class="pvo-none">No Data Submitted</span>'}
        </div>`;
    }).join('');

    const avg = subs.length
      ? Math.round(subs.reduce((a, s) => a + (s.overall_progress || 0), 0) / subs.length)
      : 0;
    return `
      ${pvLogo(data)}
      ${company ? `<div class="pv-company">${escapeHtml(company.toUpperCase())}</div>` : ''}
      <div class="pv-event">${escapeHtml(title)}</div>
      <div class="pv-subline">Daily Progress Report &middot; Generated by CLIO &middot; ${escapeHtml((data.latest && data.latest.date) || '')}</div>
      <div class="pvo-grid">${rows}</div>
      ${showAvg ? `<div class="pv-footline">Overall Average Completion: ${avg}% &middot; ${subs.length}/${depts.length} departments reporting</div>` : ''}
    `;
  }

  function pvDeptOverview(data, cfg) {
    const rcfg = cfg.dept_overview || {};
    const { dept, sub } = pvSample();
    const color = dept.stream_color || '#3B82F6';
    const tiles = Math.min(sub.photo_count || 0, 6);
    const photoTiles = tiles
      ? `<div class="pvd-photorow"><span class="pvd-photolabel">PHOTOS</span>${'<span class="pvd-phototile"></span>'.repeat(tiles)}<span class="pvd-photocount">${sub.photo_count}</span></div>`
      : '';
    return `
      ${pvLogo(data)}
      <div class="pv-accentbar" style="background:${escapeHtml(color)}"></div>
      <div class="pvd-name" style="color:${escapeHtml(color)}">${escapeHtml(dept.name.toUpperCase())}</div>
      <div class="pv-subline">HOD &middot; Submitted ${escapeHtml((data.latest && data.latest.date) || '')}</div>
      <div class="pvd-cols">
        <div class="pvd-left">
          <div class="pvd-bignum">${sub.overall_progress || 0}%</div>
          <div class="pvd-biglabel">Overall Completion</div>
          ${photoTiles}
        </div>
        <div class="pvd-right">
          <div class="pv-block"><span class="pv-blocklabel" style="color:var(--pv-muted)">STATUS</span>${escapeHtml(sub.status_text || 'n/a')}</div>
          ${(rcfg.show_highlights !== false && sub.highlights) ? `<div class="pv-block edge" style="border-color:${PV_GREEN}"><span class="pv-blocklabel" style="color:${PV_GREEN}">HIGHLIGHTS</span>${escapeHtml(sub.highlights)}</div>` : ''}
          ${(rcfg.show_blockers !== false && sub.blockers) ? `<div class="pv-block edge" style="border-color:${PV_RED}"><span class="pv-blocklabel" style="color:${PV_RED}">BLOCKERS</span>${escapeHtml(sub.blockers)}</div>` : ''}
        </div>
      </div>
    `;
  }

  function pvDeptSchedule(data, cfg) {
    const rcfg = cfg.dept_schedule || {};
    const showDonut = rcfg.show_donut !== false;
    const { dept } = pvSample();
    const color = dept.stream_color || '#3B82F6';
    const mock = [
      ['08:00', 'Site walk and safety briefing', 'Completed', PV_GREEN],
      ['10:30', 'Structure build, block A', 'Completed', PV_GREEN],
      ['14:00', 'Cabling and power distribution', 'In Progress', PV_AMBER],
      ['17:30', 'Vendor delivery, staging area', 'Pending', 'var(--pv-muted)']
    ];
    const rows = mock.map(([t, a, s, c], i) => `
      <div class="pvs-row${i % 2 === 0 ? ' alt' : ''}">
        <span class="pvs-time">${t}</span><span class="pvs-act">${a}</span><span class="pvs-st" style="color:${c}">${s.toUpperCase()}</span>
      </div>`).join('');
    const donut = showDonut ? `
      <div class="pvs-donut">
        <div class="pvs-ring" style="background:conic-gradient(${escapeHtml(color)} 0 180deg, ${PV_AMBER} 180deg 270deg, #374151 270deg 360deg)"><span>50%<small>done</small></span></div>
        <div class="pvs-legend">
          <span><i style="background:${escapeHtml(color)}"></i>Completed</span>
          <span><i style="background:${PV_AMBER}"></i>In Progress</span>
          <span><i style="background:#374151"></i>Pending</span>
        </div>
      </div>` : '';
    return `
      ${pvLogo(data)}
      <div class="pv-accentbar" style="background:${escapeHtml(color)}"></div>
      <div class="pvd-name" style="color:${escapeHtml(color)}">${escapeHtml(dept.name.toUpperCase())} &middot; TODAY'S SCHEDULE</div>
      <div class="pvs-cols${showDonut ? '' : ' full'}">
        <div class="pvs-table">
          <div class="pvs-row head"><span class="pvs-time">TIME</span><span class="pvs-act">ACTIVITY</span><span class="pvs-st">STATUS</span></div>
          ${rows}
        </div>
        ${donut}
      </div>
    `;
  }

  function pvDeptPhotos(data, cfg) {
    const rcfg = cfg.dept_photos || {};
    const perPage = Number(rcfg.photos_per_page) || 6;
    const showTs = rcfg.show_timestamps !== false;
    const { dept, sub } = pvSample();
    const color = dept.stream_color || '#3B82F6';
    const cols = perPage <= 4 ? 2 : 3;
    const captions = (sub.captions && sub.captions.length)
      ? sub.captions
      : ['Stage deck progress', 'LED wall install', 'Crew briefing', 'North gate build'];
    const cells = Array.from({ length: perPage }, (_, i) => {
      const cap = escapeHtml(captions[i % captions.length]);
      const meta = [cap, showTs ? '18:42' : null].filter(Boolean).join(' &middot; ');
      return `<div class="pvp-cell"><div class="pvp-img"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M3 17l5-4 3 2.4L16 11l5 5"/></svg></div><div class="pvp-cap">${meta}</div></div>`;
    }).join('');
    return `
      ${pvLogo(data)}
      <div class="pv-accentbar" style="background:${escapeHtml(color)}"></div>
      <div class="pvd-name" style="color:${escapeHtml(color)}">${escapeHtml(dept.name.toUpperCase())} &middot; PROGRESS PHOTOS</div>
      <div class="pvp-grid" style="grid-template-columns:repeat(${cols}, 1fr)">${cells}</div>
    `;
  }

  function pvNoSubmission(data) {
    const depts = (state.previewData && state.previewData.departments) || [];
    const subs = (state.previewData && state.previewData.latest && state.previewData.latest.submissions) || [];
    const filed = new Set(subs.map(s => s.department_id));
    const missing = depts.find(d => !filed.has(d.id));
    const name = missing ? missing.name : 'DEPARTMENT';
    return `
      <div class="pvn-center">
        <div class="pvn-title">${escapeHtml(name)}: No Update Submitted</div>
        <div class="pvn-sub">HOD was reminded. No data received before report generation.</div>
      </div>
    `;
  }

  // ── True preview (LibreOffice render) ─────────────────────
  function setPreviewTab(tab) {
    const live = tab === 'live';
    $('pv-tab-live').classList.toggle('on', live);
    $('pv-tab-true').classList.toggle('on', !live);
    $('pv-tab-live').setAttribute('aria-selected', String(live));
    $('pv-tab-true').setAttribute('aria-selected', String(!live));
    $('pv-live').hidden = !live;
    $('pv-true').hidden = live;
  }

  async function renderTruePreview() {
    const date = $('rb-date').value || state.today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) { toast('Pick a date first.', { err: true }); return; }
    const btn = $('pv-render-btn');
    btn.disabled = true;
    const prevHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span> Rendering&hellip;';
    $('pv-render-hint').textContent = 'Generating the deck and rasterizing slides. This takes 10 to 30 seconds.';
    try {
      await savePendingReportConfig();
      const data = await apiJson('/api/admin/report-preview-render', { method: 'POST', body: { date } });
      if (!data.available) {
        state.trueImages = [];
        $('pv-film').hidden = true;
        $('pv-true-empty').hidden = false;
        $('pv-true-empty').textContent = 'The true renderer is not installed on this server (needs LibreOffice + poppler). The Live tab remains the guide.';
      } else {
        state.trueImages = data.images || [];
        state.trueIdx = 0;
        renderFilmstrip();
        toast(`True preview rendered: ${state.trueImages.length} slides`);
      }
    } catch (err) {
      toast('Render failed: ' + err.message, { err: true });
    }
    btn.disabled = false;
    btn.innerHTML = prevHtml;
    $('pv-render-hint').textContent = 'Renders the real PPTX through LibreOffice. Takes 10 to 30 seconds.';
  }

  function renderFilmstrip() {
    const imgs = state.trueImages || [];
    $('pv-film').hidden = !imgs.length;
    $('pv-true-empty').hidden = !!imgs.length;
    if (!imgs.length) return;
    // Image URLs carry the password: <img> tags cannot send headers.
    const withPw = (u) => `${u}&password=${encodeURIComponent(state.pw)}`;
    const idx = Math.min(state.trueIdx, imgs.length - 1);
    state.trueIdx = idx;
    $('film-img').src = withPw(imgs[idx]);
    $('film-meta').textContent = `Slide ${idx + 1} of ${imgs.length} · arrow keys to browse`;
    const strip = $('film-strip');
    strip.innerHTML = '';
    imgs.forEach((u, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'film-thumb' + (i === idx ? ' on' : '');
      b.setAttribute('aria-label', `Slide ${i + 1}`);
      b.innerHTML = `<img src="${escapeHtml(withPw(u))}" alt="" loading="lazy" />`;
      b.addEventListener('click', () => { state.trueIdx = i; renderFilmstrip(); });
      strip.appendChild(b);
    });
    const on = strip.querySelector('.film-thumb.on');
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function filmKeydown(e) {
    if (!$('sec-report').classList.contains('on') || $('pv-true').hidden || $('pv-film').hidden) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight' && state.trueIdx < state.trueImages.length - 1) {
      state.trueIdx += 1; renderFilmstrip(); e.preventDefault();
    } else if (e.key === 'ArrowLeft' && state.trueIdx > 0) {
      state.trueIdx -= 1; renderFilmstrip(); e.preventDefault();
    }
  }

  async function generateTestDeck() {
    const date = $('rb-date').value || state.today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) { toast('Pick a date first.', { err: true }); return; }
    const btn = $('rb-generate');
    btn.disabled = true;
    const prevText = btn.textContent;
    btn.textContent = 'Generating…';
    try {
      await savePendingReportConfig();
      await apiJson('/api/generate-report', { method: 'POST', body: { date } });
      toast(`Test deck generated for ${date}`);
      downloadReport(date);
    } catch (err) {
      toast('Test deck failed: ' + err.message, { err: true });
    }
    btn.disabled = false;
    btn.textContent = prevText;
  }

  function initReportBindings() {
    $('report-dimensions').addEventListener('change', previewRefresh);
    $('tpl-file').addEventListener('change', uploadTemplate);
    $('tpl-mode').querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => setTemplateMode(b.dataset.mode));
    });
    $('tpl-colors').addEventListener('change', () => {
      state.reportConfig.template_colors = $('tpl-colors').checked;
    });
    $('pv-tab-live').addEventListener('click', () => setPreviewTab('live'));
    $('pv-tab-true').addEventListener('click', () => setPreviewTab('true'));
    $('pv-render-btn').addEventListener('click', renderTruePreview);
    $('rb-generate').addEventListener('click', generateTestDeck);
    document.addEventListener('keydown', filmKeydown);
  }

  // ══════════════════════════════════════════════════════════
  // DELIVERY
  // ══════════════════════════════════════════════════════════
  async function loadDelivery() {
    try { await fetchSettings(); } catch (err) { toast('Failed to load settings: ' + err.message, { err: true }); return; }
    state.pmEmails = state.settings.pm_emails || [];
    renderPmChips();
    const dc = state.settings.delivery_config || {};
    $('dl-sender').value = dc.sender_name || '';
    $('dl-auto').checked = !!dc.auto_email;
    $('dl-model').value = dc.ai_model || 'claude-opus-5';
    if ($('dl-model').selectedIndex === -1) $('dl-model').value = 'claude-opus-5'; // unknown stored id
    $('dl-anthropic').value = dc.anthropic_api_key || '';
    $('dl-archive').value = dc.archive_path || '';
  }

  function renderPmChips() {
    const box = $('pm-chips');
    box.innerHTML = '';
    if (!state.pmEmails.length) {
      box.innerHTML = '<span class="panel-note">No recipients configured.</span>';
      return;
    }
    state.pmEmails.forEach((email, idx) => {
      const chip = document.createElement('span');
      chip.className = 'pill';
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:8px;font-size:11px;';
      chip.innerHTML = `${escapeHtml(email)} <button type="button" aria-label="Remove ${escapeHtml(email)}" style="color:var(--red);font-size:14px;line-height:1;">&times;</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        state.pmEmails.splice(idx, 1);
        renderPmChips();
      });
      box.appendChild(chip);
    });
  }

  function addPmEmail() {
    const input = $('pm-input');
    const email = input.value.trim();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('That does not look like an email address.', { err: true }); return; }
    if (state.pmEmails.includes(email)) { toast('Already on the list.', { err: true }); return; }
    state.pmEmails.push(email);
    input.value = '';
    renderPmChips();
  }

  async function saveDelivery() {
    const prev = (state.settings && state.settings.delivery_config) || {};
    const dc = {
      ...prev,
      sender_name: $('dl-sender').value.trim(),
      auto_email: $('dl-auto').checked,
      ai_model: $('dl-model').value || 'claude-opus-5',
      anthropic_api_key: $('dl-anthropic').value.trim(),
      archive_path: $('dl-archive').value.trim()
    };
    try {
      await apiJson('/api/admin/settings', {
        method: 'PUT',
        body: { pm_emails: state.pmEmails, delivery_config: dc }
      });
      if (state.settings) { state.settings.delivery_config = dc; state.settings.pm_emails = [...state.pmEmails]; }
      toast('Delivery settings saved');
    } catch (err) { toast('Save failed: ' + err.message, { err: true }); }
  }

  // ══════════════════════════════════════════════════════════
  // SCHEDULE
  // ══════════════════════════════════════════════════════════
  let scheduleConfig = {};

  async function loadSchedule() {
    try {
      scheduleConfig = await apiJson('/api/admin/schedule');
    } catch (err) {
      toast('Failed to load schedule: ' + err.message, { err: true });
      scheduleConfig = {};
    }
    $('sch-reminder').value = scheduleConfig.reminder_time || '21:00';
    $('sch-report').value = scheduleConfig.report_time || '23:00';
    $('sch-deadline').value = scheduleConfig.deadline_text || '';
    $('sch-tz').value = (state.status && state.status.timezone) || 'Asia/Riyadh';
  }

  async function saveSchedule() {
    const payload = { ...scheduleConfig };
    delete payload.password; // never persist a legacy auth key into settings
    payload.reminder_time = $('sch-reminder').value || '21:00';
    payload.report_time = $('sch-report').value || '23:00';
    payload.deadline_text = $('sch-deadline').value.trim();
    try {
      await apiJson('/api/admin/schedule', { method: 'PUT', body: payload });
      scheduleConfig = payload;
      toast('Schedule saved. Cron jobs restarted with the new times.');
      fetchStatus().catch(() => {});
    } catch (err) { toast('Save failed: ' + err.message, { err: true }); }
  }

  // ══════════════════════════════════════════════════════════
  // ARCHIVE
  // ══════════════════════════════════════════════════════════
  async function loadArchive() {
    const box = $('arch-dates');
    let dates;
    try { dates = await apiJson('/api/archive'); }
    catch (err) { box.innerHTML = `<span class="panel-note">Could not load archive: ${escapeHtml(err.message)}</span>`; return; }
    box.innerHTML = '';
    if (!Array.isArray(dates) || !dates.length) {
      box.innerHTML = '<span class="panel-note">No archived dates yet. Dates appear once HODs upload photos.</span>';
      return;
    }
    dates.forEach(item => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'arch-date';
      const n = (item.departments || []).length;
      btn.innerHTML = `${escapeHtml(item.date)}<small>${n} dept${n !== 1 ? 's' : ''}</small>`;
      btn.addEventListener('click', () => {
        box.querySelectorAll('.arch-date').forEach(b => b.classList.toggle('on', b === btn));
        loadArchiveDate(item.date);
      });
      box.appendChild(btn);
    });
  }

  async function loadArchiveDate(date) {
    let data;
    try { data = await apiJson(`/api/archive/${date}`); }
    catch (err) { toast('Failed to load ' + date + ': ' + err.message, { err: true }); return; }
    $('arch-detail').hidden = false;
    $('arch-detail-title').textContent = `Submissions · ${date}`;
    const list = $('arch-cards');
    list.innerHTML = '';
    const depts = data.departments || [];
    if (!depts.length) {
      list.innerHTML = '<p class="panel-note">Nothing recorded for this date.</p>';
      return;
    }
    depts.forEach(d => list.appendChild(archiveCard(date, d)));
  }

  function archiveCard(date, d) {
    const card = document.createElement('div');
    card.className = 'arch-card';
    const sub = d.submission;
    const head = `
      <div class="ac-head">
        <span class="swatch-dot" style="background:${escapeHtml(d.stream_color || 'var(--muted)')}"></span>
        <span class="ac-name">${escapeHtml(d.department)}</span>
        <span class="st ${sub ? 'ok' : 'pending'}">${sub ? 'SUBMITTED' : 'NO SUBMISSION'}</span>
      </div>
    `;
    if (!sub) {
      card.innerHTML = head;
      return card;
    }
    const fields = [
      ['Status', sub.status_text],
      ['Highlights', sub.highlights],
      ['Blockers', sub.blockers, true]
    ].filter(([, v]) => (v || '').trim())
      .map(([label, v, danger]) =>
        `<div class="arch-field"><div class="af-label${danger ? ' blocked' : ''}">${label}</div><div class="af-text">${escapeHtml(v)}</div></div>`
      ).join('');
    const sched = (sub.schedule_updates || []).map(r =>
      `<div class="af-text" style="font-size:11.5px;"><span style="font-family:var(--mono);color:var(--accent-2);">${escapeHtml(r.time || '')}</span> ${escapeHtml(r.activity || '')} <span style="color:var(--muted);font-family:var(--mono);font-size:9.5px;">${escapeHtml((r.status || '').toUpperCase())}</span></div>`
    ).join('');
    // Photo URLs are the one place query-string auth stays: <img> cannot send headers.
    const photos = (d.photos || []).map(p => {
      const base = String(p.url || '').split('?')[0];
      const src = `${base}?password=${encodeURIComponent(state.pw)}`;
      return `<a href="${escapeHtml(src)}" target="_blank" rel="noopener"><img src="${escapeHtml(src)}" alt="${escapeHtml(p.filename || '')}" loading="lazy" /></a>`;
    }).join('');
    card.innerHTML = `
      ${head}
      <div class="ac-meta">${escapeHtml(timeOnly(sub.submitted_at))} · ${sub.overall_progress || 0}% · ${sub.photo_count || 0} photo${sub.photo_count !== 1 ? 's' : ''}</div>
      ${fields}
      ${sched ? `<div class="arch-field"><div class="af-label">Schedule</div>${sched}</div>` : ''}
      ${photos ? `<div class="arch-photos">${photos}</div>` : ''}
    `;
    return card;
  }

  // ══════════════════════════════════════════════════════════
  // PROJECT
  // ══════════════════════════════════════════════════════════
  async function loadProject() {
    try { await fetchSettings(); } catch (err) { toast('Failed to load settings: ' + err.message, { err: true }); return; }
    $('prj-name').value = state.settings.event_name || '';
    $('prj-edition').value = state.settings.event_edition || '';
  }

  async function saveProject() {
    try {
      await apiJson('/api/admin/settings', {
        method: 'PUT',
        body: {
          event_name: $('prj-name').value.trim(),
          event_edition: $('prj-edition').value.trim()
        }
      });
      toast('Project saved');
      fetchSettings().catch(() => {});
      refreshChrome();
    } catch (err) { toast('Save failed: ' + err.message, { err: true }); }
  }

  // ── Init ──────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    initNav();
    initBrandBindings();
    initWaBindings();

    // Gate
    $('gate-btn').addEventListener('click', tryLogin);
    $('gate-pw').addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });

    // Overview
    $('date-prev').addEventListener('click', () => { state.viewDate = shiftDate(state.viewDate, -1); loadOverview(); });
    $('date-next').addEventListener('click', () => {
      if (state.viewDate >= state.today) return;
      state.viewDate = shiftDate(state.viewDate, 1);
      loadOverview();
    });
    $('act-generate').addEventListener('click', generateReport);
    $('act-remind').addEventListener('click', remindAll);
    $('act-download').addEventListener('click', () => downloadReport(state.viewDate));
    $('log-toggle').addEventListener('click', () => {
      const open = $('log-rows').classList.toggle('open');
      $('log-toggle').classList.toggle('open', open);
      if (open) loadLogs();
    });

    // Overview: submission drawer (close button, click outside, Esc)
    $('drawer-close').addEventListener('click', closeDrawer);
    $('drawer-overlay').addEventListener('click', e => {
      if (e.target === $('drawer-overlay')) closeDrawer();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeDrawer();
    });

    // Departments
    $('dept-add-btn').addEventListener('click', addDepartment);

    // Credentials modal
    $('cred-copy').addEventListener('click', copyCredentials);
    $('cred-modal-close').addEventListener('click', () => {
      // The one-time password must not linger in the hidden DOM.
      for (const id of ['cred-modal-user', 'cred-modal-pass', 'cred-modal-dept']) $(id).textContent = '';
      $('cred-modal').hidden = true;
    });

    // Report
    $('report-save').addEventListener('click', saveReport);
    initReportBindings();

    // Delivery
    $('pm-add').addEventListener('click', addPmEmail);
    $('pm-input').addEventListener('keydown', e => { if (e.key === 'Enter') addPmEmail(); });
    $('dl-anthropic-reveal').addEventListener('click', () => {
      const inp = $('dl-anthropic');
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      $('dl-anthropic-reveal').textContent = show ? 'Hide' : 'Show';
    });
    $('delivery-save').addEventListener('click', saveDelivery);

    // Schedule
    $('schedule-save').addEventListener('click', saveSchedule);

    // Project
    $('project-save').addEventListener('click', saveProject);

    // Brand the gate card even before login
    fetchStatus().then(s => { state.today = s.date; applyLockup(s); }).catch(() => {});

    // Resume session if the stored password still verifies
    if (state.pw && await verify(state.pw).catch(() => false)) enterConsole();
  });
})();
