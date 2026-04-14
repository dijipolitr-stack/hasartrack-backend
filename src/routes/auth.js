const router  = require('express').Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');

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

// POST /api/auth/servis-login  (servis adı + şifre)
router.post('/servis-login', async (req, res, next) => {
  try {
    const { servis_id, sifre } = req.body;
    const { rows } = await query(
      `SELECT k.*, s.ad as servis_ad, s.adres as servis_adres, s.telefon as servis_tel
       FROM kullanicilar k JOIN servisler s ON s.id=k.servis_id
       WHERE k.servis_id=$1 AND k.rol='servis' AND k.aktif=TRUE LIMIT 1`,
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

// POST /api/auth/musteri-sms  (TC ile SMS kodu gönder)
router.post('/musteri-sms', async (req, res, next) => {
  try {
    const { tc_no } = req.body;
    const { rows } = await query(
      `SELECT k.id, s.telefon FROM kullanicilar k
       JOIN sahip s ON s.tc_vergi=k.tc_no
       WHERE k.tc_no=$1 AND k.rol='musteri' AND k.aktif=TRUE LIMIT 1`,
      [tc_no]
    );
    if (!rows.length) return res.status(404).json({ error: 'TC numarasına kayıt bulunamadı' });

    // Gerçek SMS API buraya entegre edilir (Netgsm, İletimerkezi vb.)
    // Demo: kod her zaman 1234
    const kod = Math.floor(1000 + Math.random() * 9000).toString();
    // await smsService.send(rows[0].telefon, `HasarTrack giriş kodu: ${kod}`);

    // Kodu geçici olarak DB'de sakla (5 dk geçerli)
    await query(
      `INSERT INTO sms_log (alici_tel, mesaj, adim_adi, durum)
       VALUES ($1, $2, 'GIRIS_KODU', 'bekliyor')`,
      [rows[0].telefon, `GIRIS:${tc_no}:${kod}`]
    );

    res.json({ mesaj: 'SMS gönderildi', telefon_masked: rows[0].telefon.replace(/(\d{4})\d+(\d{2})/, '$1***$2') });
  } catch (err) { next(err); }
});

// POST /api/auth/musteri-dogrula
router.post('/musteri-dogrula', async (req, res, next) => {
  try {
    const { tc_no, kod } = req.body;
    // Demo ortamda her kod geçerli
    // Gerçekte: DB'den son kaydı al, kodu karşılaştır, 5 dk kontrolü yap

    const { rows } = await query(
      `SELECT k.* FROM kullanicilar k WHERE k.tc_no=$1 AND k.rol='musteri' AND k.aktif=TRUE`,
      [tc_no]
    );
    if (!rows.length) return res.status(401).json({ error: 'Doğrulama başarısız' });
    const user = rows[0];
    await query('UPDATE kullanicilar SET son_giris=NOW() WHERE id=$1', [user.id]);
    res.json({ token: makeToken(user), kullanici: { id: user.id, rol: 'musteri', tc_no: user.tc_no } });
  } catch (err) { next(err); }
});

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
