'use strict';
const $ = (s) => document.querySelector(s);
let toastTimer;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.style.display = 'none'; }, 3500);
}
async function api(url, body) {
  const response = await fetch(url, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { throw new Error(data.error || ('HTTP ' + response.status)); }
  return data;
}
function esc(value) { const d = document.createElement('span'); d.textContent = String(value ?? ''); return d.innerHTML; }
function fmtBytes(n) { if (!n) return '0 B'; const u = ['B','KB','MB','GB']; const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024))); return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i]; }
function fmtUptime(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? h + 'h ' + m + 'm' : m + 'm'; }

async function loadOverview() {
  const o = await api('/api/admin/overview');
  $('#dbChip').textContent = o.db === 'sqlite' ? 'DB: SQLite' : 'DB: JSON files';
  $('#cards').innerHTML = [
    ['Accounts', o.accounts, ''], ['Guests', o.guests, ''],
    ['Online now', o.online, 'lime'], ['In voice', o.inVoice, 'lime'],
    ['Servers', o.servers, 'violet'], ['Temp servers', o.tempServers, ''],
    ['Messages', o.messages === null ? '—' : o.messages, 'violet'],
    ['Uploads', fmtBytes(o.uploads.bytes), ''], ['Disabled', o.disabled, ''],
    ['Uptime', fmtUptime(o.uptimeSec), '']
  ].map(([label, value, cls]) => `<div class="card ${cls}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');
}

async function loadUsers() {
  const q = $('#userSearch').value.trim();
  const { users } = await api('/api/admin/users' + (q ? ('?q=' + encodeURIComponent(q)) : ''));
  $('#userTable tbody').innerHTML = users.map((u) => `
    <tr>
      <th scope="row"><b>${esc(u.name)}</b> <span class="muted">${u.username ? '@' + esc(u.username) : ''}</span>
        ${u.platformAdmin ? '<span class="tag admin">ADMIN</span>' : ''}
        ${u.guest ? '<span class="tag guest">GUEST</span>' : ''}</th>
      <td class="hide-sm muted">${new Date(u.createdAt).toLocaleDateString()}</td>
      <td>${u.disabled ? '<span class="tag off">DISABLED</span>' : (u.online ? '<span class="tag online">ONLINE</span>' : '<span class="muted">offline</span>')}</td>
      <td class="hide-sm">${u.serversOwned}</td>
      <td>${u.platformAdmin ? '<span class="muted">—</span>' : `
        ${u.disabled
          ? `<button class="good" data-act="enable" data-id="${u.id}" aria-label="Enable ${esc(u.name)}">Enable</button>`
          : `<button data-act="disable" data-id="${u.id}" aria-label="Disable ${esc(u.name)}">Disable</button>`}
        ${u.guest ? '' : `<button data-act="reset-password" data-id="${u.id}" aria-label="Reset password for ${esc(u.name)}">Reset pass</button>
        <button data-act="promote" data-id="${u.id}" aria-label="Make ${esc(u.name)} a platform admin">Make admin</button>`}
        <button class="danger" data-act="delete" data-id="${u.id}" data-name="${esc(u.name)}" aria-label="Delete ${esc(u.name)}">Delete</button>`}
      </td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">No users found.</td></tr>';
}

async function loadServers() {
  const { servers } = await api('/api/admin/servers');
  $('#serverTable tbody').innerHTML = servers.map((s) => `
    <tr>
      <th scope="row"><b>${esc(s.icon || '')} ${esc(s.name)}</b></th>
      <td class="muted">${esc(s.ownerName)}</td>
      <td>${s.members}</td>
      <td class="hide-sm">${s.channels}</td>
      <td>${s.temp ? '<span class="tag temp">TEMP</span>' : '<span class="muted">permanent</span>'}</td>
      <td><button class="danger" data-srv-del="${s.id}" data-name="${esc(s.name)}" aria-label="Delete ${esc(s.name)}">Delete</button></td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">No servers yet.</td></tr>';
}

async function refresh() { await Promise.all([loadOverview(), loadUsers(), loadServers()]); }

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act], button[data-srv-del]');
  if (!button) { return; }
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    if (button.dataset.srvDel) {
      if (!confirm(`Delete the server "${button.dataset.name}" and its full history for everyone?`)) { return; }
      await api('/api/admin/servers', { action: 'delete', serverId: button.dataset.srvDel });
      toast('Server deleted.');
    } else {
      const action = button.dataset.act;
      if (action === 'delete' && !confirm(`Delete the account "${button.dataset.name}", their servers and memberships? This cannot be undone.`)) { return; }
      if (action === 'promote' && !confirm('Give this account full platform-admin access?')) { return; }
      const result = await api('/api/admin/users', { action, userId: button.dataset.id });
      if (result.tempPassword) {
        prompt('Temporary password (give it to the user — old sessions are logged out):', result.tempPassword);
      } else {
        toast('Done.');
      }
    }
    await refresh();
  } catch (error) {
    toast(error.message);
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }
});

let searchTimer;
$('#userSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadUsers, 250); });

(async () => {
  try {
    await refresh();
    $('#adminLoading').hidden = true;
    $('#panel').style.display = 'block';
    $('#adminMain').setAttribute('aria-busy', 'false');
    $('#adminTitle').focus();
    setInterval(loadOverview, 15000);
  } catch {
    $('#adminLoading').hidden = true;
    $('#gate').style.display = 'block';
    $('#adminMain').setAttribute('aria-busy', 'false');
    $('#gateTitle').focus();
  }
})();
