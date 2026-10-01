const router = require('express').Router();
const bcrypt = require('bcrypt');
const { query, withTransaction } = require('../db');
const { authMiddleware, onlyAdmin } = require('../middleware/auth');
const { uuidParam, httpHata } = require('../lib/dogrula');

router.use(authMiddleware, onlyAdmin);
router.param('id', uuidParam('id'));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SIFRE_MIN = 8;

// Boş metin -> null; tip veya uzunluk hatalıysa 400
const metin = (v, ad, maks, zorunlu = false) => {
  if (v === undefined || v === null || v === '') {
    if (zorunlu) throw httpHata(400, `${ad} zorunlu`);
    return null;
  }
  if (typeof v !== 'string' || v.length > maks) throw httpHata(400, `${ad} geçersiz`);
  return v.trim();
};
const sifreKontrol = (v) => {
  if (typeof v !== 'string' || v.length < SIFRE_MIN)
    throw httpHata(400, `Şifre en az ${SIFRE_MIN} karakter olmalı`);
  if (v.length > 72) throw httpHata(400, 'Şifre en fazla 72 karakter olabilir');
};

// GET /api/servisler — şifre/hash asla dönmez
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT s.id, s.ad, s.adres, s.telefon, s.email, s.aktif, s.created_at,
             (SELECT k.email FROM kullanicilar k WHERE k.servis_id=s.id AND k.rol='servis'
              ORDER BY k.created_at LIMIT 1) AS kullanici_email,
             (SELECT COUNT(*)::int FROM dosyalar d WHERE d.atanan_servis=s.id) AS dosya_sayisi
      FROM servisler s ORDER BY s.ad`);
    res.json({ servisler: rows });
  } catch (err) { next(err); }
});

// POST /api/servisler — servis + servis kullanıcısı (tek transaction)
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const ad = metin(b.ad, 'Ad', 200, true);
    const adres = metin(b.adres, 'Adres', 1000);
    const telefon = metin(b.telefon, 'Telefon', 20);
    const email = metin(b.email, 'E-posta', 100);
    const kullaniciEmail = metin(b.kullanici_email, 'Kullanıcı e-postası', 150, true).toLowerCase();
    if (!EMAIL_RE.test(kullaniciEmail)) throw httpHata(400, 'Kullanıcı e-postası geçersiz');
    sifreKontrol(b.sifre);
    const hash = await bcrypt.hash(b.sifre, 12);

    const servis = await withTransaction(async (client) => {
      const { rows: mevcut } = await client.query('SELECT 1 FROM kullanicilar WHERE email=$1', [kullaniciEmail]);
      if (mevcut.length) throw httpHata(409, 'Bu e-posta zaten kayıtlı');
      const { rows: [s] } = await client.query(
        `INSERT INTO servisler (ad, adres, telefon, email) VALUES ($1,$2,$3,$4)
         RETURNING id, ad, adres, telefon, email, aktif, created_at`,
        [ad, adres, telefon, email]);
      await client.query(
        `INSERT INTO kullanicilar (ad_soyad, email, sifre_hash, rol, servis_id)
         VALUES ($1,$2,$3,'servis',$4)`,
        [ad.slice(0, 100), kullaniciEmail, hash, s.id]);
      return s;
    });
    res.status(201).json({ ...servis, kullanici_email: kullaniciEmail });
  } catch (err) { next(err); }
});

// PATCH /api/servisler/:id — ad, adres, telefon, email, aktif, opsiyonel sifre (+ hesap yoksa kullanici_email)
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const set = [];
    const params = [];
    const ekle = (kolon, v) => { params.push(v); set.push(`${kolon}=$${params.length}`); };

    if ('ad' in b) ekle('ad', metin(b.ad, 'Ad', 200, true));
    if ('adres' in b) ekle('adres', metin(b.adres, 'Adres', 1000));
    if ('telefon' in b) ekle('telefon', metin(b.telefon, 'Telefon', 20));
    if ('email' in b) ekle('email', metin(b.email, 'E-posta', 100));
    if ('aktif' in b) {
      if (typeof b.aktif !== 'boolean') throw httpHata(400, 'aktif true veya false olmalı');
      ekle('aktif', b.aktif);
    }
    let hash = null;
    if ('sifre' in b) { sifreKontrol(b.sifre); hash = await bcrypt.hash(b.sifre, 12); }
    // Giriş hesabı olmayan servise şifre verilirken hesap açılır; e-posta o zaman zorunlu
    let kullaniciEmail = null;
    if ('kullanici_email' in b) {
      if (!hash) throw httpHata(400, 'Kullanıcı e-postası şifreyle birlikte gönderilmeli');
      kullaniciEmail = metin(b.kullanici_email, 'Kullanıcı e-postası', 150, true).toLowerCase();
      if (!EMAIL_RE.test(kullaniciEmail)) throw httpHata(400, 'Kullanıcı e-postası geçersiz');
    }
    if (!set.length && !hash) throw httpHata(400, 'Güncellenecek alan yok');

    const servis = await withTransaction(async (client) => {
      let s;
      if (set.length) {
        params.push(id);
        ({ rows: [s] } = await client.query(
          `UPDATE servisler SET ${set.join(', ')} WHERE id=$${params.length}
           RETURNING id, ad, adres, telefon, email, aktif, created_at`, params));
      } else {
        ({ rows: [s] } = await client.query(
          'SELECT id, ad, adres, telefon, email, aktif, created_at FROM servisler WHERE id=$1', [id]));
      }
      if (!s) throw httpHata(404, 'Servis bulunamadı');
      // Pasif servisin kullanıcısı da kapanır (eski token authMiddleware'de düşer)
      if ('aktif' in b)
        await client.query("UPDATE kullanicilar SET aktif=$1 WHERE servis_id=$2 AND rol='servis'", [b.aktif, id]);
      if (hash) {
        const { rowCount } = await client.query(
          "UPDATE kullanicilar SET sifre_hash=$1 WHERE servis_id=$2 AND rol='servis'", [hash, id]);
        if (!rowCount) {
          if (!kullaniciEmail)
            throw httpHata(400, 'Bu servisin giriş hesabı yok, kullanıcı e-postası gerekli');
          const { rows: mevcut } = await client.query('SELECT 1 FROM kullanicilar WHERE email=$1', [kullaniciEmail]);
          if (mevcut.length) throw httpHata(409, 'Bu e-posta zaten kayıtlı');
          await client.query(
            `INSERT INTO kullanicilar (ad_soyad, email, sifre_hash, rol, servis_id, aktif)
             VALUES ($1,$2,$3,'servis',$4,$5)`,
            [s.ad.slice(0, 100), kullaniciEmail, hash, id, s.aktif]);
          s.kullanici_email = kullaniciEmail;
        }
      }
      return s;
    });
    res.json(servis);
  } catch (err) { next(err); }
});

module.exports = router;
