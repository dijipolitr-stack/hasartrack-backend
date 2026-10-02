const router  = require('express').Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const { query } = require('../db');
const rateLimit = require('express-rate-limit');
const { authMiddleware } = require('../middleware/auth');
const { UUID_RE } = require('../lib/dogrula');

// Servis girişi brute-force koruması: IP başına 15 dk'da 20 deneme
const servisLoginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Çok fazla giriş denemesi. 15 dakika bekleyin.' },
});

const makeToken = (user) =>
  jwt.sign(
    { id: user.id, rol: user.rol, servis_id: user.servis_id },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES || '8h' }
  );

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, sifre } = req.body;
    if (!email || !sifre)
      return res.status(400).json({ error: 'Email ve şifre gerekli' });

    const { rows } = await query(
      `SELECT k.*, s.ad as servis_ad, s.adres as servis_adres, s.telefon as servis_tel
       FROM kullanicilar k
       LEFT JOIN servisler s ON s.id = k.servis_id
       WHERE k.email = $1 AND k.aktif = TRUE`,
      [email.toLowerCase()]
    );
    if (!rows.length)
      return res.status(401).json({ error: 'Email veya şifre hatalı' });

    const user = rows[0];
    const match = await bcrypt.compare(sifre, user.sifre_hash);
    if (!match)
      return res.status(401).json({ error: 'Email veya şifre hatalı' });

    // Son giriş güncelle
    await query('UPDATE kullanicilar SET son_giris=NOW() WHERE id=$1', [user.id]);

    const token = makeToken(user);
    res.json({
      token,
      kullanici: {
        id: user.id, ad_soyad: user.ad_soyad, email: user.email,
        rol: user.rol,
        servis: user.servis_id ? {
          id: user.servis_id, ad: user.servis_ad,
          adres: user.servis_adres, telefon: user.servis_tel,
        } : null,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/auth/servis-listesi  (anonim; yalnız id ve ad, yalnız aktifler)
router.get('/servis-listesi', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, ad FROM servisler WHERE aktif=TRUE ORDER BY ad');
    res.json({ servisler: rows });
  } catch (err) { next(err); }
});

// POST /api/auth/servis-login  (servis adı + şifre)
router.post('/servis-login', servisLoginLimit, async (req, res, next) => {
  try {
    const { servis_id, sifre } = req.body || {};
    if (typeof servis_id !== 'string' || !UUID_RE.test(servis_id) || typeof sifre !== 'string' || !sifre)
      return res.status(400).json({ error: 'Servis ve şifre gerekli' });
    const { rows } = await query(
      `SELECT k.*, s.ad as servis_ad, s.adres as servis_adres, s.telefon as servis_tel
       FROM kullanicilar k JOIN servisler s ON s.id=k.servis_id
       WHERE k.servis_id=$1 AND k.rol='servis' AND k.aktif=TRUE AND s.aktif=TRUE LIMIT 1`,
      [servis_id]
    );
    if (!rows.length) return res.status(401).json({ error: 'Servis bulunamadı' });
    const user = rows[0];
    const match = await bcrypt.compare(sifre, user.sifre_hash);
    if (!match) return res.status(401).json({ error: 'Şifre hatalı' });
    await query('UPDATE kullanicilar SET son_giris=NOW() WHERE id=$1', [user.id]);
    res.json({
      token: makeToken(user),
      kullanici: {
        id: user.id, rol: 'servis',
        servis: { id: user.servis_id, ad: user.servis_ad, adres: user.servis_adres, telefon: user.servis_tel },
      },
    });
  } catch (err) { next(err); }
});

// Müşteri girişi (TC + SMS kodu) kapalı: SMS sağlayıcısı yok ve kod doğrulanmıyordu.
// Müşteri, servisin gönderdiği takip linkiyle durumu görür (routes/takip.js).
const musteriGirisKapali = (req, res) =>
  res.status(410).json({ error: 'Müşteri girişi kapalı. Servisinizin gönderdiği takip linkini kullanın.' });
router.post('/musteri-sms', musteriGirisKapali);
router.post('/musteri-dogrula', musteriGirisKapali);

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res) => {
  res.json({ kullanici: req.user });
});

// POST /api/auth/sifre-degistir
router.post('/sifre-degistir', authMiddleware, async (req, res, next) => {
  try {
    const { mevcut_sifre, yeni_sifre } = req.body;
    if (!yeni_sifre || yeni_sifre.length < 8)
      return res.status(400).json({ error: 'Yeni şifre en az 8 karakter olmalı' });
    const { rows } = await query('SELECT sifre_hash FROM kullanicilar WHERE id=$1', [req.user.id]);
    const match = await bcrypt.compare(mevcut_sifre, rows[0].sifre_hash);
    if (!match) return res.status(401).json({ error: 'Mevcut şifre hatalı' });
    const hash = await bcrypt.hash(yeni_sifre, 12);
    await query('UPDATE kullanicilar SET sifre_hash=$1 WHERE id=$2', [hash, req.user.id]);
    res.json({ mesaj: 'Şifre güncellendi' });
  } catch (err) { next(err); }
});

module.exports = router;
