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
    const d = await api('POST', '/api/dosyalar', S.admin, { arac: { plaka, marka: 'Fiat', model: 'Egea', yil: 2022 }, sahip: { adSoyad: `Sahip ${k}`, telefon: '05321112233' }, sigorta: { sirketAd: `Sigorta ${k} ${RUN}`, hasarNo: `M-${k}-${RUN}` }, kaza: { tarih: '2026-03-01' } });
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
  assert.equal(a.sirket_ad, `Sigorta A ${RUN}`);
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

// ── Paket 2 ──
test('finans: servis faturası alacak olarak gelir, kalan hesaplanır; servis B görmez', async () => {
  const r = await api('POST', `/api/faturalar/${S.dosyaA}/servis`, S.tokA, { alici_tipi: 'sigorta', alici_ad: 'Sigorta A', tutar: 1000, kdv_orani: 20, odenen_tutar: 200 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const f = (await api('GET', '/api/moduller/finans', S.admin)).body;
  const x = f.faturalar.find((y) => y.dosya_id === S.dosyaA);
  assert.ok(x); assert.equal(Number(x.toplam), 1200); assert.equal(Number(x.kalan), 1000);
  assert.ok(Array.isArray(f.dis_faturalar));
  assert.ok(!(await api('GET', '/api/moduller/finans', S.tokB)).body.faturalar.some((y) => y.dosya_id === S.dosyaA));
});

test('plan: aktif dosya görevleriyle gelir', async () => {
  const p = (await api('GET', '/api/moduller/plan', S.admin)).body.dosyalar;
  const x = p.find((y) => y.dosya_id === S.dosyaA);
  assert.ok(x); assert.equal(x.gorevler.length, 1); assert.equal(x.gorevler[0].bolum, 'boya');
  assert.equal(x.ilerleme, 0);
});

test('siparişler ve tedarikçiler: gecikme ve tutar; servis kapsamı', async () => {
  const ted = (await api('POST', '/api/stok/tedarikciler', S.tokA, { ad: `Ted ${RUN}` })).body;
  const r = await api('POST', '/api/stok/siparisler', S.tokA, { tedarikci_id: ted.id, dosya_id: S.dosyaA, tahmini_gelis: '2020-01-01', kalemler: [{ yeni_parca: { ad: `Far ${RUN}` }, adet: 2, birim_fiyat: 500 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const s = (await api('GET', '/api/moduller/siparisler', S.admin)).body.siparisler.find((y) => y.tedarikci_id === ted.id);
  assert.ok(s); assert.equal(s.geciken, true); assert.equal(Number(s.toplam), 1000); assert.equal(s.plaka, PLAKA_A);
  assert.ok(!(await api('GET', '/api/moduller/siparisler', S.tokB)).body.siparisler.some((y) => y.tedarikci_id === ted.id));
  const t = (await api('GET', '/api/moduller/tedarikciler', S.admin)).body.tedarikciler.find((y) => y.id === ted.id);
  assert.equal(t.siparis_sayisi, 1); assert.equal(t.geciken_acik, 1); assert.equal(Number(t.toplam_tutar), 1000);
  assert.ok(!(await api('GET', '/api/moduller/tedarikciler', S.tokB)).body.tedarikciler.some((y) => y.id === ted.id));
});

test('operasyon: bekleyen onay, geciken teslim ve parça; adım süreleri', async () => {
  await sql("UPDATE onarim_merkezi SET tahmini_teslimat=CURRENT_DATE-3 WHERE dosya_id=$1", [S.dosyaA]);
  const det = (await api('GET', `/api/dosyalar/${S.dosyaA}`, S.admin)).body;
  assert.equal((await api('POST', `/api/dosyalar/${S.dosyaA}/adim/${det.onarim_adimlari[0].id}/tamamla`, S.tokA)).status, 200);
  const o = (await api('GET', '/api/moduller/operasyon', S.admin)).body;
  assert.ok(o.bekleyen_onaylar.some((y) => y.dosya_id === S.dosyaA));
  const t = o.geciken_teslimler.find((y) => y.dosya_id === S.dosyaA);
  assert.ok(t); assert.equal(t.gecikme_gun, 3);
  assert.ok(o.geciken_siparisler.some((y) => y.plaka === PLAKA_A));
  assert.ok(o.adim_sureleri.some((y) => y.ad === 'Araç Kabulü' && y.adet >= 1));
  const oB = (await api('GET', '/api/moduller/operasyon', S.tokB)).body;
  assert.ok(!oB.geciken_teslimler.some((y) => y.dosya_id === S.dosyaA));
  assert.ok(!oB.geciken_siparisler.some((y) => y.plaka === PLAKA_A));
});

test('bi: yalnız admin; 12 aylık seri, sigorta ve servis kırılımı', async () => {
  assert.equal((await api('GET', '/api/moduller/bi', S.tokA)).status, 403);
  const b = (await api('GET', '/api/moduller/bi', S.admin)).body;
  assert.equal(b.aylik.length, 12);
  assert.ok(b.aylik[11].acilan >= 2);
  assert.ok(b.sigorta.some((y) => y.ad === `Sigorta A ${RUN}` && y.dosya === 1 && Number(y.teklif) === 3000));
  assert.ok(b.servis.some((y) => y.ad === `Modul Servis A ${RUN}` && y.aktif === 1));
  assert.ok(b.genel.dosya >= 2);
});
