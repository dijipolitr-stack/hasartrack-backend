// Panel API testleri (2026-10-01-panel-api-baglama). Bağımlılık eklemez: node:test + fetch.
// BOŞ ya da migrate edilmiş bir TEST Postgres gerekir; canlı Supabase'e bağlanmaz.
//   TEST_DATABASE_URL=postgresql://u:p@localhost:55432/db TEST_JWT_SECRET=<32+ krk> TEST_ADMIN_PASSWORD=<12+ krk> \
//   node --test --test-concurrency=1 test/*.test.js
// Not: a-grubu.test.js ile aynı DB'yi kullanır; --test-concurrency=1 ile sırayla çalıştırın.
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
const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = 'admin@hasartrack.com';
const RUN = crypto.randomBytes(4).toString('hex');
const SERVIS_SIFRE = crypto.randomBytes(8).toString('hex'); // 16 karakter, her çalışmada rastgele

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
const startServer = async () => {
  srv = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...baseEnv(), DATABASE_URL: DB, JWT_SECRET: JWT, PORT: String(PORT), FRONTEND_URL: 'http://localhost:3001' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('sunucu açılmadı');
};
const stopServer = () => new Promise((r) => { if (!srv) return r(); srv.once('exit', r); srv.kill(); srv = null; });
test.after(stopServer);

const api = async (method, url, token, body) => {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};

const S = {}; // ortak durum
const yeniDosya = async (telefon = '05320000000') => {
  const r = await api('POST', '/api/dosyalar', S.admin, {
    arac: { plaka: '34TST' + Math.floor(Math.random() * 900 + 100), marka: 'Test', model: 'Model', yil: 2020 },
    sahip: { adSoyad: 'Test Sahip', telefon },
    sigorta: { sirketAd: 'Test Sigorta', hasarNo: 'H-' + RUN },
    kaza: { tarih: '2026-02-15' },
  });
  return r;
};

test('hazırlık: migrate, seed, sunucu, admin girişi', async () => {
  let r = run('src/db/migrate.js');
  assert.equal(r.status, 0, r.stderr);
  r = run('src/db/seed.js', { ADMIN_PASSWORD: PASS });
  assert.equal(r.status, 0, r.stderr);
  await startServer();
  const l = await api('POST', '/api/auth/login', null, { email: ADMIN_EMAIL, sifre: PASS });
  assert.equal(l.status, 200);
  S.admin = l.body.token;
});

test('K1-2 servisler: 401/403, oluştur, kısa şifre 400, hash dönmez, PATCH', async () => {
  assert.equal((await api('GET', '/api/servisler')).status, 401);

  let r = await api('POST', '/api/servisler', S.admin, { ad: 'Kısa', kullanici_email: `kisa-${RUN}@example.com`, sifre: 'kisa' });
  assert.equal(r.status, 400);

  for (const k of ['A', 'B']) {
    r = await api('POST', '/api/servisler', S.admin, {
      ad: `Test Servis ${k} ${RUN}`, telefon: '02120000000', kullanici_email: `Servis-${k}-${RUN}@Example.com`, sifre: SERVIS_SIFRE,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.kullanici_email, `servis-${k.toLowerCase()}-${RUN}@example.com`);
    assert.ok(!JSON.stringify(r.body).match(/sifre|hash/i));
    S[`srv${k}`] = r.body.id;
  }
  // aynı e-posta 409
  r = await api('POST', '/api/servisler', S.admin, { ad: 'Çakışan', kullanici_email: `servis-a-${RUN}@example.com`, sifre: SERVIS_SIFRE });
  assert.equal(r.status, 409);

  r = await api('GET', '/api/servisler', S.admin);
  assert.equal(r.status, 200);
  const a = r.body.servisler.find((s) => s.id === S.srvA);
  assert.ok(a && a.aktif === true && a.dosya_sayisi === 0);
  assert.ok(!JSON.stringify(r.body).match(/sifre|hash/i));

  r = await api('PATCH', `/api/servisler/${S.srvA}`, S.admin, { ad: `Test Servis A2 ${RUN}`, sifre: 'kisa' });
  assert.equal(r.status, 400);
  r = await api('PATCH', `/api/servisler/${S.srvA}`, S.admin, { ad: `Test Servis A2 ${RUN}` });
  assert.equal(r.status, 200);
  assert.equal(r.body.ad, `Test Servis A2 ${RUN}`);
  assert.equal((await api('PATCH', '/api/servisler/abc', S.admin, { ad: 'x' })).status, 400);
  assert.equal((await api('PATCH', `/api/servisler/${crypto.randomUUID()}`, S.admin, { ad: 'x' })).status, 404);
});

test('K3-4 servis girişi: liste yalnız id+ad, login 200/401/400', async () => {
  let r = await api('GET', '/api/auth/servis-listesi');
  assert.equal(r.status, 200);
  assert.ok(r.body.servisler.length >= 2);
  for (const s of r.body.servisler) assert.deepEqual(Object.keys(s).sort(), ['ad', 'id']);

  r = await api('POST', '/api/auth/servis-login', null, { servis_id: S.srvA, sifre: SERVIS_SIFRE });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  S.tokA = r.body.token;
  assert.deepEqual(Object.keys(r.body.kullanici.servis).sort(), ['ad', 'adres', 'id', 'telefon']);
  r = await api('POST', '/api/auth/servis-login', null, { servis_id: S.srvB, sifre: SERVIS_SIFRE });
  S.tokB = r.body.token;
  assert.ok(S.tokB);

  assert.equal((await api('POST', '/api/auth/servis-login', null, { servis_id: S.srvA, sifre: 'yanlis-sifre-1' })).status, 401);
  assert.equal((await api('POST', '/api/auth/servis-login', null, { servis_id: 'srv1', sifre: 'x' })).status, 400);
  assert.equal((await api('POST', '/api/auth/servis-login', null, { servis_id: S.srvA })).status, 400);
});

test('yetki: servis PATCH, POST dosya, /servisler, /raporlar için 403', async () => {
  const d = await yeniDosya();
  assert.equal(d.status, 201);
  S.dosyaId = d.body.id;
  assert.equal((await api('GET', '/api/servisler', S.tokA)).status, 403);
  assert.equal((await api('GET', '/api/raporlar/ozet', S.tokA)).status, 403);
  assert.equal((await api('POST', '/api/dosyalar', S.tokA, {})).status, 403);
  assert.equal((await api('PATCH', `/api/dosyalar/${S.dosyaId}`, S.tokA, { alan: 'durum', deger: 'Aktif' })).status, 403);
  assert.equal((await api('POST', `/api/dosyalar/${S.dosyaId}/servis-ata`, S.tokA, { servis_id: S.srvA })).status, 403);
  assert.equal((await api('GET', '/api/dosyalar')).status, 401);
});

test('K14 wizard POST: telefonsuz 400, 8 adım, onay kaydı, servis 403', async () => {
  const r = await api('POST', '/api/dosyalar', S.admin, { arac: { plaka: '34X1' }, sahip: { adSoyad: 'Telefonsuz' } });
  assert.equal(r.status, 400);
  const g = await api('GET', `/api/dosyalar/${S.dosyaId}`, S.admin);
  assert.equal(g.status, 200);
  assert.equal(g.body.onarim_adimlari.length, 8);
  assert.equal(g.body.onarim_adimlari[0].durum, 'aktif');
  assert.equal(g.body.arac.kaza_tarihi, '2026-02-15'); // DATE string, kayma yok
});

test('K15 servis-ata: geçersiz/yok/pasif 4xx, audit_log, servis listesinde görünür, K5 başka servis 403', async () => {
  const url = `/api/dosyalar/${S.dosyaId}/servis-ata`;
  assert.equal((await api('POST', url, S.admin, { servis_id: 'abc' })).status, 400);
  assert.equal((await api('POST', url, S.admin, {})).status, 400);
  assert.equal((await api('POST', url, S.admin, { servis_id: crypto.randomUUID() })).status, 404);
  assert.equal((await api('POST', `/api/dosyalar/${crypto.randomUUID()}/servis-ata`, S.admin, { servis_id: S.srvA })).status, 404);

  // pasif servis: ek bir servis aç, pasifle, ata -> 409, kullanıcısı girişsiz
  let r = await api('POST', '/api/servisler', S.admin, { ad: `Pasif ${RUN}`, kullanici_email: `pasif-${RUN}@example.com`, sifre: SERVIS_SIFRE });
  assert.equal(r.status, 201);
  const pasifId = r.body.id;
  const pasifTok = (await api('POST', '/api/auth/servis-login', null, { servis_id: pasifId, sifre: SERVIS_SIFRE })).body.token;
  assert.ok(pasifTok);
  r = await api('PATCH', `/api/servisler/${pasifId}`, S.admin, { aktif: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.aktif, false);
  assert.equal((await api('POST', url, S.admin, { servis_id: pasifId })).status, 409);
  assert.equal((await api('POST', '/api/auth/servis-login', null, { servis_id: pasifId, sifre: SERVIS_SIFRE })).status, 401);
  assert.equal((await api('GET', '/api/dosyalar', pasifTok)).status, 401); // eski token düşer
  const liste = await api('GET', '/api/auth/servis-listesi');
  assert.ok(!liste.body.servisler.some((s) => s.id === pasifId));

  r = await api('POST', url, S.admin, { servis_id: S.srvA, not_metni: 'test' });
  assert.equal(r.status, 200);
  const au = await sql("SELECT count(*)::int n FROM audit_log WHERE dosya_id=$1 AND eylem='SERVIS_ATA'", [S.dosyaId]);
  assert.equal(au.rows[0].n, 1);

  r = await api('GET', '/api/dosyalar?limit=200', S.tokA);
  assert.equal(r.status, 200);
  assert.ok(r.body.dosyalar.some((d) => d.id === S.dosyaId && d.atanan_servis === S.srvA));
  r = await api('GET', '/api/dosyalar?limit=200', S.tokB);
  assert.ok(!r.body.dosyalar.some((d) => d.id === S.dosyaId));
  assert.equal((await api('GET', `/api/dosyalar/${S.dosyaId}`, S.tokB)).status, 403);
  assert.equal((await api('GET', `/api/dosyalar/${S.dosyaId}`, S.tokA)).status, 200);
});

test('K8-9 PATCH: bilinmeyen alan/tablo 400, enjeksiyon 400 ve veri sağlam, upsert, dosyalar.durum', async () => {
  const url = `/api/dosyalar/${S.dosyaId}`;
  const once = (await api('GET', url, S.admin)).body;

  assert.equal((await api('PATCH', url, S.admin, { alt_tablo: 'arac', alan: 'yok_alan', deger: 'x' })).status, 400);
  assert.equal((await api('PATCH', url, S.admin, { alt_tablo: 'kullanicilar', alan: 'rol', deger: 'admin' })).status, 400);
  assert.equal((await api('PATCH', url, S.admin, { alt_tablo: 'arac', alan: 'plaka=plaka; DROP TABLE arac --', deger: 'x' })).status, 400);
  assert.equal((await api('PATCH', url, S.admin, { alt_tablo: 'arac', alan: '__proto__', deger: 'x' })).status, 400);
  assert.equal((await api('PATCH', url, S.admin, { alt_tablo: 'muhasebe', alan: 'onaylanan_tutar', deger: 1 })).status, 400);
  assert.equal((await api('PATCH', url, S.admin, { alt_tablo: 'sahip', alan: 'telefon', deger: '' })).status, 400);
  const sonra = (await api('GET', url, S.admin)).body;
  assert.equal(sonra.arac.plaka, once.arac.plaka);
  assert.equal((await sql("SELECT to_regclass('public.arac') t")).rows[0].t, 'arac');

  let r = await api('PATCH', url, S.admin, { alt_tablo: 'arac', alan: 'plaka', deger: '06ABC123' });
  assert.equal(r.status, 200);
  assert.equal(r.body.plaka, '06ABC123');
  // eksper ve onarim_merkezi: satır yok, upsert oluşturur
  assert.equal(once.eksper, null);
  assert.equal(once.onarim_merkezi, null);
  r = await api('PATCH', url, S.admin, { alt_tablo: 'eksper', alan: 'ad_soyad', deger: 'Eksper Test' });
  assert.equal(r.status, 200);
  r = await api('PATCH', url, S.admin, { alt_tablo: 'eksper', alan: 'inceleme_tarihi', deger: '2026-03-04' });
  assert.equal(r.status, 200);
  r = await api('PATCH', url, S.admin, { alt_tablo: 'onarim_merkezi', alan: 'ad', deger: 'Merkez Test' });
  assert.equal(r.status, 200);
  const g = (await api('GET', url, S.admin)).body;
  assert.equal(g.eksper.ad_soyad, 'Eksper Test');
  assert.equal(g.eksper.inceleme_tarihi, '2026-03-04');
  assert.equal(g.onarim_merkezi.ad, 'Merkez Test');

  assert.equal((await api('PATCH', url, S.admin, { alt_tablo: 'dosyalar', alan: 'durum', deger: 'Askıda' })).status, 200);
  assert.equal((await api('PATCH', url, S.admin, { alan: 'oncelik', deger: 'Acil' })).status, 200);
  assert.equal((await api('PATCH', url, S.admin, { alan: 'durum', deger: 'Yok' })).status, 400);
  assert.equal((await api('PATCH', url, S.admin, { alt_tablo: 'arac', alan: 'yil', deger: 'abc' })).status, 400);
  assert.equal((await api('PATCH', url, S.admin, { alt_tablo: 'arac', alan: 'kaza_tarihi', deger: '31.02.2026' })).status, 400);
  assert.equal((await api('GET', url, S.admin)).body.durum, 'Askıda');
  await api('PATCH', url, S.admin, { alan: 'durum', deger: 'Aktif' });
});

test('K13 muhasebe: geçersiz sayı 400, sayı ve tarih kaydı aynı döner', async () => {
  const url = `/api/dosyalar/${S.dosyaId}`;
  assert.equal((await api('PATCH', url, S.admin, { alt_tablo: 'muhasebe', alan: 'servis_fatura_tutar', deger: 'abc' })).status, 400);
  assert.equal((await api('PATCH', url, S.admin, { alt_tablo: 'muhasebe', alan: 'servis_fatura_tutar', deger: -5 })).status, 400);
  let r = await api('PATCH', url, S.admin, { alt_tablo: 'muhasebe', alan: 'servis_fatura_tutar', deger: 24800 });
  assert.equal(r.status, 200);
  r = await api('PATCH', url, S.admin, { alt_tablo: 'muhasebe', alan: 'servis_fatura_trh', deger: '2026-01-01' });
  assert.equal(r.status, 200);
  const m = (await api('GET', url, S.admin)).body.muhasebe;
  assert.equal(Number(m.servis_fatura_tutar), 24800);
  assert.equal(m.servis_fatura_trh, '2026-01-01');
});

test('K10 geçersiz UUID: 400, süreç ayakta', async () => {
  assert.equal((await api('GET', '/api/dosyalar/abc', S.admin)).status, 400);
  assert.equal((await api('GET', '/api/islemler/abc', S.admin)).status, 400);
  assert.equal((await api('GET', `/api/dosyalar/${crypto.randomUUID()}`, S.admin)).status, 404);
  assert.equal((await api('GET', `/api/dosyalar/${crypto.randomUUID()}`, S.tokA)).status, 404);
  assert.equal((await api('GET', '/api/dosyalar?servis_id=abc', S.admin)).status, 400);
  assert.equal((await api('GET', '/api/dosyalar?limit=5', S.admin)).status, 200);
});

test('K11 adım tamamla: sonraki aktif, 404, 409, servis atanmış dosyada çalışır', async () => {
  const g = (await api('GET', `/api/dosyalar/${S.dosyaId}`, S.admin)).body;
  const [a1, a2] = g.onarim_adimlari;
  let r = await api('POST', `/api/dosyalar/${S.dosyaId}/adim/${a1.id}/tamamla`, S.tokA);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.onarim_adimlari[0].durum, 'tamamlandi');
  assert.equal(r.body.onarim_adimlari[1].durum, 'aktif');
  assert.equal(r.body.ilerleme, 13); // 1/8
  assert.equal((await api('POST', `/api/dosyalar/${S.dosyaId}/adim/${a1.id}/tamamla`, S.admin)).status, 409);
  assert.equal((await api('POST', `/api/dosyalar/${S.dosyaId}/adim/${crypto.randomUUID()}/tamamla`, S.admin)).status, 404);
  assert.equal((await api('POST', `/api/dosyalar/${S.dosyaId}/adim/abc/tamamla`, S.admin)).status, 400);
  assert.equal((await api('POST', `/api/dosyalar/${S.dosyaId}/adim/${a2.id}/tamamla`, S.tokB)).status, 403);
  assert.equal((await api('POST', `/api/dosyalar/${S.dosyaId}/adim/${a2.id}/tamamla`, S.admin)).status, 200);
});

test('K12 işlemler: servis ekler/gönderir, admin onaylar, onaylanan_tutar = toplam, sonra ekleme 409', async () => {
  const url = `/api/islemler/${S.dosyaId}`;
  let r = await api('POST', url, S.tokA, { aciklama: 'Ön tampon', miktar: 2, birim_fiyat: 1000.5 });
  assert.equal(r.status, 201);
  r = await api('POST', url, S.tokA, { aciklama: 'Boya', miktar: 1, birim_fiyat: 500 });
  assert.equal(r.status, 201);
  assert.equal((await api('POST', `${url}/onaya-gonder`, S.tokA)).status, 200);
  assert.equal((await api('POST', url, S.tokA, { aciklama: 'Geç', birim_fiyat: 1 })).status, 409);
  assert.equal((await api('POST', `${url}/admin-karar`, S.tokA, { karar: 'onaylandi' })).status, 403);
  assert.equal((await api('POST', `/api/islemler/${crypto.randomUUID()}/admin-karar`, S.admin, { karar: 'onaylandi' })).status, 404);
  assert.equal((await api('POST', `${url}/admin-karar`, S.admin, { karar: 'onaylandi' })).status, 200);
  const m = (await api('GET', `/api/dosyalar/${S.dosyaId}`, S.admin)).body.muhasebe;
  assert.equal(Number(m.onaylanan_tutar), 2501);
  assert.equal((await api('POST', url, S.tokA, { aciklama: 'Sonra', birim_fiyat: 1 })).status, 409);
  const g = (await api('GET', url, S.tokA)).body;
  assert.equal(g.onay_durumu, 'onaylandi');
  assert.equal((await api('PATCH', `${url}/abc`, S.tokA, { aciklama: 'x' })).status, 400);
});

test('raporlar/ozet: servis satırlarında id var', async () => {
  const r = await api('GET', '/api/raporlar/ozet', S.admin);
  assert.equal(r.status, 200);
  assert.ok(r.body.servisler.every((s) => typeof s.id === 'string'));
});

test('hesapsız servise şifre: e-posta yoksa 400, varsa hesap açılır ve giriş 200; uzun ad 201', async () => {
  const ornek = '11111111-0000-0000-0000-000000000002'; // schema.sql örnek servisi, giriş hesabı yok
  let r = await api('PATCH', `/api/servisler/${ornek}`, S.admin, { sifre: SERVIS_SIFRE });
  assert.equal(r.status, 400);
  r = await api('PATCH', `/api/servisler/${ornek}`, S.admin, { kullanici_email: `x-${RUN}@test.local` });
  assert.equal(r.status, 400);
  r = await api('PATCH', `/api/servisler/${ornek}`, S.admin, { sifre: SERVIS_SIFRE, kullanici_email: ADMIN_EMAIL });
  assert.equal(r.status, 409);
  r = await api('PATCH', `/api/servisler/${ornek}`, S.admin, { sifre: SERVIS_SIFRE, kullanici_email: `ornek-${RUN}@test.local` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.kullanici_email, `ornek-${RUN}@test.local`);
  r = await api('POST', '/api/auth/servis-login', null, { servis_id: ornek, sifre: SERVIS_SIFRE });
  assert.equal(r.status, 200);
  r = await api('GET', '/api/servisler', S.admin);
  assert.equal(r.body.servisler.find((s) => s.id === ornek).kullanici_email, `ornek-${RUN}@test.local`);

  r = await api('POST', '/api/servisler', S.admin, {
    ad: 'U'.repeat(150), kullanici_email: `uzun-${RUN}@test.local`, sifre: SERVIS_SIFRE });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

test('yetki sıkılaştırma: acente yazamaz, servis kalem onaylayamaz, karar yalnız bekliyor iken, uzun metin 400', async () => {
  // Acente kullanıcısı (DB'den), login ile token
  const bcrypt = require('bcrypt');
  const acenteEmail = `acente-${RUN}@example.com`;
  await sql(`INSERT INTO kullanicilar (ad_soyad, email, sifre_hash, rol) VALUES ('Test Acente', $1, $2, 'acente')`,
    [acenteEmail, await bcrypt.hash(SERVIS_SIFRE, 4)]);
  const acente = (await api('POST', '/api/auth/login', null, { email: acenteEmail, sifre: SERVIS_SIFRE })).body.token;
  assert.ok(acente);

  const d = (await yeniDosya()).body;
  assert.equal((await api('POST', `/api/dosyalar/${d.id}/servis-ata`, S.admin, { servis_id: S.srvA })).status, 200);
  const adim = (await api('GET', `/api/dosyalar/${d.id}`, S.admin)).body.onarim_adimlari[0];
  const kalem = (await api('POST', `/api/islemler/${d.id}`, S.tokA, { kategori: 'Boya', aciklama: 'Test', birim_fiyat: 100 })).body;

  // Acente: okuyabilir, yazamaz
  assert.equal((await api('GET', `/api/islemler/${d.id}`, acente)).status, 200);
  assert.equal((await api('POST', `/api/dosyalar/${d.id}/adim/${adim.id}/tamamla`, acente)).status, 403);
  assert.equal((await api('PATCH', `/api/islemler/${d.id}/${kalem.id}`, acente, { aciklama: 'x' })).status, 403);
  assert.equal((await api('DELETE', `/api/islemler/${d.id}/${kalem.id}`, acente)).status, 403);
  assert.equal((await api('POST', `/api/islemler/${d.id}/toplu`, acente, { kalemler: [{ aciklama: 'x', birim_fiyat: 1 }] })).status, 403);

  // Servis: kalem durumunu değiştiremez, diğer alanları değiştirebilir
  assert.equal((await api('PATCH', `/api/islemler/${d.id}/${kalem.id}`, S.tokA, { durum: 'onaylandi' })).status, 403);
  assert.equal((await api('PATCH', `/api/islemler/${d.id}/${kalem.id}`, S.tokA, { aciklama: 'Yeni' })).status, 200);
  assert.equal((await api('PATCH', `/api/islemler/${d.id}/${kalem.id}`, S.admin, { durum: 'gecersiz' })).status, 400);
  assert.equal((await api('PATCH', `/api/islemler/${d.id}/${kalem.id}`, S.admin, { durum: 'reddedildi' })).status, 200);
  assert.equal((await api('POST', `/api/dosyalar/${d.id}/adim/${adim.id}/tamamla`, S.tokA)).status, 200);

  // Admin kararı: taslakta 409, bekliyor iken 200
  assert.equal((await api('POST', `/api/islemler/${d.id}/admin-karar`, S.admin, { karar: 'onaylandi' })).status, 409);
  assert.equal((await api('POST', `/api/islemler/${d.id}/onaya-gonder`, S.tokA)).status, 200);
  assert.equal((await api('POST', `/api/islemler/${d.id}/admin-karar`, S.admin, { karar: 'onaylandi' })).status, 200);
  assert.equal((await api('POST', `/api/islemler/${d.id}/admin-karar`, S.admin, { karar: 'reddedildi' })).status, 409);

  // Kolon sınırını aşan metin 400 (500 değil)
  const r = await api('PATCH', `/api/dosyalar/${d.id}`, S.admin, { alt_tablo: 'arac', alan: 'plaka', deger: 'X'.repeat(500) });
  assert.equal(r.status, 400, JSON.stringify(r.body));
});
