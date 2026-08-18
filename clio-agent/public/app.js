// CLIO operator portal: vanilla JS, mobile-first, three-step guided flow.
// Screens: select -> (readonly | form steps 1..3) -> success.
(() => {
  'use strict';

  // ── State ───────────────────────────────────────────────
  const state = {
    date: null,
    reportTime: '23:00',
    eventName: '',
    edition: '',
    brand: null,
    departments: [],
    dept: null,           // department currently open
    existing: null,       // existing submission row when editing, else null
    step: 1,
    progress: 0,
    photos: [],           // new File objects pending upload
    captions: {},         // new-photo captions keyed by file.name (pipeline keying, do not change)
    existingPhotos: [],   // [{ base, capKey, caption }] photos already on the server
    cameFrom: 'screen-select',
    submitting: false
  };

  // ── DOM utils ───────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const screens = ['screen-select', 'screen-readonly', 'screen-form', 'screen-success'];

  function show(id) {
    screens.forEach(s => $(s).classList.toggle('active', s === id));
    window.scrollTo(0, 0);
  }
  function activeScreen() {
    return screens.find(s => $(s).classList.contains('active'));
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function hhmm(d) {
    const dt = d || new Date();
    return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  }

  function shortDate(iso) {
    // "MON 18 AUG"
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase().replace(/,/g, '');
  }

  function timeOnly(stamp) {
    // "2026-08-18 21:47:12" -> "21:47"
    if (!stamp) return '';
    const m = String(stamp).match(/(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : '';
  }

  // ── Drafts (localStorage, per department per date) ──────
  const DRAFT_KEY = (deptId, date) => `clio_draft_${deptId}_${date}`;
  function saveDraft(deptId, date, data) { try { localStorage.setItem(DRAFT_KEY(deptId, date), JSON.stringify(data)); } catch {} }
  function loadDraft(deptId, date) { try { return JSON.parse(localStorage.getItem(DRAFT_KEY(deptId, date)) || 'null'); } catch { return null; } }
  function clearDraft(deptId, date) { try { localStorage.removeItem(DRAFT_KEY(deptId, date)); } catch {} }

  let draftTimer = null;
  function scheduleDraftSave() {
    if (!state.dept) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      saveDraft(state.dept.id, state.date, collectDraft());
      const el = $('autosave');
      el.textContent = `● draft saved ${hhmm()}`;
      el.classList.add('show');
    }, 500);
  }

  function collectDraft() {
    return {
      progress: state.progress,
      status_text: $('status_text').value,
      highlights: $('highlights').value,
      blockers: $('blockers').value,
      schedule: collectSchedule(),
      captions: state.captions,
      existingCaptions: Object.fromEntries(state.existingPhotos.map(p => [p.capKey, p.caption])),
      step: state.step
    };
  }

  // ── API ─────────────────────────────────────────────────
  async function fetchStatus() {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('status fetch failed');
    return res.json();
  }

  async function fetchSubmission(deptId) {
    try {
      const res = await fetch(`/api/submission/${deptId}`);
      if (!res.ok) return null;
      return res.json();
    } catch { return null; }
  }

  // ── Brand injection ─────────────────────────────────────
  function hexToRgb(hex) {
    const m = String(hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function applyBrand(data) {
    const b = data.brand || {};
    const root = document.documentElement.style;
    if (b.background_color) root.setProperty('--bg', b.background_color);
    if (b.primary_color) root.setProperty('--accent', b.primary_color);
    if (b.label_color) root.setProperty('--accent-2', b.label_color);
    if (b.text_color) root.setProperty('--text', b.text_color);
    if (b.muted_color) root.setProperty('--muted', b.muted_color);
    if (b.panel_color) root.setProperty('--panel', b.panel_color);
    if (b.font_family) {
      const stack = `"${b.font_family}", "Sora", sans-serif`;
      root.setProperty('--display', stack);
      root.setProperty('--ui', stack);
    }
    // Derive interaction tints from the brand accent so focus rings
    // and glows stay consistent with a rebranded primary color.
    const rgb = hexToRgb(b.primary_color);
    if (rgb) {
      root.setProperty('--accent-soft', `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.14)`);
      root.setProperty('--accent-glow', `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.35)`);
    }
    const rgb2 = hexToRgb(b.label_color);
    if (rgb2) root.setProperty('--accent-2-soft', `rgba(${rgb2[0]},${rgb2[1]},${rgb2[2]},0.14)`);

    // Logo in the header when present, event name text otherwise.
    if (data.logo_url) {
      $('brand-logo').src = data.logo_url;
      $('portal-logo').hidden = false;
    } else {
      $('portal-logo').hidden = true;
    }
    // Company name in the footer when present.
    const foot = $('portal-foot');
    if (b.company_name) {
      foot.textContent = b.company_name;
      foot.hidden = false;
    } else {
      foot.hidden = true;
    }
  }

  // ── Deadline pill ───────────────────────────────────────
  function renderDeadline() {
    const pill = $('pill-deadline');
    const t = String(state.reportTime || '23:00');
    const m = t.match(/^(\d{1,2}):(\d{2})$/);
    let label = `REPORT AT ${t}`;
    let warn = false;
    if (m) {
      const target = new Date();
      target.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
      const diffMin = Math.floor((target - new Date()) / 60000);
      if (diffMin > 0) {
        const h = Math.floor(diffMin / 60);
        const min = diffMin % 60;
        label += ` · ${h > 0 ? h + 'H ' : ''}${min}M LEFT`;
        warn = true;
      }
    }
    pill.textContent = label;
    pill.classList.toggle('warn', warn);
    pill.hidden = false;
  }

  // ── Screen 1: select ────────────────────────────────────
  async function refreshStatus() {
    try {
      const data = await fetchStatus();
      state.date = data.date;
      state.reportTime = data.report_time || '23:00';
      state.eventName = data.event_name || '';
      state.edition = data.event_edition || '';
      state.brand = data.brand || {};
      state.departments = data.departments || [];

      applyBrand(data);

      $('ev-name').textContent = state.eventName || 'Daily Report';
      $('pill-date').textContent = shortDate(state.date) + (state.edition ? ` · ${state.edition.toUpperCase()}` : '');
      renderDeadline();

      const done = state.departments.filter(d => d.submitted).length;
      $('team-line').innerHTML = `<b>${done} OF ${state.departments.length}</b> SUBMITTED TONIGHT`;

      const list = $('dept-list');
      list.innerHTML = '';
      state.departments.forEach(d => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'dept-card';
        card.innerHTML = `
          <span class="dot" style="background:${escapeHtml(d.stream_color || '#3B82F6')}"></span>
          <span class="dn">${escapeHtml(d.name)}</span>
          <span class="st ${d.submitted ? 'ok' : 'pending'}">${d.submitted ? `${escapeHtml(timeOnly(d.submitted_at))} ✓` : 'PENDING'}</span>
        `;
        card.addEventListener('click', () => openDepartment(d));
        list.appendChild(card);
      });
    } catch (err) {
      console.error('refreshStatus failed:', err);
    }
  }

  async function openDepartment(dept) {
    state.dept = dept;
    if (dept.submitted) {
      const sub = await fetchSubmission(dept.id);
      if (sub) return renderReadonly(dept, sub);
    }
    enterForm(dept, null, 'screen-select');
  }

  // ── Screen 2: read-only summary ─────────────────────────
  function renderReadonly(dept, sub) {
    state.dept = dept;
    state.existing = sub;

    $('ro-dot').style.background = dept.stream_color || 'var(--accent)';
    $('ro-dept-name').textContent = dept.name;
    $('ro-pill-time').textContent = `SUBMITTED ${timeOnly(sub.submitted_at)}`;
    $('ro-pill-version').textContent = `V${sub.version || 1}`;

    const pct = sub.overall_progress || 0;
    $('ro-bar').style.width = `${pct}%`;
    $('ro-pct').textContent = `${pct}%`;

    setRoText('ro-status', sub.status_text);
    setRoText('ro-highlights', sub.highlights);
    if (sub.blockers) {
      $('ro-blockers-wrap').style.display = '';
      setRoText('ro-blockers', sub.blockers);
    } else {
      $('ro-blockers-wrap').style.display = 'none';
    }

    const sched = sub.schedule_updates || [];
    $('ro-schedule-wrap').style.display = sched.length ? '' : 'none';
    $('ro-schedule').innerHTML = sched.map(a => {
      const st = (a.status || '').toLowerCase();
      const cls = st === 'completed' ? 'done-s' : (st === 'in progress' ? 'prog-s' : '');
      return `<div class="ro-sched-row">
        <span class="t">${escapeHtml(a.time || '··')}</span>
        <span class="a">${escapeHtml(a.activity || '')}</span>
        <span class="s ${cls}">${escapeHtml(a.status || '')}</span>
      </div>`;
    }).join('');

    const photos = sub.photos || [];
    const caps = sub.photo_captions || {};
    $('ro-photos-wrap').style.display = photos.length ? '' : 'none';
    $('ro-photos').innerHTML = photos.map(p => {
      const base = String(p).split('/').pop();
      const cap = matchCaption(base, caps);
      return `<div class="photo-cell">
        <div class="img"><div class="file-tile">${escapeHtml(base)}</div></div>
        <div class="cap"><span class="cl">Caption</span><span style="font-size:12.5px;color:var(--text-dim)">${escapeHtml(cap || 'No caption')}</span></div>
      </div>`;
    }).join('');

    $('ro-edit-btn').onclick = () => enterForm(dept, sub, 'screen-readonly');
    show('screen-readonly');
  }

  function setRoText(id, text) {
    const el = $(id);
    if (text) { el.textContent = text; el.classList.remove('empty'); }
    else { el.textContent = 'Not provided'; el.classList.add('empty'); }
  }

  // Match a stored caption to a saved photo filename. The server prefixes
  // saved files, and captions are keyed by the original filename, so the
  // deck matches with "key in basename". Mirror that here.
  function matchCaption(base, captions) {
    for (const key of Object.keys(captions || {})) {
      if (base.includes(key) || base.endsWith(key)) return captions[key];
    }
    return '';
  }
  function matchCaptionKey(base, captions) {
    for (const key of Object.keys(captions || {})) {
      if (base.includes(key) || base.endsWith(key)) return key;
    }
    return base; // no existing caption: key by full basename, which still matches "key in base"
  }

  // ── Screen 3: form ──────────────────────────────────────
  const STEP_NAMES = { 1: 'Progress', 2: 'Notes', 3: 'Photos' };

  function enterForm(dept, existing, cameFrom) {
    state.dept = dept;
    state.existing = existing || null;
    state.cameFrom = cameFrom || 'screen-select';
    state.step = 1;
    state.photos = [];
    state.captions = {};
    state.submitting = false;

    // Base values from the existing submission, if editing
    state.progress = existing ? (existing.overall_progress || 0) : 0;
    $('status_text').value = existing ? (existing.status_text || '') : '';
    $('highlights').value = existing ? (existing.highlights || '') : '';
    $('blockers').value = existing ? (existing.blockers || '') : '';

    const caps = (existing && existing.photo_captions) || {};
    state.existingPhotos = ((existing && existing.photos) || []).map(p => {
      const base = String(p).split('/').pop();
      const capKey = matchCaptionKey(base, caps);
      return { base, capKey, caption: caps[capKey] || '' };
    });

    let schedule = (existing && existing.schedule_updates) || [];

    // Overlay any local draft (newer than what the server has)
    const draft = loadDraft(dept.id, state.date);
    if (draft) {
      if (typeof draft.progress === 'number') state.progress = draft.progress;
      if (typeof draft.status_text === 'string') $('status_text').value = draft.status_text;
      if (typeof draft.highlights === 'string') $('highlights').value = draft.highlights;
      if (typeof draft.blockers === 'string') $('blockers').value = draft.blockers;
      if (Array.isArray(draft.schedule) && draft.schedule.length) schedule = draft.schedule;
      if (draft.captions && typeof draft.captions === 'object') state.captions = draft.captions;
      if (draft.existingCaptions) {
        state.existingPhotos.forEach(p => {
          if (typeof draft.existingCaptions[p.capKey] === 'string') p.caption = draft.existingCaptions[p.capKey];
        });
      }
    }

    // Schedule rows
    $('sched-rows').innerHTML = '';
    (schedule.length ? schedule : [{ time: '', activity: '', status: 'Pending' }]).forEach(addScheduleRow);

    // Reset review markers so untouched restored text is not re-sent
    ['status_text', 'highlights', 'blockers'].forEach(id => { $(id).dataset.reviewed = $(id).value.trim(); });

    setProgressUI(state.progress);
    renderPhotoGrid();
    $('form-error').classList.remove('show');
    $('autosave').classList.remove('show');
    $('file-input').value = '';
    renderStep();
    show('screen-form');
  }

  function renderStep() {
    const n = state.step;
    [1, 2, 3].forEach(i => {
      $(`step-${i}`).classList.toggle('active', i === n);
      $(`step-seg-${i}`).classList.toggle('done', i <= n);
    });
    $('form-title').textContent = `${state.dept.name} · ${STEP_NAMES[n]}`;
    $('form-sub').textContent = `Step ${n} of 3 · ${STEP_NAMES[n]}`;
    $('form-back-label').textContent = n === 1
      ? (state.cameFrom === 'screen-readonly' ? 'Summary' : 'Departments')
      : STEP_NAMES[n - 1];
    const btn = $('btn-continue');
    btn.disabled = false;
    btn.textContent = n === 1 ? 'Continue to Notes →'
      : n === 2 ? 'Continue to Photos →'
      : (state.existing ? 'Update report' : 'Submit report');
  }

  function goBack() {
    if (state.submitting) return;
    if (state.step > 1) {
      state.step -= 1;
      renderStep();
      window.scrollTo(0, 0);
    } else {
      show(state.cameFrom === 'screen-readonly' ? 'screen-readonly' : 'screen-select');
      if (state.cameFrom !== 'screen-readonly') refreshStatus();
    }
  }

  function goForward() {
    if (state.step === 2 && !$('status_text').value.trim()) {
      showError("Today's status is required before you continue.");
      $('status_text').focus();
      return;
    }
    $('form-error').classList.remove('show');
    if (state.step < 3) {
      state.step += 1;
      renderStep();
      scheduleDraftSave();
      window.scrollTo(0, 0);
    } else {
      handleSubmit();
    }
  }

  function showError(msg) {
    const el = $('form-error');
    el.textContent = msg;
    el.classList.add('show');
  }

  // Progress slider
  function setProgressUI(val) {
    state.progress = Math.max(0, Math.min(100, parseInt(val, 10) || 0));
    const range = $('progress-range');
    range.value = state.progress;
    range.style.setProperty('--pct', `${state.progress}%`);
    $('big-pct').textContent = state.progress;
  }

  // Schedule rows
  function addScheduleRow(data) {
    const row = document.createElement('div');
    row.className = 'sched-row';
    row.innerHTML = `
      <input type="time" class="input in-time" value="${escapeHtml((data && data.time) || '')}" aria-label="Time" />
      <input type="text" class="input in-activity" placeholder="Activity" value="${escapeHtml((data && data.activity) || '')}" aria-label="Activity" />
      <button type="button" class="row-remove" aria-label="Remove row">×</button>
      <select class="input in-status" aria-label="Status">
        <option>Pending</option>
        <option>In Progress</option>
        <option>Completed</option>
      </select>
    `;
    const sel = row.querySelector('select');
    if (data && data.status) sel.value = data.status;
    row.querySelector('.row-remove').addEventListener('click', () => { row.remove(); scheduleDraftSave(); });
    $('sched-rows').appendChild(row);
  }

  function collectSchedule() {
    return Array.from(document.querySelectorAll('#sched-rows .sched-row'))
      .map(row => ({
        time: row.querySelector('.in-time').value.trim(),
        activity: row.querySelector('.in-activity').value.trim(),
        status: row.querySelector('.in-status').value
      }))
      .filter(r => r.time || r.activity);
  }

  // ── Photos ──────────────────────────────────────────────
  function addPhotoFiles(files) {
    const MAX_NEW = 20; // server accepts up to 20 files per submit
    for (const f of files) {
      if (state.photos.length >= MAX_NEW) break;
      if (!/^image\//.test(f.type || '') && !/\.(jpe?g|png|heic|heif|webp)$/i.test(f.name)) continue;
      if (state.photos.some(p => p.name === f.name && p.size === f.size)) continue;
      state.photos.push(f);
    }
    renderPhotoGrid();
    scheduleDraftSave();
  }

  function renderPhotoGrid() {
    const grid = $('photo-grid');
    grid.innerHTML = '';

    // Photos already on the server (edit mode): caption-only, no re-upload
    state.existingPhotos.forEach(p => {
      const cell = document.createElement('div');
      cell.className = 'photo-cell';
      const tail = p.base.length > 34 ? `…${p.base.slice(-30)}` : p.base;
      cell.innerHTML = `
        <div class="img"><div class="file-tile">Uploaded<br>${escapeHtml(tail)}</div></div>
        <div class="cap"><span class="cl">Caption</span></div>
      `;
      const cap = document.createElement('input');
      cap.type = 'text';
      cap.className = 'cap-input';
      cap.setAttribute('aria-label', 'Photo caption');
      cap.placeholder = 'Describe this photo…';
      cap.value = p.caption || '';
      cap.dataset.reviewed = (p.caption || '').trim();
      cap.addEventListener('input', () => { p.caption = cap.value; scheduleDraftSave(); });
      cap.addEventListener('blur', () => reviewOnBlur(cap, 'photo caption', v => { p.caption = v; }));
      cell.querySelector('.cap').appendChild(cap);
      grid.appendChild(cell);
    });

    // Newly picked photos
    state.photos.forEach((file, idx) => {
      const cell = document.createElement('div');
      cell.className = 'photo-cell';

      const imgWrap = document.createElement('div');
      imgWrap.className = 'img';
      const isPreviewable = /^image\//.test(file.type || '') && !/hei[cf]/i.test(file.type || '');
      if (isPreviewable) {
        const img = document.createElement('img');
        img.alt = file.name;
        img.src = URL.createObjectURL(file);
        img.onload = () => URL.revokeObjectURL(img.src);
        imgWrap.appendChild(img);
      } else {
        imgWrap.innerHTML = `<div class="file-tile">${escapeHtml(file.name)}</div>`;
      }
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'remove-photo';
      rm.setAttribute('aria-label', 'Remove photo');
      rm.textContent = '×';
      rm.addEventListener('click', () => {
        state.photos.splice(idx, 1);
        delete state.captions[file.name];
        renderPhotoGrid();
        scheduleDraftSave();
      });
      imgWrap.appendChild(rm);
      cell.appendChild(imgWrap);

      const capWrap = document.createElement('div');
      capWrap.className = 'cap';
      capWrap.innerHTML = '<span class="cl">Caption</span>';
      const cap = document.createElement('input');
      cap.type = 'text';
      cap.className = 'cap-input';
      cap.setAttribute('aria-label', 'Photo caption');
      cap.placeholder = 'Describe this photo…';
      cap.value = state.captions[file.name] || '';
      cap.dataset.reviewed = (state.captions[file.name] || '').trim();
      // Captions keyed by original filename: the server stores this map and
      // the PPTX generator matches it against the saved filename.
      cap.addEventListener('input', () => { state.captions[file.name] = cap.value; scheduleDraftSave(); });
      cap.addEventListener('blur', () => reviewOnBlur(cap, 'photo caption', v => { state.captions[file.name] = v; }));
      capWrap.appendChild(cap);
      cell.appendChild(capWrap);
      grid.appendChild(cell);
    });

    // Add tile
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'photo-add';
    add.innerHTML = '<span class="plus">+</span>Add photo';
    add.addEventListener('click', () => $('file-input').click());
    grid.appendChild(add);
  }

  // ── LLM review (rate-limit friendly: only on blur, only when changed) ──
  async function reviewOnBlur(el, fieldType, apply) {
    const text = el.value.trim();
    if (!text || text === el.dataset.reviewed) return;
    el.dataset.reviewed = text; // mark first so rapid blur cycles do not re-fire
    try {
      const res = await fetch('/api/review-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, field_type: fieldType })
      });
      if (!res.ok) return;
      const data = await res.json();
      const polished = (data && data.polished) ? String(data.polished).trim() : '';
      if (!polished || polished === text) return;
      if (el.value.trim() !== text) return; // user kept typing, do not clobber
      el.value = polished;
      el.dataset.reviewed = polished;
      if (apply) apply(polished);
      el.classList.remove('polished');
      void el.offsetWidth; // restart the flash animation
      el.classList.add('polished');
      scheduleDraftSave();
    } catch { /* never block on polish */ }
  }

  // ── Submit ──────────────────────────────────────────────
  async function handleSubmit() {
    if (state.submitting) return;
    const status = $('status_text').value.trim();
    if (!status) {
      state.step = 2;
      renderStep();
      showError("Today's status is required.");
      return;
    }

    // photo_captions keyed by original filename (new files) merged with the
    // keys of already-uploaded photos; the server merges this over old captions.
    const captionMap = {};
    state.existingPhotos.forEach(p => { captionMap[p.capKey] = p.caption || ''; });
    state.photos.forEach(f => {
      if (state.captions[f.name]) captionMap[f.name] = state.captions[f.name];
    });

    const fd = new FormData();
    fd.append('department_id', state.dept.id);
    fd.append('overall_progress', state.progress);
    fd.append('status_text', status);
    fd.append('highlights', $('highlights').value.trim());
    fd.append('blockers', $('blockers').value.trim());
    fd.append('schedule_updates', JSON.stringify(collectSchedule()));
    fd.append('photo_captions', JSON.stringify(captionMap));
    state.photos.forEach(f => fd.append('photos', f));

    const btn = $('btn-continue');
    state.submitting = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Uploading…';

    try {
      const res = await fetch('/api/submit', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'submission failed');

      clearDraft(state.dept.id, state.date);
      renderSuccess();
      refreshStatus();
    } catch (err) {
      showError(`Submission failed: ${err.message}. Your draft is saved on this device.`);
      state.submitting = false;
      renderStep();
    }
  }

  function renderSuccess() {
    const photoTotal = state.existingPhotos.length + state.photos.length;
    $('success-title').textContent = `Submitted ${hhmm()}`;
    $('success-note').textContent = `AI polishes your text for the report. You can edit your submission until the ${state.reportTime} report is generated.`;
    $('r-dept').textContent = state.dept.name;
    $('r-date').textContent = shortDate(state.date);
    $('r-progress').textContent = `${state.progress}%`;
    $('r-photos').textContent = String(photoTotal);
    show('screen-success');
  }

  async function editAgain() {
    const sub = await fetchSubmission(state.dept.id);
    enterForm(state.dept, sub, 'screen-select');
  }

  // ── Init ────────────────────────────────────────────────
  function init() {
    $('ro-back').addEventListener('click', () => { show('screen-select'); refreshStatus(); });
    $('form-back').addEventListener('click', goBack);
    $('btn-continue').addEventListener('click', goForward);
    $('btn-edit-again').addEventListener('click', editAgain);
    $('btn-done').addEventListener('click', () => { show('screen-select'); refreshStatus(); });

    $('progress-range').addEventListener('input', (e) => {
      setProgressUI(e.target.value);
      scheduleDraftSave();
    });

    ['status_text', 'highlights', 'blockers'].forEach(id => {
      const el = $(id);
      el.addEventListener('input', scheduleDraftSave);
      const type = id === 'status_text' ? 'status summary' : id;
      el.addEventListener('blur', () => reviewOnBlur(el, type));
    });

    $('add-row-btn').addEventListener('click', () => { addScheduleRow(); scheduleDraftSave(); });
    $('sched-rows').addEventListener('input', scheduleDraftSave);

    $('file-input').addEventListener('change', (e) => {
      addPhotoFiles(Array.from(e.target.files || []));
      e.target.value = '';
    });

    refreshStatus();
    // Keep the select screen and countdown fresh without stomping the form
    setInterval(() => {
      if (activeScreen() === 'screen-select') refreshStatus();
      else renderDeadline();
    }, 60000);
    setInterval(renderDeadline, 30000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
