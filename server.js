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
  socialDrop(c);
  const n = cleanName(msg.name); if (!n) return;
  c.name = n; c.uid = String(msg.uid || '').slice(0, 16);
  if (!byName.has(n)) byName.set(n, new Set());
  byName.get(n).add(c);
  send(c, { t: 'hi', name: n });
  const q = waiting.get(n);
  if (q) { waiting.delete(n); for (const m of q) send(c, m); }
}
function socialDrop(c) {
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

/* ---------- rooms ---------- */
const rooms = new Map();
let nextRoom = 1;

function others(r, c, obj) { const s = JSON.stringify(obj); for (const m of r.members) if (m !== c) send(m, s); }
function all(r, obj) { const s = JSON.stringify(obj); for (const m of r.members) send(m, s); }
function lobby(r) { all(r, { t: 'lobby', n: r.members.length, ms: Math.max(0, r.startAt - Date.now()) }); }

function join(c, msg) {
  if (c.room) return;
  const mode = MODES.includes(msg.mode) ? msg.mode : 'team';
  c.ch = CHARS.includes(msg.ch) ? msg.ch : 'eli';
  c.gun = typeof msg.gun === 'string' ? msg.gun.slice(0, 16) : 'pistol';
  let r = null;
  for (const x of rooms.values()) if (x.mode === mode && x.state === 'wait' && x.members.length < CAP) { r = x; break; }
  if (!r) {
    r = { id: nextRoom++, mode, state: 'wait', members: [], host: null, startAt: Date.now() + WAIT_MS, timer: null };
    r.timer = setTimeout(() => startRoom(r), WAIT_MS);
    rooms.set(r.id, r);
  }
  c.room = r; r.members.push(c);
  if (r.members.length >= CAP) { clearTimeout(r.timer); startRoom(r); } else lobby(r);
}

function startRoom(r) {
  if (r.state !== 'wait') return;
  if (!r.members.length) { rooms.delete(r.id); return; }
  r.state = 'play';
  const ffa = r.mode.includes('ffa');
  const f = [];
  r.members.forEach((m, i) => { m.slot = i; f.push({ s: i, h: 1, ch: m.ch, gun: m.gun }); });
  for (let s = r.members.length; s < CAP; s++) {
    f.push({ s, h: 0, ch: CHARS[Math.floor(Math.random() * CHARS.length)], gun: GUNS[s % GUNS.length] });
  }
  r.host = r.members[0];
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
  const r = c.room; if (!r || r.state !== 'play') return;
  if (t === 'pick') {            // character select: a player picks for themselves, the host picks for bots
    if (!CHARS.includes(msg.ch)) return;
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
