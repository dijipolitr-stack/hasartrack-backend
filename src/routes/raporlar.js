const router = require('express').Router();
const { query } = require('../db');
const { authMiddleware, onlyAdmin } = require('../middleware/auth');

router.use(authMiddleware, onlyAdmin);

// GET /api/raporlar/ozet — genel dashboard özeti
router.get('/ozet', async (req, res, next) => {
  try {
    const { rows: [ozet] } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE durum='Aktif')       as aktif_dosya,
        COUNT(*) FILTER (WHERE durum='Tamamlandı')  as tamamlanan_dosya,
        COUNT(*) FILTER (WHERE atanan_servis IS NULL AND durum='Aktif') as servissiz,
        SUM(muallak_hasar)                           as toplam_muallak,
        COUNT(*)                                     as toplam_dosya
      FROM dosyalar`);

    const { rows: bekleyen_onay } = await query(`
      SELECT COUNT(*) as sayi FROM is_emirleri WHERE onay_durumu='bekliyor' AND durum<>'iptal'`);

    const { rows: servis_ozet } = await query(`
      SELECT srv.id, srv.ad, COUNT(d.id) as dosya_sayisi,
             SUM(d.muallak_hasar) as toplam_muallak,
             COUNT(DISTINCT d.id) FILTER (WHERE EXISTS (SELECT 1 FROM is_emirleri ie
               WHERE ie.dosya_id=d.id AND ie.onay_durumu='bekliyor' AND ie.durum<>'iptal')) as bekleyen_onay
      FROM servisler srv
      LEFT JOIN dosyalar d ON d.atanan_servis=srv.id AND d.durum='Aktif'
      GROUP BY srv.id, srv.ad ORDER BY dosya_sayisi DESC`);

    res.json({
      ...ozet,
      bekleyen_onay: parseInt(bekleyen_onay[0].sayi),
      servisler: servis_ozet,
    });
  } catch (err) { next(err); }
});

// GET /api/raporlar/aylik — aylık muhasebe raporu
router.get('/aylik', async (req, res, next) => {
  try {
    const { yil = new Date().getFullYear(), ay = new Date().getMonth() + 1 } = req.query;
    const { rows } = await query(`
      SELECT d.dosya_no, a.plaka, sa.ad_soyad, si.sirket_ad,
             d.muallak_hasar, sf.tutar AS servis_fatura_tutar, m.onaylanan_tutar,
             m.sigorta_odeme_tutar, d.durum,
             (m.sigorta_odeme_tutar - sf.tutar) as net_fark
      FROM dosyalar d
      LEFT JOIN arac a ON a.dosya_id=d.id
      LEFT JOIN sahip sa ON sa.dosya_id=d.id
      LEFT JOIN sigorta si ON si.dosya_id=d.id
      LEFT JOIN muhasebe m ON m.dosya_id=d.id
      -- Servis faturaları toplamı (KDV hariç, tüm alıcılar)
      LEFT JOIN (SELECT dosya_id, SUM(tutar) AS tutar FROM servis_faturalari GROUP BY dosya_id) sf ON sf.dosya_id=d.id
      WHERE EXTRACT(YEAR FROM d.created_at)=$1
        AND EXTRACT(MONTH FROM d.created_at)=$2
      ORDER BY d.created_at DESC`, [yil, ay]);

    const toplamlar = rows.reduce((acc, r) => ({
      muallak:         acc.muallak         + (parseFloat(r.muallak_hasar)        || 0),
      fatura:          acc.fatura          + (parseFloat(r.servis_fatura_tutar)  || 0),
      onaylanan:       acc.onaylanan       + (parseFloat(r.onaylanan_tutar)       || 0),
      odeme:           acc.odeme           + (parseFloat(r.sigorta_odeme_tutar)   || 0),
    }), { muallak: 0, fatura: 0, onaylanan: 0, odeme: 0 });

    res.json({ dosyalar: rows, toplamlar, yil, ay, dosya_sayisi: rows.length });
  } catch (err) { next(err); }
});

module.exports = router;
