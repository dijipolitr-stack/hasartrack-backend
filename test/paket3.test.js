// Paket 3: DVI (hasar haritası), sigorta protokolleri, ikame araç, sistem. --test-concurrency=1 ile çalıştırın.
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
const PORT = 3993;
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
const SIRKET = `Protokol Sigorta ${RUN}`;

test('hazırlık: iki servis, A servisine dosya', async () => {
  for (const [s, extra] of [['src/db/migrate.js', {}], ['src/db/seed.js', { ADMIN_PASSWORD: PASS }]]) {
    const r = spawnSync(process.execPath, [s], { cwd: ROOT, env: { ...baseEnv(), DATABASE_URL: DB, ...extra }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  srv = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...baseEnv(), DATABASE_URL: DB, JWT_SECRET: JWT, PORT: String(PORT), FRONTEND_URL: 'http://localhost:3001', RATE_LIMIT_MAX: '5000' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  S.admin = (await api('POST', '/api/auth/login', null, { email: 'admin@hasartrack.com', sifre: PASS })).body.token;
  for (const k of ['A', 'B']) {
    const s = await api('POST', '/api/servisler', S.admin, { ad: `P3 Servis ${k} ${RUN}`, kullanici_email: `p3-${k}-${RUN}@example.com`, sifre: SIFRE });
    S[`srv${k}`] = s.body.id;
    S[`tok${k}`] = (await api('POST', '/api/auth/servis-login', null, { servis_id: s.body.id, sifre: SIFRE })).body.token;
  }
  const d = await api('POST', '/api/dosyalar', S.admin, { arac: { plaka: '34PUC' + RUN.slice(0, 3).toUpperCase(), marka: 'VW', model: 'Golf', yil: 2021 }, sahip: { adSoyad: 'Sahip', telefon: '05321112233' }, sigorta: { sirketAd: SIRKET, hasarNo: 'P3-' + RUN, muafiyet: 2000 }, kaza: { tarih: '2026-03-01' } });
  assert.equal(d.status, 201);
  S.dosya = d.body.id;
  assert.equal((await api('POST', `/api/dosyalar/${S.dosya}/servis-ata`, S.admin, { servis_id: S.srvA })).status, 200);
});

test('DVI: ekle, doğrulama, güncelle, sil; yetki ve özet', async () => {
  const u = `/api/dvi/${S.dosya}`;
  assert.equal((await api('POST', u, S.tokA, { bolge: 'uydurma', hasar_tipi: 'gocuk', siddet: 'orta', karar: 'onarim' })).status, 400);
  assert.equal((await api('POST', u, S.tokA, { bolge: 'kaput' })).status, 400);
  assert.equal((await api('POST', u, S.tokB, { bolge: 'kaput', hasar_tipi: 'gocuk', siddet: 'orta', karar: 'onarim' })).status, 403);
  let r = await api('POST', u, S.tokA, { bolge: 'sol_on_kapi', hasar_tipi: 'gocuk', siddet: 'agir', karar: 'degisim', notlar: ' Kapı içe çökmüş ' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.notlar, 'Kapı içe çökmüş');
  const id = r.body.id;
  assert.equal((await api('POST', u, S.admin, { bolge: 'on_tampon', hasar_tipi: 'cizik', siddet: 'hafif', karar: 'boya' })).status, 201);
  r = await api('PATCH', `${u}/${id}`, S.tokA, { karar: 'onarim' });
  assert.equal(r.status, 200); assert.equal(r.body.karar, 'onarim'); assert.equal(r.body.siddet, 'agir');
  assert.equal((await api('PATCH', `${u}/${id}`, S.tokA, {})).status, 400);
  assert.equal((await api('GET', u, S.tokB)).status, 403);
  const l = (await api('GET', u, S.admin)).body.noktalar;
  assert.equal(l.length, 2);
  const oz = (await api('GET', '/api/dvi/ozet', S.admin)).body.dosyalar.find((x) => x.dosya_id === S.dosya);
  assert.equal(oz.nokta, 2); assert.equal(oz.agir, 1); assert.equal(oz.degisim, 0);
  assert.ok(!(await api('GET', '/api/dvi/ozet', S.tokB)).body.dosyalar.some((x) => x.dosya_id === S.dosya));
  assert.equal((await api('DELETE', `${u}/${id}`, S.tokA)).status, 200);
  assert.equal((await api('DELETE', `${u}/${id}`, S.tokA)).status, 404);
});

test('protokol: yalnız admin yazar; doğrulama; dosya kontrolü hesapları', async () => {
  assert.equal((await api('POST', '/api/protokoller', S.tokA, { sirket_ad: SIRKET, baslangic: '2026-01-01' })).status, 403);
  assert.equal((await api('POST', '/api/protokoller', S.admin, { sirket_ad: SIRKET, baslangic: '2026-05-01', bitis: '2026-01-01' })).status, 400);
  assert.equal((await api('POST', '/api/protokoller', S.admin, { sirket_ad: SIRKET, baslangic: '2026-01-01', parca_iskonto_yuzde: 120 })).status, 400);
  // Kontrol: protokol yokken null
  assert.equal((await api('GET', `/api/protokoller/dosya/${S.dosya}`, S.tokA)).body.protokol, null);
  const p = await api('POST', '/api/protokoller', S.admin, { sirket_ad: SIRKET.toUpperCase(), baslangic: '2026-01-01', iscilik_saat_ucreti: 400, parca_iskonto_yuzde: 10, malzeme_iskonto_yuzde: 5, muafiyet: 2000 });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const ik = `/api/islemler/${S.dosya}`;
  for (const k of [
    { kategori: 'İşçilik', aciklama: 'Söküm takım', birim: 'Saat', miktar: 3, birim_fiyat: 450 },
    { kategori: 'İşçilik', aciklama: 'Ayar', birim: 'Saat', miktar: 1, birim_fiyat: 350 },
    { kategori: 'Parça', aciklama: 'Kapı', miktar: 1, birim_fiyat: 10000 },
    { kategori: 'Malzeme', aciklama: 'Boya malzemesi', miktar: 1, birim_fiyat: 2000 },
    { kategori: 'Parça', aciklama: 'Müşteri isteği jant', miktar: 1, birim_fiyat: 5000, odeyen: 'musteri' },
  ]) assert.equal((await api('POST', ik, S.tokA, k)).status, 201);
  const k = (await api('GET', `/api/protokoller/dosya/${S.dosya}`, S.tokA)).body;
  assert.equal(k.protokol.id, p.body.id, 'şirket adı büyük/küçük harf duyarsız eşleşir');
  assert.equal(k.kontrol.teklif_sigorta, 1350 + 350 + 10000 + 2000, 'müşteri kalemi hariç');
  assert.equal(k.kontrol.parca_iskonto, 1000);
  assert.equal(k.kontrol.malzeme_iskonto, 100);
  assert.equal(k.kontrol.iscilik_fazla.length, 1);
  assert.equal(k.kontrol.iscilik_fark, 150);
  assert.equal(k.kontrol.beklenen, 13700 - 1000 - 100 - 150);
  assert.equal(k.kontrol.muafiyet_uyumlu, true);
  assert.equal((await api('GET', `/api/protokoller/dosya/${S.dosya}`, S.tokB)).status, 403);
  // Pasif protokol eşleşmez
  assert.equal((await api('PATCH', `/api/protokoller/${p.body.id}`, S.admin, { aktif: false })).status, 200);
  assert.equal((await api('GET', `/api/protokoller/dosya/${S.dosya}`, S.admin)).body.protokol, null);
  const liste = (await api('GET', '/api/protokoller', S.tokA)).body.protokoller.find((x) => x.id === p.body.id);
  assert.equal(liste.gecerli, false); assert.equal(liste.aktif_dosya, 1);
});

test('ikame: yalnız admin; ver, ikinci kez verme 409, iade km kontrolü, durum', async () => {
  assert.equal((await api('GET', '/api/ikame', S.tokA)).status, 403);
  const plaka = `34 IKM ${RUN.slice(0, 3).toUpperCase()}`;
  const a = await api('POST', '/api/ikame/araclar', S.admin, { plaka: plaka.toLowerCase(), marka: 'Renault', model: 'Clio', km: 15000, yakit_yuzde: 75 });
  assert.equal(a.status, 201, JSON.stringify(a.body)); assert.equal(a.body.plaka, plaka);
  assert.equal((await api('POST', '/api/ikame/araclar', S.admin, { plaka })).status, 409, 'aynı plaka');
  assert.equal((await api('POST', '/api/ikame/ver', S.admin, { arac_id: a.body.id, surucu_ad: 'Ali', verilis_km: 100 })).status, 400, 'km düşük');
  const v = await api('POST', '/api/ikame/ver', S.admin, { arac_id: a.body.id, dosya_id: S.dosya, surucu_ad: 'Ali Veli' });
  assert.equal(v.status, 201, JSON.stringify(v.body)); assert.equal(v.body.verilis_km, 15000); assert.equal(v.body.verilis_yakit, 75);
  assert.equal((await api('POST', '/api/ikame/ver', S.admin, { arac_id: a.body.id, surucu_ad: 'Başka' })).status, 409);
  assert.equal((await api('PATCH', `/api/ikame/araclar/${a.body.id}`, S.admin, { durum: 'bakimda' })).status, 409);
  assert.equal((await api('POST', `/api/ikame/iade/${v.body.id}`, S.admin, { iade_km: 14000 })).status, 400);
  const i = await api('POST', `/api/ikame/iade/${v.body.id}`, S.admin, { iade_km: 15420, iade_yakit: 40, hgs_tutar: 85.5, ceza_tutar: 0 });
  assert.equal(i.status, 200, JSON.stringify(i.body)); assert.equal(Number(i.body.hgs_tutar), 85.5);
  assert.equal((await api('POST', `/api/ikame/iade/${v.body.id}`, S.admin, { iade_km: 15500 })).status, 409);
  const g = (await api('GET', '/api/ikame', S.admin)).body;
  const ar = g.araclar.find((x) => x.id === a.body.id);
  assert.equal(ar.durum, 'musait'); assert.equal(ar.km, 15420); assert.equal(ar.yakit_yuzde, 40);
  assert.ok(g.kullanimlar.some((x) => x.id === v.body.id && x.iade_km === 15420));
  assert.equal((await api('PATCH', `/api/ikame/araclar/${a.body.id}`, S.admin, { km: 100 })).status, 400);
  assert.equal((await api('PATCH', `/api/ikame/araclar/${a.body.id}`, S.admin, { durum: 'bakimda' })).status, 200);
  assert.equal((await api('POST', '/api/ikame/ver', S.admin, { arac_id: a.body.id, surucu_ad: 'X' })).status, 409, 'bakımdaki araç verilmez');
});

test('sistem: yalnız admin; şifre özeti dönmez', async () => {
  assert.equal((await api('GET', '/api/moduller/sistem', S.tokA)).status, 403);
  const s = (await api('GET', '/api/moduller/sistem', S.admin)).body;
  assert.ok(s.roller.some((x) => x.rol === 'admin'));
  assert.ok(s.hesaplar.some((x) => x.email === `p3-a-${RUN}@example.com`));
  assert.ok(s.migrations.some((x) => x.ad === '010_dvi_protokol_ikame.sql'));
  assert.ok(!/sifre|hash/i.test(JSON.stringify(s)));
});
