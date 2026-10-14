const $ = id => document.getElementById(id);

const api = async (url, options = {}) => {
  const r = await fetch(url, options);
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(errText.trim() || r.statusText);
  }
  return r.status === 204 ? null : r.json();
};

const COLORS = {
  title: '#d97706',
  section: '#b45309',
  text: '#2563eb',
  list: '#0891b2',
  caption: '#c026d3',
  header: '#78716c',
  footer: '#78716c',
  table: '#dc2626',
  figure: '#db2777',
  formula: '#0d9488',
  code: '#16a34a',
};
const colorOf = label => COLORS[label?.toLowerCase()] || '#3b82f6';

const state = {
  runs: [],
  jobs: [],
  run: null,
  page: 0,
  zoom: 1,
  raw: false,
  hidden: new Set(),
  file: null,
  follow: null,
};

async function refreshSidebar() {
  try {
    const [runs, jobs] = await Promise.all([api('/api/runs'), api('/api/jobs')]);
    state.runs = runs || [];
    state.jobs = jobs || [];
    renderSidebar();
    if (state.jobs.some(j => j.status === 'running')) watchJobs();
  } catch (err) {
    console.error(err);
  }
}

function renderSidebar() {
  const jobs = state.jobs.filter(j => j.status !== 'done');
  const runs = state.runs.filter(r => !jobs.some(j => j.name === r.name));
  const runsCount = $('runs-count');
  if (runsCount) runsCount.textContent = runs.length ? String(runs.length) : '';
  const nav = $('runs');
  if (!nav) return;
  nav.replaceChildren(...jobs.map(jobRow), ...runs.map(runRow));
  if (!nav.children.length) nav.innerHTML = '<div class="hint">No runs yet.</div>';
}

function runRow(run) {
  const row = document.createElement('a');
  row.className = 'run' + (state.run && state.run.name === run.name ? ' current' : '');
  row.href = '#' + encodeURIComponent(run.name);
  row.innerHTML = `
    <span class="run-name"></span>
    <span class="run-meta"><i></i><span></span></span>
    <button type="button" class="delete" title="Delete run" aria-label="Delete">×</button>
  `;
  row.querySelector('.run-name').textContent = run.name;
  row.querySelector('i').style.setProperty('--c', run.mode === 'markdown' ? COLORS.title : COLORS.text);
  row.querySelector('.run-meta span').textContent = `${run.mode} · ${run.page_count} pg · ${when(run.modified)}`;
  row.querySelector('.delete').onclick = e => {
    e.preventDefault();
    deleteRun(e.target, run.name);
  };
  return row;
}

function jobRow(job) {
  const row = document.createElement('div');
  row.className = `run job ${job.status}`;
  row.innerHTML = `
    <span class="run-name"></span>
    <span class="run-meta"><span></span></span>
    <progress max="100"></progress>
    <button type="button" class="delete" aria-label="Dismiss">×</button>
  `;
  row.querySelector('.run-name').textContent = job.name;
  row.querySelector('.run-meta span').textContent = job.status === 'error' ? job.error : 'Processing inference…';
  row.querySelector('progress').value = job.total ? Math.round((100 * job.done) / job.total) : 40;
  if (job.status === 'error') {
    row.querySelector('progress').remove();
    row.querySelector('.delete').onclick = () => api('/api/jobs/' + job.id, { method: 'DELETE' }).then(refreshSidebar).catch(toast);
  } else {
    row.querySelector('.delete').remove();
  }
  return row;
}

function deleteRun(button, name) {
  if (!button.classList.contains('armed')) {
    button.classList.add('armed');
    button.textContent = 'Delete?';
    setTimeout(() => {
      button.classList.remove('armed');
      button.textContent = '×';
    }, 3000);
    return;
  }
  api('/api/runs/' + encodeURIComponent(name), { method: 'DELETE' })
    .then(() => {
      if (state.run && state.run.name === name) closeRun();
      return refreshSidebar();
    })
    .catch(toast);
}

function when(seconds) {
  if (!seconds) return 'just now';
  const age = Date.now() / 1000 - seconds;
  if (age < 60) return 'just now';
  if (age < 3600) return `${Math.floor(age / 60)}m ago`;
  if (age < 86400) return `${Math.floor(age / 3600)}h ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

let poller = null;
function watchJobs() {
  if (poller) return;
  poller = setInterval(async () => {
    const wasRunning = new Set(state.jobs.filter(j => j.status === 'running').map(j => j.id));
    try {
      state.jobs = await api('/api/jobs');
    } catch (e) {
      return;
    }
    const finished = state.jobs.filter(j => wasRunning.has(j.id) && j.status === 'done');
    if (finished.length) state.runs = await api('/api/runs');
    renderSidebar();
    const followed = finished.find(j => j.id === state.follow);
    if (followed) {
      state.follow = null;
      openRun(followed.name).catch(toast);
    }
    if (!state.jobs.some(j => j.status === 'running')) {
      clearInterval(poller);
      poller = null;
    }
  }, 1000);
}

async function openRun(name) {
  try {
    const run = await api('/api/runs/' + encodeURIComponent(name));
    Object.assign(state, { run, page: 0, zoom: 1, raw: false });
    state.hidden.clear();
    if (decodeURIComponent(location.hash.slice(1)) !== name) {
      history.replaceState(null, '', '#' + encodeURIComponent(name));
    }
    document.body.classList.remove('menu-open');
    renderSidebar();
    renderViewer();
  } catch (err) {
    toast(err);
  }
}

function closeRun() {
  state.run = null;
  history.replaceState(null, '', location.pathname);
  renderSidebar();
  renderViewer();
}

function renderViewer() {
  const run = state.run;
  document.title = run ? `${run.name} · Unlimited-OCR` : 'Unlimited-OCR NVFP4';
  const toolbar = document.querySelector('.toolbar');
  if (toolbar) toolbar.classList.toggle('idle', !run);

  if ($('title')) $('title').textContent = run ? run.title : '';
  if ($('mode')) $('mode').textContent = run ? run.mode : '';
  if ($('viewer')) $('viewer').hidden = !run;
  if ($('empty')) $('empty').hidden = !!run;
  if (!run || !run.pages || !run.pages.length) return;

  const pages = run.pages;
  const p = pages[state.page];
  if (!p) return;

  if ($('raw')) $('raw').setAttribute('aria-pressed', String(state.raw));
  if ($('pageno')) $('pageno').value = p.page;
  if ($('count')) $('count').textContent = `/ ${pages.length}`;
  if ($('prev')) $('prev').disabled = state.page === 0;
  if ($('next')) $('next').disabled = state.page === pages.length - 1;

  const img = $('img');
  img.src = p.image;
  img.onload = () => fitPage();

  const layer = $('boxes-layer');
  const panel = $('panel');
  if (layer) layer.replaceChildren();
  if ($('filters')) $('filters').replaceChildren();
  if (panel) panel.replaceChildren();
  spy.disconnect();

  if (state.raw && panel) {
    const pre = document.createElement('pre');
    pre.className = 'raw';
    pre.textContent = p.raw || '';
    panel.appendChild(pre);
    return;
  }

  // Draw Grounding Detection Boxes on the image
  if (p.blocks && p.blocks.length > 0 && layer && panel) {
    renderFilters(p.blocks);
    let shown = 0;

    p.blocks.forEach((block, i) => {
      if (state.hidden.has(block.label)) return;
      shown++;

      // DeepSeek/Unlimited-OCR bounding box is [y1, x1, y2, x2] or [x1, y1, x2, y2] normalized to 1000
      let [c1, c2, c3, c4] = block.bbox;
      let left, top, width, height;

      // Check standard [x1, y1, x2, y2] coordinate assignment
      if (c3 > c1 && c4 > c2) {
        left = c1 / 10;
        top = c2 / 10;
        width = (c3 - c1) / 10;
        height = (c4 - c2) / 10;
      } else {
        // Fallback for [y1, x1, y2, x2]
        left = c2 / 10;
        top = c1 / 10;
        width = (c4 - c2) / 10;
        height = (c3 - c1) / 10;
      }

      const c = colorOf(block.label);
      const box = document.createElement('div');
      box.className = 'box';
      box.dataset.i = i;
      box.dataset.label = block.label;
      box.style.setProperty('--c', c);
      box.style.left = `${Math.max(0, left)}%`;
      box.style.top = `${Math.max(0, top)}%`;
      box.style.width = `${Math.min(100, width)}%`;
      box.style.height = `${Math.min(100, height)}%`;
      layer.appendChild(box);

      const card = document.createElement('div');
      card.className = 'blk';
      card.dataset.i = i;
      card.style.setProperty('--c', c);
      card.innerHTML = `<div class="meta"><span class="lab">${block.label}</span><span class="bbox">[${block.bbox.join(', ')}]</span></div>`;
      card.appendChild(renderMarkdown(block.text || ''));
      panel.appendChild(card);
      spy.observe(card);
    });

    if (!shown) panel.innerHTML = '<div class="empty">All block types hidden by filters</div>';
  } else if (panel) {
    const doc = document.createElement('div');
    doc.className = 'doc';
    doc.appendChild(renderMarkdown(p.parsed || p.raw || 'No output text'));
    panel.appendChild(doc);
  }
}

function fitPage() {
  if (!state.run) return;
  const pane = $('left');
  const img = $('img');
  const page = $('page');
  if (!pane || !img || !page) return;

  const natW = img.naturalWidth || 800;
  const natH = img.naturalHeight || 1100;
  const pad = 60;
  const scale = Math.min((pane.clientWidth - pad) / natW, (pane.clientHeight - pad) / natH);

  page.style.width = Math.max(120, Math.floor(natW * scale * state.zoom)) + 'px';
  if ($('zoom-fit')) $('zoom-fit').textContent = state.zoom === 1 ? 'Fit' : state.zoom.toFixed(1) + '×';
}

function setZoom(zoom) {
  state.zoom = Math.min(4, Math.max(1, zoom));
  fitPage();
}

function goTo(index) {
  const pages = state.run ? state.run.pages : [];
  if (index < 0 || index >= pages.length || index === state.page) return;
  state.page = index;
  renderViewer();
}

function renderFilters(blocks) {
  const counts = {};
  blocks.forEach(block => {
    counts[block.label] = (counts[block.label] || 0) + 1;
  });
  const filters = $('filters');
  if (!filters) return;
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([label, n]) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.setProperty('--c', colorOf(label));
    chip.setAttribute('aria-pressed', String(!state.hidden.has(label)));
    chip.innerHTML = `<i></i>${label} <b>${n}</b>`;
    chip.onclick = () => {
      state.hidden.has(label) ? state.hidden.delete(label) : state.hidden.add(label);
      renderViewer();
    };
    filters.appendChild(chip);
  });
}

function renderMarkdown(text) {
  const el = document.createElement('div');
  el.className = 'md';
  try {
    el.innerHTML = typeof marked !== 'undefined' ? marked.parse(text) : text;
  } catch (e) {
    el.textContent = text;
  }
  return el;
}

const spy = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    const box = document.querySelector(`.box[data-i="${entry.target.dataset.i}"]`);
    if (box) box.classList.toggle('inview', entry.isIntersecting);
  });
}, { root: document.getElementById('right'), threshold: 0.3 });

const linked = i => document.querySelectorAll(`[data-i="${i}"]`);
document.addEventListener('mouseover', e => {
  const t = e.target.closest('[data-i]');
  if (t) linked(t.dataset.i).forEach(el => el.classList.add('on'));
});
document.addEventListener('mouseout', e => {
  const t = e.target.closest('[data-i]');
  if (t) linked(t.dataset.i).forEach(el => el.classList.remove('on'));
});
document.addEventListener('click', e => {
  const t = e.target.closest('[data-i]');
  if (t) linked(t.dataset.i).forEach(el => {
    if (el !== t) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
});

if ($('prev')) $('prev').onclick = () => goTo(state.page - 1);
if ($('next')) $('next').onclick = () => goTo(state.page + 1);
if ($('pageno')) $('pageno').onchange = () => {
  goTo(Number($('pageno').value) - 1);
};
if ($('zoom-in')) $('zoom-in').onclick = () => setZoom(state.zoom * 1.25);
if ($('zoom-out')) $('zoom-out').onclick = () => setZoom(state.zoom / 1.25);
if ($('zoom-fit')) $('zoom-fit').onclick = () => setZoom(1);
if ($('raw')) $('raw').onclick = () => {
  state.raw = !state.raw;
  renderViewer();
};
window.addEventListener('resize', fitPage);

function openNewRun(file = null) {
  pickFile(file);
  const dlg = $('new-run-dialog');
  if (dlg) dlg.showModal();
}

function pickFile(file) {
  state.file = file;
  const label = $('file-label');
  const text = $('file-text');
  if (label) label.classList.toggle('has', !!file);
  if (text) text.textContent = file ? `${file.name} · ${(file.size / 1e6).toFixed(1)} MB` : 'Choose a PDF or image…';
  if ($('name')) $('name').value = file ? file.name.replace(/\.[^.]+$/, '') : '';
}

if ($('new-run')) $('new-run').onclick = () => openNewRun();
if ($('cancel')) $('cancel').onclick = () => { const dlg = $('new-run-dialog'); if (dlg) dlg.close(); };
if ($('file')) $('file').onchange = () => pickFile($('file').files[0]);

const newRunForm = $('new-run-form');
if (newRunForm) {
  newRunForm.onsubmit = async e => {
    e.preventDefault();
    if (!state.file) return;

    const formData = new FormData();
    formData.append('file', state.file);
    const runName = $('name') ? $('name').value.trim() : '';
    formData.append('name', runName || state.file.name.replace(/\.[^.]+$/, ''));
    formData.append('mode', $('prompt-mode').value);

    const submitBtn = $('submit');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const job = await api('/api/runs', { method: 'POST', body: formData });
      state.follow = job.id;
      $('new-run-dialog').close();
      await refreshSidebar();
    } catch (err) {
      alert(err.message);
    }
    if (submitBtn) submitBtn.disabled = false;
  };
}

const probeEndpoint = () => api('/api/settings').then(s => {
  $('endpoint-url').textContent = `${s.serving || 'vLLM'} @ ${s.base_url}`;
  $('endpoint-dot').className = 'dot ' + (s.reachable ? 'ok' : 'down');
  return s;
});

function toast(err) {
  const toastEl = $('toast');
  if (!toastEl) return;
  toastEl.textContent = err.message || String(err);
  toastEl.hidden = false;
  setTimeout(() => { toastEl.hidden = true; }, 4000);
}

window.addEventListener('hashchange', () => {
  const name = decodeURIComponent(location.hash.slice(1));
  if (name && (!state.run || state.run.name !== name)) openRun(name).catch(toast);
});

async function boot() {
  probeEndpoint().catch(() => { });
  await refreshSidebar();
  const wanted = decodeURIComponent(location.hash.slice(1));
  if (wanted && state.runs.some(r => r.name === wanted)) await openRun(wanted);
  else if (state.runs.length) await openRun(state.runs[0].name);
}

boot().catch(toast);