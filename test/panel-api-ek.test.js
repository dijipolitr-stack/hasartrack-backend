// Panel API ek testleri (2026-10-01-panel-api-baglama): K6 liste/sayaç, K3/K16/K17/K18 ön yüz statik.
// panel-api.test.js ile aynı ortam değişkenleri; --test-concurrency=1 ile çalıştırın.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DB = process.env.TEST_DATABASE_URL;
const JWT = process.env.TEST_JWT_SECRET;
const PASS = process.env.TEST_ADMIN_PASSWORD;
const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}`;
if (!DB || !JWT || !PASS) throw new Error('TEST_DATABASE_URL, TEST_JWT_SECRET, TEST_ADMIN_PASSWORD gerekli');
const HTML = fs.readFileSync(path.join(ROOT, '..', 'frontend', 'index.html'), 'utf8');
const blok = (bas, son) => { const i = HTML.indexOf(bas); const j = HTML.indexOf(son, i + 1); assert.ok(i >= 0 && j > i, `${bas} bulunamadı`); return HTML.slice(i, j); };

const env = () => { const e = { ...process.env }; for (const k of ['DATABASE_SSL', 'NODE_ENV']) delete e[k]; return e; };
let srv;
test.after(() => srv && srv.kill());
const api = async (method, url, token, body) => {
  const res = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};

test('K6 admin liste: arama (dosya no, plaka, sahip), durum filtresi ve sayaçlar ozet ile eşit', async () => {
  const e = { ...env(), DATABASE_URL: DB, ADMIN_PASSWORD: PASS };
  for (const s of ['src/db/migrate.js', 'src/db/seed.js']) assert.equal(spawnSync(process.execPath, [s], { cwd: ROOT, env: e, encoding: 'utf8' }).status, 0);
  srv = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...env(), DATABASE_URL: DB, JWT_SECRET: JWT, PORT: String(PORT), FRONTEND_URL: 'http://localhost:3001' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  const tok = (await api('POST', '/api/auth/login', null, { email: 'admin@hasartrack.com', sifre: PASS })).body.token;
  const tag = 'ZQK' + Date.now().toString(36).toUpperCase();
  const mk = (plaka, ad) => api('POST', '/api/dosyalar', tok, { arac: { plaka, marka: 'T', model: 'M', yil: 2021 }, sahip: { adSoyad: ad, telefon: '05321112233' }, sigorta: { sirketAd: 'S', hasarNo: 'H' + plaka }, kaza: { tarih: '2026-03-01' } });
  const a = await mk(tag + '1', 'Aramasahip Bir'); const b = await mk(tag + '2', 'Baska Kisi');
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  const ara = async (q) => (await api('GET', '/api/dosyalar?' + q, tok)).body;
  assert.equal((await ara('arama=' + tag)).toplam, 2, 'plaka ile');
  assert.equal((await ara('arama=Aramasahip')).toplam, 1, 'sahip ile');
  const no = (await ara('arama=Aramasahip')).dosyalar[0].dosya_no;
  assert.equal((await ara('arama=' + encodeURIComponent(no))).toplam, 1, 'dosya no ile');
  assert.equal((await ara('arama=' + tag + '&durum=Tamamlandı')).toplam, 0, 'durum filtresi sonucu değiştirir');
  assert.equal((await ara('arama=' + tag + '&durum=Aktif')).toplam, 2);
  const oz = (await api('GET', '/api/raporlar/ozet', tok)).body;
  assert.equal(Number(oz.toplam_dosya), (await ara('limit=1')).toplam, 'toplam = ozet');
  assert.equal(Number(oz.aktif_dosya), (await ara('durum=Aktif&limit=1')).toplam, 'aktif = ozet');
  const servissiz = (await ara('durum=Aktif&limit=200')).dosyalar.filter((d) => !d.atanan_servis).length;
  assert.equal(Number(oz.servissiz), servissiz, 'servissiz = ozet');
});

test('K3 ön yüz: ServisGiris gömülü şifre ve SERVISLER kullanmaz, token ht_token', () => {
  const b = blok('function ServisGiris', 'function ', );
  const g = HTML.slice(HTML.indexOf('function ServisGiris'), HTML.indexOf('function ServisGiris') + 4000);
  assert.ok(/apiCall\("\/auth\/servis-login","POST"/.test(g));
  assert.ok(/localStorage\.setItem\("ht_token"/.test(g));
  assert.ok(!/SERVISLER/.test(g) && !/sifre\s*[:=]\s*"[^"]+"/.test(g.replace(/useState\(""\)/g, '')), 'gömülü şifre yok');
  assert.ok(!/\bconst SERVISLER\b/.test(HTML), 'SERVISLER sabiti silindi');
  assert.ok(b.length > 0);
});

test('K16 ön yüz: Anthropic anahtarı ve api.anthropic.com çağrısı yok', () => {
  assert.ok(!/api\.anthropic\.com/i.test(HTML));
  assert.ok(!/ANTHROPIC_API_KEY/.test(HTML));
  assert.ok(!/sk-ant-/.test(HTML));
});

test('K18 ön yüz: apiCall hata/401 davranışı ve demo veriye düşmeme', () => {
  const a = blok('async function apiCall', '\n}\n');
  assert.ok(/Sunucuya ulaşılamadı/.test(a));
  assert.ok(/401/.test(a) && /removeItem\("ht_token"\)/.test(a) && /ht-oturum-bitti/.test(a));
  assert.ok(/addEventListener\("ht-oturum-bitti"/.test(HTML), 'App olayı dinler');
  for (const f of ['AdminDashboard', 'ServisPanel', 'AdminPanel']) {
    const i = HTML.indexOf(`function ${f}(`);
    const g = HTML.slice(i, HTML.indexOf('\nfunction ', i + 10));
    assert.ok(/apiCall\(/.test(g), `${f} API kullanır`);
    assert.ok(!/DEMO_DOSYALAR?\b/.test(g), `${f} demo veriye düşmez`);
  }
});

test('K17 regresyon: acente paneli demo veriyle kalır, müşteri demo girişi yok, MuhasebeGorunum api prop isteğe bağlı', () => {
  assert.ok(/function AcentePanel|function AcenteDetay|rol="acente"/.test(HTML));
  assert.ok(HTML.split('\n').some((l) => l.includes('<MuhasebeGorunum') && l.includes('DEMO_DOSYA.muhasebe') && l.includes('rol="acente"') && !l.includes('api=')), 'acente demo muhasebe');
  // Müşteri demo paneli ve sabit SMS kodu (1234) kaldırıldı; yerine takip linki sayfası (TakipSayfasi)
  assert.ok(!/function MusteriPanel\(/.test(HTML) && !/kod==="1234"/.test(HTML), 'müşteri demo girişi yok');
  for (const f of ['AcentePanel']) {
    const i = HTML.indexOf(`function ${f}(`);
    assert.ok(!/apiCall\(/.test(HTML.slice(i, HTML.indexOf('\nfunction ', i + 10))), `${f} API çağırmaz`);
  }
  const m = HTML.slice(HTML.indexOf('function MuhasebeGorunum'), HTML.indexOf('function MuhasebeGorunum') + 600);
  assert.ok(/api/.test(m));
});
