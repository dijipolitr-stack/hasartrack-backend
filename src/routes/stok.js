// Servis deposu ve parça siparişleri. Servis yalnız kendi kayıtlarını yazar/okur; admin okur
// (?servis_id=... ile servis seçer). Stok miktarı hareketlerden hesaplanır.
const router = require('express').Router();
const { query, withTransaction } = require('../db');
const { authMiddleware, requireRole, notMusteri, dosyaErisim } = require('../middleware/auth');
const { uuidParam, httpHata, UUID_RE, alanDegeri } = require('../lib/dogrula');

router.use(authMiddleware);
router.param('dosyaId', uuidParam('dosyaId'));
router.param('id', uuidParam('id'));
const yazar = requireRole('servis');

// Hangi servisin deposu: servis kendi, admin ?servis_id
const kapsam = (req) => {
  if (req.user.rol === 'servis') {
    if (!req.user.servis_id) throw httpHata(403, 'Servis hesabı bir servise bağlı değil');
    return req.user.servis_id;
  }
  if (req.user.rol === 'admin') {
    const id = req.query.servis_id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw httpHata(400, 'servis_id gerekli');
    return id;
  }
  throw httpHata(403, 'Bu işlem için yetkiniz yok');
};

const metin = (v, ad, maks, zorunlu) => {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
    if (zorunlu) throw httpHata(400, `${ad} gerekli`);
    return null;
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw httpHata(400, `${ad} geçersiz`);
  const t = String(v).trim();
  if (t.length > maks) throw httpHata(400, `${ad} en fazla ${maks} karakter olabilir`);
  return t;
};
const sayi = (v, ad, { zorunlu, sifirOlur, eksiOlur } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (zorunlu) throw httpHata(400, `${ad} gerekli`);
    return null;
  }
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || Math.abs(n) >= 1e8 || (!eksiOlur && n < 0) || (!sifirOlur && n === 0))
    throw httpHata(400, `${ad} geçerli bir sayı olmalı`);
  return Math.round(n * 100) / 100;
};
const tarih = (v, ad) => alanDegeri({ t: 'tarih' }, v, ad);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Kayıt bu servise mi ait (yoksa 404)
const sahiplik = async (db, tablo, id, servisId, ad) => {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw httpHata(400, `Geçersiz ${ad}`);
  const { rows: [r] } = await db.query(`SELECT * FROM ${tablo} WHERE id=$1 AND servis_id=$2`, [id, servisId]);
  if (!r) throw httpHata(404, `${ad[0].toLocaleUpperCase('tr-TR')}${ad.slice(1)} bulunamadı`);
  return r;
};
// Dosya bu servise atanmış olmalı
const dosyaKontrol = async (db, dosyaId, servisId) => {
  if (dosyaId === undefined || dosyaId === null || dosyaId === '') return null;
  if (typeof dosyaId !== 'string' || !UUID_RE.test(dosyaId)) throw httpHata(400, 'Geçersiz dosya');
  const { rows: [d] } = await db.query('SELECT id FROM dosyalar WHERE id=$1 AND atanan_servis=$2', [dosyaId, servisId]);
  if (!d) throw httpHata(404, 'Dosya bulunamadı veya bu servise atanmamış');
  return d.id;
};

const STOK_SQL = `
  SELECT p.*,
    COALESCE(SUM(CASE WHEN h.tip='cikis' THEN -h.adet ELSE h.adet END), 0) AS stok,
    ROUND(SUM(h.adet*h.birim_maliyet) FILTER (WHERE h.tip='giris' AND h.birim_maliyet IS NOT NULL)
      / NULLIF(SUM(h.adet) FILTER (WHERE h.tip='giris' AND h.birim_maliyet IS NOT NULL), 0), 2) AS ort_maliyet,
    (SELECT COALESCE(SUM(k.adet-k.gelen_adet),0) FROM siparis_kalemleri k
       JOIN parca_siparisleri s ON s.id=k.siparis_id
      WHERE k.parca_id=p.id AND s.durum IN ('siparis','yolda','kismi')) AS yoldaki
  FROM parcalar p LEFT JOIN stok_hareketleri h ON h.parca_id=p.id`;
const parcaStok = async (db, parcaId) => {
  const { rows: [r] } = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN tip='cikis' THEN -adet ELSE adet END),0) AS stok FROM stok_hareketleri WHERE parca_id=$1`, [parcaId]);
  return Number(r.stok);
};

// Siparişleri kalemleriyle döner
const siparisleriGetir = async (where, params) => {
  const { rows: sip } = await query(`
    SELECT s.*, t.ad AS tedarikci_ad, a.plaka, d.dosya_no,
      (s.durum IN ('siparis','yolda','kismi') AND s.tahmini_gelis < CURRENT_DATE) AS geciken
    FROM parca_siparisleri s
    LEFT JOIN tedarikciler t ON t.id=s.tedarikci_id
    LEFT JOIN dosyalar d ON d.id=s.dosya_id
    LEFT JOIN arac a ON a.dosya_id=s.dosya_id
    WHERE ${where} ORDER BY s.siparis_trh DESC, s.created_at DESC LIMIT 300`, params);
  if (!sip.length) return [];
  const { rows: kal } = await query(
    `SELECT k.*, p.ad AS parca_ad, p.birim FROM siparis_kalemleri k JOIN parcalar p ON p.id=k.parca_id
     WHERE k.siparis_id = ANY($1) ORDER BY p.ad`, [sip.map((s) => s.id)]);
  return sip.map((s) => {
    const kalemler = kal.filter((k) => k.siparis_id === s.id);
    const toplam = kalemler.reduce((t, k) => t + Number(k.adet) * Number(k.birim_fiyat || 0), 0);
    return { ...s, kalemler, toplam: Math.round(toplam * 100) / 100 };
  });
};

// GET /api/stok/ozet — depo, siparişler, tedarikçiler, son hareketler (tek çağrı)
router.get('/ozet', notMusteri, async (req, res, next) => {
  try {
    if (req.user.rol === 'acente') throw httpHata(403, 'Bu işlem için yetkiniz yok');
    const sid = kapsam(req);
    const [{ rows: parcalar }, { rows: tedarikciler }, siparisler, { rows: hareketler }] = await Promise.all([
      query(`${STOK_SQL} WHERE p.servis_id=$1 GROUP BY p.id ORDER BY p.aktif DESC, p.ad`, [sid]),
      query('SELECT * FROM tedarikciler WHERE servis_id=$1 ORDER BY aktif DESC, ad', [sid]),
      siparisleriGetir('s.servis_id=$1', [sid]),
      query(`SELECT h.*, p.ad AS parca_ad, p.birim, a.plaka, d.dosya_no, k.ad_soyad AS kullanici_ad
             FROM stok_hareketleri h JOIN parcalar p ON p.id=h.parca_id
             LEFT JOIN dosyalar d ON d.id=h.dosya_id LEFT JOIN arac a ON a.dosya_id=h.dosya_id
             LEFT JOIN kullanicilar k ON k.id=h.kullanici_id
             WHERE h.servis_id=$1 ORDER BY h.created_at DESC LIMIT 200`, [sid]),
    ]);
    res.json({
      parcalar: parcalar.map((p) => ({ ...p, kritik: p.aktif && Number(p.stok) <= Number(p.min_stok) })),
      tedarikciler, siparisler, hareketler,
    });
  } catch (err) { next(err); }
});

// GET /api/stok/dosya/:dosyaId — bu araç için siparişler ve takılan parçalar
router.get('/dosya/:dosyaId', notMusteri, dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const siparisler = await siparisleriGetir('s.dosya_id=$1', [dosyaId]);
    const { rows: takilan } = await query(
      `SELECT h.id, h.adet, h.aciklama, h.created_at, p.ad AS parca_ad, p.birim, p.oem_no,
         (SELECT ROUND(SUM(g.adet*g.birim_maliyet)/NULLIF(SUM(g.adet),0),2) FROM stok_hareketleri g
           WHERE g.parca_id=p.id AND g.tip='giris' AND g.birim_maliyet IS NOT NULL) AS ort_maliyet
       FROM stok_hareketleri h JOIN parcalar p ON p.id=h.parca_id
       WHERE h.dosya_id=$1 AND h.tip='cikis' ORDER BY h.created_at`, [dosyaId]);
    res.json({ siparisler, takilan });
  } catch (err) { next(err); }
});

// ── PARÇA KARTLARI ───────────────────────────────────────
const parcaAlanlari = (b, kismi) => {
  const d = {};
  const al = (k, fn) => { if (!kismi || own(b, k)) d[k] = fn(b[k]); };
  al('ad', (v) => metin(v, 'Parça adı', 200, true));
  al('oem_no', (v) => metin(v, 'OEM no', 60));
  al('kategori', (v) => metin(v, 'Kategori', 50));
  al('birim', (v) => metin(v, 'Birim', 20) || 'Adet');
  al('min_stok', (v) => sayi(v, 'Asgari stok', { sifirOlur: true }) ?? 0);
  if (kismi && own(b, 'aktif')) {
    if (typeof b.aktif !== 'boolean') throw httpHata(400, 'aktif true/false olmalı');
    d.aktif = b.aktif;
  }
  return d;
};
const ekle = async (db, tablo, servisId, d) => {
  const k = Object.keys(d);
  const { rows: [r] } = await db.query(
    `INSERT INTO ${tablo} (servis_id, ${k.map((x) => `"${x}"`).join(', ')})
     VALUES ($1, ${k.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`, [servisId, ...k.map((x) => d[x])]);
  return r;
};
const guncelle = async (tablo, id, servisId, d) => {
  const k = Object.keys(d);
  if (!k.length) throw httpHata(400, 'Güncellenecek alan yok');
  const { rows: [r] } = await query(
    `UPDATE ${tablo} SET ${k.map((x, i) => `"${x}"=$${i + 1}`).join(', ')}
     WHERE id=$${k.length + 1} AND servis_id=$${k.length + 2} RETURNING *`, [...k.map((x) => d[x]), id, servisId]);
  if (!r) throw httpHata(404, 'Kayıt bulunamadı');
  return r;
};

router.post('/parcalar', yazar, async (req, res, next) => {
  try { res.status(201).json(await ekle({ query }, 'parcalar', kapsam(req), parcaAlanlari(req.body || {}, false))); }
  catch (err) { next(err); }
});
router.patch('/parcalar/:id', yazar, async (req, res, next) => {
  try { res.json(await guncelle('parcalar', req.params.id, kapsam(req), parcaAlanlari(req.body || {}, true))); }
  catch (err) { next(err); }
});

// ── TEDARİKÇİLER ─────────────────────────────────────────
const tedarikciAlanlari = (b, kismi) => {
  const d = {};
  const al = (k, fn) => { if (!kismi || own(b, k)) d[k] = fn(b[k]); };
  al('ad', (v) => metin(v, 'Tedarikçi adı', 150, true));
  al('telefon', (v) => metin(v, 'Telefon', 30));
  al('email', (v) => metin(v, 'E-posta', 150));
  al('vkn', (v) => {
    const t = metin(v, 'VKN', 11);
    if (t && !/^\d{10,11}$/.test(t)) throw httpHata(400, 'VKN 10 veya 11 haneli olmalı');
    return t;
  });
  al('notlar', (v) => metin(v, 'Not', 1000));
  if (kismi && own(b, 'aktif')) {
    if (typeof b.aktif !== 'boolean') throw httpHata(400, 'aktif true/false olmalı');
    d.aktif = b.aktif;
  }
  return d;
};
router.post('/tedarikciler', yazar, async (req, res, next) => {
  try { res.status(201).json(await ekle({ query }, 'tedarikciler', kapsam(req), tedarikciAlanlari(req.body || {}, false))); }
  catch (err) { next(err); }
});
router.patch('/tedarikciler/:id', yazar, async (req, res, next) => {
  try { res.json(await guncelle('tedarikciler', req.params.id, kapsam(req), tedarikciAlanlari(req.body || {}, true))); }
  catch (err) { next(err); }
});

// ── SİPARİŞLER ───────────────────────────────────────────
// POST /api/stok/siparisler { tedarikci_id?, dosya_id?, siparis_no?, siparis_trh?, tahmini_gelis?, notlar?,
//   kalemler: [{ parca_id | yeni_parca: {ad, oem_no?, kategori?, birim?}, adet, birim_fiyat? }] }
router.post('/siparisler', yazar, async (req, res, next) => {
  try {
    const sid = kapsam(req);
    const b = req.body || {};
    if (!Array.isArray(b.kalemler) || !b.kalemler.length) throw httpHata(400, 'Sipariş kalemi gerekli');
    if (b.kalemler.length > 100) throw httpHata(400, 'Bir siparişte en fazla 100 kalem olabilir');
    const id = await withTransaction(async (c) => {
      const tedarikci = b.tedarikci_id ? (await sahiplik(c, 'tedarikciler', b.tedarikci_id, sid, 'tedarikçi')).id : null;
      const dosya = await dosyaKontrol(c, b.dosya_id, sid);
      const { rows: [s] } = await c.query(
        `INSERT INTO parca_siparisleri (servis_id, tedarikci_id, dosya_id, siparis_no, siparis_trh, tahmini_gelis, notlar, olusturan_id)
         VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6,$7,$8) RETURNING id`,
        [sid, tedarikci, dosya, metin(b.siparis_no, 'Sipariş no', 50), tarih(b.siparis_trh, 'Sipariş tarihi'),
         tarih(b.tahmini_gelis, 'Tahmini geliş'), metin(b.notlar, 'Not', 1000), req.user.id]);
      for (const k of b.kalemler) {
        let parcaId;
        if (k?.yeni_parca) parcaId = (await ekle(c, 'parcalar', sid, parcaAlanlari(k.yeni_parca, false))).id;
        else parcaId = (await sahiplik(c, 'parcalar', k?.parca_id, sid, 'parça')).id;
        await c.query(
          'INSERT INTO siparis_kalemleri (siparis_id, parca_id, adet, birim_fiyat) VALUES ($1,$2,$3,$4)',
          [s.id, parcaId, sayi(k.adet, 'Adet', { zorunlu: true }), sayi(k.birim_fiyat, 'Birim fiyat', { sifirOlur: true })]);
      }
      return s.id;
    });
    res.status(201).json((await siparisleriGetir('s.id=$1', [id]))[0]);
  } catch (err) { next(err); }
});

// PATCH /api/stok/siparisler/:id { durum?: siparis|yolda|iptal, tahmini_gelis?, siparis_no?, fatura_no?, notlar? }
router.patch('/siparisler/:id', yazar, async (req, res, next) => {
  try {
    const sid = kapsam(req);
    const s = await sahiplik({ query }, 'parca_siparisleri', req.params.id, sid, 'sipariş');
    const b = req.body || {};
    const d = {};
    if (own(b, 'durum')) {
      if (!['siparis', 'yolda', 'iptal'].includes(b.durum)) throw httpHata(400, 'Durum siparis, yolda veya iptal olabilir');
      if (['geldi', 'iptal'].includes(s.durum)) throw httpHata(409, `Sipariş ${s.durum === 'geldi' ? 'teslim alındı' : 'iptal edildi'}, durumu değişmez`);
      if (b.durum === 'iptal') {
        const { rows: [g] } = await query('SELECT COALESCE(SUM(gelen_adet),0) AS g FROM siparis_kalemleri WHERE siparis_id=$1', [s.id]);
        if (Number(g.g) > 0) throw httpHata(409, 'Kısmen teslim alınan sipariş iptal edilemez');
      } else if (s.durum === 'kismi') throw httpHata(409, 'Kısmen teslim alınan siparişin durumu teslimle değişir');
      d.durum = b.durum;
    }
    if (own(b, 'tahmini_gelis')) d.tahmini_gelis = tarih(b.tahmini_gelis, 'Tahmini geliş');
    if (own(b, 'siparis_no')) d.siparis_no = metin(b.siparis_no, 'Sipariş no', 50);
    if (own(b, 'fatura_no')) d.fatura_no = metin(b.fatura_no, 'Fatura no', 50);
    if (own(b, 'notlar')) d.notlar = metin(b.notlar, 'Not', 1000);
    await guncelle('parca_siparisleri', s.id, sid, d);
    res.json((await siparisleriGetir('s.id=$1', [s.id]))[0]);
  } catch (err) { next(err); }
});

// POST /api/stok/siparisler/:id/teslim { kalemler: [{ kalem_id, adet }], araca_tak?: bool }
// Gelen parça depoya girer. Sipariş bir araç içinse ve araca_tak true ise aynı anda araca çıkış yapılır.
router.post('/siparisler/:id/teslim', yazar, async (req, res, next) => {
  try {
    const sid = kapsam(req);
    const b = req.body || {};
    if (!Array.isArray(b.kalemler) || !b.kalemler.length) throw httpHata(400, 'Teslim alınan kalem gerekli');
    await withTransaction(async (c) => {
      const { rows: [s] } = await c.query(
        'SELECT * FROM parca_siparisleri WHERE id=$1 AND servis_id=$2 FOR UPDATE', [req.params.id, sid]);
      if (!s) throw httpHata(404, 'Sipariş bulunamadı');
      if (['geldi', 'iptal'].includes(s.durum)) throw httpHata(409, `Sipariş ${s.durum === 'geldi' ? 'zaten teslim alındı' : 'iptal edildi'}`);
      const tak = b.araca_tak === true && s.dosya_id;
      for (const t of b.kalemler) {
        if (typeof t?.kalem_id !== 'string' || !UUID_RE.test(t.kalem_id)) throw httpHata(400, 'Geçersiz kalem');
        const { rows: [k] } = await c.query('SELECT * FROM siparis_kalemleri WHERE id=$1 AND siparis_id=$2', [t.kalem_id, s.id]);
        if (!k) throw httpHata(404, 'Sipariş kalemi bulunamadı');
        const adet = sayi(t.adet, 'Teslim adedi', { zorunlu: true });
        if (adet > Number(k.adet) - Number(k.gelen_adet)) throw httpHata(400, 'Teslim adedi kalan siparişten fazla');
        await c.query('UPDATE siparis_kalemleri SET gelen_adet=gelen_adet+$1 WHERE id=$2', [adet, k.id]);
        await c.query(
          `INSERT INTO stok_hareketleri (servis_id, parca_id, tip, adet, birim_maliyet, siparis_id, aciklama, kullanici_id)
           VALUES ($1,$2,'giris',$3,$4,$5,$6,$7)`,
          [sid, k.parca_id, adet, k.birim_fiyat, s.id, `Sipariş teslimi${s.siparis_no ? ` (${s.siparis_no})` : ''}`, req.user.id]);
        if (tak)
          await c.query(
            `INSERT INTO stok_hareketleri (servis_id, parca_id, tip, adet, siparis_id, dosya_id, aciklama, kullanici_id)
             VALUES ($1,$2,'cikis',$3,$4,$5,'Siparişle gelen parça araca takıldı',$6)`,
            [sid, k.parca_id, adet, s.id, s.dosya_id, req.user.id]);
      }
      const { rows: [{ kalan }] } = await c.query(
        'SELECT COALESCE(SUM(adet-gelen_adet),0) AS kalan FROM siparis_kalemleri WHERE siparis_id=$1', [s.id]);
      const bitti = Number(kalan) <= 0;
      await c.query(
        `UPDATE parca_siparisleri SET durum=$1, gelis_trh=CASE WHEN $2 THEN CURRENT_DATE ELSE gelis_trh END WHERE id=$3`,
        [bitti ? 'geldi' : 'kismi', bitti, s.id]);
    });
    res.json((await siparisleriGetir('s.id=$1', [req.params.id]))[0]);
  } catch (err) { next(err); }
});

// ── STOK HAREKETLERİ ─────────────────────────────────────
// POST /api/stok/hareketler { parca_id, tip: giris|cikis|duzeltme, adet, birim_maliyet?, dosya_id?, aciklama? }
// Çıkış: stoktan fazla olamaz; dosya verilirse parça o araca takılmış sayılır. Düzeltme: ± adet, stok eksiye düşmez.
router.post('/hareketler', yazar, async (req, res, next) => {
  try {
    const sid = kapsam(req);
    const b = req.body || {};
    if (!['giris', 'cikis', 'duzeltme'].includes(b.tip)) throw httpHata(400, 'Tip giris, cikis veya duzeltme olmalı');
    const adet = sayi(b.adet, 'Adet', { zorunlu: true, eksiOlur: b.tip === 'duzeltme' });
    const h = await withTransaction(async (c) => {
      const { rows: [p] } = await c.query(
        'SELECT id FROM parcalar WHERE id=$1 AND servis_id=$2 FOR UPDATE',
        [typeof b.parca_id === 'string' && UUID_RE.test(b.parca_id) ? b.parca_id : null, sid]);
      if (!p) throw httpHata(404, 'Parça bulunamadı');
      const dosya = b.tip === 'cikis' ? await dosyaKontrol(c, b.dosya_id, sid) : null;
      const stok = await parcaStok(c, p.id);
      const sonra = stok + (b.tip === 'cikis' ? -adet : adet);
      if (sonra < 0) throw httpHata(409, `Stok yetersiz (depoda ${stok})`);
      const { rows: [r] } = await c.query(
        `INSERT INTO stok_hareketleri (servis_id, parca_id, tip, adet, birim_maliyet, dosya_id, aciklama, kullanici_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [sid, p.id, b.tip, adet, b.tip === 'giris' ? sayi(b.birim_maliyet, 'Birim maliyet', { sifirOlur: true }) : null,
         dosya, metin(b.aciklama, 'Açıklama', 500), req.user.id]);
      return { ...r, stok: sonra };
    });
    res.status(201).json(h);
  } catch (err) { next(err); }
});

module.exports = router;
