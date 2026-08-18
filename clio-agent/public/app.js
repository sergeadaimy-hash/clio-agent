// CLIO portal app.js: vanilla JS, mobile-first
(() => {
  const state = {
    date: null,
    departments: [],
    currentDept: null,
    photos: [], // File objects pending upload
    captions: {} // idx -> caption text
  };

  // ── DOM utils ───────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const screens = ['screen-select', 'screen-readonly', 'screen-form', 'screen-success'];
  function show(id) {
    screens.forEach(s => $(s).classList.toggle('active', s === id));
    window.scrollTo(0, 0);
  }

  function formatDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── API ─────────────────────────────────────────────
  async function fetchStatus() {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('status fetch failed');
    return res.json();
  }

  async function fetchSubmission(deptId) {
    const res = await fetch(`/api/submission/${deptId}`);
    if (!res.ok) return null;
    return res.json();
  }

  // ── Render screen 1 ─────────────────────────────────
  async function refreshStatus() {
    try {
      const data = await fetchStatus();
      state.date = data.date;
      state.departments = data.departments;
      const eventLabel = [data.event_name, data.event_edition].filter(Boolean).join(' · ');
      $('event-name').textContent = eventLabel;
      $('date-line').textContent = formatDate(data.date);

      const logoEl = $('brand-logo');
      const wordmarkEl = $('brand-wordmark');
      if (data.logo_url) {
        logoEl.src = data.logo_url;
        logoEl.style.display = '';
        wordmarkEl.style.display = 'none';
      } else {
        logoEl.style.display = 'none';
        wordmarkEl.style.display = '';
      }

      const submitted = data.departments.filter(d => d.submitted);
      $('sub-count').textContent = submitted.length;
      $('sub-total').textContent = data.departments.length;

      // Dots
      const dots = $('dots');
      dots.innerHTML = '';
      data.departments.forEach(d => {
        const el = document.createElement('div');
        el.className = 'dot' + (d.submitted ? ' done' : '');
        el.style.background = d.submitted ? d.stream_color : '';
        dots.appendChild(el);
      });

      // Grid
      const grid = $('dept-grid');
      grid.innerHTML = '';
      data.departments.forEach(d => {
        const card = document.createElement('div');
        card.className = 'dept-card';
        card.innerHTML = `
          <span class="accent" style="background:${d.stream_color}"></span>
          <div class="name" style="color:${d.stream_color}">${escapeHtml(d.name)}</div>
          <div class="badge ${d.submitted ? 'done' : ''}">
            ${d.submitted
              ? `✓ Submitted <span class="pct">${d.overall_progress}%</span>`
              : 'Not submitted yet'}
          </div>
        `;
        card.addEventListener('click', () => openDepartment(d));
        grid.appendChild(card);
      });
    } catch (err) {
      console.error('refreshStatus err', err);
    }
  }

  async function openDepartment(dept) {
    state.currentDept = dept;
    if (dept.submitted) {
      const sub = await fetchSubmission(dept.id);
      if (sub) return showReadonly(dept, sub);
    }
    showForm(dept, null);
  }

  // ── Readonly ────────────────────────────────────────
  function showReadonly(dept, sub) {
    $('ro-dept-name').textContent = dept.name;
    $('ro-dept-name').style.color = dept.stream_color;
    $('readonly-banner').style.borderLeftColor = dept.stream_color;
    $('ro-pct').textContent = `${sub.overall_progress}%`;
    $('ro-pct').style.color = dept.stream_color;
    $('ro-status').textContent = sub.status_text || 'Not provided';
    $('ro-highlights').textContent = sub.highlights || 'Not provided';
    if (sub.blockers) {
      $('ro-blockers-wrap').style.display = '';
      $('ro-blockers').textContent = sub.blockers;
    } else {
      $('ro-blockers-wrap').style.display = 'none';
    }
    const tbody = $('ro-schedule-body');
    tbody.innerHTML = '';
    (sub.schedule_updates || []).forEach(a => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(a.time||'')}</td><td>${escapeHtml(a.activity||'')}</td><td>${escapeHtml(a.status||'')}</td>`;
      tbody.appendChild(tr);
    });
    const thumbs = $('ro-thumbs');
    thumbs.innerHTML = '';
    (sub.photos || []).forEach(p => {
      const el = document.createElement('div');
      el.className = 'thumb';
      const fname = p.split('/').pop();
      el.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:10px;padding:8px;text-align:center;">${escapeHtml(fname)}</div>`;
      thumbs.appendChild(el);
    });

    $('update-btn').onclick = () => showForm(dept, sub);
    show('screen-readonly');
  }

  // ── Form ────────────────────────────────────────────
  function showForm(dept, existing) {
    $('form-dept-name').textContent = dept.name;
    $('form-dept-name').style.color = dept.stream_color;
    $('form-subdate').textContent = formatDate(state.date);
    $('department_id').value = dept.id;

    // Accent colors
    document.documentElement.style.setProperty('--accent', dept.stream_color);

    // Reset
    const progress = existing ? existing.overall_progress : 0;
    $('overall_progress').value = progress;
    $('slider-value').textContent = `${progress}%`;
    $('slider-value').style.color = dept.stream_color;
    $('status_text').value = existing ? (existing.status_text || '') : '';
    $('highlights').value = existing ? (existing.highlights || '') : '';
    $('blockers').value = existing ? (existing.blockers || '') : '';
    $('status-count').textContent = `${$('status_text').value.length}/300`;

    const rows = $('schedule-rows');
    rows.innerHTML = '';
    const schedule = existing && existing.schedule_updates && existing.schedule_updates.length
      ? existing.schedule_updates
      : [{time:'',activity:'',status:'Pending'},{time:'',activity:'',status:'Pending'},{time:'',activity:'',status:'Pending'}];
    schedule.forEach(s => addScheduleRow(s));

    state.photos = [];
    state.captions = {};
    $('preview').innerHTML = '';
    $('file-input').value = '';

    $('submit-btn').disabled = false;
    $('submit-btn').textContent = 'Submit Report';

    show('screen-form');
  }

  function addScheduleRow(data) {
    const row = document.createElement('div');
    row.className = 'schedule-row';
    row.innerHTML = `
      <input type="time" value="${escapeHtml((data && data.time) || '')}" />
      <input type="text" placeholder="Activity" value="${escapeHtml((data && data.activity) || '')}" />
      <select>
        <option>Pending</option>
        <option>In Progress</option>
        <option>Completed</option>
      </select>
      <button type="button" class="remove" aria-label="Remove row">×</button>
    `;
    const sel = row.querySelector('select');
    if (data && data.status) sel.value = data.status;
    row.querySelector('.remove').addEventListener('click', () => row.remove());
    $('schedule-rows').appendChild(row);
  }

  function collectSchedule() {
    return Array.from(document.querySelectorAll('#schedule-rows .schedule-row'))
      .map(row => {
        const inputs = row.querySelectorAll('input');
        const sel = row.querySelector('select');
        return {
          time: inputs[0].value.trim(),
          activity: inputs[1].value.trim(),
          status: sel.value
        };
      })
      .filter(r => r.time || r.activity);
  }

  // ── Photo handling ──────────────────────────────────
  function addPhotoFiles(files) {
    const max = 20;
    for (const f of files) {
      if (state.photos.length >= max) break;
      state.photos.push(f);
    }
    renderPreviews();
  }

  function renderPreviews() {
    const p = $('preview');
    p.innerHTML = '';
    state.photos.forEach((file, idx) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;';
      const d = document.createElement('div');
      d.className = 'thumb';
      const isImage = /^image\//.test(file.type) && !/hei[cf]/i.test(file.type);
      if (isImage) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.onload = () => URL.revokeObjectURL(img.src);
        d.appendChild(img);
      } else {
        d.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:24px;">📷</div>';
      }
      const fname = document.createElement('div');
      fname.className = 'fname';
      fname.textContent = file.name;
      d.appendChild(fname);
      // Remove on click (on the X overlay)
      const removeBtn = document.createElement('div');
      removeBtn.style.cssText = 'position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.7);color:#F87171;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (e) => { e.stopPropagation(); state.photos.splice(idx, 1); delete state.captions[idx]; renderPreviews(); });
      d.appendChild(removeBtn);
      wrap.appendChild(d);
      // Caption input
      const caption = document.createElement('textarea');
      caption.className = 'thumb-caption';
      caption.placeholder = 'Describe this photo...';
      caption.rows = 2;
      caption.value = state.captions[idx] || '';
      caption.addEventListener('input', () => { state.captions[idx] = caption.value; });
      wrap.appendChild(caption);
      p.appendChild(wrap);
    });
  }

  // ── LLM Review ─────────────────────────────────────
  async function reviewText(text, fieldType) {
    if (!text || !text.trim()) return { polished: text };
    try {
      const res = await fetch('/api/review-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim(), field_type: fieldType })
      });
      if (!res.ok) return { polished: text };
      return res.json();
    } catch { return { polished: text }; }
  }

  // ── Submit ──────────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault();
    const deptId = $('department_id').value;
    const overall = parseInt($('overall_progress').value, 10);
    const status = $('status_text').value.trim();
    if (!status) { alert('Status summary is required'); return; }

    // Build caption map keyed by filename
    const captionMap = {};
    state.photos.forEach((f, idx) => {
      if (state.captions[idx]) captionMap[f.name] = state.captions[idx];
    });

    const btn = $('submit-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Reviewing & Uploading…';

    // LLM review, fire-and-forget style, don't block if it fails
    let reviewedStatus = status;
    let reviewedHighlights = $('highlights').value.trim();
    let reviewedBlockers = $('blockers').value.trim();
    try {
      const reviews = await Promise.all([
        reviewText(status, 'status summary'),
        reviewedHighlights ? reviewText(reviewedHighlights, 'highlights') : Promise.resolve({ polished: reviewedHighlights }),
        reviewedBlockers ? reviewText(reviewedBlockers, 'blockers') : Promise.resolve({ polished: reviewedBlockers })
      ]);
      reviewedStatus = reviews[0].polished || status;
      reviewedHighlights = reviews[1].polished || reviewedHighlights;
      reviewedBlockers = reviews[2].polished || reviewedBlockers;
    } catch (e) { console.warn('LLM review skipped:', e.message); }

    // Review photo captions
    for (const key of Object.keys(captionMap)) {
      try {
        const r = await reviewText(captionMap[key], 'photo caption');
        if (r.polished) captionMap[key] = r.polished;
      } catch {}
    }

    const fd = new FormData();
    fd.append('department_id', deptId);
    fd.append('overall_progress', overall);
    fd.append('status_text', reviewedStatus);
    fd.append('highlights', reviewedHighlights);
    fd.append('blockers', reviewedBlockers);
    fd.append('schedule_updates', JSON.stringify(collectSchedule()));
    fd.append('photo_captions', JSON.stringify(captionMap));
    state.photos.forEach(f => fd.append('photos', f));

    try {
      const res = await fetch('/api/submit', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'submission failed');

      $('success-dept').textContent = state.currentDept ? state.currentDept.name : '';
      $('sum-pct').textContent = `${overall}%`;
      $('sum-photos').textContent = state.photos.length;
      $('sum-activities').textContent = collectSchedule().length;
      show('screen-success');
      refreshStatus();
    } catch (err) {
      alert('Submission failed: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Submit Report';
    }
  }

  // ── Init ────────────────────────────────────────────
  function init() {
    // Nav buttons
    document.querySelectorAll('[data-nav]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const target = el.getAttribute('data-nav');
        if (target === 'screen-select') {
          document.documentElement.style.setProperty('--accent', '#3B82F6');
        }
        show(target);
      });
    });

    // Slider
    $('overall_progress').addEventListener('input', (e) => {
      $('slider-value').textContent = `${e.target.value}%`;
    });

    // Status char count
    $('status_text').addEventListener('input', (e) => {
      $('status-count').textContent = `${e.target.value.length}/300`;
    });

    // Add row
    $('add-row-btn').addEventListener('click', () => addScheduleRow());

    // Drop zone
    const drop = $('drop-zone');
    const input = $('file-input');
    drop.addEventListener('click', () => input.click());
    input.addEventListener('change', (e) => addPhotoFiles(Array.from(e.target.files)));
    ['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hover'); }));
    ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hover'); }));
    drop.addEventListener('drop', (e) => addPhotoFiles(Array.from(e.dataTransfer.files)));

    // Submit
    $('submit-form').addEventListener('submit', handleSubmit);

    refreshStatus();
    setInterval(refreshStatus, 60000); // poll every 60s
  }

  document.addEventListener('DOMContentLoaded', init);
})();
