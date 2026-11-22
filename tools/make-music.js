// Builds the Full download's music as plain WAV files (no dependencies).
// Run: node tools/make-music.js   -> packs/menu.wav, packs/match.wav, packs/manifest.json
const fs = require('fs'), path = require('path');
const SR = 32000, OUT = path.join(__dirname, '..', 'packs');
const hz = n => 440 * Math.pow(2, (n - 69) / 12);
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function track(bpm, bars) {
  const beat = 60 / bpm, len = Math.round(bars * 4 * beat * SR), buf = new Float32Array(len);
  // every voice writes modulo the loop length, so tails wrap round and the loop is seamless
  const add = (t0, dur, fn) => { const s0 = Math.round(t0 * SR), n = Math.round(dur * SR); for (let i = 0; i < n; i++) buf[(s0 + i) % len] += fn(i / SR, i / n); };
  return { beat, len, buf, add };
}
const env = (t, a, d, total) => Math.min(1, t / a) * Math.min(1, Math.max(0, (total - t) / d));
const saw = p => 2 * (p - Math.floor(p + .5));
const pad = (T, t0, dur, note, vol) => { const f = hz(note); T.add(t0, dur, t => { let s = 0; for (const d of [-.006, 0, .007]) { const ff = f * (1 + d); s += Math.sin(2 * Math.PI * ff * t) + .35 * Math.sin(4 * Math.PI * ff * t) + .12 * Math.sin(6 * Math.PI * ff * t); } return s / 3 * vol * env(t, dur * .3, dur * .35, dur); }); };
const pluck = (T, t0, note, vol, dur = .9) => { const f = hz(note); T.add(t0, dur, t => (Math.sin(2 * Math.PI * f * t) + .4 * Math.sin(4 * Math.PI * f * t) * Math.exp(-t * 9) + .2 * Math.sin(6 * Math.PI * f * t) * Math.exp(-t * 14)) * vol * Math.exp(-t * 4.5) * Math.min(1, t / .004)); };
const bass = (T, t0, dur, note, vol) => { const f = hz(note); let lp = 0; T.add(t0, dur, t => { const x = saw(f * t) * .6 + Math.sin(2 * Math.PI * f * t); lp += (x - lp) * .12; return lp * vol * env(t, .008, .06, dur); }); };
const kick = (T, t0, vol) => T.add(t0, .32, t => Math.sin(2 * Math.PI * (48 * t + 22 * (1 - Math.exp(-t * 28)))) * Math.exp(-t * 11) * vol);
const hat = (T, t0, vol, dec = 60) => { let p = 0; T.add(t0, .09, t => { const n = rnd() * 2 - 1, h = n - p; p = n; return h * Math.exp(-t * dec) * vol; }); };
const snare = (T, t0, vol) => { let p = 0; T.add(t0, .2, t => { const n = rnd() * 2 - 1, h = n - p * .5; p = n; return (h * .7 + Math.sin(2 * Math.PI * 190 * t) * .5 * Math.exp(-t * 30)) * Math.exp(-t * 18) * vol; }); };

function finish(T, name) {
  const { buf, len } = T;
  // simple wrap-around echo for space
  const out = new Float32Array(len), d1 = Math.round(.31 * SR), d2 = Math.round(.47 * SR);
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < len; i++) out[i] = buf[i] + .28 * out[(i - d1 + len) % len] + .18 * out[(i - d2 + len) % len];
  let peak = 0; for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(out[i]));
  const g = .82 / peak, wav = Buffer.alloc(44 + len * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + len * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(len * 2, 40);
  for (let i = 0; i < len; i++) wav.writeInt16LE(Math.round(Math.tanh(out[i] * g * 1.1) / Math.tanh(1.1) * 32000 * .9), 44 + i * 2);
  fs.writeFileSync(path.join(OUT, name), wav); return wav.length;
}

// chords: A minor, F, D minor, E  (root, third, fifth as MIDI notes)
const CH = [[57, 60, 64], [53, 57, 60], [50, 53, 57], [52, 56, 59]];

// MENU — slow, dark and spacious. 72 bpm, 8 bars.
{ const T = track(72, 8), b = T.beat;
  for (let bar = 0; bar < 8; bar++) { const c = CH[bar % 4], t = bar * 4 * b;
    c.forEach(n => pad(T, t, 4 * b * 1.15, n, .16)); pad(T, t, 4 * b * 1.15, c[0] - 12, .2);
    bass(T, t, 3.6 * b, c[0] - 24, .26);
    const arp = [c[0] + 12, c[2] + 12, c[1] + 24, c[2] + 12, c[0] + 24, c[2] + 12, c[1] + 24, c[1] + 12];
    arp.forEach((n, i) => { if (bar < 4 && i % 2) return; pluck(T, t + i * b / 2, n, .17 + (i === 0 ? .06 : 0), 1.4); });
    if (bar >= 4) { kick(T, t, .5); kick(T, t + 2.5 * b, .32); hat(T, t + b, .05, 35); hat(T, t + 3 * b, .05, 35); } }
  var menuSize = finish(T, 'menu.wav'); }

// MATCH — driving and tense. 124 bpm, 16 bars.
{ const T = track(124, 16), b = T.beat;
  for (let bar = 0; bar < 16; bar++) { const c = CH[bar % 4], t = bar * 4 * b, hi = bar >= 8;
    for (let i = 0; i < 8; i++) bass(T, t + i * b / 2, b / 2 * .8, c[0] - 24 + (i === 6 ? 12 : i === 3 ? 7 : 0), .36);
    for (let i = 0; i < 4; i++) kick(T, t + i * b, .75);
    snare(T, t + b, .2); snare(T, t + 3 * b, .22); if (bar % 4 === 3) { snare(T, t + 3.5 * b, .22); snare(T, t + 3.75 * b, .26); }
    for (let i = 0; i < 8; i++) hat(T, t + i * b / 2, i % 2 ? .045 : .022);
    c.forEach(n => pad(T, t, 4 * b, n, .07));
    [0, 1.5, 3].forEach(o => c.forEach(n => pluck(T, t + o * b, n + 12, .1, .5)));
    if (hi) { const mel = [c[2] + 24, c[1] + 24, c[0] + 24, c[1] + 24, c[2] + 24, c[0] + 36, c[2] + 24, c[1] + 24]; mel.forEach((n, i) => pluck(T, t + i * b / 2, n, .13, .6)); } }
  var matchSize = finish(T, 'match.wav'); }

const manifest = { v: 1, full: [{ id: 'menu', file: 'menu.wav', size: menuSize }, { id: 'match', file: 'match.wav', size: matchSize }] };
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest));
console.log(manifest);
