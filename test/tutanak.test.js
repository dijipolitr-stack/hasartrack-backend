// Araç kabul ve teslim tutanağı testleri. panel-api.test.js ile aynı ortam değişkenleri; --test-concurrency=1 ile çalıştırın.
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
const PORT = 3995;
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = crypto.randomBytes(4).toString('hex');
const SIFRE = crypto.randomBytes(8).toString('hex');
if (!DB || !JWT || !PASS) throw new Error('TEST_DATABASE_URL, TEST_JWT_SECRET, TEST_ADMIN_PASSWORD gerekli');

const baseEnv = () => {
  const e = { ...process.env };
  for (const k of ['DATABASE_URL', 'DATABASE_SSL', 'JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'FRONTEND_URL', 'NODE_ENV', 'PORT', 'RATE_LIMIT_MAX']) delete e[k];
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
  return { status: res.status, body: json };
};

const S = {};
const KONTROL_TAM = { 'Onarılan bölgeler kontrol edildi': 'tamam', 'Boya ve renk uyumu kontrol edildi': 'tamam', 'Göstergede uyarı lambası yok': 'tamam', 'Araç temizlendi': 'yok', 'Fatura ve evraklar teslim edildi': 'tamam', 'Anahtar teslim edildi': 'tamam' };
const KABUL = { km: 45200, yakit_yuzde: 50, aksesuarlar: { Ruhsat: true, Stepne: true, 'Yedek anahtar': false }, aciklama: 'Sağ arka çamurlukta eski çizik', musteri_ad: 'Ayşe Demir', personel_ad: 'Kemal Usta' };
const TESLIM = { km: 45230, yakit_yuzde: 50, aksesuarlar: { Ruhsat: true, Stepne: true }, kontrol: KONTROL_TAM, musteri_ad: 'Ayşe Demir', personel_ad: 'Kemal Usta' };
const yeniDosya = async () => {
  const d = await api('POST', '/api/dosyalar', S.admin, { arac: { plaka: '34TTN' + Math.floor(Math.random() * 900 + 100), marka: 'Renault', model: 'Clio', yil: 2021 }, sahip: { adSoyad: 'Ayşe Demir', telefon: '05321112233' }, sigorta: { sirketAd: 'S', hasarNo: 'T-' + RUN }, kaza: { tarih: '2026-03-01' } });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.equal((await api('POST', `/api/dosyalar/${d.body.id}/servis-ata`, S.admin, { servis_id: S.srvA })).status, 200);
  return d.body.id;
};
const adimlar = async (id) => (await api('GET', `/api/dosyalar/${id}`, S.admin)).body.onarim_adimlari;

test('hazırlık: migrate, seed, sunucu, admin + iki servis + dosya', async () => {
  for (const [s, extra] of [['src/db/migrate.js', {}], ['src/db/seed.js', { ADMIN_PASSWORD: PASS }]]) {
    const r = spawnSync(process.execPath, [s], { cwd: ROOT, env: { ...baseEnv(), DATABASE_URL: DB, ...extra }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  srv = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...baseEnv(), DATABASE_URL: DB, JWT_SECRET: JWT, PORT: String(PORT), FRONTEND_URL: 'http://localhost:3001', RATE_LIMIT_MAX: '5000' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  S.admin = (await api('POST', '/api/auth/login', null, { email: 'admin@hasartrack.com', sifre: PASS })).body.token;
  for (const k of ['A', 'B']) {
    const r = await api('POST', '/api/servisler', S.admin, { ad: `Tutanak Servis ${k} ${RUN}`, kullanici_email: `tutanak-${k}-${RUN}@example.com`, sifre: SIFRE });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    S[`srv${k}`] = r.body.id;
    S[`tok${k}`] = (await api('POST', '/api/auth/servis-login', null, { servis_id: r.body.id, sifre: SIFRE })).body.token;
  }
  S.dosya = await yeniDosya();
});

test('GET: boş tutanak + seçenek listeleri; yetki 401/403', async () => {
  const u = `/api/tutanaklar/${S.dosya}`;
  assert.equal((await api('GET', u)).status, 401);
  assert.equal((await api('GET', u, S.tokB)).status, 403);
  const r = await api('GET', u, S.tokA);
  assert.equal(r.status, 200);
  assert.equal(r.body.kabul, null); assert.equal(r.body.teslim, null);
  assert.ok(r.body.secenekler.aksesuarlar.includes('Ruhsat'));
  assert.equal(r.body.secenekler.teslim_kontrol.length, 6);
  assert.equal((await api('PUT', `${u}/kabul`, S.tokB, KABUL)).status, 403);
});

test('kabul: doğrulama 400, kayıt, düzeltme, servise giriş tarihi dolar', async () => {
  const u = `/api/tutanaklar/${S.dosya}/kabul`;
  for (const hatali of [{ ...KABUL, km: undefined }, { ...KABUL, km: -1 }, { ...KABUL, km: 'abc' }, { ...KABUL, yakit_yuzde: 101 },
    { ...KABUL, musteri_ad: '  ' }, { ...KABUL, personel_ad: undefined }, { ...KABUL, aksesuarlar: { Uydurma: true } },
    { ...KABUL, aksesuarlar: ['Ruhsat'] }, { ...KABUL, musteri_ad: 'x'.repeat(101) }])
    assert.equal((await api('PUT', u, S.tokA, hatali)).status, 400, JSON.stringify(hatali).slice(0, 80));

  let r = await api('PUT', u, S.tokA, KABUL);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.kabul.km, 45200);
  assert.deepEqual(r.body.kabul.aksesuarlar, { Ruhsat: true, Stepne: true, 'Yedek anahtar': false });
  assert.equal(r.body.kabul.musteri_ad, 'Ayşe Demir');
  const giris = (await api('GET', `/api/dosyalar/${S.dosya}`, S.admin)).body.onarim_merkezi.arac_giris_trh;
  assert.match(giris, /^\d{4}-\d{2}-\d{2}$/);

  // Düzeltme aynı kaydı günceller, servise giriş tarihini değiştirmez
  await sql("UPDATE onarim_merkezi SET arac_giris_trh='2026-09-30' WHERE dosya_id=$1", [S.dosya]);
  r = await api('PUT', u, S.admin, { ...KABUL, km: 45210 });
  assert.equal(r.status, 200);
  assert.equal(r.body.kabul.km, 45210);
  assert.equal((await sql("SELECT count(*)::int n FROM arac_tutanaklari WHERE dosya_id=$1", [S.dosya])).rows[0].n, 1);
  assert.equal((await api('GET', `/api/dosyalar/${S.dosya}`, S.admin)).body.onarim_merkezi.arac_giris_trh, '2026-09-30');
});

test('teslim: kabulsüz 409, eksik kontrol 400, bitmemiş adım 409, km düşük 400, eksik aksesuar açıklama ister', async () => {
  const d2 = await yeniDosya();
  assert.equal((await api('POST', `/api/tutanaklar/${d2}/teslim`, S.tokA, TESLIM)).status, 409, 'kabulsüz');

  const u = `/api/tutanaklar/${S.dosya}/teslim`;
  const { 'Araç temizlendi': _, ...eksikKontrol } = KONTROL_TAM;
  let r = await api('POST', u, S.tokA, { ...TESLIM, kontrol: eksikKontrol });
  assert.equal(r.status, 400); assert.match(r.body.error, /Araç temizlendi/);
  assert.equal((await api('POST', u, S.tokA, { ...TESLIM, kontrol: { ...KONTROL_TAM, 'Araç temizlendi': 'eksik' } })).status, 400);

  r = await api('POST', u, S.tokA, TESLIM);
  assert.equal(r.status, 409, 'adımlar bitmedi'); assert.match(r.body.error, /Bitmemiş adım/);

  // Teslim dışındaki adımları bitir
  for (const a of (await adimlar(S.dosya)).filter((x) => x.ad !== 'Araç Teslimi'))
    assert.equal((await api('POST', `/api/dosyalar/${S.dosya}/adim/${a.id}/tamamla`, S.tokA)).status, 200, a.ad);
  // Teslim adımı elle kapanmaz
  const teslimAdimi = (await adimlar(S.dosya)).find((x) => x.ad === 'Araç Teslimi');
  r = await api('POST', `/api/dosyalar/${S.dosya}/adim/${teslimAdimi.id}/tamamla`, S.admin);
  assert.equal(r.status, 409); assert.match(r.body.error, /Teslim tutanağı/);

  assert.equal((await api('POST', u, S.tokA, { ...TESLIM, km: 45000 })).status, 400, 'km düşük');
  r = await api('POST', u, S.tokA, { ...TESLIM, aksesuarlar: { Ruhsat: true } });
  assert.equal(r.status, 400); assert.match(r.body.error, /Stepne/);
  assert.equal((await api('POST', u, S.tokB, TESLIM)).status, 403);
  assert.equal((await sql("SELECT count(*)::int n FROM arac_tutanaklari WHERE dosya_id=$1 AND tip='teslim'", [S.dosya])).rows[0].n, 0, 'hatalı denemeler kayıt bırakmaz');
});

test('teslim: kayıt teslim adımını tamamlar, SMS kuyruğu, ikinci teslim ve kabul düzeltme 409', async () => {
  const u = `/api/tutanaklar/${S.dosya}/teslim`;
  const r = await api('POST', u, S.tokA, { ...TESLIM, aksesuarlar: { Ruhsat: true }, aciklama: 'Stepne müşteri isteğiyle serviste kaldı' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.teslim.km, 45230);
  assert.equal(r.body.teslim.kontrol['Araç temizlendi'], 'yok');
  const a = await adimlar(S.dosya);
  assert.ok(a.every((x) => x.durum === 'tamamlandi'), 'tüm adımlar tamam');
  assert.equal((await sql("SELECT count(*)::int n FROM sms_log WHERE dosya_id=$1 AND adim_adi='Araç Teslimi'", [S.dosya])).rows[0].n, 1);

  assert.equal((await api('POST', u, S.admin, TESLIM)).status, 409, 'ikinci teslim');
  assert.equal((await api('PUT', `/api/tutanaklar/${S.dosya}/kabul`, S.admin, KABUL)).status, 409, 'kabul kilitli');
  const g = await api('GET', `/api/tutanaklar/${S.dosya}`, S.admin);
  assert.ok(g.body.kabul && g.body.teslim);
  assert.equal(g.body.kabul.km, 45210);
});

test('teslim adımı önceden tamamlanmış eski dosyada tutanak yine kaydedilir', async () => {
  const d = await yeniDosya();
  await sql("UPDATE onarim_adimlari SET durum='tamamlandi', tamamlanma_trh=NOW() WHERE dosya_id=$1", [d]);
  assert.equal((await api('PUT', `/api/tutanaklar/${d}/kabul`, S.tokA, KABUL)).status, 200);
  const r = await api('POST', `/api/tutanaklar/${d}/teslim`, S.tokA, TESLIM);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await sql("SELECT count(*)::int n FROM sms_log WHERE dosya_id=$1", [d])).rows[0].n, 0, 'adım zaten tamamdı, SMS eklenmez');
});
