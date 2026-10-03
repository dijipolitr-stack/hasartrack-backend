// Panel modülleri (/api/moduller) testleri. panel-api.test.js ile aynı ortam değişkenleri; --test-concurrency=1 ile çalıştırın.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const DB = process.env.TEST_DATABASE_URL;
const JWT = process.env.TEST_JWT_SECRET;
const PASS = process.env.TEST_ADMIN_PASSWORD;
const PORT = 3994;
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = crypto.randomBytes(4).toString('hex');
const SIFRE = crypto.randomBytes(8).toString('hex');
if (!DB || !JWT || !PASS) throw new Error('TEST_DATABASE_URL, TEST_JWT_SECRET, TEST_ADMIN_PASSWORD gerekli');

const baseEnv = () => {
  const e = { ...process.env };
  for (const k of ['DATABASE_URL', 'DATABASE_SSL', 'JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'FRONTEND_URL', 'NODE_ENV', 'PORT', 'RATE_LIMIT_MAX']) delete e[k];
  return e;
};
const sql = async (q, p) => { const c = new Client({ connectionString: DB }); await c.connect(); try { return await c.query(q, p); } finally { await c.end(); } };
let srv;
test.after(() => srv && srv.kill());
const api = async (method, url, token, body) => {
  const res = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};
const S = {};
const PLAKA_A = '34MDA' + RUN.slice(0, 3).toUpperCase();
const PLAKA_B = '34MDB' + RUN.slice(0, 3).toUpperCase();

test('hazırlık: iki servis, her birine bir dosya, tutanak, görev, link, eksik evrak', async () => {
  for (const [s, extra] of [['src/db/migrate.js', {}], ['src/db/seed.js', { ADMIN_PASSWORD: PASS }]]) {
    const r = spawnSync(process.execPath, [s], { cwd: ROOT, env: { ...baseEnv(), DATABASE_URL: DB, ...extra }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  srv = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...baseEnv(), DATABASE_URL: DB, JWT_SECRET: JWT, PORT: String(PORT), FRONTEND_URL: 'http://localhost:3001', RATE_LIMIT_MAX: '5000' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  S.admin = (await api('POST', '/api/auth/login', null, { email: 'admin@hasartrack.com', sifre: PASS })).body.token;
  for (const [k, plaka] of [['A', PLAKA_A], ['B', PLAKA_B]]) {
    const s = await api('POST', '/api/servisler', S.admin, { ad: `Modul Servis ${k} ${RUN}`, kullanici_email: `modul-${k}-${RUN}@example.com`, sifre: SIFRE });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    S[`tok${k}`] = (await api('POST', '/api/auth/servis-login', null, { servis_id: s.body.id, sifre: SIFRE })).body.token;
    const d = await api('POST', '/api/dosyalar', S.admin, { arac: { plaka, marka: 'Fiat', model: 'Egea', yil: 2022 }, sahip: { adSoyad: `Sahip ${k}`, telefon: '05321112233' }, sigorta: { sirketAd: `Sigorta ${k}`, hasarNo: `M-${k}-${RUN}` }, kaza: { tarih: '2026-03-01' } });
    assert.equal(d.status, 201);
    S[`dosya${k}`] = d.body.id;
    assert.equal((await api('POST', `/api/dosyalar/${d.body.id}/servis-ata`, S.admin, { servis_id: s.body.id })).status, 200);
  }
  assert.equal((await api('PUT', `/api/tutanaklar/${S.dosyaA}/kabul`, S.tokA, { km: 1200, musteri_ad: 'Sahip A', personel_ad: 'Usta' })).status, 200);
  const ie = (await api('GET', `/api/is-emirleri/${S.dosyaA}`, S.tokA)).body.is_emirleri[0];
  assert.equal((await api('POST', `/api/is-emirleri/${S.dosyaA}/${ie.id}/gorevler`, S.tokA, { bolum: 'boya', aciklama: 'Kapı boya', sorumlu_usta: 'Hasan' })).status, 201);
  assert.equal((await api('POST', `/api/takip/dosya/${S.dosyaA}`, S.tokA, {})).status, 201);
  await sql("UPDATE evrak SET durum='eksik' WHERE dosya_id=$1 AND sira=1", [S.dosyaA]);
});

const bul = (liste, id) => liste.find((x) => x.dosya_id === id);

test('yetki: oturumsuz 401, müşteri/acente 403, geçersiz bölüm 400', async () => {
  assert.equal((await api('GET', '/api/moduller/kabul-teslim')).status, 401);
  const r = await sql("INSERT INTO kullanicilar (ad_soyad,email,sifre_hash,rol) VALUES ('Acente','acente-" + RUN + "@example.com','x','acente') RETURNING id");
  const jwt = require('jsonwebtoken');
  const acente = jwt.sign({ id: r.rows[0].id, rol: 'acente' }, JWT);
  assert.equal((await api('GET', '/api/moduller/ekspertiz', acente)).status, 403);
  assert.equal((await api('GET', '/api/moduller/bolum/uydurma', S.admin)).status, 400);
});

test('kabul-teslim: admin ikisini, servis yalnız kendini görür; kabul bilgisi gelir', async () => {
  const a = (await api('GET', '/api/moduller/kabul-teslim', S.admin)).body.dosyalar;
  assert.ok(bul(a, S.dosyaA) && bul(a, S.dosyaB));
  assert.equal(bul(a, S.dosyaA).kabul_km, 1200);
  assert.equal(bul(a, S.dosyaB).kabul_km, null);
  assert.equal(bul(a, S.dosyaA).kalan_adim, 8);
  const sA = (await api('GET', '/api/moduller/kabul-teslim', S.tokA)).body.dosyalar;
  assert.ok(bul(sA, S.dosyaA)); assert.ok(!bul(sA, S.dosyaB), 'servis A, B dosyasını görmez');
});

test('ekspertiz: sigorta ve tutarlar; servis kapsamı', async () => {
  const ik = `/api/islemler/${S.dosyaA}`;
  assert.equal((await api('POST', ik, S.tokA, { kategori: 'Boya', aciklama: 'Kapı', miktar: 2, birim_fiyat: 1500 })).status, 201);
  const a = bul((await api('GET', '/api/moduller/ekspertiz', S.admin)).body.dosyalar, S.dosyaA);
  assert.equal(a.sirket_ad, 'Sigorta A');
  assert.equal(Number(a.teklif_tutar), 3000);
  assert.equal(Number(a.onaylanan_tutar), 0);
  assert.equal(a.eksper_onay, 'Beklemede');
  assert.equal(a.onay_bekleme_gun, null, 'bekleyen onay turu yokken null');
  assert.equal((await api('POST', `/api/islemler/${S.dosyaA}/onaya-gonder`, S.tokA, {})).status, 200);
  assert.equal(bul((await api('GET', '/api/moduller/ekspertiz', S.admin)).body.dosyalar, S.dosyaA).onay_bekleme_gun, 0, 'bugün gönderildi');
  assert.ok(!bul((await api('GET', '/api/moduller/ekspertiz', S.tokB)).body.dosyalar, S.dosyaA));
});

test('bölüm: boya görevi listede, kaporta boş; servis B görmez', async () => {
  const b = (await api('GET', '/api/moduller/bolum/boya', S.admin)).body;
  assert.equal(b.bolum.ad, 'Boya');
  const g = b.gorevler.find((x) => x.dosya_id === S.dosyaA);
  assert.ok(g); assert.equal(g.sorumlu_usta, 'Hasan'); assert.equal(g.adim_sayisi, 3); assert.equal(g.biten_adim, 0);
  assert.ok(!(await api('GET', '/api/moduller/bolum/kaporta', S.admin)).body.gorevler.some((x) => x.dosya_id === S.dosyaA));
  assert.ok(!(await api('GET', '/api/moduller/bolum/boya', S.tokB)).body.gorevler.some((x) => x.dosya_id === S.dosyaA));
});

test('medya: evrak sayıları ve eksik liste', async () => {
  const a = bul((await api('GET', '/api/moduller/medya', S.admin)).body.dosyalar, S.dosyaA);
  assert.equal(a.evrak_toplam, 9); assert.equal(a.evrak_eksik, 1); assert.equal(a.foto_sayisi, 0);
  assert.deepEqual(a.eksik_liste, ['Kaza Tespit Tutanağı']);
  assert.equal(a.bekleyen_liste.length, 8);
});

test('portal: link listesi token içermez; linksiz aktif dosya listelenir', async () => {
  const p = (await api('GET', '/api/moduller/portal', S.admin)).body;
  const l = p.linkler.find((x) => x.dosya_id === S.dosyaA);
  assert.ok(l && l.aktif === true);
  assert.ok(!/token/.test(JSON.stringify(p)));
  assert.ok(p.linksiz.some((x) => x.dosya_id === S.dosyaB));
  assert.ok(!p.linksiz.some((x) => x.dosya_id === S.dosyaA));
  const pB = (await api('GET', '/api/moduller/portal', S.tokB)).body;
  assert.ok(!pB.linkler.some((x) => x.dosya_id === S.dosyaA));
});
