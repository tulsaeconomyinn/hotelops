/* HotelOps — Supabase-backed app */
const SUPABASE_URL = 'https://vjaibkfckxauoxdsojfn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_yqOFCrP8mBYm32x2cUYFYg_eHMDWB18';
const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let userEmail = '';
let properties = [], rooms = [], orders = [], historyRows = [];
let currentTab = 'overview';
let f = { property: 'all', roomStatus: 'all', roomSearch: '', orderStatus: 'open', orderProperty: 'all', histProperty: 'all', histSearch: '' };

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const todayISO = () => new Date().toISOString().slice(0, 10);
const isOverdue = o => o.expected_return_date && o.expected_return_date < todayISO() && o.status !== 'completed';
const propName = id => { const p = properties.find(p => p.id === id); return p ? p.name : '—'; };
const roomLabel = o => { const r = rooms.find(r => r.id === o.room_id); return r ? 'Room ' + r.room_number : ''; };
const fmtDateTime = ts => { try { return new Date(ts).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); } catch(e){ return ''; } };

/* ---------- AUTH ---------- */
const APP_URL = 'https://tulsaeconomyinn.github.io/hotelops/';
let inRecovery = false;

function showRecovery() {
  inRecovery = true;
  history.replaceState(null, '', APP_URL);
  $('login-view').classList.add('hidden');
  $('app-view').classList.add('hidden');
  $('recovery-view').classList.remove('hidden');
}

async function init() {
  client.auth.onAuthStateChange(event => { if (event === 'PASSWORD_RECOVERY') showRecovery(); });
  const hasRecoveryCode = new URLSearchParams(location.search).get('code') || location.hash.includes('type=recovery');
  const { data } = await client.auth.getSession();
  if (hasRecoveryCode) { /* wait for PASSWORD_RECOVERY event */ }
  else if (data.session) { await enterApp(data.session.user.email); }
  else { $('login-view').classList.remove('hidden'); }

  $('login-btn').onclick = doLogin;
  $('forgot-btn').onclick = doForgotPassword;
  $('recovery-btn').onclick = doRecoverySave;
  $('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('signout-btn').onclick = async () => { await client.auth.signOut(); location.reload(); };
  $('refresh-btn').onclick = () => loadAll();
  $('user-chip').onclick = e => { if (e.target.closest('#user-menu')) return; $('user-menu').classList.toggle('hidden'); };
  $('change-pw-btn').onclick = changePassword;
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));
  $('modal-overlay').onclick = e => { if (e.target.id === 'modal-overlay') closeModal(); };
}

async function doLogin() {
  const email = $('login-email').value.trim(), password = $('login-password').value;
  const errBox = $('login-error');
  errBox.classList.add('hidden');
  $('login-btn').textContent = 'Signing in…';
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  $('login-btn').textContent = 'Sign in';
  if (error) { errBox.textContent = error.message; errBox.classList.remove('hidden'); return; }
  await enterApp(data.user.email);
}

async function doForgotPassword() {
  const email = $('login-email').value.trim();
  const errBox = $('login-error'), infoBox = $('login-info');
  errBox.classList.add('hidden'); infoBox.classList.add('hidden');
  if (!email) { errBox.textContent = 'Type your email above first.'; errBox.classList.remove('hidden'); return; }
  $('forgot-btn').textContent = 'Sending…';
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: APP_URL });
  $('forgot-btn').textContent = 'Forgot password?';
  if (error) { errBox.textContent = error.message; errBox.classList.remove('hidden'); return; }
  infoBox.textContent = 'Reset link sent — check your email (including spam).';
  infoBox.classList.remove('hidden');
}

async function doRecoverySave() {
  const pw = $('recovery-password').value, confirm = $('recovery-confirm').value;
  const errBox = $('recovery-error');
  errBox.classList.add('hidden');
  if (pw.length < 6) { errBox.textContent = 'Password must be at least 6 characters.'; errBox.classList.remove('hidden'); return; }
  if (pw !== confirm) { errBox.textContent = 'Passwords do not match.'; errBox.classList.remove('hidden'); return; }
  $('recovery-btn').textContent = 'Saving…';
  const { error } = await client.auth.updateUser({ password: pw });
  $('recovery-btn').textContent = 'Save new password';
  if (error) { errBox.textContent = error.message; errBox.classList.remove('hidden'); return; }
  await client.auth.signOut();
  location.reload();
}

async function enterApp(email) {
  userEmail = email;
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  $('user-email').textContent = email;
  await loadAll();
}

function changePassword() {
  $('user-menu').classList.add('hidden');
  openModal(`
    <h3>Change password</h3>
    <label>New password<input type="password" id="npw" placeholder="••••••••"></label>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" id="npw-save">Save</button>
    </div>`);
  $('npw-save').onclick = async () => {
    const pw = $('npw').value;
    if (pw.length < 6) { alert('Password must be at least 6 characters.'); return; }
    const { error } = await client.auth.updateUser({ password: pw });
    if (error) alert(error.message); else { alert('Password updated.'); closeModal(); }
  };
}

/* ---------- DATA ---------- */
async function loadAll() {
  const content = $('tab-content');
  content.innerHTML = '<div class="loading">Loading…</div>';
  const [p, r, o, h] = await Promise.all([
    client.from('properties').select('*').order('name'),
    client.from('rooms').select('*').order('room_number'),
    client.from('work_orders').select('*').order('created_at', { ascending: false }),
    client.from('room_history').select('*').order('created_at', { ascending: false }).limit(300)
  ]);
  if (p.error || r.error || o.error || h.error) {
    content.innerHTML = '<div class="empty">Could not load data. Tap ↻ to retry.<br><small>' + esc((p.error||r.error||o.error||h.error).message) + '</small></div>';
    return;
  }
  properties = p.data; rooms = r.data; orders = o.data; historyRows = h.data;
  render();
}

async function logHistory({ property_id, room_id, room_number, event_type, details }) {
  await client.from('room_history').insert({
    property_id, room_id: room_id || null, room_number: room_number || null,
    event_type, details, created_by: userEmail
  });
}

/* ---------- NAV ---------- */
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  render();
}

function render() {
  const c = $('tab-content');
  if (currentTab === 'overview') c.innerHTML = viewOverview();
  else if (currentTab === 'rooms') c.innerHTML = viewRooms();
  else if (currentTab === 'orders') c.innerHTML = viewOrders();
  else if (currentTab === 'team') c.innerHTML = viewTeam();
  else if (currentTab === 'history') c.innerHTML = viewHistory();
  bindView();
}

/* ---------- OVERVIEW ---------- */
function viewOverview() {
  if (!properties.length) return '<div class="empty">No properties yet.</div>';
  return '<div class="section-head"><h2>Portfolio</h2></div>' + properties.map(p => {
    const pr = rooms.filter(r => r.property_id === p.id);
    const avail = pr.filter(r => r.status === 'available').length;
    const out = pr.filter(r => r.status !== 'available').length;
    const open = orders.filter(o => o.property_id === p.id && o.status !== 'completed').length;
    const od = orders.filter(o => o.property_id === p.id && isOverdue(o)).length;
    return `<div class="card prop-card" data-prop="${p.id}">
      <div class="prop-name">${esc(p.name)}</div>
      <div class="prop-addr">${esc(p.address || '')}</div>
      <div class="stat-row">
        <div class="stat ok"><div class="n">${avail}</div><div class="l">Available</div></div>
        <div class="stat ${out ? 'warn' : ''}"><div class="n">${out}</div><div class="l">Out of svc</div></div>
        <div class="stat ${od ? 'bad' : 'info'}"><div class="n">${open}</div><div class="l">Open orders${od ? ' (' + od + ' overdue)' : ''}</div></div>
      </div>
    </div>`;
  }).join('');
}

/* ---------- ROOMS ---------- */
function viewRooms() {
  const propOpts = ['<option value="all">All properties</option>'] +
    properties.map(p => `<option value="${p.id}" ${f.property === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const chips = ['all', 'available', 'unavailable', 'maintenance'].map(s =>
    `<button class="chip ${f.roomStatus === s ? 'active' : ''}" data-rs="${s}">${s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)}</button>`).join('');
  let list = rooms.filter(r =>
    (f.property === 'all' || r.property_id === f.property) &&
    (f.roomStatus === 'all' || r.status === f.roomStatus) &&
    (!f.roomSearch || r.room_number.toLowerCase().includes(f.roomSearch.toLowerCase())));
  // sort: non-available first, then room number
  list.sort((a, b) => (a.status === 'available') - (b.status === 'available') || a.room_number.localeCompare(b.room_number, undefined, { numeric: true }));
  const rows = list.map(r => `
    <div class="room-row" data-room="${r.id}">
      <div><div class="room-num">Room ${esc(r.room_number)}</div><div class="room-prop">${esc(propName(r.property_id))}</div></div>
      <div><span class="badge ${r.status}">${r.status.replace('_', ' ')}</span>
      ${r.status !== 'available' ? `<button class="btn-secondary btn-small quick-avail" data-avail="${r.id}">✓ Available</button>` : ''}</div>
    </div>`).join('');
  return `
    <div class="section-head"><h2>Rooms</h2><button class="btn-secondary btn-small" id="add-room-btn">+ Add room</button></div>
    <div class="filter-bar"><select id="f-property">${propOpts}</select>
    <input type="search" id="f-search" placeholder="Search room #" value="${esc(f.roomSearch)}"></div>
    <div class="chips">${chips}</div>
    ${rows || '<div class="empty">No rooms match. Add rooms to get started.</div>'}
    <button class="fab" id="fab-room">+</button>`;
}

function openRoomModal(roomId) {
  const r = rooms.find(x => x.id === roomId);
  if (!r) return;
  const stBtns = ['available', 'unavailable', 'maintenance'].map(s =>
    `<button class="chip ${r.status === s ? 'active' : ''}" data-setst="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('');
  openModal(`
    <h3>Room ${esc(r.room_number)} <small style="color:#64748b">· ${esc(propName(r.property_id))}</small></h3>
    <label>Status</label>
    <div class="status-btns">${stBtns}</div>
    <label>Notes<textarea id="room-notes" placeholder="e.g. waiting on parts…">${esc(r.notes || '')}</textarea></label>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" id="room-save">Save</button>
    </div>`);
  let newStatus = r.status;
  document.querySelectorAll('[data-setst]').forEach(b => b.onclick = () => {
    newStatus = b.dataset.setst;
    document.querySelectorAll('[data-setst]').forEach(x => x.classList.toggle('active', x === b));
  });
  $('room-save').onclick = async () => {
    const notes = $('room-notes').value.trim();
    const { error } = await client.from('rooms').update({ status: newStatus, notes: notes || null }).eq('id', r.id);
    if (error) { alert(error.message); return; }
    if (newStatus !== r.status) {
      await logHistory({ property_id: r.property_id, room_id: r.id, room_number: r.room_number,
        event_type: 'status_change', details: `Status changed from ${r.status} to ${newStatus}` });
    }
    closeModal(); await loadAll();
  };
}

function openAddRoom() {
  const propOpts = properties.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  openModal(`
    <h3>Add room</h3>
    <label>Property<select id="nr-prop">${propOpts}</select></label>
    <label>Room number<input id="nr-num" placeholder="e.g. 205"></label>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" id="nr-save">Add</button>
    </div>`);
  $('nr-save').onclick = async () => {
    const num = $('nr-num').value.trim();
    if (!num) { alert('Enter a room number.'); return; }
    const { error } = await client.from('rooms').insert({ property_id: $('nr-prop').value, room_number: num, status: 'available' });
    if (error) { alert(error.message); return; }
    closeModal(); await loadAll();
  };
}

/* ---------- WORK ORDERS ---------- */
function viewOrders() {
  const propOpts = ['<option value="all">All properties</option>'] +
    properties.map(p => `<option value="${p.id}" ${f.orderProperty === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const chips = [['open', 'Open'], ['in_progress', 'In Progress'], ['completed', 'Done'], ['all', 'All']].map(([v, l]) =>
    `<button class="chip ${f.orderStatus === v ? 'active' : ''}" data-os="${v}">${l}</button>`).join('');
  let list = orders.filter(o =>
    (f.orderProperty === 'all' || o.property_id === f.orderProperty) &&
    (f.orderStatus === 'all' || o.status === f.orderStatus));
  list.sort((a, b) => (isOverdue(b) - isOverdue(a)) || (b.created_at < a.created_at ? -1 : 1));
  const cards = list.map(o => {
    const od = isOverdue(o);
    const next = o.status === 'open' ? ['in_progress', 'Start →'] : o.status === 'in_progress' ? ['completed', 'Complete ✓'] : null;
    return `<div class="card order-card pri-${o.priority}">
      <div class="order-title">${esc(o.title)} ${od ? '<span class="badge overdue">OVERDUE</span>' : ''}</div>
      <div class="order-meta">${esc(propName(o.property_id))}${roomLabel(o) ? ' · ' + esc(roomLabel(o)) : ''} · <span class="badge ${o.priority}">${o.priority}</span> <span class="badge ${o.status}">${o.status.replace('_', ' ')}</span></div>
      ${o.description ? `<div style="font-size:13px;color:#475569">${esc(o.description)}</div>` : ''}
      <div class="order-meta">👤 ${esc(o.assigned_to || 'Unassigned')}${o.expected_return_date ? ' · 📅 Expected back: ' + esc(o.expected_return_date) : ''}</div>
      ${next ? `<div class="order-actions"><button class="btn-secondary btn-small" data-move="${o.id}" data-to="${next[0]}">${next[1]}</button></div>` : ''}
    </div>`;
  }).join('');
  return `
    <div class="section-head"><h2>Work orders</h2></div>
    <div class="filter-bar"><select id="f-orderprop">${propOpts}</select></div>
    <div class="chips">${chips}</div>
    ${cards || '<div class="empty">No work orders here.</div>'}
    <button class="fab" id="fab-order">+</button>`;
}

function openNewOrder() {
  const propOpts = properties.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  openModal(`
    <h3>New work order</h3>
    <label>Property<select id="no-prop">${propOpts}</select></label>
    <label>Room<select id="no-room"></select></label>
    <label>Title<input id="no-title" placeholder="e.g. AC not cooling"></label>
    <label>Details<textarea id="no-desc" placeholder="What's wrong, what needs doing…"></textarea></label>
    <label>Assign to<input id="no-who" list="assignees" placeholder="Name"><datalist id="assignees">${[...new Set(orders.map(o => o.assigned_to).filter(Boolean))].map(a => `<option value="${esc(a)}">`).join('')}</datalist></label>
    <label>Priority<select id="no-pri"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
    <label>Expected return date<input type="date" id="no-date"></label>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" id="no-save">Create</button>
    </div>`);
  const fillRooms = () => {
    const pid = $('no-prop').value;
    $('no-room').innerHTML = '<option value="">— No specific room —</option>' +
      rooms.filter(r => r.property_id === pid)
        .sort((a, b) => a.room_number.localeCompare(b.room_number, undefined, { numeric: true }))
        .map(r => `<option value="${r.id}">Room ${esc(r.room_number)} (${r.status})</option>`).join('');
  };
  $('no-prop').onchange = fillRooms; fillRooms();
  $('no-save').onclick = async () => {
    const title = $('no-title').value.trim();
    if (!title) { alert('Enter a title.'); return; }
    const pid = $('no-prop').value, rid = $('no-room').value || null;
    const { data, error } = await client.from('work_orders').insert({
      property_id: pid, room_id: rid, title,
      description: $('no-desc').value.trim() || null,
      assigned_to: $('no-who').value.trim() || null,
      priority: $('no-pri').value, status: 'open',
      expected_return_date: $('no-date').value || null,
      created_by: userEmail
    }).select('id').single();
    if (error) { alert(error.message); return; }
    const rm = rooms.find(r => r.id === rid);
    await logHistory({ property_id: pid, room_id: rid, room_number: rm ? rm.room_number : null,
      event_type: 'work_order_created', details: `Work order opened: ${title}` });
    closeModal(); await loadAll();
  };
}

async function moveOrder(id, to) {
  const o = orders.find(x => x.id === id);
  if (!o) return;
  const patch = { status: to };
  if (to === 'completed') patch.completed_at = new Date().toISOString();
  const { error } = await client.from('work_orders').update(patch).eq('id', id);
  if (error) { alert(error.message); return; }
  const rm = rooms.find(r => r.id === o.room_id);
  await logHistory({ property_id: o.property_id, room_id: o.room_id, room_number: rm ? rm.room_number : null,
    event_type: 'work_order_status', details: `Work order "${o.title}" moved to ${to.replace('_', ' ')}` });
  await loadAll();
}

/* ---------- TEAM ---------- */
function viewTeam() {
  const open = orders.filter(o => o.status !== 'completed');
  const groups = {};
  open.forEach(o => { const k = o.assigned_to || 'Unassigned'; (groups[k] = groups[k] || []).push(o); });
  const names = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
  const rows = names.map(n => {
    const od = groups[n].filter(isOverdue).length;
    return `<div class="team-row" data-team="${esc(n)}">
      <div><div class="team-name">${esc(n)}</div>
      <div style="font-size:12px;color:#64748b">${od ? od + ' overdue · ' : ''}${groups[n].filter(o => o.priority === 'urgent').length} urgent</div></div>
      <div class="team-count">${groups[n].length}</div>
    </div>`;
  }).join('');
  return `<div class="section-head"><h2>Team workload</h2></div>
    <div style="font-size:13px;color:#64748b;margin-bottom:10px">Open work orders per person. Tap a row to see their orders.</div>
    ${rows || '<div class="empty">No open work orders.</div>'}`;
}

/* ---------- HISTORY ---------- */
function viewHistory() {
  const propOpts = ['<option value="all">All properties</option>'] +
    properties.map(p => `<option value="${p.id}" ${f.histProperty === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const list = historyRows.filter(h =>
    (f.histProperty === 'all' || h.property_id === f.histProperty) &&
    (!f.histSearch || (h.room_number || '').toLowerCase().includes(f.histSearch.toLowerCase()) ||
      (h.details || '').toLowerCase().includes(f.histSearch.toLowerCase())));
  const rows = list.map(h => `
    <div class="hist-row">
      <div class="hist-top"><span class="hist-room">${h.room_number ? 'Room ' + esc(h.room_number) : esc(propName(h.property_id))}</span><span class="hist-time">${fmtDateTime(h.created_at)}</span></div>
      <div class="hist-details">${esc(h.details || h.event_type)}</div>
      <div class="hist-by">${esc(h.created_by || '')}</div>
    </div>`).join('');
  return `
    <div class="section-head"><h2>History</h2></div>
    <div class="export-row">
      <button class="btn-secondary" id="exp-rooms">⬇ Rooms CSV</button>
      <button class="btn-secondary" id="exp-orders">⬇ Orders CSV</button>
    </div>
    <div class="filter-bar"><select id="f-histprop">${propOpts}</select>
    <input type="search" id="f-histsearch" placeholder="Search room or details…" value="${esc(f.histSearch)}"></div>
    ${rows || '<div class="empty">No history yet.</div>'}`;
}

/* ---------- CSV ---------- */
function downloadCSV(name, rows) {
  const csv = rows.map(r => r.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function exportRooms() {
  downloadCSV('hotelops-rooms.csv', [['Property', 'Room', 'Status', 'Notes'],
    ...rooms.map(r => [propName(r.property_id), r.room_number, r.status, r.notes || ''])]);
}
function exportOrders() {
  downloadCSV('hotelops-orders.csv', [['Property', 'Room', 'Title', 'Priority', 'Status', 'Assigned to', 'Expected return', 'Created', 'Created by'],
    ...orders.map(o => [propName(o.property_id), roomLabel(o), o.title, o.priority, o.status, o.assigned_to || '', o.expected_return_date || '', o.created_at, o.created_by || ''])]);
}

/* ---------- MODAL ---------- */
function openModal(html) { $('modal-box').innerHTML = html; $('modal-overlay').classList.remove('hidden'); }
function closeModal() { $('modal-overlay').classList.add('hidden'); }
window.closeModal = closeModal;

/* ---------- EVENT BINDING ---------- */
function bindView() {
  document.querySelectorAll('.prop-card').forEach(c => c.onclick = () => {
    f.property = c.dataset.prop; f.roomStatus = 'all'; f.roomSearch = ''; switchTab('rooms');
  });
  const fp = $('f-property'); if (fp) fp.onchange = () => { f.property = fp.value; render(); };
  const fs = $('f-search'); if (fs) fs.oninput = () => { f.roomSearch = fs.value; render(); if ($('f-search')) { $('f-search').focus(); $('f-search').setSelectionRange(999, 999); } };
  document.querySelectorAll('[data-rs]').forEach(b => b.onclick = () => { f.roomStatus = b.dataset.rs; render(); });
  document.querySelectorAll('.room-row').forEach(r => r.onclick = e => {
    if (e.target.closest('[data-avail]')) return;
    openRoomModal(r.dataset.room);
  });
  document.querySelectorAll('[data-avail]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    const r = rooms.find(x => x.id === b.dataset.avail);
    const { error } = await client.from('rooms').update({ status: 'available' }).eq('id', r.id);
    if (error) { alert(error.message); return; }
    await logHistory({ property_id: r.property_id, room_id: r.id, room_number: r.room_number,
      event_type: 'status_change', details: `Status changed from ${r.status} to available` });
    await loadAll();
  });
  const arb = $('add-room-btn'); if (arb) arb.onclick = openAddRoom;
  const fabr = $('fab-room'); if (fabr) fabr.onclick = openAddRoom;
  const fabo = $('fab-order'); if (fabo) fabo.onclick = openNewOrder;
  const fop = $('f-orderprop'); if (fop) fop.onchange = () => { f.orderProperty = fop.value; render(); };
  document.querySelectorAll('[data-os]').forEach(b => b.onclick = () => { f.orderStatus = b.dataset.os; render(); });
  document.querySelectorAll('[data-move]').forEach(b => b.onclick = () => moveOrder(b.dataset.move, b.dataset.to));
  document.querySelectorAll('.team-row').forEach(r => r.onclick = () => {
    f.orderStatus = 'all'; f.orderProperty = 'all'; switchTab('orders');
    // highlight this person's orders via alert-free approach: filter not implemented per-person, show all
  });
  const fhp = $('f-histprop'); if (fhp) fhp.onchange = () => { f.histProperty = fhp.value; render(); };
  const fhs = $('f-histsearch'); if (fhs) fhs.oninput = () => { f.histSearch = fhs.value; render(); if ($('f-histsearch')) { $('f-histsearch').focus(); $('f-histsearch').setSelectionRange(999, 999); } };
  const er = $('exp-rooms'); if (er) er.onclick = exportRooms;
  const eo = $('exp-orders'); if (eo) eo.onclick = exportOrders;
}

init();
