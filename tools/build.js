// Adds a build of the game to builds/ and lists it in builds/index.json.
// Run: node tools/build.js <game.html> "what changed"
// Players do not get a build until the developer releases it from the in-game studio.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..'), dir = path.join(root, 'builds'), KEEP = 30;
const [src, note = 'Update'] = process.argv.slice(2);
if (!src) { console.error('usage: node tools/build.js <game.html> "what changed"'); process.exit(1); }
const z = n => String(n).padStart(2, '0'), d = new Date();
const id = d.getUTCFullYear() + z(d.getUTCMonth() + 1) + z(d.getUTCDate()) + z(d.getUTCHours()) + z(d.getUTCMinutes()) + z(d.getUTCSeconds());
let html = fs.readFileSync(src, 'utf8');
if (!/const BUILD='\d+'/.test(html)) { console.error('no BUILD stamp in ' + src); process.exit(1); }
html = html.replace(/const BUILD='\d+'/, "const BUILD='" + id + "'");
fs.writeFileSync(src, html);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, id + '.html'), html);
const man = fs.readFileSync(path.join(root, 'packs', 'manifest.json'));
const ids = re => { const out = []; let m; while ((m = re.exec(html))) out.push(m[1]); return [...new Set(out)]; };
const entry = {
  id, note, html: Buffer.byteLength(html),
  packs: crypto.createHash('sha1').update(man).digest('hex').slice(0, 12),
  packBytes: (JSON.parse(man).full || []).reduce((a, f) => a + f.size, 0),
  content: { ch: ids(/\{id:'([a-z0-9_]+)',n:'[^']+',g:'/g), wp: ids(/\{id:'([a-z0-9_]+)',n:'[^']+',t:'g'/g), map: ['mansion'] },
};
const file = path.join(dir, 'index.json');
const idx = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { builds: [] };
idx.builds.push(entry);
while (idx.builds.length > KEEP) { const old = idx.builds.shift(); try { fs.unlinkSync(path.join(dir, old.id + '.html')); } catch (e) {} }
fs.writeFileSync(file, JSON.stringify(idx, null, 1));
console.log('build', id, entry.html, 'bytes;', idx.builds.length, 'builds kept;', entry.content.ch.length, 'characters,', entry.content.wp.length, 'weapons');
