// A grubu kabul testleri (2026-10-01-yeni-deploy). Bağımlılık eklemez: node:test + fetch.
// Çalıştırma (BOŞ bir Postgres gerekir; gizli değerler oturum env'i olarak verilir):
//   TEST_DATABASE_URL=postgresql://u:p@localhost:55432/db TEST_JWT_SECRET=<32+ krk> TEST_ADMIN_PASSWORD=<12+ krk> \
//   node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const DB = process.env.TEST_DATABASE_URL;
const JWT = process.env.TEST_JWT_SECRET;
const PASS = process.env.TEST_ADMIN_PASSWORD;
const ORIGIN = 'https://dijipolitr-stack.github.io';
const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = 'admin@hasartrack.com';

if (!DB || !JWT || !PASS) throw new Error('TEST_DATABASE_URL, TEST_JWT_SECRET, TEST_ADMIN_PASSWORD gerekli');

const baseEnv = () => {
  const e = { ...process.env };
  for (const k of ['DATABASE_URL', 'DATABASE_SSL', 'JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'FRONTEND_URL', 'NODE_ENV', 'PORT']) delete e[k];
  return e;
};
const run = (script, extra = {}) =>
  spawnSync(process.execPath, [script], { cwd: ROOT, env: { ...baseEnv(), DATABASE_URL: DB, ...extra }, encoding: 'utf8' });

const sql = async (q, p) => {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try { return await c.query(q, p); } finally { await c.end(); }
};

let srv;
const startServer = async (extra = {}) => {
  srv = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...baseEnv(), DATABASE_URL: DB, JWT_SECRET: JWT, PORT: String(PORT), FRONTEND_URL: ORIGIN, ...extra },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('sunucu açılmadı');
};
const stopServer = () => new Promise((r) => { if (!srv) return r(); srv.once('exit', r); srv.kill(); srv = null; });
const login = (sifre, email = EMAIL) =>
  fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, sifre }) });

test.after(stopServer);

test('A2 migrate: boş DB, 17 tablo + migrations, 2. çalışma atlar, RLS açık', async () => {
  let r = run('src/db/migrate.js');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Şema uygulandı/);
  const t = await sql("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'");
  assert.equal(t.rows[0].n, 23); // schema.sql 17 + migrations (5 tablo) + schema_migrations
  r = run('src/db/migrate.js');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Şema var, atlandı/);
  const rls = await sql("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity");
  assert.equal(rls.rows[0].n, 0);
});

test('A3/A4 seed: ADMIN_PASSWORD env ile tek admin, 2. çalışma çift kayıt yapmaz', async () => {
  let r = run('src/db/seed.js', { ADMIN_PASSWORD: PASS });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Admin oluşturuldu/);
  assert.ok(!r.stdout.includes(PASS), 'şifre çıktıya yazılmamalı');
  r = run('src/db/seed.js', { ADMIN_PASSWORD: PASS });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /zaten var/);
  const n = await sql("SELECT count(*)::int n FROM kullanicilar WHERE rol='admin'");
  assert.equal(n.rows[0].n, 1);
});

test('A4 seed hata yolları: kısa şifre reddedilir, şifresiz reddedilir (production ve dev)', async () => {
  const email = 'tmp-seed@example.com';
  let r = run('src/db/seed.js', { ADMIN_EMAIL: email, ADMIN_PASSWORD: 'kisa' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /12 karakter/);
  r = run('src/db/seed.js', { ADMIN_EMAIL: email, NODE_ENV: 'production' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ADMIN_PASSWORD/);
  r = run('src/db/seed.js', { ADMIN_EMAIL: email });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ADMIN_PASSWORD/);
  await sql('DELETE FROM kullanicilar WHERE email=$1', [email]);
});

test('A4 repoda düz şifre/hash yok (frontend, schema, backend kaynak)', () => {
  const dosyalar = [];
  const gez = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', 'test'].includes(f.name) || f.name === 'package-lock.json') continue;
      const p = path.join(d, f.name);
      if (f.isDirectory()) gez(p);
      else if (/\.(js|sql|html|json|yml|example|md)$/.test(f.name) || f.name.startsWith('.env')) dosyalar.push(p);
    }
  };
  gez(ROOT); gez(path.join(ROOT, '..', 'frontend'));
  for (const p of dosyalar) {
    const s = fs.readFileSync(p, 'utf8');
    assert.ok(!/\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}/.test(s), `bcrypt hash: ${p}`);
    if (!p.endsWith('docker-compose.yml')) assert.ok(!/admin123/.test(s), `admin123: ${p}`);
  }
});

test('A7 /health 200; A5 login 200 + token, yanlış şifre 401, eksik alan 400', async () => {
  await startServer();
  let r = await fetch(`${BASE}/health`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'ok');
  r = await login(PASS);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.token && j.kullanici.rol === 'admin');
  assert.equal((await login('yanlis-sifre-123')).status, 401);
  assert.equal((await login(PASS, 'yok@example.com')).status, 401);
  r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 400);
});

test('A5/A6 /me, dosya oluştur + listele, yetkisiz istekler reddedilir', async () => {
  const { token } = await (await login(PASS)).json();
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let r = await fetch(`${BASE}/api/auth/me`, { headers: H });
  assert.equal(r.status, 200);
  // yetkisiz
  assert.equal((await fetch(`${BASE}/api/auth/me`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/dosyalar`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/dosyalar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(`${BASE}/api/dosyalar`, { headers: { Authorization: 'Bearer sahte.token.x' } })).status, 401);
  // başka sırla imzalanmış token
  const jwt = require('jsonwebtoken');
  const sahte = jwt.sign({ id: '00000000-0000-0000-0000-000000000000', rol: 'admin' }, 'baska-bir-gizli-deger-en-az-32-karakter-xx');
  assert.equal((await fetch(`${BASE}/api/dosyalar`, { headers: { Authorization: `Bearer ${sahte}` } })).status, 401);
  // zorunlu alan eksik
  r = await fetch(`${BASE}/api/dosyalar`, { method: 'POST', headers: H, body: JSON.stringify({ arac: { plaka: '34 TEST 01' } }) });
  assert.equal(r.status, 400);
  // oluştur
  const plaka = '34 TST ' + (Date.now() % 1000);
  r = await fetch(`${BASE}/api/dosyalar`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      arac: { plaka, marka: 'Test', model: 'M', yil: 2020 },
      sahip: { adSoyad: 'Test Kişi', tcVergi: '11111111111', telefon: '5550000000' },
      sigorta: { sirketAd: 'Test Sigorta', bransi: 'kasko' },
      kaza: { tarih: '2026-09-30', aciklama: 'test' },
    }),
  });
  const body = await r.text();
  assert.ok(r.status === 200 || r.status === 201, `${r.status} ${body}`);
  // listede
  r = await fetch(`${BASE}/api/dosyalar`, { headers: H });
  assert.equal(r.status, 200);
  const liste = await r.text();
  assert.ok(liste.includes(plaka), 'liste yeni dosyayı içermeli: ' + liste.slice(0, 300));
  const db = await sql('SELECT count(*)::int n FROM dosyalar');
  assert.equal(db.rows[0].n, 1);
});

test('A10 CORS: izinli origin preflight geçer, izinsiz origin başlık almaz', async () => {
  const pre = (origin) => fetch(`${BASE}/api/auth/login`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' },
  });
  let r = await pre(ORIGIN);
  assert.ok(r.status === 204 || r.status === 200);
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  r = await pre('https://evil.example.com');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  r = await pre('https://dijipolitr-stack.github.io.evil.com');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  r = await fetch(`${BASE}/health`, { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  await stopServer();
  // FRONTEND_URL sonunda "/" olsa da eşleşir
  await startServer({ FRONTEND_URL: ORIGIN + '/' });
  r = await pre(ORIGIN);
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  await stopServer();
});

test('A9 SSL: DATABASE_SSL yokken production dahil bağlanır; DATABASE_SSL=true SSL desteklemeyen DB ile hata verir', async () => {
  await startServer({ NODE_ENV: 'production' });
  assert.equal((await login(PASS)).status, 200);
  await stopServer();
  await startServer({ DATABASE_SSL: 'true' });
  const r = await login(PASS);
  assert.equal(r.status, 500, 'env gerçekten okunuyor olmalı');
  await stopServer();
});

test('Production 500 yanıtı sabit "Sunucu hatası" döner, iç mesaj sızmaz; dev ortamda ayrıntı kalır', async () => {
  await startServer({ NODE_ENV: 'production', DATABASE_SSL: 'true' });
  let r = await login(PASS);
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: 'Sunucu hatası' });
  await stopServer();
  await startServer({ DATABASE_SSL: 'true' });
  r = await login(PASS);
  assert.equal(r.status, 500);
  assert.notEqual((await r.json()).error, 'Sunucu hatası');
  await stopServer();
});

test('Repo hijyeni: .gitignore ve .vercelignore sırları ve test/schema dosyalarını dışarıda tutar', () => {
  const satirlar = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/);
  const gi = satirlar('.gitignore');
  for (const k of ['.env', 'node_modules/', '.vercel/']) assert.ok(gi.includes(k), `.gitignore: ${k}`);
  const vi = satirlar('.vercelignore');
  for (const k of ['schema.sql', 'test/', '.env']) assert.ok(vi.includes(k), `.vercelignore: ${k}`);
  assert.ok(!vi.some((l) => /^(api|src)\/?$/.test(l)), 'api/ ve src/ ignore edilmemeli');
});

test('A8 JWT_SECRET yok veya kısa: sunucu çıkış kodu 1, net mesaj', () => {
  for (const extra of [{}, { JWT_SECRET: 'kisa' }]) {
    const r = spawnSync(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...baseEnv(), DATABASE_URL: DB, ...extra }, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /JWT_SECRET/);
  }
});

test('Vercel handler: api/index.js import edilir, HTTP olarak servis eder; JWT yoksa import throw eder', () => {
  const kod = `
    process.env.DATABASE_URL=${JSON.stringify(DB)}; process.env.JWT_SECRET=${JSON.stringify(JWT)};
    const h = require('./api/index.js'); const http = require('http');
    if (typeof h !== 'function') { console.log('NOT_FUNCTION'); process.exit(2); }
    const s = http.createServer(h).listen(0, async () => {
      const b = 'http://127.0.0.1:' + s.address().port;
      const a = await fetch(b + '/health'); const c = await fetch(b + '/api/auth/me');
      console.log(a.status, c.status); s.close(); require('./src/db').pool.end();
    });`;
  const r = spawnSync(process.execPath, ['-e', kod], { cwd: ROOT, env: baseEnv(), encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /200 401/);
  const r2 = spawnSync(process.execPath, ['-e', "require('./api/index.js')"], { cwd: ROOT, env: baseEnv(), encoding: 'utf8' });
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /JWT_SECRET/);
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.deepEqual(v.rewrites, [{ source: '/(.*)', destination: '/api' }]);
});

test('A1 (revize) compose geçerli, build/Dockerfile/railway bağımlılığı yok', () => {
  const y = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
  assert.ok(!/^\s*build:/m.test(y), 'build: kalmamalı');
  assert.ok(!fs.existsSync(path.join(ROOT, 'Dockerfile')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'railway.json')));
  const r = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', 'config', '-q'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.error) return; // docker yoksa yalnız statik kontrol
  assert.equal(r.status, 0, r.stderr);
});

test('A11/A12 ön yüz statik: API adresi tek noktada, demo düşme yok, gömülü admin girişi yok', () => {
  const h = fs.readFileSync(path.join(ROOT, '..', 'frontend', 'index.html'), 'utf8');
  assert.equal((h.match(/const API_URL_CANLI/g) || []).length, 1);
  assert.equal((h.match(/https?:\/\/[^"' ]*\/api/g) || []).filter((u) => !u.includes('localhost')).length, 0, 'sabit uzak API adresi yok');
  assert.ok(!/railway\.app/i.test(h));
  const i = h.indexOf('function AdminGiris');
  const blok = h.slice(i, h.indexOf('function ServisGiris'));
  assert.ok(/apiCall\("\/auth\/login","POST",\{email,sifre\}\)/.test(blok));
  assert.ok(/setHata\(e\.message/.test(blok), 'hata kullanıcıya gösterilir');
  const catchBlok = blok.slice(blok.indexOf('catch'), blok.indexOf('finally'));
  assert.ok(!/onGiris/.test(catchBlok), 'catch içinde onGiris (demo düşme) yok');
  assert.ok(!/admin123|useState\("admin@/.test(blok));
  assert.ok(/ht_token/.test(blok));
});

test('Tur2 admin listesi filtreleri: arama, durum ve sayfalama 200 döner', async () => {
  await startServer();
  const { token } = await (await login(PASS)).json();
  const H = { Authorization: `Bearer ${token}` };
  for (const q of ['', '?arama=TST', '?durum=aktif', '?arama=yok-boyle-bir-sey&sayfa=1&limit=5']) {
    const r = await fetch(`${BASE}/api/dosyalar${q}`, { headers: H });
    const txt = await r.text();
    assert.equal(r.status, 200, `${q} -> ${r.status} ${txt}`);
    assert.equal(typeof JSON.parse(txt).toplam, 'number');
  }
  const j = await (await fetch(`${BASE}/api/dosyalar?arama=TST`, { headers: H })).json();
  assert.equal(j.toplam, 1);
  assert.equal((await (await fetch(`${BASE}/api/dosyalar?arama=yok-boyle-bir-sey`, { headers: H })).json()).toplam, 0);
  await stopServer();
});
