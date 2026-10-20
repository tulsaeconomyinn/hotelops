/* HotelOps — Supabase-backed app */
const SUPABASE_URL = 'https://vjaibkfckxauoxdsojfn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_yqOFCrP8mBYm32x2cUYFYg_eHMDWB18';
const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let userEmail = '';
let properties = [], rooms = [], orders = [], historyRows = [];
let currentTab = 'overview';
let f = { property: 'all', roomStatus: 'all', roomSearch: '', orderStatus: 'open', orderProperty: 'all', histProperty: 'all', histSearch: '' };
/* Per-user scoping: profile.property_id NULL (or role 'admin') = all-properties admin.
   Managers/staff are assigned one or more hotels (profiles.property_ids, with
   property_id kept as the primary). One hotel -> locked to it; several -> they
   can switch between their own hotels. RLS enforces the set server-side, and
   the loaded `properties` array is already limited to what they may see. */
let profile = null;
const isAdmin = () => !!profile && (profile.role === 'admin' || !profile.property_id);
const myPropIds = () => {
  if (!profile) return [];
  if (Array.isArray(profile.property_ids) && profile.property_ids.length) return profile.property_ids;
  return profile.property_id ? [profile.property_id] : [];
};
const scopedProp = () => { const ids = myPropIds(); return (!isAdmin() && ids.length === 1) ? ids[0] : null; };
const multiProp = () => !isAdmin() && myPropIds().length > 1;
const canPickProp = () => isAdmin() || multiProp();
const allPropsLabel = () => isAdmin() ? 'All properties' : 'All my hotels';

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const todayISO = () => new Date().toISOString().slice(0, 10);
const isOverdue = o => o.expected_return_date && o.expected_return_date < todayISO() && o.status !== 'completed';
const propName = id => { const p = properties.find(p => p.id === id); return p ? p.name : '—'; };
const roomLabel = o => { const r = rooms.find(r => r.id === o.room_id); return r ? 'Room ' + r.room_number : ''; };
const fmtDateTime = ts => { try { return new Date(ts).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); } catch(e){ return ''; } };
const fmtDate = ts => { try { return new Date(ts).toLocaleDateString([], {month:'short',day:'numeric'}); } catch(e){ return ''; } };
const fmtDue = d => { try { const p = String(d).split('-').map(Number); return new Date(p[0], p[1]-1, p[2]).toLocaleDateString([], {month:'short',day:'numeric'}); } catch(e){ return String(d || ''); } };
const fmtMoney = n => '$' + (Number(n) || 0).toLocaleString([], { maximumFractionDigits: 2 });

/* ---------- PHOTOS (Supabase Storage, bucket 'work-order-photos') ---------- */
/* Bucket is private; photos are shown via short-lived signed URLs.
   Everything here fails soft: until the storage migration is applied the
   bucket won't exist, uploads/signing just return null and the flow
   continues without a photo. */
const photoUrlCache = {};
async function signedPhotoUrl(path) {
  if (!path) return null;
  if (photoUrlCache[path]) return photoUrlCache[path];
  try {
    const { data, error } = await client.storage.from('work-order-photos').createSignedUrl(path, 3600);
    if (error || !data || !data.signedUrl) return null;
    photoUrlCache[path] = data.signedUrl;
    return data.signedUrl;
  } catch (e) { return null; }
}
async function uploadReportPhoto(file, pid) {
  try {
    const ext = ((file.name || '').split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = pid + '/tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    const { error } = await client.storage.from('work-order-photos')
      .upload(path, file, { contentType: file.type || 'image/jpeg' });
    if (error) throw error;
    return path;
  } catch (e) { return null; }
}
function openPhotoModal(url) {
  openModal(`
    <div class="photo-modal"><img src="${esc(url)}" alt="Work order photo"></div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Close</button>
    </div>`);
}

/* ---------- REPAIR SPEND (this month, from completed orders' cost) ---------- */
function repairSpendSection() {
  const now = new Date();
  const ym = now.toISOString().slice(0, 7);
  const monthLabel = now.toLocaleString([], { month: 'long' });
  const done = orders.filter(o => o.status === 'completed' && o.completed_at &&
    o.completed_at.slice(0, 7) === ym && (Number(o.cost) || 0) > 0);
  const total = done.reduce((s, o) => s + (Number(o.cost) || 0), 0);
  if (!total) return '';
  const props = properties; // RLS already limits this to the viewer's hotels
  const rows = props.map(p => {
    const sum = done.filter(o => o.property_id === p.id).reduce((s, o) => s + (Number(o.cost) || 0), 0);
    return sum ? `<div class="spend-row"><span>${esc(p.name)}</span><strong>${fmtMoney(sum)}</strong></div>` : '';
  }).join('');
  return `<div class="card spend-card"><div class="prop-name">🔧 Repair spend · ${monthLabel}</div>
    <div class="spend-rows">${rows}</div>
    <div class="spend-total"><span>Total</span><strong>${fmtMoney(total)}</strong></div></div>`;
}

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
  else if (data.session) { await enterApp(data.session.user.email, data.session.user.id); }
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
  await enterApp(data.user.email, data.user.id);
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

async function enterApp(email, userId) {
  userEmail = email;
  // Fetch the user's profile: role + property decides what they can see.
  const { data: prof } = await client.from('profiles')
    .select('role, property_id, property_ids').eq('id', userId).single();
  if (!prof) {
    // No profile row -> RLS would show nothing. Fail closed with a clear message.
    await client.auth.signOut();
    $('app-view').classList.add('hidden');
    $('login-view').classList.remove('hidden');
    const errBox = $('login-error');
    errBox.textContent = 'No HotelOps profile for this account — ask your admin to set you up.';
    errBox.classList.remove('hidden');
    return;
  }
  profile = prof;
  if (!isAdmin() && scopedProp()) {
    // Single-hotel login: lock every property filter to their hotel.
    // Multi-hotel logins keep 'all', which means all of THEIR hotels.
    f.property = f.orderProperty = f.histProperty = scopedProp();
  }
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
  const ht = $('header-title');
  if (ht) {
    if (isAdmin()) ht.textContent = '🏨 HotelOps';
    else if (scopedProp()) {
      const sp = properties.find(p => p.id === scopedProp());
      ht.innerHTML = '🏨 HotelOps <span class="header-prop">· ' + esc(sp ? sp.name : '') + '</span>';
    } else {
      ht.innerHTML = '🏨 HotelOps <span class="header-prop">· My hotels</span>';
    }
  }
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
  else if (currentTab === 'orders') c.innerHTML = viewRooms();
  else if (currentTab === 'team') c.innerHTML = viewTeam();
  else if (currentTab === 'history') c.innerHTML = viewHistory();
  bindView();
}

/* ---------- OVERVIEW ---------- */
function viewOverview() {
  if (!properties.length) return '<div class="empty">No properties yet.</div>';
  const total = rooms.length;
  const avail = rooms.filter(r => r.status === 'available').length;
  const out = total - avail;
  const openOrders = orders.filter(o => o.status !== 'completed').length;
  const od = orders.filter(o => isOverdue(o)).length;
  const kpis = `
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-label">Total rooms</div><div class="kpi-num">${total}</div><div class="kpi-cap">${properties.length > 1 ? 'Across ' + properties.length + ' properties' : esc(propName(scopedProp()))}</div></div>
      <div class="kpi-card"><div class="kpi-label">Available</div><div class="kpi-num good">${avail}</div><div class="kpi-cap">${total ? Math.floor(avail / total * 100) : 0}% ready to sell</div></div>
      <div class="kpi-card"><div class="kpi-label">Out of service</div><div class="kpi-num ${out ? 'warn' : ''}">${out}</div><div class="kpi-cap">Needs work</div></div>
    </div>`;
  const headName = isAdmin() ? 'Portfolio' : (scopedProp() ? esc(propName(scopedProp())) : 'My hotels');
  return `<div class="section-head"><h2>${headName}</h2></div>
    <button class="btn-primary report-down-btn" id="report-down-btn">🚨 Report room down</button>` + kpis + repairSpendSection() + properties.map(p => {
    const pr = rooms.filter(r => r.property_id === p.id);
    const pavail = pr.filter(r => r.status === 'available').length;
    const pout = pr.filter(r => r.status !== 'available').length;
    const popen = orders.filter(o => o.property_id === p.id && o.status !== 'completed').length;
    const pod = orders.filter(o => o.property_id === p.id && isOverdue(o)).length;
    const pct = pr.length ? Math.round(pavail / pr.length * 100) : 0;
    return `<div class="card prop-card" data-prop="${p.id}">
      <div class="prop-name">${esc(p.name)}</div>
      <div class="prop-addr">${esc(p.address || '')}</div>
      <div class="pbar"><div class="pbar-fill" style="width:${pct}%"></div></div>
      <div class="prop-sub">${pavail} / ${pr.length} available${pout ? ' · ' + pout + ' down' : ''}</div>
      <div class="stat-row">
        <div class="stat ok"><div class="n">${pavail}</div><div class="l">Available</div></div>
        <div class="stat ${pout ? 'warn' : ''}"><div class="n">${pout}</div><div class="l">Out of svc</div></div>
      </div>
    </div>`;
  }).join('');
}

/* ---------- ROOMS ---------- */
function viewRooms() {
  const propSel = canPickProp()
    ? `<select id="f-property">${['<option value="all">' + allPropsLabel() + '</option>'].concat(properties.map(p => `<option value="${p.id}" ${f.property === p.id ? 'selected' : ''}>${esc(p.name)}</option>`)).join('')}</select>`
    : '';
  const chips = ['all', 'available', 'maintenance'].map(s =>
    `<button class="chip ${f.roomStatus === s ? 'active' : ''}" data-rs="${s}">${s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)}</button>`).join('');
  let list = rooms.filter(r =>
    (f.property === 'all' || r.property_id === f.property) &&
    (f.roomStatus === 'all' || (f.roomStatus === 'maintenance' ? r.status !== 'available' : r.status === f.roomStatus)) &&
    (!f.roomSearch || r.room_number.toLowerCase().includes(f.roomSearch.toLowerCase())));
  // sort: non-available first, then room number
  list.sort((a, b) => (a.status === 'available') - (b.status === 'available') || a.room_number.localeCompare(b.room_number, undefined, { numeric: true }));
  const rows = list.map(r => {
    // Table layout: aligned columns. Under the hotel name, only the date
    // the down entry was created; reason / due / assignee get own columns.
    const down = r.status !== 'available';
    const oo = down ? orders.find(o => o.room_id === r.id && o.status !== 'completed') : null;
    const inLine = oo ? `<div class="room-in">In: ${fmtDate(oo.created_at)}</div>` : '';
    const dueCell = !oo ? '—' : (oo.expected_return_date ? `<span class="${isOverdue(oo) ? 'due-od' : ''}">${fmtDue(oo.expected_return_date)}${isOverdue(oo) ? ' ⚠️' : ''}</span>` : '—');
    return `
    <tr class="room-trow" data-room="${r.id}">
      <td><div class="room-num">Room ${esc(r.room_number)}</div><div class="room-prop">${esc(propName(r.property_id))}</div>${inLine}</td>
      <td><span class="badge ${down ? 'maintenance' : 'available'}">${down ? 'maintenance' : 'available'}</span></td>
      <td class="rt-reason">${oo && oo.title ? esc(oo.title) : '—'}</td>
      <td>${dueCell}</td>
      <td>${oo ? esc(oo.assigned_to || 'Unassigned') : '—'}</td>
    </tr>`;
  }).join('');
  const table = list.length ? `<div class="table-wrap"><table class="rooms-table"><thead><tr><th>Room</th><th>Status</th><th>Reason for Down</th><th>Due Date</th><th>Assigned To</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No rooms match. Add rooms to get started.</div>';
  return `
    <div class="section-head"><h2>Rooms Status</h2><div style="display:flex;gap:8px"><button class="btn-secondary btn-small" id="new-order-btn">+ New order</button><button class="btn-secondary btn-small" id="fix-rooms-btn">Fix room list</button><button class="btn-secondary btn-small" id="add-room-btn">+ Add room</button></div></div>
    <div class="filter-bar">${propSel}
    <input type="search" id="f-search" placeholder="Search room #" value="${esc(f.roomSearch)}"></div>
    <div class="chips">${chips}</div>
    ${table}
    <button class="fab" id="fab-room">+</button>`;
}

function openRoomModal(roomId) {
  const r = rooms.find(x => x.id === roomId);
  if (!r) return;
  const curStatus = r.status === 'available' ? 'available' : 'maintenance';
  const stBtns = ['available', 'maintenance'].map(s =>
    `<button class="chip ${curStatus === s ? 'active' : ''}" data-setst="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('');
  // Managers may delete rooms in their own property when the room has no
  // work orders or history (enforced by RLS too). Hide the button when the
  // client can see the room has history; admins keep unconditional delete.
  const hasHistory = orders.some(o => o.room_id === r.id) || historyRows.some(h => h.room_id === r.id);
  // Open work orders for this room, with Start / Complete right here (the
  // Orders tab was removed at Sajan's request — its actions live here now).
  const roomOrders = orders.filter(o => o.room_id === r.id && o.status !== 'completed')
    .sort((a, b) => (isOverdue(b) - isOverdue(a)) || (b.created_at < a.created_at ? -1 : 1));
  const orderSection = roomOrders.length ? `
    <label>Open work order${roomOrders.length > 1 ? 's' : ''}</label>
    ${roomOrders.map(o => `
    <div class="modal-order">
      <div class="order-title" style="font-size:14px">${esc(o.title)} ${isOverdue(o) ? '<span class="badge overdue">OVERDUE</span>' : ''}</div>
      <div class="order-meta">👤 ${esc(o.assigned_to || 'Unassigned')}${o.expected_return_date ? ' · 📅 Due: ' + esc(fmtDue(o.expected_return_date)) : ''} · <span class="badge ${o.status}">${o.status.replace('_', ' ')}</span></div>
      ${o.description ? `<div style="font-size:13px;color:#475569">${esc(o.description)}</div>` : ''}
      ${o.photo_path ? `<img class="order-thumb" data-photo="${esc(o.photo_path)}" style="display:none" alt="Work order photo">` : ''}
      <div class="order-actions">
        ${o.status === 'open' ? `<button class="btn-secondary btn-small" data-mstart="${o.id}">Start →</button>` : ''}
        ${o.status === 'in_progress' ? `<button class="btn-primary btn-small" data-mcomplete="${o.id}">Complete ✓</button>` : ''}
      </div>
    </div>`).join('')}` : '';
  openModal(`
    <h3>Room ${esc(r.room_number)} <small style="color:#64748b">· ${esc(propName(r.property_id))}</small></h3>
    <label>Room number<input id="room-num" value="${esc(r.room_number)}" autocomplete="off"></label>
    <label>Status</label>
    <div class="status-btns">${stBtns}</div>
    <label>Notes<textarea id="room-notes" placeholder="e.g. waiting on parts…">${esc(r.notes || '')}</textarea></label>
    ${orderSection}
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" id="room-save">Save</button>
    </div>
    ${(isAdmin() || !hasHistory) ? '<button class="btn-secondary btn-danger" id="room-del" style="width:100%;margin-top:10px">Delete room</button>' : ''}`);
  let newStatus = curStatus;
  document.querySelectorAll('[data-mstart]').forEach(b => b.onclick = async () => { const id = b.dataset.mstart; closeModal(); await moveOrder(id, 'in_progress'); });
  document.querySelectorAll('[data-mcomplete]').forEach(b => b.onclick = () => openCompleteOrder(b.dataset.mcomplete));
  document.querySelectorAll('.modal-order img[data-photo]').forEach(async img => {
    const url = await signedPhotoUrl(img.dataset.photo);
    if (!url) return;
    img.src = url; img.style.display = '';
    img.onclick = e => { e.stopPropagation(); openPhotoModal(url); };
  });
  document.querySelectorAll('[data-setst]').forEach(b => b.onclick = () => {
    newStatus = b.dataset.setst;
    document.querySelectorAll('[data-setst]').forEach(x => x.classList.toggle('active', x === b));
  });
  $('room-save').onclick = async () => {
    const notes = $('room-notes').value.trim();
    const newNum = $('room-num').value.trim();
    if (!newNum) { alert('Room number cannot be empty.'); return; }
    const { error } = await client.from('rooms').update({ status: newStatus, notes: notes || null, room_number: newNum }).eq('id', r.id);
    if (error) { alert(error.message); return; }
    if (newStatus !== r.status) {
      await logHistory({ property_id: r.property_id, room_id: r.id, room_number: newNum,
        event_type: 'status_change', details: `Status changed from ${r.status} to ${newStatus}` });
    }
    if (newNum !== r.room_number) {
      await logHistory({ property_id: r.property_id, room_id: r.id, room_number: newNum,
        event_type: 'room_renamed', details: `Room renumbered from ${r.room_number} to ${newNum}` });
    }
    closeModal(); await loadAll();
  };
  const rdel = $('room-del');
  if (rdel) rdel.onclick = async () => {
    if (!confirm(`Delete Room ${r.room_number}? Open orders keep their history but lose the room link.`)) return;
    const { error } = await client.from('rooms').delete().eq('id', r.id);
    if (error) { alert(error.message); return; }
    await logHistory({ property_id: r.property_id, room_id: null, room_number: r.room_number,
      event_type: 'room_deleted', details: `Room ${r.room_number} deleted` });
    closeModal(); await loadAll();
  };
}

function openAddRoom() {
  const admin = canPickProp();
  const propField = admin
    ? `<label>Property<select id="nr-prop">${properties.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>`
    : '';
  openModal(`
    <h3>Add room</h3>
    ${propField}
    <label>Room number<input id="nr-num" placeholder="e.g. 205"></label>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" id="nr-save">Add</button>
    </div>`);
  $('nr-save').onclick = async () => {
    const num = $('nr-num').value.trim();
    if (!num) { alert('Enter a room number.'); return; }
    const pid = admin ? $('nr-prop').value : scopedProp();
    const { error } = await client.from('rooms').insert({ property_id: pid, room_number: num, status: 'available' });
    if (error) { alert(error.message); return; }
    closeModal(); await loadAll();
  };
}

/* ---------- FIX ROOM LIST (bulk editor) ----------
   Manager edits their hotel's whole room list in one textarea.
   Save adds rooms that are new and deletes rooms that were removed;
   rooms with work history can't be deleted (RLS) and are reported back. */
function openFixRooms() {
  if (canPickProp() && (!f.property || f.property === 'all')) {
    // Admin with no property selected: ask which hotel first.
    openModal(`
      <h3>Fix room list</h3>
      <p style="font-size:13px;color:#64748b;margin:0 0 12px">Pick the hotel whose room list you want to fix.</p>
      <label>Hotel<select id="frl-prop">${properties.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeModal()">Cancel</button>
        <button class="btn-primary" id="frl-pick">Continue</button>
      </div>`);
    $('frl-pick').onclick = () => openFixRoomsModal($('frl-prop').value);
    return;
  }
  openFixRoomsModal(canPickProp() ? f.property : scopedProp());
}

function openFixRoomsModal(pid) {
  const p = properties.find(x => x.id === pid);
  const current = rooms
    .filter(r => r.property_id === pid)
    .map(r => r.room_number.trim())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  openModal(`
    <h3>Fix room list <small style="color:#64748b">· ${esc(p ? p.name : '')}</small></h3>
    <p style="font-size:13px;color:#64748b;margin:0 0 8px">Edit this list to match the hotel's real room numbers — one per line. Save adds new ones and removes wrong ones (rooms with work history are kept and flagged).</p>
    <label>Room numbers<textarea id="frl-text" rows="10" style="font-family:monospace" placeholder="101&#10;102&#10;201" autocomplete="off">${esc(current.join('\n'))}</textarea></label>
    <div id="frl-error" class="error-box hidden" style="margin-top:10px"></div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" id="frl-save">Save list</button>
    </div>`);
  $('frl-save').onclick = () => saveRoomList(pid);
}

async function saveRoomList(pid) {
  const errBox = $('frl-error');
  errBox.classList.add('hidden');
  // Parse: trim, drop empty lines, dedupe case-insensitively.
  const seen = new Set();
  const wanted = [];
  $('frl-text').value.split('\n').forEach(line => {
    const t = line.trim();
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k); wanted.push(t);
  });
  if (!wanted.length) {
    errBox.textContent = 'The list is empty — nothing to save.';
    errBox.classList.remove('hidden'); return;
  }
  const btn = $('frl-save');
  btn.textContent = 'Saving…'; btn.disabled = true;
  const cur = rooms.filter(r => r.property_id === pid);
  const curKeys = new Map(cur.map(r => [r.room_number.trim().toLowerCase(), r]));
  const wantedKeys = new Set(wanted.map(w => w.toLowerCase()));
  const toAdd = wanted.filter(w => !curKeys.has(w.toLowerCase()));
  const toRemove = cur.filter(r => !wantedKeys.has(r.room_number.trim().toLowerCase()));
  let added = 0;
  const removedNums = [], keptNums = [];
  // Add the new rooms first.
  for (const num of toAdd) {
    const { data, error } = await client.from('rooms')
      .insert({ property_id: pid, room_number: num, status: 'available' })
      .select('id, room_number').single();
    if (error) { alert('Could not add room ' + num + ': ' + error.message); break; }
    added++;
    await logHistory({ property_id: pid, room_id: data.id, room_number: num,
      event_type: 'room_added', details: `Room ${num} added from Fix room list` });
  }
  // Remove rooms that were taken off the list. RLS blocks any room that has
  // work orders or room history (and, until the room-delete migration runs,
  // blocks managers entirely) — failures go to the "kept" list.
  for (const r of toRemove) {
    const { error } = await client.from('rooms').delete().eq('id', r.id);
    if (error) keptNums.push(r.room_number); else removedNums.push(r.room_number);
  }
  await loadAll();
  openModal(`
    <h3>Room list updated</h3>
    <div class="info-box" style="margin:0">
      Added ${added} room${added === 1 ? '' : 's'}. Removed ${removedNums.length} wrong room${removedNums.length === 1 ? '' : 's'}.
      ${keptNums.length ? `<br><br>Couldn't remove these (they have work history) — ask an admin or rename them: <strong>${esc(keptNums.join(', '))}</strong>` : ''}
    </div>
    <div class="modal-actions">
      <button class="btn-primary" onclick="closeModal()">Done</button>
    </div>`);
}

/* ---------- REPORT ROOM DOWN ---------- */
/* One simple form: date, room, why, expected return, who's fixing it.
   Creates a work order AND marks the room maintenance (down), plus a history entry. */
function openReportDown() {
  const admin = canPickProp();
  const propField = admin
    ? `<label>Property<select id="rd-prop">${properties.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>`
    : `<div class="static-prop">${esc(propName(scopedProp()))}</div>`;
  openModal(`
    <h3>🚨 Report room down</h3>
    ${propField}
    <label>Date<input type="date" id="rd-date" value="${todayISO()}"></label>
    <label>Room<input id="rd-room" list="rd-room-list" placeholder="e.g. 214" autocomplete="off"><datalist id="rd-room-list"></datalist>
    <small class="hint">Type any number — if it's not in the system you'll be asked before it's added.</small></label>
    <label>What's wrong<input id="rd-reason" placeholder="e.g. AC not cooling"></label>
    <label>Expected back<input type="date" id="rd-return"></label>
    <label>Who's working on it<input id="rd-who" placeholder="Name"></label>
    <label>Photo (optional)<input type="file" id="rd-photo" accept="image/*" capture="environment"></label>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" id="rd-save">Report it</button>
    </div>`);
  const fillRooms = () => {
    const pid = admin ? $('rd-prop').value : scopedProp();
    $('rd-room-list').innerHTML =
      rooms.filter(r => r.property_id === pid)
        .sort((a, b) => a.room_number.localeCompare(b.room_number, undefined, { numeric: true }))
        .map(r => `<option value="${esc(r.room_number)}">Room ${esc(r.room_number)} (${r.status})</option>`).join('');
  };
  if (admin) $('rd-prop').onchange = fillRooms;
  fillRooms();
  $('rd-save').onclick = async () => {
    const reason = $('rd-reason').value.trim();
    const roomNum = $('rd-room').value.trim();
    if (!roomNum) { alert('Enter a room number.'); return; }
    if (!reason) { alert('Say what\'s wrong with the room.'); return; }
    const pid = admin ? $('rd-prop').value : scopedProp();
    const btn = $('rd-save'); btn.textContent = 'Reporting…'; btn.disabled = true;
    let photoNote = '';
    try {
      // Self-correcting room numbers: find the typed room, or ask before creating it.
      let rm = rooms.find(r => r.property_id === pid && r.room_number.trim() === roomNum);
      if (!rm) {
        if (!confirm(`Room ${roomNum} isn't in the system for this hotel. Add it as a new room?`)) {
          btn.textContent = 'Report it'; btn.disabled = false;
          return;
        }
        const { data, error } = await client.from('rooms')
          .insert({ property_id: pid, room_number: roomNum, status: 'available' })
          .select('id, room_number').single();
        if (error) { alert(error.message); return; }
        rm = data;
        await logHistory({ property_id: pid, room_id: data.id, room_number: roomNum,
          event_type: 'room_added', details: `Room ${roomNum} added from Report room down` });
      }
      const rid = rm.id;
      const when = $('rd-date').value || todayISO();
      const ret = $('rd-return').value || null;
      const who = $('rd-who').value.trim() || null;
      // Photo upload is optional and non-blocking: if the bucket isn't set up
      // (or the upload fails) the order is still created without it.
      let photoPath = null;
      const file = $('rd-photo').files && $('rd-photo').files[0];
      if (file) photoPath = await uploadReportPhoto(file, pid);
      if (file && !photoPath) photoNote = ' (photo could not be uploaded — order saved without it)';
      const orderRow = {
        property_id: pid, room_id: rid, title: reason, status: 'open', priority: 'medium',
        description: 'Reported down on ' + when + '.',
        assigned_to: who, expected_return_date: ret, created_by: userEmail, photo_path: photoPath
      };
      let { error: oerr } = await client.from('work_orders').insert(orderRow);
      if (oerr && photoPath && /photo_path/i.test(oerr.message)) {
        // photo_path column not migrated yet — retry without it
        const { photo_path: _drop, ...row2 } = orderRow;
        ({ error: oerr } = await client.from('work_orders').insert(row2));
      }
      if (oerr) { alert(oerr.message); return; }
      const { error: rerr } = await client.from('rooms').update({ status: 'maintenance' }).eq('id', rid);
      if (rerr) { alert(rerr.message); return; }
      await logHistory({ property_id: pid, room_id: rid, room_number: rm.room_number,
        event_type: 'room_down', details: `Room reported down on ${when}: ${reason}${who ? ' — ' + who + ' on it' : ''}${ret ? ' — expected back ' + ret : ''}${photoNote}` });
      closeModal(); await loadAll();
      if (photoNote) alert('Room reported. Note: the photo could not be uploaded.');
    } finally {
      btn.textContent = 'Report it'; btn.disabled = false;
    }
  };
}

/* ---------- WORK ORDERS ---------- */
function viewOrders() {
  const propSel = canPickProp()
    ? `<select id="f-orderprop">${['<option value="all">' + allPropsLabel() + '</option>'].concat(properties.map(p => `<option value="${p.id}" ${f.orderProperty === p.id ? 'selected' : ''}>${esc(p.name)}</option>`)).join('')}</select>`
    : '';
  const chips = [['open', 'Open'], ['in_progress', 'In Progress'], ['completed', 'Done'], ['all', 'All']].map(([v, l]) =>
    `<button class="chip ${f.orderStatus === v ? 'active' : ''}" data-os="${v}">${l}</button>`).join('');
  let list = orders.filter(o =>
    (f.orderProperty === 'all' || o.property_id === f.orderProperty) &&
    (f.orderStatus === 'all' || o.status === f.orderStatus));
  list.sort((a, b) => (isOverdue(b) - isOverdue(a)) || (b.created_at < a.created_at ? -1 : 1));
  const cards = list.map(o => {
    const od = isOverdue(o);
    const next = o.status === 'open' ? ['in_progress', 'Start →'] : null;
    return `<div class="card order-card pri-${o.priority}">
      <div class="order-title">${esc(o.title)} ${od ? '<span class="badge overdue">OVERDUE</span>' : ''}</div>
      <div class="order-meta">${esc(propName(o.property_id))}${roomLabel(o) ? ' · ' + esc(roomLabel(o)) : ''} · <span class="badge ${o.priority}">${o.priority}</span> <span class="badge ${o.status}">${o.status.replace('_', ' ')}</span></div>
      ${o.description ? `<div style="font-size:13px;color:#475569">${esc(o.description)}</div>` : ''}
      <div class="order-meta">👤 ${esc(o.assigned_to || 'Unassigned')}${o.expected_return_date ? ' · 📅 Expected back: ' + esc(o.expected_return_date) : ''}${o.cost != null && o.cost !== '' ? ' · 💰 ' + fmtMoney(o.cost) : ''}</div>
      ${o.photo_path ? `<img class="order-thumb" data-photo="${esc(o.photo_path)}" style="display:none" alt="Work order photo">` : ''}
      ${next ? `<div class="order-actions"><button class="btn-secondary btn-small" data-move="${o.id}" data-to="${next[0]}">${next[1]}</button></div>` : ''}
      ${o.status === 'in_progress' ? `<div class="order-actions"><button class="btn-secondary btn-small" data-complete="${o.id}">Complete ✓</button></div>` : ''}
    </div>`;
  }).join('');
  return `
    <div class="section-head"><h2>Work orders</h2></div>
    <div class="filter-bar">${propSel}</div>
    <div class="chips">${chips}</div>
    ${cards || '<div class="empty">No work orders here.</div>'}
    <button class="fab" id="fab-order">+</button>`;
}

function openNewOrder() {
  const admin = canPickProp();
  const propField = admin
    ? `<label>Property<select id="no-prop">${properties.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>`
    : `<div class="static-prop">${esc(propName(scopedProp()))}</div>`;
  openModal(`
    <h3>New work order</h3>
    ${propField}
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
    const pid = admin ? $('no-prop').value : scopedProp();
    $('no-room').innerHTML = '<option value="">— No specific room —</option>' +
      rooms.filter(r => r.property_id === pid)
        .sort((a, b) => a.room_number.localeCompare(b.room_number, undefined, { numeric: true }))
        .map(r => `<option value="${r.id}">Room ${esc(r.room_number)} (${r.status})</option>`).join('');
  };
  if (admin) $('no-prop').onchange = fillRooms;
  fillRooms();
  $('no-save').onclick = async () => {
    const title = $('no-title').value.trim();
    if (!title) { alert('Enter a title.'); return; }
    const pid = admin ? $('no-prop').value : scopedProp(), rid = $('no-room').value || null;
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

async function moveOrder(id, to, cost) {
  const o = orders.find(x => x.id === id);
  if (!o) return;
  const patch = { status: to };
  if (to === 'completed') {
    patch.completed_at = new Date().toISOString();
    if (cost != null) patch.cost = cost;
  }
  let { error } = await client.from('work_orders').update(patch).eq('id', id);
  if (error && cost != null && /cost/i.test(error.message)) {
    // cost column not migrated yet — complete without it
    delete patch.cost;
    ({ error } = await client.from('work_orders').update(patch).eq('id', id));
  }
  if (error) { alert(error.message); return; }
  const rm = rooms.find(r => r.id === o.room_id);
  await logHistory({ property_id: o.property_id, room_id: o.room_id, room_number: rm ? rm.room_number : null,
    event_type: 'work_order_status', details: `Work order "${o.title}" moved to ${to.replace('_', ' ')}${cost != null ? ' · cost ' + fmtMoney(cost) : ''}` });
  await loadAll();
}

function openCompleteOrder(id) {
  const o = orders.find(x => x.id === id);
  if (!o) return;
  openModal(`
    <h3>Complete work order</h3>
    <div class="co-title">${esc(o.title)}${roomLabel(o) ? ' · ' + esc(roomLabel(o)) : ''}</div>
    <label>Repair cost (optional)<input type="number" id="co-cost" inputmode="decimal" min="0" step="0.01" placeholder="$ 0.00"></label>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" id="co-save">Complete ✓</button>
    </div>`);
  $('co-save').onclick = async () => {
    const v = $('co-cost').value.trim();
    const cost = v === '' ? null : Number(v);
    if (v !== '' && (!isFinite(cost) || cost < 0)) { alert('Enter a valid cost, or leave it blank.'); return; }
    closeModal();
    await moveOrder(id, 'completed', cost);
  };
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
    ${addManagerSection()}
    <div style="font-size:13px;color:#64748b;margin-bottom:10px">Open work orders per person. Tap a row to see their orders.</div>
    ${rows || '<div class="empty">No open work orders.</div>'}`;
}

/* ---------- MANAGER ONBOARDING (admin only) ----------
   Admin enters email + name + hotel. The create-manager edge function makes
   the login, links the hotel, and emails the credentials. */
function addManagerSection() {
  if (!isAdmin()) return '';
  return `<div class="card am-card">
    <h3 style="margin:0 0 6px;font-size:17px;font-weight:800">Add manager</h3>
    <p style="font-size:13px;color:#64748b;margin:0 0 12px">Creates their login, assigns their hotel(s), and emails them the sign-in details automatically.</p>
    <label>Email<input type="email" id="am-email" placeholder="manager@example.com" autocomplete="off"></label>
    <label>Full name<input id="am-name" placeholder="e.g. Jordan Lee" autocomplete="off"></label>
    <label>Assigned hotel(s) — tick all that apply</label>
    <div class="am-props">${properties.map(p => `<label class="check-row"><input type="checkbox" class="am-prop-check" value="${p.id}"> ${esc(p.name)}</label>`).join('')}</div>
    <button class="btn-primary" id="am-create">Create account &amp; send login</button>
    <div id="am-error" class="error-box hidden" style="margin-top:12px;margin-bottom:0"></div>
    <div id="am-result" class="hidden" style="margin-top:12px"></div>
  </div>`;
}

async function createManagerAccount() {
  const email = $('am-email').value.trim();
  const name = $('am-name').value.trim();
  const propertyIds = [...document.querySelectorAll('.am-prop-check:checked')].map(c => c.value);
  const errBox = $('am-error'), resBox = $('am-result');
  errBox.classList.add('hidden'); resBox.classList.add('hidden'); resBox.innerHTML = '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errBox.textContent = 'Enter a valid email address.'; errBox.classList.remove('hidden'); return; }
  if (!propertyIds.length) { errBox.textContent = 'Tick at least one hotel for them.'; errBox.classList.remove('hidden'); return; }
  const btn = $('am-create');
  btn.textContent = 'Creating…'; btn.disabled = true;
  try {
    const { data: { session } } = await client.auth.getSession();
    if (!session) { errBox.textContent = 'You are not signed in.'; errBox.classList.remove('hidden'); return; }
    const resp = await fetch(SUPABASE_URL + '/functions/v1/create-manager', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + session.access_token, 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name, property_ids: propertyIds })
    });
    const out = await resp.json();
    if (!out.ok) { errBox.textContent = out.error || 'Something went wrong.'; errBox.classList.remove('hidden'); return; }
    resBox.classList.remove('hidden');
    resBox.innerHTML = `<div class="info-box" style="margin-top:0">
      <strong>✅ Account created.</strong> Login details were emailed to ${esc(email)}.<br><br>
      Temporary password (shown once):<br>
      <code id="am-temp" class="am-temp">${esc(out.tempPassword)}</code><br>
      <button class="btn-secondary btn-small" id="am-copy" style="margin-top:8px">📋 Copy password</button><br>
      <small style="color:#64748b">Tell them to change it after their first sign-in (top-right menu → Change password).</small>
    </div>`;
    $('am-copy').onclick = async () => {
      const pw = $('am-temp').textContent;
      try { await navigator.clipboard.writeText(pw); $('am-copy').textContent = '✓ Copied'; }
      catch (e) {
        const ta = document.createElement('textarea'); ta.value = pw; document.body.appendChild(ta);
        ta.select(); try { document.execCommand('copy'); $('am-copy').textContent = '✓ Copied'; } catch (_) {}
        document.body.removeChild(ta);
      }
    };
    $('am-email').value = ''; $('am-name').value = ''; document.querySelectorAll('.am-prop-check').forEach(c => { c.checked = false; });
  } catch (e) {
    errBox.textContent = 'Could not reach the server. Check your connection and try again.';
    errBox.classList.remove('hidden');
  } finally {
    btn.textContent = 'Create account & send login'; btn.disabled = false;
  }
}

/* ---------- HISTORY ---------- */
function viewHistory() {
  const propSel = canPickProp()
    ? `<select id="f-histprop">${['<option value="all">' + allPropsLabel() + '</option>'].concat(properties.map(p => `<option value="${p.id}" ${f.histProperty === p.id ? 'selected' : ''}>${esc(p.name)}</option>`)).join('')}</select>`
    : '';
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
    <div class="filter-bar">${propSel}
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
  downloadCSV('hotelops-orders.csv', [['Property', 'Room', 'Title', 'Priority', 'Status', 'Assigned to', 'Expected return', 'Cost', 'Created', 'Created by'],
    ...orders.map(o => [propName(o.property_id), roomLabel(o), o.title, o.priority, o.status, o.assigned_to || '', o.expected_return_date || '', o.cost != null && o.cost !== '' ? o.cost : '', o.created_at, o.created_by || ''])]);
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
  document.querySelectorAll('.room-trow').forEach(r => r.onclick = e => {
    openRoomModal(r.dataset.room);
  });
  const arb = $('add-room-btn'); if (arb) arb.onclick = openAddRoom;
  const nob = $('new-order-btn'); if (nob) nob.onclick = openNewOrder;
  const frb = $('fix-rooms-btn'); if (frb) frb.onclick = openFixRooms;
  const rdb = $('report-down-btn'); if (rdb) rdb.onclick = openReportDown;
  const fabr = $('fab-room'); if (fabr) fabr.onclick = openAddRoom;
  const fabo = $('fab-order'); if (fabo) fabo.onclick = openNewOrder;
  const fop = $('f-orderprop'); if (fop) fop.onchange = () => { f.orderProperty = fop.value; render(); };
  document.querySelectorAll('[data-os]').forEach(b => b.onclick = () => { f.orderStatus = b.dataset.os; render(); });
  document.querySelectorAll('[data-move]').forEach(b => b.onclick = () => moveOrder(b.dataset.move, b.dataset.to));
  document.querySelectorAll('[data-complete]').forEach(b => b.onclick = () => openCompleteOrder(b.dataset.complete));
  document.querySelectorAll('img[data-photo]').forEach(async img => {
    const url = await signedPhotoUrl(img.dataset.photo);
    if (!url) return;
    img.src = url; img.style.display = '';
    img.onclick = e => { e.stopPropagation(); openPhotoModal(url); };
  });
  document.querySelectorAll('.team-row').forEach(r => r.onclick = () => {
    switchTab('rooms');
  });
  const amc = $('am-create'); if (amc) amc.onclick = createManagerAccount;
  const fhp = $('f-histprop'); if (fhp) fhp.onchange = () => { f.histProperty = fhp.value; render(); };
  const fhs = $('f-histsearch'); if (fhs) fhs.oninput = () => { f.histSearch = fhs.value; render(); if ($('f-histsearch')) { $('f-histsearch').focus(); $('f-histsearch').setSelectionRange(999, 999); } };
  const er = $('exp-rooms'); if (er) er.onclick = exportRooms;
  const eo = $('exp-orders'); if (eo) eo.onclick = exportOrders;
}

init();
