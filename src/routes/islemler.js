// İşlem kalemleri ve onay turları. Her kalem bir iş emrine bağlıdır; onay iş emri başınadır
// (ana iş emri + ek hasar iş emirleri). is_emri_id verilmezse ana iş emri kullanılır.
const router = require('express').Router();
const { query, withTransaction } = require('../db');
const { authMiddleware, adminOrServis, dosyaErisim } = require('../middleware/auth');
const { uuidParam, httpHata } = require('../lib/dogrula');
const { anaIsEmri, isEmriBul, kalemDuzenlenebilir } = require('../lib/isEmri');

const KALEM_DURUM = ['bekliyor', 'onaylandi', 'reddedildi'];
// Kalemi kim öder: sigorta, müşteri (sigorta harici iş), acente, diğer
const ODEYEN = ['sigorta', 'musteri', 'acente', 'diger'];
const odeyenKontrol = (v) => {
  if (v !== undefined && v !== null && !ODEYEN.includes(v)) throw httpHata(400, 'Geçersiz ödeyen');
  return v ?? null;
};
const kilitMesaji = (ie) => ie.durum === 'iptal'
  ? 'İş emri iptal edildi, değişiklik yapılamaz'
  : `Kalemler ${ie.onay_durumu} durumunda, değişiklik yapılamaz`;

router.use(authMiddleware);
router.param('dosyaId', uuidParam('dosyaId'));
router.param('kalemId', uuidParam('kalemId'));

// GET /api/islemler/:dosyaId — kalemler + iş emirlerinin onay durumu
// onay_durumu: ana iş emrinin durumu (geriye uyumluluk)
router.get('/:dosyaId', dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const ana = await anaIsEmri(dosyaId);
    const { rows: kalemler } = await query(
      `SELECT i.*, k.ad_soyad as giris_yapan_ad
       FROM islemler i
       LEFT JOIN kullanicilar k ON k.id = i.giris_yapan
       WHERE i.dosya_id=$1 ORDER BY i.created_at`, [dosyaId]);
    const { rows: isEmirleri } = await query(
      `SELECT id, no, tur, aciklama, durum, onay_durumu, gonderim_trh, karar_trh, karar_notu,
              eksper_ad, musteri_ad, created_at
       FROM is_emirleri WHERE dosya_id=$1 ORDER BY no`, [dosyaId]);
    res.json({ kalemler, onay_durumu: ana.onay_durumu, is_emirleri: isEmirleri });
  } catch (err) { next(err); }
});

// POST /api/islemler/:dosyaId — kalem ekle { ..., is_emri_id? }
router.post('/:dosyaId', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const ie = await isEmriBul(dosyaId, req.body?.is_emri_id);
    if (!kalemDuzenlenebilir(ie)) return res.status(409).json({ error: kilitMesaji(ie) });

    const { kategori, aciklama, birim = 'Adet', miktar = 1, birim_fiyat } = req.body;
    if (!aciklama || !birim_fiyat)
      return res.status(400).json({ error: 'Açıklama ve birim fiyat zorunlu' });
    const odeyen = odeyenKontrol(req.body.odeyen) || 'sigorta';

    const { rows: [kalem] } = await query(
      `INSERT INTO islemler (dosya_id, is_emri_id, kategori, aciklama, birim, miktar, birim_fiyat, giris_yapan, odeyen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [dosyaId, ie.id, kategori||'Diğer', aciklama, birim, miktar, birim_fiyat, req.user.id, odeyen]
    );
    res.status(201).json(kalem);
  } catch (err) { next(err); }
});

// POST /api/islemler/:dosyaId/toplu — toplu kalem ekle { kalemler, is_emri_id? }
router.post('/:dosyaId/toplu', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const { kalemler } = req.body;
    if (!Array.isArray(kalemler) || !kalemler.length)
      return res.status(400).json({ error: 'Kalem listesi boş' });
    const ie = await isEmriBul(dosyaId, req.body?.is_emri_id);
    if (!kalemDuzenlenebilir(ie)) return res.status(409).json({ error: kilitMesaji(ie) });

    for (const k of kalemler) odeyenKontrol(k?.odeyen);
    const eklenenler = await withTransaction(async (client) => {
      const sonuc = [];
      for (const k of kalemler) {
        const { rows: [ekl] } = await client.query(
          `INSERT INTO islemler (dosya_id,is_emri_id,kategori,aciklama,birim,miktar,birim_fiyat,giris_yapan,odeyen)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [dosyaId, ie.id, k.kategori||'Diğer', k.aciklama, k.birim||'Adet',
           k.miktar||1, k.birim_fiyat, req.user.id, k.odeyen||'sigorta']
        );
        sonuc.push(ekl);
      }
      return sonuc;
    });
    res.status(201).json({ eklenen: eklenenler.length, kalemler: eklenenler });
  } catch (err) { next(err); }
});

// Kalemi iş emri durumuyla birlikte bulur
const kalemBul = async (dosyaId, kalemId) => {
  const { rows: [k] } = await query(
    `SELECT i.id, ie.onay_durumu, ie.durum AS is_emri_durum
     FROM islemler i JOIN is_emirleri ie ON ie.id = i.is_emri_id
     WHERE i.id=$1 AND i.dosya_id=$2`, [kalemId, dosyaId]);
  if (!k) throw httpHata(404, 'Kalem bulunamadı');
  return k;
};

// PATCH /api/islemler/:dosyaId/:kalemId — güncelle
// Taslak/reddedildi iken düzenlenir; onay beklerken kalem bazında onay/red (admin veya atanmış servis).
router.patch('/:dosyaId/:kalemId', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId, kalemId } = req.params;
    const k = await kalemBul(dosyaId, kalemId);
    if (k.is_emri_durum === 'iptal')
      return res.status(409).json({ error: 'İş emri iptal edildi, değişiklik yapılamaz' });
    if (k.onay_durumu === 'onaylandi')
      return res.status(409).json({ error: 'Onaylanan kalemler değiştirilemez' });

    const { kategori, aciklama, birim, miktar, birim_fiyat, durum } = req.body;
    // Kalem durumu (onay/red) onay kararının parçasıdır (admin veya atanmış servis)
    if (durum !== undefined && durum !== null) {
      if (!KALEM_DURUM.includes(durum))
        return res.status(400).json({ error: 'Geçersiz kalem durumu' });
      if (k.onay_durumu !== 'bekliyor')
        return res.status(409).json({ error: 'Kalem kararı yalnız onay bekleyen iş emrinde verilir' });
    }
    const odeyen = odeyenKontrol(req.body.odeyen);
    const { rows: [kalem] } = await query(
      `UPDATE islemler SET
         kategori=COALESCE($1,kategori), aciklama=COALESCE($2,aciklama),
         birim=COALESCE($3,birim), miktar=COALESCE($4,miktar),
         birim_fiyat=COALESCE($5,birim_fiyat),
         durum=COALESCE($6,durum), odeyen=COALESCE($9,odeyen), updated_at=NOW()
       WHERE id=$7 AND dosya_id=$8 RETURNING *`,
      [kategori, aciklama, birim, miktar, birim_fiyat, durum, kalemId, dosyaId, odeyen]
    );
    res.json(kalem);
  } catch (err) { next(err); }
});

// DELETE /api/islemler/:dosyaId/:kalemId
router.delete('/:dosyaId/:kalemId', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId, kalemId } = req.params;
    const k = await kalemBul(dosyaId, kalemId);
    if (k.is_emri_durum === 'iptal' || ['bekliyor', 'onaylandi'].includes(k.onay_durumu))
      return res.status(409).json({ error: 'Bu aşamada kalem silinemez' });
    await query('DELETE FROM islemler WHERE id=$1 AND dosya_id=$2', [kalemId, dosyaId]);
    res.json({ mesaj: 'Kalem silindi' });
  } catch (err) { next(err); }
});

// POST /api/islemler/:dosyaId/onaya-gonder — servis gönderir { is_emri_id? }
// Yeniden gönderimde kalemler tekrar "bekliyor" olur; admin baştan değerlendirir.
router.post('/:dosyaId/onaya-gonder', dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    if (req.user.rol !== 'servis')
      return res.status(403).json({ error: 'Sadece servis onaya gönderebilir' });
    const ie = await isEmriBul(dosyaId, req.body?.is_emri_id);
    if (!kalemDuzenlenebilir(ie)) return res.status(409).json({ error: kilitMesaji(ie) });
    const { rowCount } = await query('SELECT 1 FROM islemler WHERE is_emri_id=$1', [ie.id]);
    if (!rowCount) return res.status(400).json({ error: 'Onaya gönderilecek kalem yok' });
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE is_emirleri SET onay_durumu='bekliyor', gonderim_trh=NOW(), gonderen_id=$1
         WHERE id=$2`, [req.user.id, ie.id]);
      await client.query(`UPDATE islemler SET durum='bekliyor' WHERE is_emri_id=$1`, [ie.id]);
    });
    res.json({ mesaj: 'Onaya gönderildi' });
  } catch (err) { next(err); }
});

// POST /api/islemler/:dosyaId/admin-karar — onay kararı (admin veya atanmış servis)
// { karar, not_metni?, is_emri_id?, eksper_ad?, musteri_ad? }
// Onayda: sigorta kalemlerini eksper, müşteri kalemlerini müşteri onaylamış sayılır; admin
// kararı onların adına girer. Ad verilmezse dosyadaki eksper / araç sahibi adı kullanılır.
// Admin'in tek tek reddettiği kalemler reddedilmiş kalır.
router.post('/:dosyaId/admin-karar', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const { karar, not_metni } = req.body; // karar: 'onaylandi' | 'reddedildi'
    if (!['onaylandi','reddedildi'].includes(karar))
      return res.status(400).json({ error: 'Karar "onaylandi" veya "reddedildi" olmalı' });

    const ie = await isEmriBul(dosyaId, req.body?.is_emri_id);
    if (ie.onay_durumu !== 'bekliyor')
      return res.status(409).json({ error: 'Karar yalnız onay bekleyen kalemler için verilebilir' });

    const metin = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 150) : null);
    let eksperAd = null, musteriAd = null;
    if (karar === 'onaylandi') {
      const { rows: taraflar } = await query(
        `SELECT DISTINCT odeyen FROM islemler WHERE is_emri_id=$1 AND durum<>'reddedildi'`, [ie.id]);
      const var_ = (t) => taraflar.some((r) => r.odeyen === t);
      const { rows: [kisi] } = await query(
        `SELECT e.ad_soyad AS eksper, s.ad_soyad AS sahip FROM dosyalar d
         LEFT JOIN eksper e ON e.dosya_id=d.id LEFT JOIN sahip s ON s.dosya_id=d.id WHERE d.id=$1`, [dosyaId]);
      if (var_('sigorta')) {
        eksperAd = metin(req.body.eksper_ad) || metin(kisi?.eksper);
        if (!eksperAd) return res.status(400).json({ error: 'Sigorta kalemleri için onaylayan eksper adı gerekli' });
      }
      if (var_('musteri')) {
        musteriAd = metin(req.body.musteri_ad) || metin(kisi?.sahip);
        if (!musteriAd) return res.status(400).json({ error: 'Sigorta harici kalemler için onaylayan müşteri adı gerekli' });
      }
    }

    await withTransaction(async (client) => {
      // Koşullu güncelleme: aynı anda verilen ikinci karar ilkini ezmez
      const { rowCount } = await client.query(
        `UPDATE is_emirleri SET onay_durumu=$1, karar_trh=NOW(), karar_veren_id=$2, karar_notu=$3,
           eksper_ad=$4, musteri_ad=$5
         WHERE id=$6 AND onay_durumu='bekliyor'`,
        [karar, req.user.id, not_metni || null, eksperAd, musteriAd, ie.id]
      );
      if (!rowCount) throw httpHata(409, 'Karar yalnız onay bekleyen kalemler için verilebilir');
      if (karar === 'onaylandi') {
        await client.query(
          `UPDATE islemler SET durum='onaylandi', karar_trh=NOW(),
             onaylayan_tip = CASE odeyen WHEN 'sigorta' THEN 'eksper' WHEN 'musteri' THEN 'musteri' ELSE 'admin' END,
             onaylayan_ad  = CASE odeyen WHEN 'sigorta' THEN $2 WHEN 'musteri' THEN $3 ELSE $4 END
           WHERE is_emri_id=$1 AND durum<>'reddedildi'`,
          [ie.id, eksperAd, musteriAd, req.user.ad_soyad || 'Admin']);
        // Onaylanan tutar: onaylanmış (iptal edilmemiş) turlardaki onaylı kalemler
        const { rows: [toplam] } = await client.query(
          `SELECT COALESCE(SUM(i.miktar*i.birim_fiyat),0) as tutar FROM islemler i
           JOIN is_emirleri ie ON ie.id=i.is_emri_id AND ie.onay_durumu='onaylandi' AND ie.durum<>'iptal'
           WHERE i.dosya_id=$1 AND i.durum='onaylandi'`, [dosyaId]);
        await client.query(
          `INSERT INTO muhasebe (dosya_id, onaylanan_tutar) VALUES ($2, $1)
           ON CONFLICT (dosya_id) DO UPDATE SET onaylanan_tutar=EXCLUDED.onaylanan_tutar, updated_at=NOW()`,
          [toplam.tutar, dosyaId]);
      }
      await client.query(
        `INSERT INTO audit_log (dosya_id,kullanici_id,eylem,detay)
         VALUES ($1,$2,'ISLEM_KARAR',$3)`,
        [dosyaId, req.user.id, JSON.stringify({ karar, not: not_metni, is_emri_no: ie.no, eksper: eksperAd, musteri: musteriAd })]
      );
    });
    res.json({ mesaj: `Kalemler ${karar}` });
  } catch (err) { next(err); }
});

module.exports = router;
