// CLIO admin console: vanilla JS, sidebar shell, header-authenticated API.
// Sections: overview, departments, whatsapp (placeholder), brand, report,
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
    overviewTimer: null
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
    whatsapp: () => {},
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

    const byDept = new Map(subs.map(r => [r.department_id, r]));
    const withContact = depts.filter(d => (d.head_email || '').trim() || (d.head_whatsapp || '').trim());
    const denom = withContact.length || depts.length;
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

  function renderStreams(depts, byDept) {
    const box = $('ov-streams');
    box.innerHTML = '';
    if (!depts.length) {
      box.innerHTML = '<p class="panel-note">No departments configured yet.</p>';
      return;
    }
    depts.forEach(d => {
      const sub = byDept.get(d.id);
      const row = document.createElement('div');
      row.className = 'sub-row' + (sub ? '' : ' missing');
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
      box.appendChild(row);
    });
    box.querySelectorAll('.nudge').forEach(btn => {
      btn.addEventListener('click', () => nudge(btn));
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
    const list = $('dept-list');
    list.innerHTML = '';
    if (!depts.length) list.innerHTML = '<p class="panel-note">No departments yet. Add the first one.</p>';
    depts.forEach(d => list.appendChild(deptRow(d)));
  }

  function deptRow(d) {
    const row = document.createElement('div');
    row.className = 'dept-admin-row';
    row.innerHTML = `
      <div class="dept-admin-head">
        <span class="swatch-dot" style="background:${escapeHtml(d.stream_color || '#3B82F6')}"></span>
        <span class="da-name">${escapeHtml(d.name)}</span>
        <span class="da-meta"><b>${escapeHtml(d.head_name || 'No HOD')}</b>
          ${d.head_email ? ' · ' + escapeHtml(d.head_email) : ''}
          ${d.head_whatsapp ? ' · ' + escapeHtml(d.head_whatsapp) : ''}</span>
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
      row.appendChild(deptEditor(d));
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

  function deptEditor(d) {
    const isNew = !d.id;
    const wrap = document.createElement('div');
    wrap.className = 'dept-editor';
    const color = d.stream_color || '#3B82F6';
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
    `;
    const pick = wrap.querySelector('[data-f="color-pick"]');
    const hex = wrap.querySelector('[data-f="stream_color"]');
    pick.addEventListener('input', () => { hex.value = pick.value.toUpperCase(); });
    hex.addEventListener('change', () => {
      if (/^#[0-9a-f]{6}$/i.test(hex.value.trim())) pick.value = hex.value.trim();
    });
    wrap.querySelector('.cancel').addEventListener('click', () => wrap.remove());
    wrap.querySelector('.save').addEventListener('click', async () => {
      const payload = {
        name: wrap.querySelector('[data-f="name"]').value.trim(),
        head_name: wrap.querySelector('[data-f="head_name"]').value.trim(),
        head_email: wrap.querySelector('[data-f="head_email"]').value.trim(),
        head_whatsapp: wrap.querySelector('[data-f="head_whatsapp"]').value.trim(),
        stream_color: /^#[0-9a-f]{6}$/i.test(hex.value.trim()) ? hex.value.trim() : pick.value
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
    $('dept-list').prepend(deptEditor({}));
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
    renderSlides();
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
        });
      });
      card.querySelector('.sc-enable').addEventListener('change', e => {
        card.classList.toggle('off', !e.target.checked);
      });
      list.appendChild(card);
    });
  }

  function syncReportConfigFromDom() {
    const cfg = { ...state.reportConfig };
    cfg.slide_dimensions = $('report-dimensions').value;
    cfg.slide_order = slideOrder();
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

    // Departments
    $('dept-add-btn').addEventListener('click', addDepartment);

    // Report
    $('report-save').addEventListener('click', saveReport);

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
