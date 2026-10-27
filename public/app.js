'use strict';

const $ = (selector) => document.querySelector(selector);

const TOKEN_KEY = 'paas.token';
const LIVE_LIMIT = 20000; // longer text is sent as "changed, please reload" instead of live

const state = {
  token: null,
  config: null,
  sb: null,            // Supabase client (only used for live sync and uploads)
  channel: null,
  channelKey: null,
  session: null,
  devices: [],
  presence: {},
  lastLocalEdit: 0,
  lastRemoteAt: 0,
  justJoined: false,
  pairTimer: null,
};

/* ---------- Basics ---------- */

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function setToken(token) {
  state.token = token || null;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode: token lives only for this tab */ }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('Can’t reach Paas. Check your internet connection.'), { status: 0 });
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { status: res.status });
  }
  return data;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function deviceName() {
  const ua = navigator.userAgent;
  const isIpad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const os = /iPhone/.test(ua) ? 'iPhone'
    : isIpad ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /CrOS/.test(ua) ? 'Chromebook'
    : /Linux/.test(ua) ? 'Linux'
    : 'device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser';
  return `${browser} on ${os}`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function timeAgo(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

function setBusy(button, busy) {
  if (button) button.disabled = busy;
}

/* ---------- Start-up ---------- */

async function boot() {
  state.token = getToken();

  // Opening /join/123456 (what the QR code points to) links this device straight away.
  const match = location.pathname.match(/^\/join\/(\d{6})\/?$/);
  const joinCode = match ? match[1] : null;
  if (match) history.replaceState(null, '', '/');

  let data;
  try {
    data = await api('/api/session');
  } catch (err) {
    $('#loadingText').textContent = err.message;
    return;
  }
  if (!startSupabase(data.config)) return;

  if (data.linked) {
    enterApp(data);
    if (joinCode && confirm('This device is already in a space. Switch to the space this code belongs to?')) {
      await redeemCode(joinCode);
    }
    return;
  }

  if (state.token) setToken(null);
  showWelcome(data.networkSpace);
  if (joinCode) {
    $('#codeInput').value = `${joinCode.slice(0, 3)} ${joinCode.slice(3)}`;
    await redeemCode(joinCode);
  }
}

function startSupabase(config) {
  state.config = config;
  if (!config?.supabaseUrl || !config?.supabaseAnonKey) {
    $('#loadingText').textContent = 'Paas isn’t set up yet: SUPABASE_URL and SUPABASE_ANON_KEY are missing on the server.';
    return false;
  }
  if (!window.supabase?.createClient) {
    $('#loadingText').textContent = 'A required script didn’t load. Reload the page.';
    return false;
  }
  if (!state.sb) {
    state.sb = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  $('#filesHint').textContent = `Drop files anywhere on the page. Up to ${config.maxFileMb} MB each; they delete themselves after ${config.fileDays} days.`;
  $('#pad').maxLength = config.maxTextChars;
  return true;
}

/* ---------- Welcome screen ---------- */

function showWelcome(networkSpace) {
  $('#loading').hidden = true;
  $('#app').hidden = true;
  $('#welcome').hidden = false;
  $('#networkOffer').hidden = !networkSpace;
  $('#codeError').textContent = '';
}

let redeeming = false;
async function redeemCode(code) {
  if (redeeming) return;
  redeeming = true;
  const button = $('#codeBtn');
  setBusy(button, true);
  $('#codeError').textContent = '';
  try {
    const data = await api('/api/pair', { method: 'POST', body: { action: 'redeem', code, name: deviceName() } });
    leaveChannel();
    setToken(data.token);
    state.justJoined = true;
    enterApp(data);
    toast('Linked. This device is in your space now.');
  } catch (err) {
    if (state.session) {
      toast(err.message); // already in a space: stay there
    } else {
      if ($('#welcome').hidden) showWelcome(false);
      $('#codeError').textContent = err.message;
      $('#codeInput').focus();
    }
  } finally {
    redeeming = false;
    setBusy(button, false);
  }
}

$('#codeInput').addEventListener('input', (event) => {
  const digits = event.target.value.replace(/\D/g, '').slice(0, 6);
  event.target.value = digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
  $('#codeError').textContent = '';
  if (digits.length === 6) redeemCode(digits);
});

$('#codeForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const digits = $('#codeInput').value.replace(/\D/g, '');
  if (digits.length !== 6) {
    $('#codeError').textContent = 'Type all 6 digits shown on your other device.';
    return;
  }
  redeemCode(digits);
});

$('#createBtn').addEventListener('click', async (event) => {
  setBusy(event.currentTarget, true);
  try {
    const data = await api('/api/session', { method: 'POST', body: { action: 'create', name: deviceName() } });
    setToken(data.token);
    enterApp(data);
  } catch (err) {
    $('#codeError').textContent = err.message;
  } finally {
    setBusy(event.currentTarget, false);
  }
});

$('#joinNetworkBtn').addEventListener('click', async (event) => {
  setBusy(event.currentTarget, true);
  try {
    const data = await api('/api/session', { method: 'POST', body: { action: 'join-network', name: deviceName() } });
    setToken(data.token);
    state.justJoined = true;
    enterApp(data);
    toast('Joined the space on this WiFi.');
  } catch (err) {
    $('#networkOffer').hidden = true;
    $('#codeError').textContent = err.message;
  } finally {
    setBusy(event.currentTarget, false);
  }
});

/* ---------- App screen ---------- */

function enterApp(data) {
  applySession(data, true);
  $('#loading').hidden = true;
  $('#welcome').hidden = true;
  $('#app').hidden = false;
  connect();
}

function applySession(data, forceText = false) {
  state.session = data;
  setPadText(data.space.content, forceText);
  $('#netJoin').checked = data.space.allowNetworkJoin;
  renderFiles(data.files);
  renderDevices(data.devices);
}

async function refreshSession() {
  if (!state.token) return;
  try {
    const data = await api('/api/session');
    if (!data.linked) { removedFromSpace(); return; }
    applySession(data);
    connect();
  } catch (err) {
    if (err.status === 401) removedFromSpace();
  }
}

async function removedFromSpace(message = 'This device was removed from the space.') {
  leaveChannel();
  setToken(null);
  state.session = null;
  $('#pad').value = '';
  if ($('#pairDialog').open) $('#pairDialog').close();
  let networkSpace = false;
  try { networkSpace = (await api('/api/session')).networkSpace; } catch { /* show welcome anyway */ }
  showWelcome(networkSpace);
  if (message) toast(message);
}

/* ---------- Live sync ---------- */

function connect() {
  const { space, device } = state.session;
  if (state.channel && state.channelKey === space.channelKey) return;
  leaveChannel();

  state.channelKey = space.channelKey;
  setLive('connecting');

  const channel = state.sb.channel(`paas-${space.channelKey}`, {
    config: { broadcast: { self: false }, presence: { key: device.id } },
  });

  channel
    .on('broadcast', { event: 'text' }, ({ payload }) => onRemoteText(payload))
    .on('broadcast', { event: 'text-saved' }, () => refreshSession())
    .on('broadcast', { event: 'files' }, () => refreshFiles())
    .on('broadcast', { event: 'devices' }, ({ payload }) => onDevicesChanged(payload))
    .on('broadcast', { event: 'rekey' }, () => refreshSession())
    .on('presence', { event: 'sync' }, () => {
      if (state.channel !== channel) return;
      state.presence = channel.presenceState();
      renderDevices();
      updateLiveText();
    })
    .subscribe(async (status) => {
      if (state.channel !== channel) return;
      if (status === 'SUBSCRIBED') {
        setLive('live');
        await channel.track({ name: device.name });
        if (state.justJoined) {
          state.justJoined = false;
          broadcast('devices', { joined: device.name });
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setLive('offline');
      }
    });

  state.channel = channel;
}

function leaveChannel() {
  if (state.channel) state.sb.removeChannel(state.channel);
  state.channel = null;
  state.channelKey = null;
  state.presence = {};
}

function broadcast(event, payload = {}) {
  if (state.channel) state.channel.send({ type: 'broadcast', event, payload });
}

function setLive(status) {
  $('#live').dataset.state = status;
  updateLiveText();
}

function updateLiveText() {
  const status = $('#live').dataset.state;
  const others = Object.keys(state.presence).filter((id) => id !== state.session?.device.id).length;
  $('#liveText').textContent =
    status === 'connecting' ? 'Connecting…'
    : status === 'offline' ? 'Reconnecting… your text still saves'
    : others === 0 ? 'Live. No other devices open right now'
    : `Live with ${others} other ${others === 1 ? 'device' : 'devices'}`;
}

/* ---------- Text ---------- */

const pad = $('#pad');
let liveTimer = null;
let saveTimer = null;

function setPadText(content, force = false) {
  // Don't overwrite what this person is typing right now with an older copy.
  if (!force && Date.now() - state.lastLocalEdit < 2500) return;
  if (pad.value === content) return;
  const focused = document.activeElement === pad;
  const { selectionStart, selectionEnd } = pad;
  pad.value = content;
  if (focused) pad.setSelectionRange(Math.min(selectionStart, content.length), Math.min(selectionEnd, content.length));
}

function setSaveState(text, isError = false) {
  const el = $('#saveState');
  el.textContent = text;
  el.dataset.state = isError ? 'error' : '';
}

pad.addEventListener('input', () => {
  state.lastLocalEdit = Date.now();
  setSaveState('Saving…');
  if (!liveTimer) liveTimer = setTimeout(sendLiveText, 120);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveText, 700);
});

function sendLiveText() {
  liveTimer = null;
  if (!state.session) return;
  const content = pad.value;
  if (content.length <= LIVE_LIMIT) broadcast('text', { content, at: Date.now() });
}

async function saveText() {
  if (!state.session) return;
  const content = pad.value;
  try {
    await api('/api/text', { method: 'POST', body: { content } });
    if (pad.value === content) setSaveState('Saved');
    if (content.length > LIVE_LIMIT) broadcast('text-saved');
  } catch (err) {
    if (err.status === 401) { removedFromSpace(); return; }
    setSaveState('Not saved', true);
    toast(err.message);
  }
}

function onRemoteText(payload) {
  if (!payload || typeof payload.content !== 'string') return;
  if (payload.at && payload.at < state.lastRemoteAt) return;
  state.lastRemoteAt = payload.at || Date.now();
  setPadText(payload.content, true);
  setSaveState('Saved');
}

$('#copyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pad.value);
    toast('Copied');
  } catch {
    pad.select();
    toast('Press Ctrl+C (or Copy) to copy the selected text.');
  }
});

$('#clearBtn').addEventListener('click', () => {
  if (!pad.value) return;
  if (!confirm('Clear the text on all your devices?')) return;
  pad.value = '';
  pad.dispatchEvent(new Event('input'));
});

// Phones pause pages in the background; catch up when the page comes back.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.session) refreshSession();
});
window.addEventListener('online', () => { if (state.session) refreshSession(); });

/* ---------- Files ---------- */

function renderFiles(files) {
  const list = $('#fileList');
  const uploading = [...list.querySelectorAll('.uploading')].map((el) => el.parentElement);
  list.innerHTML = '';
  uploading.forEach((li) => list.appendChild(li));

  if (!files.length && !uploading.length) {
    list.innerHTML = '<li class="empty">No files yet. Upload one here and download it on any of your devices.</li>';
    return;
  }

  for (const file of files) {
    const ext = (file.name.split('.').pop() || '').slice(0, 4).toUpperCase();
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="file">
        <div class="thumb">${file.previewUrl ? `<img src="${escapeHtml(file.previewUrl)}" alt="" loading="lazy">` : escapeHtml(ext || 'FILE')}</div>
        <div>
          <div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
          <div class="file-meta">${formatSize(file.size)}, ${timeAgo(file.createdAt)}</div>
        </div>
        <div class="file-actions">
          <button type="button" class="icon-btn" data-download="${file.id}" aria-label="Download ${escapeHtml(file.name)}">
            <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
          </button>
          <button type="button" class="icon-btn danger" data-delete="${file.id}" aria-label="Delete ${escapeHtml(file.name)}">
            <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/></svg>
          </button>
        </div>
      </div>`;
    const img = li.querySelector('img');
    if (img) img.addEventListener('error', () => { img.replaceWith(ext || 'FILE'); }, { once: true });
    list.appendChild(li);
  }
}

async function refreshFiles() {
  try {
    const { files } = await api('/api/files');
    renderFiles(files);
  } catch (err) {
    if (err.status === 401) removedFromSpace();
  }
}

function addUploadingRow(name) {
  const empty = $('#fileList .empty');
  if (empty) empty.remove();
  const li = document.createElement('li');
  li.innerHTML = `
    <div class="file uploading">
      <div class="thumb">…</div>
      <div>
        <div class="file-name">${escapeHtml(name)}</div>
        <div class="file-meta">Uploading…</div>
      </div>
      <div></div>
    </div>`;
  $('#fileList').prepend(li);
  return li;
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length || !state.session) return;
  const maxBytes = state.config.maxFileMb * 1024 * 1024;
  let uploaded = 0;

  for (const file of files) {
    if (file.size > maxBytes) { toast(`${file.name} is over ${state.config.maxFileMb} MB, so it wasn’t uploaded.`); continue; }
    if (file.size === 0) { toast(`${file.name} is empty, so it wasn’t uploaded.`); continue; }

    const row = addUploadingRow(file.name);
    try {
      const prep = await api('/api/files', {
        method: 'POST',
        body: { action: 'prepare', name: file.name, size: file.size, type: file.type },
      });
      const { error } = await state.sb.storage
        .from(prep.bucket)
        .uploadToSignedUrl(prep.path, prep.token, file, { contentType: file.type || 'application/octet-stream' });
      if (error) throw new Error(`${file.name} didn’t upload: ${error.message}`);
      await api('/api/files', {
        method: 'POST',
        body: { action: 'confirm', path: prep.path, name: file.name, size: file.size, type: file.type },
      });
      uploaded++;
    } catch (err) {
      if (err.status === 401) { removedFromSpace(); return; }
      toast(err.message);
    } finally {
      row.remove();
    }
  }

  await refreshFiles();
  if (uploaded) {
    broadcast('files');
    toast(uploaded === 1 ? 'Uploaded' : `Uploaded ${uploaded} files`);
  }
}

$('#fileInput').addEventListener('change', (event) => {
  uploadFiles(event.target.files);
  event.target.value = '';
});

$('#fileList').addEventListener('click', async (event) => {
  const download = event.target.closest('[data-download]');
  const remove = event.target.closest('[data-delete]');
  try {
    if (download) {
      const { url } = await api(`/api/files?download=${encodeURIComponent(download.dataset.download)}`);
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    if (remove) {
      remove.disabled = true;
      await api(`/api/files?id=${encodeURIComponent(remove.dataset.delete)}`, { method: 'DELETE' });
      broadcast('files');
      await refreshFiles();
    }
  } catch (err) {
    if (remove) remove.disabled = false;
    toast(err.message);
    if (err.status === 404) refreshFiles();
  }
});

// Drag and drop anywhere, and paste files straight into the text box.
let dragDepth = 0;
const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (event) => {
  if (!state.session || !hasFiles(event)) return;
  dragDepth++;
  $('#dropzone').hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#dropzone').hidden = true;
});
window.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
window.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  $('#dropzone').hidden = true;
  if (state.session) uploadFiles(event.dataTransfer.files);
});
pad.addEventListener('paste', (event) => {
  const files = event.clipboardData?.files;
  if (files?.length) {
    event.preventDefault();
    uploadFiles(files);
  }
});

/* ---------- Devices ---------- */

function renderDevices(devices) {
  if (devices) state.devices = devices;
  if (!state.session) return;
  const me = state.session.device.id;
  const list = $('#deviceList');
  list.innerHTML = '';

  for (const device of state.devices) {
    const online = Boolean(state.presence[device.id]) || device.id === me;
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="device">
        <span class="dot ${online ? 'on' : ''}" aria-hidden="true"></span>
        <div class="device-text">
          <div class="device-name">${escapeHtml(device.name)}</div>
          <div class="device-meta">${device.id === me ? 'This device' : online ? 'Online now' : `Last seen ${timeAgo(device.lastSeen)}`}</div>
        </div>
        ${device.id === me
          ? `<button type="button" class="btn small ghost" data-rename="${device.id}">Rename</button>`
          : `<button type="button" class="btn small ghost" data-remove="${device.id}" data-name="${escapeHtml(device.name)}">Remove</button>`}
      </div>`;
    list.appendChild(li);
  }
}

async function refreshDevices() {
  try {
    const { devices } = await api('/api/devices');
    renderDevices(devices);
  } catch (err) {
    if (err.status === 401) removedFromSpace();
  }
}

function onDevicesChanged(payload) {
  refreshDevices();
  if (payload?.joined && $('#pairDialog').open) showJoined(payload.joined);
}

$('#deviceList').addEventListener('click', async (event) => {
  const remove = event.target.closest('[data-remove]');
  const rename = event.target.closest('[data-rename]');

  if (remove) {
    if (!confirm(`Remove ${remove.dataset.name}? It won’t see your text or files anymore.`)) return;
    remove.disabled = true;
    try {
      await api(`/api/devices?id=${encodeURIComponent(remove.dataset.remove)}`, { method: 'DELETE' });
      broadcast('rekey'); // tells every device to fetch the new channel key
      await refreshSession();
      toast('Device removed');
    } catch (err) {
      remove.disabled = false;
      toast(err.message);
    }
  }

  if (rename) {
    const name = prompt('Name this device, for example “Ammi’s phone”', state.session.device.name);
    if (!name || !name.trim()) return;
    try {
      const result = await api('/api/devices', { method: 'PATCH', body: { name } });
      state.session.device.name = result.name;
      if (state.channel) state.channel.track({ name: result.name });
      broadcast('devices');
      await refreshDevices();
    } catch (err) {
      toast(err.message);
    }
  }
});

$('#netJoin').addEventListener('change', async (event) => {
  const allowNetworkJoin = event.target.checked;
  try {
    await api('/api/session', { method: 'POST', body: { action: 'settings', allowNetworkJoin } });
    toast(allowNetworkJoin ? 'Devices on your WiFi can join without a code' : 'New devices now need a code to join');
  } catch (err) {
    event.target.checked = !allowNetworkJoin;
    toast(err.message);
  }
});

$('#leaveBtn').addEventListener('click', async () => {
  if (!confirm('Remove this device from the space? Your text and files stay on your other devices.')) return;
  try {
    await api(`/api/devices?id=${encodeURIComponent(state.session.device.id)}`, { method: 'DELETE' });
    broadcast('rekey');
    await removedFromSpace('This device left the space.');
  } catch (err) {
    toast(err.message);
  }
});

/* ---------- Add device dialog ---------- */

const pairDialog = $('#pairDialog');
const pairBody = $('#pairBody');

$('#addDeviceBtn').addEventListener('click', () => {
  pairDialog.showModal();
  makeCode();
});
$('#pairClose').addEventListener('click', () => pairDialog.close());
pairDialog.addEventListener('click', (event) => { if (event.target === pairDialog) pairDialog.close(); });
pairDialog.addEventListener('close', () => clearInterval(state.pairTimer));

async function makeCode() {
  clearInterval(state.pairTimer);
  pairBody.innerHTML = '<div class="pair-center"><p>Making a code…</p></div>';
  try {
    const { code, expiresAt } = await api('/api/pair', { method: 'POST', body: { action: 'create' } });
    showCode(code, expiresAt);
  } catch (err) {
    pairBody.innerHTML = `
      <div class="pair-center">
        <p>${escapeHtml(err.message)}</p>
        <button type="button" class="btn primary" data-new-code>Try again</button>
      </div>`;
  }
}

function showCode(code, expiresAt) {
  const joinUrl = `${location.origin}/join/${code}`;
  let qrSvg = '';
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(joinUrl);
    qr.make();
    qrSvg = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true, alt: 'QR code to join this space' });
  } catch { /* QR library missing: the typed code still works */ }

  pairBody.innerHTML = `
    ${qrSvg ? `<p class="pair-step">On your other device, scan this with the camera</p><div class="qr-plate">${qrSvg}</div>` : ''}
    <p class="pair-step">${qrSvg ? 'or open' : 'On your other device, open'} <strong>${escapeHtml(location.host)}</strong> and type</p>
    <div class="tiles fresh" role="img" aria-label="Code ${code.split('').join(' ')}">
      ${code.split('').map((digit) => `<span class="tile" aria-hidden="true">${digit}</span>`).join('')}
    </div>
    <p class="timer" id="pairTimer"></p>`;

  const end = new Date(expiresAt).getTime();
  const tick = () => {
    const left = Math.max(0, Math.round((end - Date.now()) / 1000));
    if (left === 0) {
      clearInterval(state.pairTimer);
      pairBody.innerHTML = `
        <div class="pair-center">
          <p>That code expired. Codes last 5 minutes so nobody else can use them later.</p>
          <button type="button" class="btn primary" data-new-code>Make a new code</button>
        </div>`;
      return;
    }
    const timer = $('#pairTimer');
    if (timer) timer.textContent = `Works once, for the next ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  };
  tick();
  state.pairTimer = setInterval(tick, 1000);
}

function showJoined(name) {
  clearInterval(state.pairTimer);
  pairBody.innerHTML = `
    <div class="pair-center">
      <div class="joined-badge"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
      <p><strong>${escapeHtml(name)}</strong> joined your space.</p>
      <button type="button" class="btn" data-new-code>Add another device</button>
    </div>`;
}

pairBody.addEventListener('click', (event) => {
  if (event.target.closest('[data-new-code]')) makeCode();
});

boot();
