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
  // Eski tek servis faturası alanları artık yazılmaz (servis_faturalari tablosu)
  assert.equal((await api('PATCH', url, S.admin, { alt_tablo: 'muhasebe', alan: 'servis_fatura_tutar', deger: 1 })).status, 400);
  assert.equal((await api('PATCH', url, S.admin, { alt_tablo: 'muhasebe', alan: 'sigorta_odeme_tutar', deger: 'abc' })).status, 400);
  assert.equal((await api('PATCH', url, S.admin, { alt_tablo: 'muhasebe', alan: 'sigorta_odeme_tutar', deger: -5 })).status, 400);
  let r = await api('PATCH', url, S.admin, { alt_tablo: 'muhasebe', alan: 'sigorta_odeme_tutar', deger: 24800 });
  assert.equal(r.status, 200);
  r = await api('PATCH', url, S.admin, { alt_tablo: 'muhasebe', alan: 'sigorta_odeme_trh', deger: '2026-01-01' });
  assert.equal(r.status, 200);
  const m = (await api('GET', url, S.admin)).body.muhasebe;
  assert.equal(Number(m.sigorta_odeme_tutar), 24800);
  assert.equal(m.sigorta_odeme_trh, '2026-01-01');
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
  // Eksper adı verilmedi: dosyanın eksper kaydındaki ad kullanılır (K8-9'da girildi)
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
  // Kalem kararı yalnız onay bekleyen iş emrinde
  assert.equal((await api('PATCH', `/api/islemler/${d.id}/${kalem.id}`, S.admin, { durum: 'reddedildi' })).status, 409);
  assert.equal((await api('POST', `/api/dosyalar/${d.id}/adim/${adim.id}/tamamla`, S.tokA)).status, 200);

  // Admin kararı: taslakta 409, bekliyor iken 200
  assert.equal((await api('POST', `/api/islemler/${d.id}/admin-karar`, S.admin, { karar: 'onaylandi' })).status, 409);
  const k2 = (await api('POST', `/api/islemler/${d.id}`, S.tokA, { kategori: 'Boya', aciklama: 'Reddedilecek', birim_fiyat: 50 })).body;
  assert.equal((await api('POST', `/api/islemler/${d.id}/onaya-gonder`, S.tokA)).status, 200);
  assert.equal((await api('PATCH', `/api/islemler/${d.id}/${k2.id}`, S.admin, { durum: 'reddedildi' })).status, 200);
  assert.equal((await api('POST', `/api/islemler/${d.id}/admin-karar`, S.admin, { karar: 'onaylandi', eksper_ad: 'Test Eksper' })).status, 200);
  assert.equal((await api('POST', `/api/islemler/${d.id}/admin-karar`, S.admin, { karar: 'reddedildi' })).status, 409);
  // Tek tek reddedilen kalem onaylanan tutara girmez
  assert.equal(Number((await api('GET', `/api/dosyalar/${d.id}`, S.admin)).body.muhasebe.onaylanan_tutar), 100);

  // Kolon sınırını aşan metin 400 (500 değil)
  const r = await api('PATCH', `/api/dosyalar/${d.id}`, S.admin, { alt_tablo: 'arac', alan: 'plaka', deger: 'X'.repeat(500) });
  assert.equal(r.status, 400, JSON.stringify(r.body));
});

test('faturalar: kalem ödeyeni, pay özeti, çoklu servis faturası, dış hizmet faturası, yetki', async () => {
  const d = (await yeniDosya()).body;
  assert.equal((await api('POST', `/api/dosyalar/${d.id}/servis-ata`, S.admin, { servis_id: S.srvA })).status, 200);
  assert.equal((await api('PATCH', `/api/dosyalar/${d.id}`, S.admin, { alt_tablo: 'sigorta', alan: 'muafiyet', deger: 1000 })).status, 200);

  // Kalemler: sigorta 10.000, müşteri 2.000, reddedilen sayılmaz
  const ik = `/api/islemler/${d.id}`;
  assert.equal((await api('POST', ik, S.tokA, { aciklama: 'Kapı', birim_fiyat: 10000 })).body.odeyen, 'sigorta');
  const m = (await api('POST', ik, S.tokA, { aciklama: 'Cam filmi', birim_fiyat: 500, odeyen: 'sigorta' })).body;
  assert.equal((await api('POST', ik, S.tokA, { aciklama: 'x', birim_fiyat: 1, odeyen: 'kimse' })).status, 400);
  assert.equal((await api('PATCH', `${ik}/${m.id}`, S.tokA, { odeyen: 'musteri', birim_fiyat: 2000 })).body.odeyen, 'musteri');
  assert.equal((await api('PATCH', `${ik}/${m.id}`, S.tokA, { odeyen: 'kimse' })).status, 400);
  assert.equal((await api('POST', `${ik}/toplu`, S.tokA, { kalemler: [{ aciklama: 'y', birim_fiyat: 1, odeyen: 'kimse' }] })).status, 400);

  const u = `/api/faturalar/${d.id}`;
  let r = await api('GET', u, S.tokA);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.ozet.pay, { sigorta: 9000, musteri: 3000, acente: 0, diger: 0 });
  assert.equal(r.body.ozet.muafiyet, 1000);
  assert.equal((await api('GET', u, S.tokB)).status, 403);

  // Servis faturaları: iki alıcı
  assert.equal((await api('POST', `${u}/servis`, S.tokA, { alici_tipi: 'sigorta', tutar: 100 })).status, 400); // alici_ad yok
  assert.equal((await api('POST', `${u}/servis`, S.tokA, { alici_tipi: 'banka', alici_ad: 'X', tutar: 100 })).status, 400);
  assert.equal((await api('POST', `${u}/servis`, S.tokA, { alici_tipi: 'sigorta', alici_ad: 'X', tutar: 100, kdv_orani: 18 })).status, 400);
  assert.equal((await api('POST', `${u}/servis`, S.tokA, { alici_tipi: 'sigorta', alici_ad: 'X', tutar: 100, alici_vkn: '12ab' })).status, 400);
  r = await api('POST', `${u}/servis`, S.tokA, {
    alici_tipi: 'sigorta', alici_ad: 'Test Sigorta', alici_vkn: '1234567890', fatura_no: 'SF-1', fatura_trh: '2026-09-30', tutar: 9000 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(Number(r.body.kdv_tutar), 1800);
  assert.equal(Number(r.body.toplam), 10800);
  assert.equal(r.body.odeme_durumu, 'bekliyor');
  const sf = r.body;
  r = await api('POST', `${u}/servis`, S.admin, { alici_tipi: 'musteri', alici_ad: 'Test Sahip', tutar: 2500, kdv_orani: 10 });
  assert.equal(r.status, 201);
  assert.equal(Number(r.body.toplam), 2750);

  r = await api('PATCH', `${u}/servis/${sf.id}`, S.tokA, { odenen_tutar: 5000, odeme_trh: '2026-10-01' });
  assert.equal(r.body.odeme_durumu, 'kismi');
  r = await api('PATCH', `${u}/servis/${sf.id}`, S.tokA, { odenen_tutar: 10800 });
  assert.equal(r.body.odeme_durumu, 'odendi');
  assert.equal((await api('PATCH', `${u}/servis/${sf.id}`, S.tokA, {})).status, 400);
  assert.equal((await api('PATCH', `${u}/servis/${sf.id}`, S.tokA, { alici_ad: '  ' })).status, 400);
  assert.equal((await api('PATCH', `${u}/servis/${sf.id}`, S.tokB, { tutar: 1 })).status, 403);
  assert.equal((await api('PATCH', `${u}/servis/abc`, S.tokA, { tutar: 1 })).status, 400);
  assert.equal((await api('PATCH', `${u}/servis/${crypto.randomUUID()}`, S.tokA, { tutar: 1 })).status, 404);

  // Dış hizmet faturası: kaleme bağlanabilir, başka dosyanın kalemine bağlanamaz
  const baska = (await yeniDosya()).body;
  const bk = (await api('POST', `/api/islemler/${baska.id}`, S.admin, { aciklama: 'b', birim_fiyat: 1 })).body;
  assert.equal((await api('POST', `${u}/dis`, S.tokA, { firma: 'Cam Usta', tutar: 100 })).status, 400); // hizmet yok
  assert.equal((await api('POST', `${u}/dis`, S.tokA, { firma: 'Cam Usta', hizmet: 'Ön cam', tutar: 'abc' })).status, 400);
  assert.equal((await api('POST', `${u}/dis`, S.tokA, { firma: 'Cam Usta', hizmet: 'Ön cam', tutar: 1, islem_id: bk.id })).status, 400);
  r = await api('POST', `${u}/dis`, S.tokA, { firma: 'Cam Usta', hizmet: 'Ön cam değişimi', islem_id: m.id, fatura_trh: '2026-09-20', tutar: 4500 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.fatura_trh, '2026-09-20');
  assert.equal(r.body.yansitildi, false);
  assert.equal(Number(r.body.toplam), 5400);
  const df = r.body;
  assert.equal((await api('PATCH', `${u}/dis/${df.id}`, S.tokA, { yansitildi: 'evet' })).status, 400);
  assert.equal((await api('PATCH', `${u}/dis/${df.id}`, S.tokA, { yansitildi: true })).body.yansitildi, true);

  r = await api('GET', u, S.admin);
  assert.equal(r.body.servis_faturalari.length, 2);
  assert.equal(r.body.dis_faturalar.length, 1);
  assert.deepEqual(r.body.ozet.faturalanan, { sigorta: 9000, musteri: 2500, acente: 0, diger: 0 });
  assert.deepEqual(r.body.ozet.kalan, { sigorta: 0, musteri: 500, acente: 0, diger: 0 });
  assert.equal(r.body.ozet.dis_toplam, 4500);
  assert.equal(r.body.ozet.tahsil_edilen, 10800);

  assert.equal((await api('DELETE', `${u}/dis/${df.id}`, S.tokB)).status, 403);
  assert.equal((await api('DELETE', `${u}/dis/${df.id}`, S.tokA)).status, 200);
  assert.equal((await api('DELETE', `${u}/dis/${df.id}`, S.tokA)).status, 404);
  assert.equal((await api('DELETE', `${u}/servis/${sf.id}`, S.tokA)).status, 200);

  // Servis muhasebe PATCH'i yapamaz (fatura artık servis_faturalari'nda)
  assert.equal((await api('PATCH', `/api/dosyalar/${d.id}`, S.tokA, { alt_tablo: 'muhasebe', alan: 'servis_fatura_no', deger: 'x' })).status, 403);
});

test('iş emri ve bölüm görevleri: usta bildirimi, onarım adımı açık görevle kapanmaz, pano', async () => {
  const d = (await yeniDosya()).body;
  assert.equal((await api('POST', `/api/dosyalar/${d.id}/servis-ata`, S.admin, { servis_id: S.srvA })).status, 200);
  let r = await api('GET', `/api/is-emirleri/${d.id}`, S.tokA);
  assert.equal(r.status, 200);
  assert.equal(r.body.is_emirleri.length, 1);
  const ana = r.body.is_emirleri[0];
  assert.equal(ana.no, 1);
  assert.equal(ana.tur, 'ana');
  assert.equal((await api('GET', `/api/is-emirleri/${d.id}`, S.tokB)).status, 403);

  const g = `/api/is-emirleri/${d.id}/${ana.id}/gorevler`;
  assert.equal((await api('POST', g, S.tokA, { bolum: 'bahce' })).status, 400);
  r = await api('POST', g, S.tokA, { bolum: 'boya', aciklama: 'Sağ ön çamurluk boya', sorumlu_usta: 'Mehmet Usta' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.adimlar.map((a) => a.ad), ['Hazırlık (macun, astar)', 'Boya', 'Pasta-cila']);
  const boya = r.body;
  const kap = (await api('POST', g, S.tokA, { bolum: 'kaporta' })).body;
  assert.equal((await api('POST', g, S.tokB, { bolum: 'kaporta' })).status, 403);

  // Durum: beklemede nedensiz 400, nedenli 200; tamam elle verilemez
  assert.equal((await api('PATCH', `${g}/${boya.id}`, S.tokA, { durum: 'beklemede' })).status, 400);
  r = await api('PATCH', `${g}/${boya.id}`, S.tokA, { durum: 'beklemede', bekleme_nedeni: 'Boya kodu bekleniyor' });
  assert.equal(r.status, 200);
  assert.equal(r.body.bekleme_nedeni, 'Boya kodu bekleniyor');
  assert.equal((await api('PATCH', `${g}/${boya.id}`, S.tokA, { durum: 'tamam' })).status, 400);

  // Pano: açık görevler, servis yalnız kendi
  r = await api('GET', '/api/is-emirleri/pano', S.tokA);
  assert.equal(r.status, 200);
  const panoBoya = r.body.gorevler.find((x) => x.id === boya.id);
  assert.ok(panoBoya && panoBoya.aktif_adim === 'Hazırlık (macun, astar)' && panoBoya.durum === 'beklemede');
  assert.ok(!(await api('GET', '/api/is-emirleri/pano', S.tokB)).body.gorevler.some((x) => x.dosya_id === d.id));

  // Adım tamamlama: usta adı zorunlu, tekrar 409, son adımla görev tamam
  const adim = (i) => `${g}/${boya.id}/adimlar/${boya.adimlar[i].id}/tamamla`;
  assert.equal((await api('POST', adim(0), S.tokA, {})).status, 400);
  r = await api('POST', adim(0), S.tokA, { usta: 'Mehmet Usta' });
  assert.equal(r.status, 200);
  assert.equal(r.body.durum, 'devam');
  assert.equal(r.body.bekleme_nedeni, null);
  assert.equal(r.body.adimlar[0].tamamlayan_usta, 'Mehmet Usta');
  assert.equal((await api('POST', adim(0), S.tokA, { usta: 'Mehmet Usta' })).status, 409);
  await api('POST', adim(1), S.tokA, { usta: 'Mehmet Usta' });
  r = await api('POST', adim(2), S.tokA, { usta: 'Ali Usta' });
  assert.equal(r.body.durum, 'tamam');
  assert.equal(r.body.bitiren_usta, 'Ali Usta');
  assert.equal((await api('PATCH', `${g}/${boya.id}`, S.tokA, { aciklama: 'x' })).status, 409);
  assert.equal((await api('DELETE', `${g}/${boya.id}`, S.tokA)).status, 409);

  // Onarım adımı: kaporta görevi açıkken kapanmaz
  const adimlar = (await api('GET', `/api/dosyalar/${d.id}`, S.admin)).body.onarim_adimlari;
  for (const a of adimlar.filter((x) => x.sira < 6))
    assert.equal((await api('POST', `/api/dosyalar/${d.id}/adim/${a.id}/tamamla`, S.tokA)).status, 200);
  const onarim = adimlar.find((x) => x.ad === 'Onarım');
  r = await api('POST', `/api/dosyalar/${d.id}/adim/${onarim.id}/tamamla`, S.tokA);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Kaporta \(1\)/);
  // Adımı bitmemiş görev silinebilir; sonra onarım kapanır
  assert.equal((await api('DELETE', `${g}/${kap.id}`, S.tokA)).status, 200);
  assert.equal((await api('POST', `/api/dosyalar/${d.id}/adim/${onarim.id}/tamamla`, S.tokA)).status, 200);
});

test('ek hasar: ana onaydan önce 409, ayrı onay turu, eksper/müşteri onaylayanı, bekleyen onaylar', async () => {
  const d = (await yeniDosya()).body;
  assert.equal((await api('POST', `/api/dosyalar/${d.id}/servis-ata`, S.admin, { servis_id: S.srvA })).status, 200);
  const ik = `/api/islemler/${d.id}`;
  await api('POST', ik, S.tokA, { aciklama: 'Kapı', birim_fiyat: 1000 });
  assert.equal((await api('POST', `/api/is-emirleri/${d.id}`, S.tokA, { aciklama: 'Gizli hasar' })).status, 409);
  assert.equal((await api('POST', `${ik}/onaya-gonder`, S.tokA)).status, 200);
  assert.equal((await api('POST', `${ik}/admin-karar`, S.admin, { karar: 'onaylandi', eksper_ad: 'Eksper Bey' })).status, 200);

  // Ek hasar iş emri
  assert.equal((await api('POST', `/api/is-emirleri/${d.id}`, S.tokA, {})).status, 400);
  let r = await api('POST', `/api/is-emirleri/${d.id}`, S.tokA, { aciklama: 'Söküm sonrası panel hasarı' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.no, 2);
  assert.equal(r.body.tur, 'ek_hasar');
  const ek = r.body;

  // Ana iş emrine artık kalem eklenmez; ek hasara eklenir
  assert.equal((await api('POST', ik, S.tokA, { aciklama: 'x', birim_fiyat: 1 })).status, 409);
  assert.equal((await api('POST', ik, S.tokA, { aciklama: 'x', birim_fiyat: 1, is_emri_id: crypto.randomUUID() })).status, 404);
  assert.equal((await api('POST', ik, S.tokA, { aciklama: 'Panel', birim_fiyat: 3000, is_emri_id: ek.id })).status, 201);
  assert.equal((await api('POST', ik, S.tokA, { aciklama: 'Jant (sigorta harici)', birim_fiyat: 500, odeyen: 'musteri', is_emri_id: ek.id })).status, 201);
  assert.equal((await api('POST', `${ik}/onaya-gonder`, S.tokA, { is_emri_id: ek.id })).status, 200);

  // Liste: bekleyen tur var -> dosya "bekliyor"
  r = await api('GET', `/api/dosyalar?arama=${encodeURIComponent(d.dosya_no)}`, S.admin);
  assert.equal(r.body.dosyalar[0].onay_durumu, 'bekliyor');
  r = await api('GET', '/api/is-emirleri/bekleyen-onaylar', S.admin);
  const bo = r.body.onaylar.find((o) => o.id === ek.id);
  assert.ok(bo && bo.no === 2 && Number(bo.tutar) === 3500 && bo.gun === 0);
  assert.equal((await api('GET', '/api/is-emirleri/bekleyen-onaylar', S.tokA)).status, 403);

  // Karar: dosyada eksper yok, sahip var -> müşteri adı sahipten gelir, eksper adı zorunlu
  const karar = (b) => api('POST', `${ik}/admin-karar`, S.admin, { is_emri_id: ek.id, ...b });
  assert.equal((await karar({ karar: 'onaylandi' })).status, 400);
  assert.equal((await karar({ karar: 'onaylandi', eksper_ad: 'Eksper Bey' })).status, 200);
  r = await api('GET', ik, S.admin);
  const panel = r.body.kalemler.find((k) => k.aciklama === 'Panel');
  const jant = r.body.kalemler.find((k) => k.aciklama.startsWith('Jant'));
  assert.equal(panel.onaylayan_tip, 'eksper');
  assert.equal(panel.onaylayan_ad, 'Eksper Bey');
  assert.equal(jant.onaylayan_tip, 'musteri');
  assert.equal(jant.onaylayan_ad, 'Test Sahip');
  assert.equal(r.body.is_emirleri.find((x) => x.id === ek.id).onay_durumu, 'onaylandi');
  // Onaylanan tutar tüm turların toplamı
  r = await api('GET', `/api/dosyalar/${d.id}`, S.admin);
  assert.equal(Number(r.body.muhasebe.onaylanan_tutar), 4500);

  // İptal: yalnız onaya gitmemiş ek hasar
  const ek2 = (await api('POST', `/api/is-emirleri/${d.id}`, S.tokA, { aciklama: 'Yanlış bildirim' })).body;
  assert.equal(ek2.no, 3);
  assert.equal((await api('PATCH', `/api/is-emirleri/${d.id}/${ek.id}`, S.tokA, { durum: 'iptal' })).status, 409);
  assert.equal((await api('PATCH', `/api/is-emirleri/${d.id}/${ek2.id}`, S.tokA, { durum: 'iptal' })).status, 200);
  assert.equal((await api('POST', ik, S.tokA, { aciklama: 'x', birim_fiyat: 1, is_emri_id: ek2.id })).status, 409);

  // Dış fatura ek hasar iş emrine bağlanabilir; verilmezse ana iş emri
  r = await api('POST', `/api/faturalar/${d.id}/dis`, S.tokA, { firma: 'Jant Ustası', hizmet: 'Jant düzeltme', tutar: 400, is_emri_id: ek.id });
  assert.equal(r.status, 201);
  assert.equal(r.body.is_emri_id, ek.id);
  r = await api('POST', `/api/faturalar/${d.id}/dis`, S.tokA, { firma: 'X', hizmet: 'Y', tutar: 1 });
  assert.equal(r.body.is_emri_id, (await api('GET', `/api/is-emirleri/${d.id}`, S.tokA)).body.is_emirleri[0].id);
});

// multipart yükleme (Node 22 FormData + Blob)
const yukleIstek = async (url, token, { bayt, mime, ad = 'dosya.jpg', alanlar = {} }) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(alanlar)) fd.append(k, v);
  if (bayt) fd.append('dosya', new Blob([bayt], { type: mime }), ad);
  const res = await fetch(`${BASE}${url}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
};

test('fotoğraflar: yükle, imzalı URL ile görüntüle, tür/boyut sınırı, yetki, düzenle, sil', async () => {
  const d = (await yeniDosya()).body;
  assert.equal((await api('POST', `/api/dosyalar/${d.id}/servis-ata`, S.admin, { servis_id: S.srvA })).status, 200);
  const u = `/api/fotograflar/${d.id}`;
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2000)]);

  let r = await yukleIstek(u, S.tokA, { bayt: jpeg, mime: 'image/jpeg', ad: 'sağ ön çamurluk.jpg', alanlar: { kategori: 'onarim' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.etiket, 'sağ ön çamurluk');
  assert.equal(r.body.kategori, 'onarim');
  assert.equal(r.body.boyut_byte, jpeg.length);
  const foto = r.body;

  // İmzalı URL çalışır, imza bozulunca 403
  let g = await fetch(foto.url);
  assert.equal(g.status, 200);
  assert.ok(Buffer.from(await g.arrayBuffer()).equals(jpeg));
  assert.equal((await fetch(foto.url.replace(/i=[0-9a-f]+/, 'i=' + '0'.repeat(32)))).status, 403);
  assert.equal((await fetch(foto.url.replace(/b=\d+/, 'b=1'))).status, 403);

  assert.equal((await yukleIstek(u, S.tokA, { bayt: Buffer.from('x'), mime: 'text/plain', ad: 'a.txt' })).status, 400);
  assert.equal((await yukleIstek(u, S.tokA, { bayt: Buffer.from('%PDF'), mime: 'application/pdf', ad: 'a.pdf' })).status, 400);
  assert.equal((await yukleIstek(u, S.tokA, { bayt: Buffer.alloc(4 * 1024 * 1024 + 10), mime: 'image/jpeg' })).status, 413);
  assert.equal((await yukleIstek(u, S.tokA, {})).status, 400);
  assert.equal((await yukleIstek(u, S.tokA, { bayt: jpeg, mime: 'image/jpeg', alanlar: { kategori: 'tatil' } })).status, 400);
  assert.equal((await yukleIstek(u, S.tokB, { bayt: jpeg, mime: 'image/jpeg' })).status, 403);

  r = await api('GET', u, S.admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.fotograflar.length, 1);
  assert.equal(r.body.fotograflar[0].yukleyen_rol, 'servis');
  assert.ok(r.body.fotograflar[0].url.includes('/api/medya/'));
  assert.equal((await api('GET', u, S.tokB)).status, 403);

  r = await api('PATCH', `${u}/${foto.id}`, S.tokA, { etiket: 'Sağ ön (boya sonrası)', kategori: 'teslimat' });
  assert.equal(r.status, 200);
  assert.equal(r.body.kategori, 'teslimat');
  assert.equal((await api('PATCH', `${u}/${foto.id}`, S.tokA, { kategori: 'x' })).status, 400);

  assert.equal((await api('DELETE', `${u}/${foto.id}`, S.tokB)).status, 403);
  // Admin'in yüklediği fotoğrafı servis silemez, admin siler
  const adminFoto = (await yukleIstek(u, S.admin, { bayt: jpeg, mime: 'image/jpeg', ad: 'kaza.jpg' })).body;
  assert.equal(adminFoto.kategori, 'kaza');
  assert.equal((await api('DELETE', `${u}/${adminFoto.id}`, S.tokA)).status, 403);
  assert.equal((await api('DELETE', `${u}/${adminFoto.id}`, S.admin)).status, 200);
  assert.equal((await api('DELETE', `${u}/${foto.id}`, S.tokA)).status, 200);
  assert.equal((await api('DELETE', `${u}/${foto.id}`, S.tokA)).status, 404);
  assert.equal((await fetch(foto.url)).status, 404); // depodan da silindi
});

test('evrak: varsayılan liste, belge yükle (PDF), durum, ekle/sil yetkisi', async () => {
  const d = (await yeniDosya()).body;
  assert.equal((await api('POST', `/api/dosyalar/${d.id}/servis-ata`, S.admin, { servis_id: S.srvA })).status, 200);
  const u = `/api/evrak/${d.id}`;
  let r = await api('GET', u, S.tokA);
  assert.equal(r.status, 200);
  assert.equal(r.body.evrak.length, 9);
  assert.equal(r.body.evrak[0].ad, 'Kaza Tespit Tutanağı');
  assert.ok(r.body.evrak.every((e) => e.durum === 'bekliyor' && e.url === null));
  const proforma = r.body.evrak.find((e) => e.ad.startsWith('Maliyet Teklifi'));

  const pdf = Buffer.from('%PDF-1.4\n% test\n');
  r = await yukleIstek(`${u}/${proforma.id}/yukle`, S.tokA, { bayt: pdf, mime: 'application/pdf', ad: 'proforma.pdf' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.durum, 'tamam');
  assert.equal(r.body.dosya_adi, 'proforma.pdf');
  assert.ok(r.body.teslim_trh);
  const g = await fetch(r.body.url);
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('content-type'), 'application/pdf');
  assert.equal((await yukleIstek(`${u}/${crypto.randomUUID()}/yukle`, S.tokA, { bayt: pdf, mime: 'application/pdf' })).status, 404);
  assert.equal((await yukleIstek(`${u}/${proforma.id}/yukle`, S.tokB, { bayt: pdf, mime: 'application/pdf' })).status, 403);

  r = await api('PATCH', `${u}/${proforma.id}`, S.admin, { durum: 'eksik', uyari_not: 'İmzasız' });
  assert.equal(r.body.durum, 'eksik');
  assert.equal(r.body.uyari_not, 'İmzasız');
  assert.equal((await api('PATCH', `${u}/${proforma.id}`, S.admin, { durum: 'kayip' })).status, 400);

  r = await api('POST', u, S.tokA, { ad: 'Çekici Faturası', kaynak: 'Servis' });
  assert.equal(r.status, 201);
  assert.equal(r.body.sira, 10);
  assert.equal((await api('POST', u, S.tokA, { ad: '  ' })).status, 400);
  assert.equal((await api('DELETE', `${u}/${r.body.id}`, S.tokA)).status, 403);
  assert.equal((await api('DELETE', `${u}/${r.body.id}`, S.admin)).status, 200);
});

test('dosya silinince audit_log kaydı kalır, bağ NULL olur (006)', async () => {
  const d = (await yeniDosya()).body;
  const once = (await sql('SELECT COUNT(*)::int n FROM audit_log WHERE dosya_id=$1', [d.id])).rows[0].n;
  assert.ok(once >= 1);
  await sql('DELETE FROM dosyalar WHERE id=$1', [d.id]);
  const kalan = (await sql(`SELECT COUNT(*)::int n FROM audit_log WHERE dosya_id IS NULL AND detay->>'dosya_no'=$1`, [d.dosya_no])).rows[0].n;
  assert.equal(kalan, 1);
});

test('mesajlar: admin ↔ servis, okunmamış sayısı, okundu işareti, yetki', async () => {
  const d = (await yeniDosya()).body;
  const u = `/api/mesajlar/${d.id}`;
  assert.equal((await api('POST', u, S.admin, { mesaj: 'Servis yok' })).status, 409);
  assert.equal((await api('POST', `/api/dosyalar/${d.id}/servis-ata`, S.admin, { servis_id: S.srvA })).status, 200);

  assert.equal((await api('POST', u, S.admin, { mesaj: '   ' })).status, 400);
  assert.equal((await api('POST', u, S.admin, { mesaj: 'x'.repeat(2001) })).status, 400);
  let r = await api('POST', u, S.admin, { mesaj: 'Proforma yarın gelir mi?' });
  assert.equal(r.status, 201);
  assert.equal(r.body.hedef_rol, 'servis');
  assert.equal((await api('POST', u, S.tokB, { mesaj: 'x' })).status, 403);

  // Servis: okunmamış 1, açınca 0; admin tarafında servis cevabı okunmamış
  r = await api('GET', '/api/mesajlar/okunmamis', S.tokA);
  assert.equal(r.body.dosyalar[d.id], 1);
  r = await api('GET', u, S.tokA);
  assert.equal(r.body.mesajlar.length, 1);
  assert.equal(r.body.mesajlar[0].gonderen_rol, 'admin');
  assert.equal((await api('GET', '/api/mesajlar/okunmamis', S.tokA)).body.dosyalar[d.id], undefined);
  assert.equal((await api('POST', u, S.tokA, { mesaj: 'Evet, öğleden sonra.' })).body.hedef_rol, 'admin');
  assert.equal((await api('GET', '/api/mesajlar/okunmamis', S.admin)).body.dosyalar[d.id], 1);
  // isaretle=hayir okundu yapmaz
  assert.equal((await api('GET', `${u}?isaretle=hayir`, S.admin)).body.mesajlar.length, 2);
  assert.equal((await api('GET', '/api/mesajlar/okunmamis', S.admin)).body.dosyalar[d.id], 1);
  assert.ok(!('dosyalar' in ((await api('GET', '/api/mesajlar/okunmamis', S.tokB)).body.dosyalar)) || (await api('GET', '/api/mesajlar/okunmamis', S.tokB)).body.dosyalar[d.id] === undefined);
  // Admin okuyunca servisin mesajı okundu
  r = await api('GET', u, S.admin);
  assert.equal(r.body.mesajlar.length, 2);
  assert.equal((await api('GET', '/api/mesajlar/okunmamis', S.admin)).body.dosyalar[d.id], undefined);
  assert.equal((await api('GET', u, S.tokB)).status, 403);
});
