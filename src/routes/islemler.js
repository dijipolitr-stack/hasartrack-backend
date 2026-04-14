const router = require('express').Router();
const { query, withTransaction } = require('../db');
const { authMiddleware, onlyAdmin, dosyaErisim } = require('../middleware/auth');

router.use(authMiddleware);

// GET /api/islemler/:dosyaId — kalemler + onay durumu
router.get('/:dosyaId', dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const { rows: kalemler } = await query(
      `SELECT i.*, k.ad_soyad as giris_yapan_ad
       FROM islemler i
       LEFT JOIN kullanicilar k ON k.id = i.giris_yapan
       WHERE i.dosya_id=$1 ORDER BY i.created_at`, [dosyaId]);
    const { rows: [onay] } = await query(
      'SELECT * FROM islem_onay WHERE dosya_id=$1', [dosyaId]);
    res.json({ kalemler, onay_durumu: onay?.durum || 'taslak' });
  } catch (err) { next(err); }
});

// POST /api/islemler/:dosyaId — kalem ekle (servis)
router.post('/:dosyaId', dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    if (req.user.rol !== 'servis' && req.user.rol !== 'admin')
      return res.status(403).json({ error: 'Sadece servis kalem girebilir' });

    // Onay bekliyorsa veya onaylandıysa ekleme yapılamaz
    const { rows: [onay] } = await query(
      'SELECT durum FROM islem_onay WHERE dosya_id=$1', [dosyaId]);
    if (['bekliyor','onaylandi'].includes(onay?.durum))
      return res.status(409).json({ error: `Kalemler ${onay.durum} durumunda — değişiklik yapılamaz` });

    const { kategori, aciklama, birim = 'Adet', miktar = 1, birim_fiyat } = req.body;
    if (!aciklama || !birim_fiyat)
      return res.status(400).json({ error: 'Açıklama ve birim fiyat zorunlu' });

    const { rows: [kalem] } = await query(
      `INSERT INTO islemler (dosya_id, kategori, aciklama, birim, miktar, birim_fiyat, giris_yapan)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [dosyaId, kategori||'Diğer', aciklama, birim, miktar, birim_fiyat, req.user.id]
    );
    res.status(201).json(kalem);
  } catch (err) { next(err); }
});

// POST /api/islemler/:dosyaId/toplu — toplu kalem ekle
router.post('/:dosyaId/toplu', dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const { kalemler } = req.body;
    if (!Array.isArray(kalemler) || !kalemler.length)
      return res.status(400).json({ error: 'Kalem listesi boş' });

    const { rows: [onay] } = await query('SELECT durum FROM islem_onay WHERE dosya_id=$1', [dosyaId]);
    if (['bekliyor','onaylandi'].includes(onay?.durum))
      return res.status(409).json({ error: 'Kalemler onay sürecinde — değişiklik yapılamaz' });

    const eklenenler = await withTransaction(async (client) => {
      const sonuc = [];
      for (const k of kalemler) {
        const { rows: [ekl] } = await client.query(
          `INSERT INTO islemler (dosya_id,kategori,aciklama,birim,miktar,birim_fiyat,giris_yapan)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [dosyaId, k.kategori||'Diğer', k.aciklama, k.birim||'Adet',
           k.miktar||1, k.birim_fiyat, req.user.id]
        );
        sonuc.push(ekl);
      }
      return sonuc;
    });
    res.status(201).json({ eklenen: eklenenler.length, kalemler: eklenenler });
  } catch (err) { next(err); }
});

// PATCH /api/islemler/:dosyaId/:kalemId — güncelle
router.patch('/:dosyaId/:kalemId', dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId, kalemId } = req.params;
    const { rows: [onay] } = await query('SELECT durum FROM islem_onay WHERE dosya_id=$1', [dosyaId]);
    if (onay?.durum === 'bekliyor' && req.user.rol !== 'admin')
      return res.status(409).json({ error: 'Onay sürecinde servis değişiklik yapamaz' });
    if (onay?.durum === 'onaylandi')
      return res.status(409).json({ error: 'Onaylanan kalemler değiştirilemez' });

    const { kategori, aciklama, birim, miktar, birim_fiyat, durum } = req.body;
    const { rows: [kalem] } = await query(
      `UPDATE islemler SET
         kategori=COALESCE($1,kategori), aciklama=COALESCE($2,aciklama),
         birim=COALESCE($3,birim), miktar=COALESCE($4,miktar),
         birim_fiyat=COALESCE($5,birim_fiyat),
         durum=COALESCE($6,durum), updated_at=NOW()
       WHERE id=$7 AND dosya_id=$8 RETURNING *`,
      [kategori, aciklama, birim, miktar, birim_fiyat, durum, kalemId, dosyaId]
    );
    if (!kalem) return res.status(404).json({ error: 'Kalem bulunamadı' });
    res.json(kalem);
  } catch (err) { next(err); }
});

// DELETE /api/islemler/:dosyaId/:kalemId
router.delete('/:dosyaId/:kalemId', dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId, kalemId } = req.params;
    const { rows: [onay] } = await query('SELECT durum FROM islem_onay WHERE dosya_id=$1', [dosyaId]);
    if (['bekliyor','onaylandi'].includes(onay?.durum))
      return res.status(409).json({ error: 'Bu aşamada kalem silinemez' });
    await query('DELETE FROM islemler WHERE id=$1 AND dosya_id=$2', [kalemId, dosyaId]);
    res.json({ mesaj: 'Kalem silindi' });
  } catch (err) { next(err); }
});

// POST /api/islemler/:dosyaId/onaya-gonder — servis gönderir
router.post('/:dosyaId/onaya-gonder', dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    if (req.user.rol !== 'servis')
      return res.status(403).json({ error: 'Sadece servis onaya gönderebilir' });
    const { rows: kalemler } = await query(
      'SELECT id FROM islemler WHERE dosya_id=$1', [dosyaId]);
    if (!kalemler.length)
      return res.status(400).json({ error: 'Onaya gönderilecek kalem yok' });
    await query(
      `UPDATE islem_onay SET durum='bekliyor', gonderim_trh=NOW(), gonderen_id=$1
       WHERE dosya_id=$2`,
      [req.user.id, dosyaId]
    );
    res.json({ mesaj: 'Onaya gönderildi' });
  } catch (err) { next(err); }
});

// POST /api/islemler/:dosyaId/admin-karar — admin onaylar/reddeder
router.post('/:dosyaId/admin-karar', onlyAdmin, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const { karar, not_metni } = req.body; // karar: 'onaylandi' | 'reddedildi'
    if (!['onaylandi','reddedildi'].includes(karar))
      return res.status(400).json({ error: 'Karar "onaylandi" veya "reddedildi" olmalı' });

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE islem_onay SET durum=$1, karar_trh=NOW(), karar_veren=$2, admin_not=$3
         WHERE dosya_id=$4`,
        [karar, req.user.id, not_metni, dosyaId]
      );
      if (karar === 'onaylandi') {
        await client.query(
          `UPDATE islemler SET durum='onaylandi' WHERE dosya_id=$1`, [dosyaId]);
        // Muhasebe güncelle
        const { rows: [toplam] } = await client.query(
          'SELECT SUM(miktar*birim_fiyat) as tutar FROM islemler WHERE dosya_id=$1', [dosyaId]);
        await client.query(
          'UPDATE muhasebe SET onaylanan_tutar=$1, updated_at=NOW() WHERE dosya_id=$2',
          [toplam.tutar, dosyaId]
        );
      }
      await client.query(
        `INSERT INTO audit_log (dosya_id,kullanici_id,eylem,detay)
         VALUES ($1,$2,'ISLEM_KARAR',$3)`,
        [dosyaId, req.user.id, JSON.stringify({ karar, not: not_metni })]
      );
    });
    res.json({ mesaj: `Kalemler ${karar}` });
  } catch (err) { next(err); }
});

module.exports = router;
