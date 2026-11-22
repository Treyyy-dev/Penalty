// Penalty online server: serves the game and relays matches over WebSocket.
// No dependencies — plain Node.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 10000;
const WAIT_MS = 10000;          // how long a lobby waits for more players
const CAP = 12;                 // fighters per match
const CHARS = ['eli', 'june', 'dex', 'mara', 'noah', 'sloane', 'ivy', 'kai', 'wren', 'asher'];
const GUNS = ['rifle', 'shotgun', 'smg'];
const MODES = ['team', 'ffa', 'rteam', 'rffa'];
const BOTN = 1000;             // bot players; every copy of the game builds the same list, so a number is enough
// players may pick characters newer than this list; bots stick to the ones every build has
const okId = v => typeof v === 'string' && /^[a-z0-9_]{2,14}$/.test(v);

/* ---------- http: health check + the game page ---------- */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (url === '/health' || url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok ' + rooms.size + ' rooms ' + clients.size + ' players');
  }
  if (url === '/' || url === '/index.html') {
    return fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }
  // the builds of the game that index.html chooses between
  const bd = /^\/builds\/(\d{14}\.html|index\.json)$/.exec(url);
  if (bd) {
    return fs.readFile(path.join(__dirname, 'builds', bd[1]), (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': bd[1].endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }
  // the download packs (music for the Full download)
  const pk = /^\/packs\/([a-z0-9_-]+\.(wav|json))$/.exec(url);
  if (pk) {
    return fs.readFile(path.join(__dirname, 'packs', pk[1]), (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': pk[2] === 'wav' ? 'audio/wav' : 'application/json', 'Content-Length': buf.length, 'Cache-Control': pk[2] === 'wav' ? 'public, max-age=86400' : 'no-cache' });
      res.end(buf);
    });
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

/* ---------- minimal WebSocket (RFC 6455, text frames) ---------- */
const clients = new Set();
let nextId = 1;

function frame(str) {
  const p = Buffer.from(str);
  let h;
  if (p.length < 126) h = Buffer.from([0x81, p.length]);
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(p.length, 6); }
  return Buffer.concat([h, p]);
}
function send(c, obj) {
  if (!c || c.closed) return;
  try { c.sock.write(frame(typeof obj === 'string' ? obj : JSON.stringify(obj))); } catch (e) { drop(c); }
}

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { id: nextId++, sock, buf: Buffer.alloc(0), parts: [], room: null, slot: -1, alive: Date.now(), closed: false };
  clients.add(c);
  sock.on('data', d => { c.alive = Date.now(); c.buf = Buffer.concat([c.buf, d]); parse(c); });
  sock.on('close', () => drop(c));
  sock.on('error', () => drop(c));
});

function parse(c) {
  while (c.buf.length >= 2) {
    const b0 = c.buf[0], b1 = c.buf[1], op = b0 & 15, fin = b0 & 128, masked = b1 & 128;
    let len = b1 & 127, off = 2;
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (c.buf.length < 10) return; len = c.buf.readUInt32BE(6); off = 10; }
    if (len > 262144) { drop(c); return; }
    const need = off + (masked ? 4 : 0) + len;
    if (c.buf.length < need) return;
    let data = c.buf.subarray(off + (masked ? 4 : 0), need);
    if (masked) {
      const m = c.buf.subarray(off, off + 4);
      data = Buffer.from(data);
      for (let i = 0; i < data.length; i++) data[i] ^= m[i & 3];
    }
    c.buf = c.buf.subarray(need);
    if (op === 8) { drop(c); return; }
    if (op === 9) { try { c.sock.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); } catch (e) {} continue; }
    if (op === 10) continue;
    c.parts.push(data);
    if (fin) {
      const text = Buffer.concat(c.parts).toString('utf8'); c.parts = [];
      let msg; try { msg = JSON.parse(text); } catch (e) { continue; }
      if (msg && typeof msg === 'object') { try { onMsg(c, msg); } catch (e) { console.error('onMsg', e); } }
    }
  }
}

function drop(c) {
  if (c.closed) return;
  c.closed = true; clients.delete(c);
  try { c.sock.destroy(); } catch (e) {}
  leave(c);
  socialDrop(c);
}

// keep connections honest: ping every 25s, drop anything silent for 70s
setInterval(() => {
  const now = Date.now();
  for (const c of clients) {
    if (now - c.alive > 70000) { drop(c); continue; }
    try { c.sock.write(Buffer.from([0x89, 0])); } catch (e) { drop(c); }
  }
}, 25000);

/* ---------- friends and chat ---------- */
// Players are known by name. Nothing is stored on disk: who is online and any
// waiting messages live in memory and are lost when the server restarts.
const byName = new Map();        // NAME -> Set of connections
const waiting = new Map();       // NAME -> messages sent while they were offline
const cleanName = n => String(n || '').toUpperCase().replace(/[^A-Z0-9 _-]/g, '').trim().slice(0, 14);
const isOn = n => { const s = byName.get(n); return !!(s && s.size); };
function hello(c, msg) {
  unname(c);
  const n = cleanName(msg.name); if (!n) return;
  c.name = n; c.uid = String(msg.uid || '').slice(0, 16);
  if (!byName.has(n)) byName.set(n, new Set());
  byName.get(n).add(c);
  send(c, { t: 'hi', name: n });
  const q = waiting.get(n);
  if (q) { waiting.delete(n); for (const m of q) send(c, m); }
}
function socialDrop(c) {
  partyLeave(c);
  unname(c);
}
function unname(c) {
  if (!c.name) return;
  const s = byName.get(c.name);
  if (s) { s.delete(c); if (!s.size) byName.delete(c.name); }
  c.name = null;
}
function who(c, msg) {
  const on = {};
  for (const x of (Array.isArray(msg.names) ? msg.names : []).slice(0, 60)) { const n = cleanName(x); if (n) on[n] = isOn(n); }
  send(c, { t: 'who', on });
}
function dm(c, msg) {
  if (!c.name) return;
  const to = cleanName(msg.to), text = String(msg.text || '').slice(0, 200);
  if (!to || !text.trim() || to === c.name) return;
  const now = Date.now();
  c.dms = (c.dms || []).filter(x => now - x < 10000); if (c.dms.length >= 8) return;   // at most 8 messages per 10s
  c.dms.push(now);
  const out = { t: 'dm', from: c.name, text };
  const s = byName.get(to);
  if (s && s.size) { for (const x of s) send(x, out); return; }
  if (waiting.size > 2000 && !waiting.has(to)) return;
  const q = waiting.get(to) || []; q.push(out); if (q.length > 30) q.shift(); waiting.set(to, q);
}

// a friend request: delivered now if they are online, otherwise held like a message
function freq(c, msg) {
  if (!c.name) return;
  const to = cleanName(msg.to); if (!to || to === c.name) return;
  const now = Date.now(); c.frs = (c.frs || []).filter(x => now - x < 60000); if (c.frs.length >= 10) return; c.frs.push(now);
  const out = { t: 'freq', from: c.name }, s = byName.get(to);
  if (s && s.size) { for (const x of s) send(x, out); return; }
  if (waiting.size > 2000 && !waiting.has(to)) return;
  const q = waiting.get(to) || []; if (!q.some(m => m.t === 'freq' && m.from === c.name)) q.push(out); if (q.length > 30) q.shift(); waiting.set(to, q);
}

/* ---------- parties: up to three friends who queue together ---------- */
const parties = new Map(); let nextParty = 1;
const LOOK = ['ch', 'sk', 'camo', 'g1', 'g2', 'ic', 'bd', 'bn', 'st', 'md', 'pb'];
function pState(p) {
  const out = { t: 'party', pid: p.id, leader: p.leader.name, members: p.members.map(m => ({ name: m.name, look: m.look || {} })) };
  for (const m of p.members) send(m, out);
}
function partyLeave(c) {
  const p = c.party; if (!p) return;
  c.party = null; p.members = p.members.filter(m => m !== c);
  if (!c.closed) send(c, { t: 'party', pid: 0 });
  if (p.members.length <= 1) { for (const m of p.members) { m.party = null; send(m, { t: 'party', pid: 0 }); } parties.delete(p.id); return; }
  if (p.leader === c) p.leader = p.members[0];
  pState(p);
}
function party(c, t, msg) {
  if (!c.name) return send(c, { t: 'pnote', text: 'Not connected yet. Try again in a moment.' });
  const p = c.party;
  if (t === 'plook') {
    const l = {}; if (msg.look && typeof msg.look === 'object') for (const k of LOOK) { const v = String(msg.look[k] || ''); if (/^[a-z0-9_]{0,24}$/.test(v)) l[k] = v; }
    c.look = l; if (p) pState(p); return;
  }
  if (t === 'pinv') {
    const now = Date.now(); c.pinvs = (c.pinvs || []).filter(x => now - x < 10000); if (c.pinvs.length >= 6) return; c.pinvs.push(now);
    const to = cleanName(msg.to), s = byName.get(to);
    if (!to || to === c.name) return;
    if (!s || !s.size) return send(c, { t: 'pnote', text: to + ' is not online.' });
    if (p && p.leader !== c) return send(c, { t: 'pnote', text: 'Only the party leader can invite.' });
    if (p && p.members.length >= 3) return send(c, { t: 'pnote', text: 'Your party is full.' });
    let q = p;
    if (!q) { q = { id: nextParty++, leader: c, members: [c], inv: new Set() }; parties.set(q.id, q); c.party = q; }
    if (q.members.some(m => m.name === to)) return send(c, { t: 'pnote', text: to + ' is already in your party.' });
    q.inv.add(to);
    for (const x of s) send(x, { t: 'pinv', from: c.name, pid: q.id });
    return send(c, { t: 'pnote', text: 'Invite sent to ' + to + '.' });
  }
  if (t === 'pacc') {
    const q = parties.get(msg.pid);
    if (!q || !q.inv.has(c.name)) return send(c, { t: 'pnote', text: 'That invite has expired.' });
    if (q === p) return;
    if (q.members.length >= 3) return send(c, { t: 'pnote', text: 'That party is full.' });
    partyLeave(c); q.inv.delete(c.name); q.members.push(c); c.party = q; return pState(q);
  }
  if (t === 'pdec') { const q = parties.get(msg.pid); if (q && q.inv.delete(c.name)) send(q.leader, { t: 'pnote', text: c.name + ' declined your invite.' }); return; }
  if (t === 'pleave') return partyLeave(c);
  if (!p) return;
  // the leader starts matchmaking for everyone; anyone can call it off
  if (t === 'pgo' && p.leader === c) { const mode = MODES.includes(msg.mode) ? msg.mode : 'team', nb = Math.max(0, Math.min(2, msg.nb | 0)); for (const m of p.members) send(m, { t: 'pgo', mode, pid: p.id, n: Math.min(3, p.members.length + nb) }); return; }
  if (t === 'pcan') { for (const m of p.members) send(m, { t: 'pcan', by: c.name }); }
}

/* ---------- rooms ---------- */
const rooms = new Map();
let nextRoom = 1;

function others(r, c, obj) { const s = JSON.stringify(obj); for (const m of r.members) if (m !== c) send(m, s); }
function all(r, obj) { const s = JSON.stringify(obj); for (const m of r.members) send(m, s); }
function lobby(r) { all(r, { t: 'lobby', n: r.members.length, ms: Math.max(0, r.startAt - Date.now()) }); }

function join(c, msg) {
  if (c.room) return;
  const mode = MODES.includes(msg.mode) ? msg.mode : 'team';
  c.ch = okId(msg.ch) ? msg.ch : 'eli';
  c.gun = typeof msg.gun === 'string' ? msg.gun.slice(0, 16) : 'pistol';
  // cosmetics other players should see: the gun camo and the skin worn per character
  c.camo = okId(msg.camo) || /^[a-z0-9_]{2,24}$/.test(msg.camo || '') ? String(msg.camo) : '';
  c.skins = {};
  if (msg.skins && typeof msg.skins === 'object') for (const k of Object.keys(msg.skins).slice(0, 30)) if (okId(k) && /^[a-z0-9_]{2,24}$/.test(String(msg.skins[k]))) c.skins[k] = String(msg.skins[k]);
  c.pid = Number.isInteger(msg.pid) && msg.pid > 0 ? msg.pid : 0;
  // bots the player invited to their party come with them
  c.pb = Array.isArray(msg.pb) ? [...new Set(msg.pb.filter(v => Number.isInteger(v) && v >= 0 && v < BOTN))].slice(0, 2) : [];
  c.pn = c.pid ? Math.min(3, Math.max(1, msg.pn | 0)) : 1 + c.pb.length;
  c.nm = cleanName(msg.name) || 'PLAYER';
  const cid = v => (/^[a-z0-9_]{2,24}$/.test(String(v || '')) ? String(v) : '');
  c.ic = cid(msg.ic); c.bd = cid(msg.bd); c.bn = cid(msg.bn);
  let r = null;
  if (c.pid) for (const x of rooms.values()) if (x.mode === mode && x.state === 'wait' && x.members.some(m => m.pid === c.pid)) { r = x; break; }
  if (!r) for (const x of rooms.values()) if (x.mode === mode && x.state === 'wait' && pack(groupsOf(x, c), x.mode.includes('ffa'))) { r = x; break; }
  if (!r) {
    r = { id: nextRoom++, mode, state: 'wait', members: [], host: null, startAt: Date.now() + WAIT_MS, timer: null };
    r.timer = setTimeout(() => startRoom(r), WAIT_MS);
    rooms.set(r.id, r);
  }
  c.room = r; r.members.push(c);
  if (used(r) >= CAP && !groupsOf(r).some(g => g.members.length + g.pb.length < g.size)) { clearTimeout(r.timer); startRoom(r); } else lobby(r);
}

// a party counts as its full size from the moment its first member arrives
function groupsOf(r, extra) {
  const g = new Map(), list = extra ? [...r.members, extra] : r.members;
  for (const m of list) { const k = m.pid ? 'p' + m.pid : 'c' + m.id; if (!g.has(k)) g.set(k, { size: m.pn || 1, members: [], pb: [] }); const q = g.get(k); q.members.push(m); q.pb.push(...(m.pb || [])); q.size = Math.max(q.size, m.pn || 1); }
  return [...g.values()];
}
const used = r => groupsOf(r).reduce((a, g) => a + g.size, 0);
// slots 0-11; in team modes slots 3t..3t+2 are team t, and each party must fit inside one team
function pack(groups, ffa) {
  if (groups.reduce((a, g) => a + g.size, 0) > CAP) return null;
  const at = new Map();
  if (ffa) { let s = 0; for (const g of groups) { at.set(g, s); s += g.size; } return at; }
  const free = [3, 3, 3, 3];
  for (const g of [...groups].sort((a, b) => b.size - a.size)) { const t = free.findIndex(n => n >= g.size); if (t < 0) return null; at.set(g, t * 3 + 3 - free[t]); free[t] -= g.size; }
  return at;
}
function startRoom(r) {
  if (r.state !== 'wait') return;
  if (!r.members.length) { rooms.delete(r.id); return; }
  // give a party that is still arriving a few more seconds, once
  if (!r.ext && groupsOf(r).some(g => g.members.length + g.pb.length < g.size)) { r.ext = 1; r.timer = setTimeout(() => startRoom(r), 4000); return; }
  r.state = 'play';
  const ffa = r.mode.includes('ffa');
  const groups = groupsOf(r), at = pack(groups, ffa) || new Map();
  const taken = new Set(), pbs = new Map();
  for (const g of groups) {
    let s = at.has(g) ? at.get(g) : -1;
    const place = () => { if (s < 0 || taken.has(s)) { s = 0; while (taken.has(s)) s++; } const v = s; taken.add(s); s++; return v; };
    for (const m of g.members) m.slot = place();
    for (const b of g.pb) if (taken.size < CAP) pbs.set(place(), b);
  }
  // every other spot is a bot player, picked at random and never twice in one match
  const usedB = new Set(pbs.values()), pickB = () => { let b; do b = Math.floor(Math.random() * BOTN); while (usedB.has(b)); usedB.add(b); return b; };
  const f = [];
  for (let s = 0; s < CAP; s++) {
    const m = r.members.find(x => x.slot === s);
    f.push(m ? { s, h: 1, ch: m.ch, gun: m.gun, camo: m.camo || '', skins: m.skins || {}, name: m.nm, ic: m.ic, bd: m.bd, bn: m.bn }
      : { s, h: 0, b: pbs.has(s) ? pbs.get(s) : pickB(), ch: CHARS[Math.floor(Math.random() * CHARS.length)], gun: GUNS[s % GUNS.length] });
  }
  r.host = r.members.reduce((a, b) => (b.slot < a.slot ? b : a));
  for (const m of r.members) send(m, { t: 'start', you: m.slot, host: r.host.slot, mode: r.mode, ffa, f });
  console.log('room', r.id, r.mode, 'started with', r.members.length, 'players');
}

function leave(c) {
  const r = c.room; if (!r) return;
  c.room = null;
  r.members = r.members.filter(m => m !== c);
  if (!r.members.length) { clearTimeout(r.timer); rooms.delete(r.id); return; }
  if (r.state === 'wait') { lobby(r); return; }
  all(r, { t: 'left', s: c.slot });
  if (r.host === c) { r.host = r.members[0]; all(r, { t: 'host', s: r.host.slot }); }
}

const bySlot = (r, s) => r.members.find(m => m.slot === s);

function onMsg(c, msg) {
  const t = msg.t;
  if (t === 'join') return join(c, msg);
  if (t === 'ping') return send(c, { t: 'pong' });
  if (t === 'hello') return hello(c, msg);
  if (t === 'who') return who(c, msg);
  if (t === 'dm') return dm(c, msg);
  if (t === 'freq') return freq(c, msg);
  if (/^p(look|inv|acc|dec|leave|go|can)$/.test(t)) return party(c, t, msg);
  const r = c.room; if (!r || r.state !== 'play') return;
  if (t === 'pick') {            // character select: a player picks for themselves, the host picks for bots
    if (!okId(msg.ch)) return;
    const bot = Number.isInteger(msg.s) && msg.s >= 0 && msg.s < CAP && !bySlot(r, msg.s);
    return others(r, c, { t: 'pick', s: r.host === c && bot ? msg.s : c.slot, ch: msg.ch });
  }
  if (t === 'st') { msg.s = c.slot; return others(r, c, msg); }
  if (t === 'bots') { if (r.host === c) others(r, c, msg); return; }
  if (t === 'hit' || t === 'rev' || t === 'frz') { const to = bySlot(r, msg.to); if (to && to !== c) { msg.from = c.slot; send(to, msg); } return; }
  if (t === 'bhit' || t === 'brev' || t === 'bfz') { if (r.host && r.host !== c) { msg.from = c.slot; send(r.host, msg); } return; }
  if (t === 'out') { drop(c); }
}

server.listen(PORT, () => console.log('Penalty server listening on', PORT));
