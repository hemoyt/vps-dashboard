// ─── VPSphere App ─────────────────────────────────────────────
let token = localStorage.getItem('vpsphere_token') || '';
let currentPanel = 'dashboard';
let currentPath = '/';
let selectedFiles = new Set();
let term, termWS, termFit, editorFilePath;

// ─── API Helpers ─────────────────────────────────────────────
async function api(url, opts = {}) {
  const headers = { ...opts.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
  return res;
}

async function apiJSON(url, opts) {
  const r = await api(url, opts);
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.detail || r.statusText); }
  return r.json();
}

// ─── Toast ───────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const c = document.getElementById('toasts');
  const d = document.createElement('div');
  d.className = `toast ${type}`;
  d.textContent = msg;
  c.appendChild(d);
  setTimeout(() => d.remove(), 3500);
}

// ─── Auth ────────────────────────────────────────────────────
async function login() {
  const pw = document.getElementById('login-password').value;
  const err = document.getElementById('login-error');
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    if (!r.ok) { const e = await r.json(); err.textContent = e.detail; return; }
    const data = await r.json();
    token = data.token;
    localStorage.setItem('vpsphere_token', token);
    showApp();
  } catch (e) { err.textContent = 'Connection failed'; }
}

function logout() {
  api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  token = '';
  localStorage.removeItem('vpsphere_token');
  if (termWS) { termWS.close(); termWS = null; }
  document.getElementById('login-page').style.display = 'flex';
  document.getElementById('app-layout').style.display = 'none';
  document.getElementById('login-password').value = '';
}

function showApp() {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('app-layout').style.display = 'flex';
  switchPanel('dashboard');
}

// ─── Navigation ──────────────────────────────────────────────
function switchPanel(name) {
  currentPanel = name;
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  document.querySelector(`[data-panel="${name}"]`).classList.add('active');

  if (name === 'dashboard') loadStats();
  if (name === 'files') loadFiles(currentPath);
  if (name === 'terminal') initTerminal();
}

// ─── Dashboard Stats ─────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatUptime(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  let parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

async function loadStats() {
  try {
    const s = await apiJSON('/api/stats');
    document.getElementById('dashboard-time').textContent = new Date().toLocaleString();
    const g = document.getElementById('stats-grid');

    const cpuColor = s.cpu.percent > 80 ? 'red' : s.cpu.percent > 50 ? 'yellow' : 'green';
    const memColor = s.memory.percent > 80 ? 'red' : s.memory.percent > 60 ? 'yellow' : 'green';
    const diskColor = s.disk.percent > 80 ? 'red' : s.disk.percent > 60 ? 'yellow' : 'green';

    g.innerHTML = `
      <div class="stat-card">
        <div class="label">CPU Usage</div>
        <div class="value">${s.cpu.percent}%</div>
        <div class="sub">${s.cpu.cores} cores · Load ${s.load.join(' / ')}</div>
        <div class="bar"><div class="fill ${cpuColor}" style="width:${s.cpu.percent}%"></div></div>
      </div>
      <div class="stat-card">
        <div class="label">Memory</div>
        <div class="value">${formatBytes(s.memory.used)}</div>
        <div class="sub">of ${formatBytes(s.memory.total)} (${s.memory.percent}%)</div>
        <div class="bar"><div class="fill ${memColor}" style="width:${s.memory.percent}%"></div></div>
      </div>
      <div class="stat-card">
        <div class="label">Disk</div>
        <div class="value">${formatBytes(s.disk.used)}</div>
        <div class="sub">of ${formatBytes(s.disk.total)} (${s.disk.percent}%)</div>
        <div class="bar"><div class="fill ${diskColor}" style="width:${s.disk.percent}%"></div></div>
      </div>
      <div class="stat-card">
        <div class="label">Network</div>
        <div class="value">${formatBytes(s.network.sent + s.network.recv)}</div>
        <div class="sub">↓ ${formatBytes(s.network.recv)} · ↑ ${formatBytes(s.network.sent)}</div>
      </div>
      <div class="stat-card">
        <div class="label">System</div>
        <div class="value" style="font-size:18px">${s.hostname}</div>
        <div class="sub">${s.os} · Up ${formatUptime(s.uptime)}</div>
      </div>
    `;
  } catch (e) {
    document.getElementById('stats-grid').innerHTML = `<div class="empty">⚠ ${e.message}</div>`;
  }
}

// Auto-refresh dashboard stats every 5s
let statsInterval;
function startStatsRefresh() {
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(() => { if (currentPanel === 'dashboard') loadStats(); }, 5000);
}

// ─── File Manager ────────────────────────────────────────────
function renderBreadcrumb(path) {
  const parts = path.split('/').filter(Boolean);
  let html = '<a onclick="navigateTo(\'/\')">/</a>';
  let acc = '';
  parts.forEach((p, i) => {
    acc += '/' + p;
    html += '<span>/</span>';
    if (i === parts.length - 1) {
      html += `<strong style="color:var(--text)">${p}</strong>`;
    } else {
      html += `<a onclick="navigateTo('${acc}')">${p}</a>`;
    }
  });
  document.getElementById('files-breadcrumb').innerHTML = html || '<strong>/</strong>';
}

function iconFor(item) {
  if (item.type === 'dir') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>';
  const ext = item.name.split('.').pop().toLowerCase();
  const codeExts = ['py','js','ts','jsx','tsx','html','css','json','yaml','yml','toml','md','sh','bash','sql','rb','go','rs','cpp','c','h','java','php','xml','svg','env','cfg','ini','conf'];
  const mediaExts = ['png','jpg','jpeg','gif','webp','svg','mp4','mp3','wav','ogg','pdf'];
  if (codeExts.includes(ext)) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
  if (mediaExts.includes(ext)) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(1) + ' GB';
}

async function loadFiles(path) {
  currentPath = path;
  selectedFiles.clear();
  document.getElementById('btn-delete').disabled = true;
  try {
    const data = await apiJSON(`/api/files?path=${encodeURIComponent(path)}`);
    renderBreadcrumb(path);
    const tbody = document.getElementById('files-list');
    if (data.items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty">📂 Empty directory</div></td></tr>`;
      return;
    }
    // Parent dir
    let rows = '';
    if (path !== '/') {
      const parent = path.split('/').slice(0, -1).join('/') || '/';
      rows += `<tr><td></td><td class="name" onclick="navigateTo('${parent}')" style="color:var(--text3)">📁 ..</td><td></td><td></td><td></td></tr>`;
    }
    data.items.forEach(item => {
      const fullPath = path === '/' ? '/' + item.name : path + '/' + item.name;
      rows += `<tr>
        <td><input type="checkbox" data-path="${fullPath}" data-type="${item.type}" onchange="toggleSelect(this)"></td>
        <td class="name" ondblclick="${item.type === 'dir' ? `navigateTo('${fullPath}')` : `openEditor('${fullPath}')`}" onclick="if(event.target.tagName!=='INPUT')${item.type === 'dir' ? `navigateTo('${fullPath}')` : `openEditor('${fullPath}')`}">${iconFor(item)} ${item.name}</td>
        <td class="size">${item.type === 'dir' ? '—' : formatFileSize(item.size)}</td>
        <td class="modified">${formatDate(item.modified)}</td>
        <td><code style="font-size:12px;color:var(--text3)">${item.permissions}</code></td>
      </tr>`;
    });
    tbody.innerHTML = rows;
  } catch (e) {
    document.getElementById('files-list').innerHTML = `<tr><td colspan="5"><div class="empty">⚠ ${e.message}</div></td></tr>`;
  }
}

function navigateTo(path) {
  loadFiles(path);
}

function toggleSelect(cb) {
  const p = cb.dataset.path;
  if (cb.checked) selectedFiles.add(p);
  else selectedFiles.delete(p);
  document.getElementById('btn-delete').disabled = selectedFiles.size === 0;
}

async function fileNewFolder() {
  const name = prompt('Folder name:');
  if (!name) return;
  try {
    await apiJSON('/api/files/mkdir', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentPath, name })
    });
    toast(`Folder "${name}" created`);
    loadFiles(currentPath);
  } catch (e) { toast(e.message, 'error'); }
}

async function fileDelete() {
  if (selectedFiles.size === 0) return;
  if (!confirm(`Delete ${selectedFiles.size} item(s)? This cannot be undone.`)) return;
  let count = 0;
  for (const p of selectedFiles) {
    try {
      await apiJSON(`/api/files?path=${encodeURIComponent(p)}`, { method: 'DELETE' });
      count++;
    } catch (e) { toast(`Failed to delete ${p}: ${e.message}`, 'error'); }
  }
  if (count) toast(`Deleted ${count} item(s)`);
  loadFiles(currentPath);
}

function fileUpload() {
  document.getElementById('upload-input').click();
}

async function handleUpload(files) {
  if (!files.length) return;
  const form = new FormData();
  form.append('path', currentPath);
  for (const f of files) form.append('files', f);
  try {
    const r = await api('/api/files/upload', { method: 'POST', body: form });
    if (r.ok) {
      const data = await r.json();
      toast(`Uploaded ${data.uploaded.length} file(s)`);
      loadFiles(currentPath);
    } else {
      const e = await r.json();
      toast(e.detail, 'error');
    }
  } catch (e) { toast(e.message, 'error'); }
  document.getElementById('upload-input').value = '';
}

// Drag & drop upload
const dropZone = document.getElementById('upload-drop');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.borderColor = 'var(--accent)'; });
dropZone.addEventListener('dragleave', () => dropZone.style.borderColor = 'var(--border)');
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.style.borderColor = 'var(--border)';
  handleUpload(e.dataTransfer.files);
});

// Right-click rename
document.addEventListener('contextmenu', e => {
  const td = e.target.closest('td.name');
  if (!td || currentPanel !== 'files') return;
  const row = td.closest('tr');
  const cb = row.querySelector('input[type="checkbox"]');
  if (!cb || !cb.dataset.path) return;
  e.preventDefault();
  const path = cb.dataset.path;
  const name = path.split('/').pop();
  const newName = prompt('Rename to:', name);
  if (!newName || newName === name) return;
  apiJSON('/api/files/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, name: newName })
  }).then(() => { toast('Renamed'); loadFiles(currentPath); })
    .catch(e => toast(e.message, 'error'));
});

// Search
let searchTimeout;
function fileSearch() {
  clearTimeout(searchTimeout);
  const q = document.getElementById('file-search').value.trim();
  if (!q) { loadFiles(currentPath); return; }
  searchTimeout = setTimeout(async () => {
    try {
      const data = await apiJSON(`/api/files/search?path=/&q=${encodeURIComponent(q)}`);
      const tbody = document.getElementById('files-list');
      if (data.results.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5"><div class="empty">No results for "${q}"</div></td></tr>`;
        return;
      }
      tbody.innerHTML = data.results.map(item => `
        <tr>
          <td></td>
          <td class="name" ondblclick="${item.type === 'dir' ? `navigateTo('/${item.path}')` : `openEditor('/${item.path}')`}" onclick="if(event.target.tagName!=='INPUT')${item.type === 'dir' ? `navigateTo('/${item.path}')` : `openEditor('/${item.path}')`}">${iconFor(item)} ${item.path}</td>
          <td class="size">${item.type === 'dir' ? '—' : formatFileSize(item.size)}</td>
          <td class="modified">${formatDate(item.modified)}</td>
          <td></td>
        </tr>
      `).join('');
    } catch (e) {}
  }, 300);
}

// Download file
async function downloadFile(path) {
  try {
    const r = await api(`/api/files/download?path=${encodeURIComponent(path)}`);
    if (!r.ok) throw new Error('Download failed');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop();
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) { toast(e.message, 'error'); }
}

// ─── File Editor ─────────────────────────────────────────────
async function openEditor(path) {
  // Check if it's a text file by extension
  const ext = path.split('.').pop().toLowerCase();
  const textExts = ['txt','py','js','ts','jsx','tsx','html','css','json','yaml','yml','toml','md','sh','bash','sql','rb','go','rs','cpp','c','h','java','php','xml','svg','env','cfg','ini','conf','log','gitignore','dockerignore','editorconfig'];
  if (!textExts.includes(ext) && ext !== '') {
    // Offer download instead
    if (confirm(`"${path.split('/').pop()}" may not be a text file. Download instead?`)) {
      downloadFile(path);
    }
    return;
  }
  try {
    const data = await apiJSON(`/api/files/read?path=${encodeURIComponent(path)}`);
    editorFilePath = path;
    document.getElementById('editor-title').textContent = path;
    document.getElementById('editor-textarea').value = data.content;
    document.getElementById('file-editor-overlay').classList.add('show');
    document.getElementById('editor-textarea').focus();
  } catch (e) { toast(e.message, 'error'); }
}

function closeEditor() {
  document.getElementById('file-editor-overlay').classList.remove('show');
  editorFilePath = null;
}

async function saveEditor() {
  if (!editorFilePath) return;
  try {
    await apiJSON('/api/files/write', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: editorFilePath, content: document.getElementById('editor-textarea').value })
    });
    toast(`Saved ${editorFilePath}`);
    closeEditor();
    if (currentPanel === 'files') loadFiles(currentPath);
  } catch (e) { toast(e.message, 'error'); }
}

// ESC to close editor
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeEditor();
  if (e.ctrlKey && e.key === 's') { e.preventDefault(); if (editorFilePath) saveEditor(); }
});

// ─── Terminal ────────────────────────────────────────────────
function initTerminal() {
  if (term) return; // Already initialized

  term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    theme: {
      background: '#0a0a0b',
      foreground: '#e4e4e7',
      cursor: '#6366f1',
      selectionBackground: '#6366f133',
      black: '#18181b',
      red: '#ef4444',
      green: '#22c55e',
      yellow: '#eab308',
      blue: '#6366f1',
      magenta: '#a855f7',
      cyan: '#06b6d4',
      white: '#e4e4e7',
      brightBlack: '#71717a',
      brightRed: '#f87171',
      brightGreen: '#4ade80',
      brightYellow: '#facc15',
      brightBlue: '#818cf8',
      brightMagenta: '#c084fc',
      brightCyan: '#22d3ee',
      brightWhite: '#ffffff',
    }
  });

  const fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);

  const container = document.getElementById('terminal-container');
  term.open(container);
  fitAddon.fit();
  termFit = fitAddon;

  // Connect WebSocket
  connectTerminal();

  // Resize handler
  window.addEventListener('resize', () => {
    if (termFit) termFit.fit();
  });
}

function connectTerminal() {
  if (termWS) termWS.close();

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/api/terminal`;
  termWS = new WebSocket(wsUrl);

  termWS.onopen = () => {
    // Authenticate
    termWS.send(JSON.stringify({ type: 'auth', token }));
  };

  termWS.onmessage = (event) => {
    if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
      // Binary — write directly
      const reader = new FileReader();
      reader.onload = () => term.write(new Uint8Array(reader.result));
      reader.readAsArrayBuffer(event.data);
    } else {
      // Text — could be error
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'error') {
          term.writeln(`\r\n\x1b[31mError: ${msg.msg}\x1b[0m`);
        }
      } catch {
        term.write(event.data);
      }
    }
  };

  termWS.onclose = () => {
    term.writeln('\r\n\x1b[33m[Terminal disconnected. Type to reconnect...]\x1b[0m');
  };

  termWS.onerror = () => {};

  term.onData(data => {
    if (termWS && termWS.readyState === WebSocket.OPEN) {
      termWS.send(JSON.stringify({ type: 'input', data }));
    } else {
      connectTerminal();
      setTimeout(() => {
        if (termWS && termWS.readyState === WebSocket.OPEN) {
          termWS.send(JSON.stringify({ type: 'input', data }));
        }
      }, 500);
    }
  });

  term.onResize(({ cols, rows }) => {
    if (termWS && termWS.readyState === WebSocket.OPEN) {
      termWS.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });
}

// Cleanup terminal on nav away
const origSwitchPanel = switchPanel;
switchPanel = function(name) {
  if (currentPanel === 'terminal' && name !== 'terminal' && termWS) {
    termWS.close();
    termWS = null;
    if (term) { term.dispose(); term = null; }
  }
  origSwitchPanel(name);
};

// ─── Init ────────────────────────────────────────────────────
if (token) {
  // Verify token is still valid
  api('/api/auth/check').then(r => {
    if (r.ok) showApp();
    else logout();
  }).catch(() => logout());
}

startStatsRefresh();
