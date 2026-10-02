// Müşteri takip linki: admin/servis süreli link üretir, müşteri giriş yapmadan onarım durumunu görür.
// Token yalnız oluşturulurken bir kez döner; DB'de SHA-256 özeti saklanır.
// Herkese açık görünüm para, iç not, TC ve sigorta ayrıntısı içermez.
const router = require('express').Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const { authMiddleware, adminOrServis, dosyaErisim } = require('../middleware/auth');
const { uuidParam, httpHata, alanDegeri } = require('../lib/dogrula');

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;  // 32 bayt base64url
const ozet = (token) => crypto.createHash('sha256').update(token).digest('hex');

// Token tahminine karşı: IP başına 15 dk'da 60 istek
const takipLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.TAKIP_RATE_LIMIT_MAX) || 60,
  message: { error: 'Çok fazla istek. 15 dakika bekleyin.' },
});

router.param('dosyaId', uuidParam('dosyaId'));
router.param('linkId', uuidParam('linkId'));

const yonetim = [authMiddleware, adminOrServis, dosyaErisim];

// GET /api/takip/dosya/:dosyaId  (linklerin listesi; token dönmez)
router.get('/dosya/:dosyaId', ...yonetim, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT t.id, t.son_gecerlilik, t.iptal_trh, t.son_erisim, t.erisim_sayisi, t.created_at,
              k.ad_soyad AS olusturan_ad, k.rol AS olusturan_rol,
              (t.iptal_trh IS NULL AND t.son_gecerlilik > NOW()) AS aktif
       FROM takip_linkleri t LEFT JOIN kullanicilar k ON k.id = t.olusturan_id
       WHERE t.dosya_id = $1 ORDER BY t.created_at DESC`,
      [req.params.dosyaId]
    );
    res.json({ linkler: rows });
  } catch (err) { next(err); }
});

// POST /api/takip/dosya/:dosyaId  { gun?: 1-90 }  → { id, token, son_gecerlilik }
router.post('/dosya/:dosyaId', ...yonetim, async (req, res, next) => {
  try {
    const gun = alanDegeri({ t: 'tamsayi', min: 1, max: 90 }, req.body?.gun, 'Geçerlilik (gün)') ?? 30;
    const token = crypto.randomBytes(32).toString('base64url');
    const { rows: [link] } = await query(
      `INSERT INTO takip_linkleri (dosya_id, token_ozet, son_gecerlilik, olusturan_id)
       VALUES ($1, $2, NOW() + make_interval(days => $3), $4)
       RETURNING id, son_gecerlilik`,
      [req.params.dosyaId, ozet(token), gun, req.user.id]
    );
    res.status(201).json({ ...link, token });
  } catch (err) { next(err); }
});

// DELETE /api/takip/dosya/:dosyaId/:linkId  (iptal; kayıt geçmiş için kalır)
router.delete('/dosya/:dosyaId/:linkId', ...yonetim, async (req, res, next) => {
  try {
    const { rowCount } = await query(
      `UPDATE takip_linkleri SET iptal_trh = COALESCE(iptal_trh, NOW())
       WHERE id = $1 AND dosya_id = $2`,
      [req.params.linkId, req.params.dosyaId]
    );
    if (!rowCount) throw httpHata(404, 'Link bulunamadı');
    res.json({ mesaj: 'Link iptal edildi' });
  } catch (err) { next(err); }
});

// GET /api/takip/:token  (herkese açık)
router.get('/:token', takipLimit, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { token } = req.params;
    const gecersiz = () => res.status(404).json({ error: 'Link geçersiz veya süresi dolmuş' });
    if (!TOKEN_RE.test(token)) return gecersiz();

    const { rows: [link] } = await query(
      `UPDATE takip_linkleri SET son_erisim = NOW(), erisim_sayisi = erisim_sayisi + 1
       WHERE token_ozet = $1 AND iptal_trh IS NULL AND son_gecerlilik > NOW()
       RETURNING dosya_id, son_gecerlilik`,
      [ozet(token)]
    );
    if (!link) return gecersiz();

    const { rows: [d] } = await query(
      `SELECT d.dosya_no, d.durum, d.updated_at,
              a.plaka, a.marka, a.model, a.yil,
              sa.ad_soyad AS sahip_ad,
              om.arac_giris_trh, om.tahmini_teslimat, om.telefon AS om_telefon,
              srv.ad AS servis_ad, srv.telefon AS servis_telefon, srv.adres AS servis_adres
       FROM dosyalar d
       LEFT JOIN arac a ON a.dosya_id = d.id
       LEFT JOIN sahip sa ON sa.dosya_id = d.id
       LEFT JOIN onarim_merkezi om ON om.dosya_id = d.id
       LEFT JOIN servisler srv ON srv.id = d.atanan_servis
       WHERE d.id = $1`,
      [link.dosya_id]
    );
    if (!d) return gecersiz();
    const { rows: adimlar } = await query(
      `SELECT sira, ad, durum, tamamlanma_trh FROM onarim_adimlari
       WHERE dosya_id = $1 ORDER BY sira`,
      [link.dosya_id]
    );

    res.json({
      dosya_no: d.dosya_no,
      durum: d.durum,
      // Selamlama için yalnız ilk ad
      sahip_ad: d.sahip_ad ? d.sahip_ad.trim().split(/\s+/)[0] : null,
      arac: { plaka: d.plaka, marka: d.marka, model: d.model, yil: d.yil },
      arac_giris_trh: d.arac_giris_trh,
      tahmini_teslimat: d.tahmini_teslimat,
      servis: d.servis_ad
        ? { ad: d.servis_ad, telefon: d.servis_telefon || d.om_telefon, adres: d.servis_adres }
        : null,
      adimlar,
      son_guncelleme: d.updated_at,
      link_son_gecerlilik: link.son_gecerlilik,
    });
  } catch (err) { next(err); }
});

module.exports = router;
