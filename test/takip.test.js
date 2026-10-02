// Müşteri takip linki testleri. panel-api.test.js ile aynı ortam değişkenleri; --test-concurrency=1 ile çalıştırın.
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
const PORT = 3996;
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = crypto.randomBytes(4).toString('hex');
const SIFRE = crypto.randomBytes(8).toString('hex');
if (!DB || !JWT || !PASS) throw new Error('TEST_DATABASE_URL, TEST_JWT_SECRET, TEST_ADMIN_PASSWORD gerekli');

const baseEnv = () => {
  const e = { ...process.env };
  for (const k of ['DATABASE_URL', 'DATABASE_SSL', 'JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'FRONTEND_URL', 'NODE_ENV', 'PORT', 'RATE_LIMIT_MAX', 'TAKIP_RATE_LIMIT_MAX']) delete e[k];
  return e;
};
const sql = async (q, p) => {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try { return await c.query(q, p); } finally { await c.end(); }
};
let srv;
test.after(() => srv && srv.kill());
const api = async (method, url, token, body) => {
  const res = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json, headers: res.headers };
};

const S = {};

test('hazırlık: migrate, seed, sunucu, admin + iki servis + dosya', async () => {
  for (const [s, extra] of [['src/db/migrate.js', {}], ['src/db/seed.js', { ADMIN_PASSWORD: PASS }]]) {
    const r = spawnSync(process.execPath, [s], { cwd: ROOT, env: { ...baseEnv(), DATABASE_URL: DB, ...extra }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  srv = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...baseEnv(), DATABASE_URL: DB, JWT_SECRET: JWT, PORT: String(PORT), FRONTEND_URL: 'http://localhost:3001', RATE_LIMIT_MAX: '5000', TAKIP_RATE_LIMIT_MAX: '5000' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  S.admin = (await api('POST', '/api/auth/login', null, { email: 'admin@hasartrack.com', sifre: PASS })).body.token;
  assert.ok(S.admin);
  for (const k of ['A', 'B']) {
    const r = await api('POST', '/api/servisler', S.admin, { ad: `Takip Servis ${k} ${RUN}`, telefon: '02125550000', adres: 'Test Mah. 1', kullanici_email: `takip-${k}-${RUN}@example.com`, sifre: SIFRE });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    S[`srv${k}`] = r.body.id;
    S[`tok${k}`] = (await api('POST', '/api/auth/servis-login', null, { servis_id: r.body.id, sifre: SIFRE })).body.token;
  }
  const d = await api('POST', '/api/dosyalar', S.admin, {
    arac: { plaka: '34TKP' + RUN.slice(0, 3).toUpperCase(), marka: 'Fiat', model: 'Egea', yil: 2022 },
    sahip: { adSoyad: 'Ayşe Yılmaz Demir', telefon: '05321112233', tcVergi: '12345678901' },
    sigorta: { sirketAd: 'Gizli Sigorta', hasarNo: 'GIZLI-' + RUN },
    kaza: { tarih: '2026-03-01' },
  });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  S.dosya = d.body.id;
  assert.equal((await api('POST', `/api/dosyalar/${S.dosya}/servis-ata`, S.admin, { servis_id: S.srvA })).status, 200);
});

test('yetki: oturumsuz 401, atanmamış servis 403, geçersiz id 400, yok 404', async () => {
  const u = `/api/takip/dosya/${S.dosya}`;
  assert.equal((await api('POST', u, null, {})).status, 401);
  assert.equal((await api('GET', u)).status, 401);
  assert.equal((await api('POST', u, S.tokB, {})).status, 403);
  assert.equal((await api('GET', u, S.tokB)).status, 403);
  assert.equal((await api('POST', '/api/takip/dosya/abc', S.admin, {})).status, 400);
  assert.equal((await api('POST', `/api/takip/dosya/${crypto.randomUUID()}`, S.admin, {})).status, 404);
  assert.equal((await api('POST', u, S.admin, { gun: 0 })).status, 400);
  assert.equal((await api('POST', u, S.admin, { gun: 91 })).status, 400);
});

test('oluştur: token yalnız bir kez döner, DB özet saklar, liste token içermez', async () => {
  const r = await api('POST', `/api/takip/dosya/${S.dosya}`, S.tokA, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.token, /^[A-Za-z0-9_-]{43}$/);
  const gun = (new Date(r.body.son_gecerlilik) - Date.now()) / 86400000;
  assert.ok(gun > 29.9 && gun <= 30, `varsayılan 30 gün: ${gun}`);
  S.token = r.body.token; S.linkId = r.body.id;

  const { rows } = await sql('SELECT token_ozet FROM takip_linkleri WHERE id=$1', [S.linkId]);
  assert.equal(rows[0].token_ozet, crypto.createHash('sha256').update(S.token).digest('hex'));

  const l = await api('GET', `/api/takip/dosya/${S.dosya}`, S.admin);
  assert.equal(l.status, 200);
  const k = l.body.linkler.find((x) => x.id === S.linkId);
  assert.ok(k && k.aktif === true && k.erisim_sayisi === 0);
  assert.ok(!JSON.stringify(l.body).includes(S.token), 'liste token sızdırmaz');
  assert.ok(!/token/.test(JSON.stringify(l.body)));
});

test('herkese açık görünüm: adımlar ve servis var, para/TC/sigorta/iç not yok', async () => {
  // Bir adımı tamamla, iç not ekle: görünümde not çıkmamalı
  const det = (await api('GET', `/api/dosyalar/${S.dosya}`, S.admin)).body;
  await sql("UPDATE onarim_adimlari SET not_metni='IC-NOT-GIZLI' WHERE dosya_id=$1", [S.dosya]);
  assert.equal((await api('POST', `/api/dosyalar/${S.dosya}/adim/${det.onarim_adimlari[0].id}/tamamla`, S.tokA)).status, 200);
  await sql("UPDATE dosyalar SET muallak_hasar=98765 WHERE id=$1", [S.dosya]);

  const r = await api('GET', `/api/takip/${S.token}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.body.sahip_ad, 'Ayşe', 'yalnız ilk ad');
  assert.equal(r.body.arac.marka, 'Fiat');
  assert.equal(r.body.servis.ad, `Takip Servis A ${RUN}`);
  assert.equal(r.body.servis.telefon, '02125550000');
  assert.equal(r.body.adimlar.length, 8);
  assert.equal(r.body.adimlar[0].durum, 'tamamlandi');
  assert.deepEqual(Object.keys(r.body.adimlar[0]).sort(), ['ad', 'durum', 'sira', 'tamamlanma_trh']);
  const metin = JSON.stringify(r.body);
  for (const yasak of ['IC-NOT-GIZLI', '98765', '12345678901', 'GIZLI-', 'Gizli Sigorta', '05321112233', 'Yılmaz', S.dosya, 'muallak', 'tutar'])
    assert.ok(!metin.includes(yasak), `görünümde olmamalı: ${yasak}`);

  const { rows } = await sql('SELECT erisim_sayisi, son_erisim FROM takip_linkleri WHERE id=$1', [S.linkId]);
  assert.equal(rows[0].erisim_sayisi, 1);
  assert.ok(rows[0].son_erisim);
});

test('geçersiz, süresi dolmuş ve iptal edilen link 404', async () => {
  assert.equal((await api('GET', '/api/takip/kisa')).status, 404);
  assert.equal((await api('GET', `/api/takip/${'A'.repeat(43)}`)).status, 404);

  const e = await api('POST', `/api/takip/dosya/${S.dosya}`, S.admin, { gun: 1 });
  await sql("UPDATE takip_linkleri SET son_gecerlilik=NOW() - INTERVAL '1 minute' WHERE id=$1", [e.body.id]);
  assert.equal((await api('GET', `/api/takip/${e.body.token}`)).status, 404, 'süresi dolmuş');
  const l = (await api('GET', `/api/takip/dosya/${S.dosya}`, S.admin)).body.linkler;
  assert.equal(l.find((x) => x.id === e.body.id).aktif, false);

  // Başka servis iptal edemez; başka dosyanın kimliğiyle 404
  assert.equal((await api('DELETE', `/api/takip/dosya/${S.dosya}/${S.linkId}`, S.tokB)).status, 403);
  assert.equal((await api('DELETE', `/api/takip/dosya/${S.dosya}/${crypto.randomUUID()}`, S.admin)).status, 404);
  assert.equal((await api('DELETE', `/api/takip/dosya/${S.dosya}/${S.linkId}`, S.tokA)).status, 200);
  assert.equal((await api('GET', `/api/takip/${S.token}`)).status, 404, 'iptal sonrası');
  // Tekrar iptal iptal tarihini değiştirmez
  const once = (await sql('SELECT iptal_trh FROM takip_linkleri WHERE id=$1', [S.linkId])).rows[0].iptal_trh;
  assert.equal((await api('DELETE', `/api/takip/dosya/${S.dosya}/${S.linkId}`, S.admin)).status, 200);
  const sonra = (await sql('SELECT iptal_trh FROM takip_linkleri WHERE id=$1', [S.linkId])).rows[0].iptal_trh;
  assert.equal(sonra.getTime(), once.getTime());
});

test('dosya silinince linkler de silinir (CASCADE)', async () => {
  const d = await api('POST', '/api/dosyalar', S.admin, { arac: { plaka: '34SIL' + RUN.slice(0, 3).toUpperCase(), marka: 'X', model: 'Y', yil: 2020 }, sahip: { adSoyad: 'Sil', telefon: '05320000000' }, sigorta: { sirketAd: 'S', hasarNo: 'S-' + RUN }, kaza: { tarih: '2026-03-01' } });
  const l = await api('POST', `/api/takip/dosya/${d.body.id}`, S.admin, {});
  await sql('DELETE FROM dosyalar WHERE id=$1', [d.body.id]);
  assert.equal((await sql('SELECT 1 FROM takip_linkleri WHERE id=$1', [l.body.id])).rowCount, 0);
  assert.equal((await api('GET', `/api/takip/${l.body.token}`)).status, 404);
});

test('müşteri TC+SMS girişi kapalı (410), token üretmez', async () => {
  for (const u of ['/api/auth/musteri-sms', '/api/auth/musteri-dogrula']) {
    const r = await api('POST', u, null, { tc_no: '12345678901', kod: '0000' });
    assert.equal(r.status, 410);
    assert.ok(!r.body.token);
  }
});
