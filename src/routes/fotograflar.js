// Dosya fotoğrafları. Okuma: dosyayı görebilen admin/servis/acente. Yükleme, düzenleme, silme:
// admin ve atanmış servis. URL'ler imzalı ve 1 saat geçerli.
const router = require('express').Router();
const { query } = require('../db');
const { authMiddleware, adminOrServis, notMusteri, dosyaErisim } = require('../middleware/auth');
const { uuidParam, httpHata } = require('../lib/dogrula');
const { isEmriBul } = require('../lib/isEmri');
const depo = require('../lib/depo');
const { tekDosya, anahtarUret, tabanUrl, dosyaAdi, GORSEL } = require('../lib/yukleme');

router.use(authMiddleware);
router.param('dosyaId', uuidParam('dosyaId'));
router.param('fotoId', uuidParam('fotoId'));

const KATEGORI = ['kaza', 'ekspertiz', 'onarim', 'teslimat', 'ek_hasar'];
const kategoriAl = (v, varsayilan) => {
  if (v === undefined || v === null || v === '') return varsayilan;
  if (!KATEGORI.includes(v)) throw httpHata(400, 'Geçersiz kategori');
  return v;
};
const etiketAl = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);

const urlEkle = async (req, satirlar) => {
  const urller = await depo.urlListesi(satirlar.map((f) => f.url), tabanUrl(req));
  return satirlar.map(({ url, ...f }) => ({ ...f, url: urller[url] || null }));
};

// GET /api/fotograflar/:dosyaId
router.get('/:dosyaId', notMusteri, dosyaErisim, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT f.id, f.url, f.dosya_adi, f.etiket, f.kategori, f.boyut_byte, f.mime_tipi, f.is_emri_id,
              f.created_at, k.ad_soyad AS yukleyen_ad, k.rol AS yukleyen_rol
       FROM fotograflar f LEFT JOIN kullanicilar k ON k.id=f.yukleyen_id
       WHERE f.dosya_id=$1 ORDER BY f.created_at DESC`, [req.params.dosyaId]);
    res.json({ fotograflar: await urlEkle(req, rows) });
  } catch (err) { next(err); }
});

// POST /api/fotograflar/:dosyaId  (multipart: dosya, kategori?, etiket?, is_emri_id?)
router.post('/:dosyaId', adminOrServis, dosyaErisim, tekDosya(GORSEL), async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const kategori = kategoriAl(req.body.kategori, req.user.rol === 'servis' ? 'onarim' : 'kaza');
    const isEmriId = req.body.is_emri_id ? (await isEmriBul(dosyaId, req.body.is_emri_id)).id : null;
    const ad = dosyaAdi(req.file);
    const anahtar = anahtarUret(dosyaId, 'foto', req.file.mimetype);
    await depo.yukle(anahtar, req.file.buffer, req.file.mimetype);
    const { rows: [f] } = await query(
      `INSERT INTO fotograflar (dosya_id, url, dosya_adi, etiket, kategori, boyut_byte, mime_tipi, yukleyen_id, is_emri_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, url, dosya_adi, etiket, kategori, boyut_byte, mime_tipi, is_emri_id, created_at`,
      [dosyaId, anahtar, ad, etiketAl(req.body.etiket) || ad.replace(/\.[^.]+$/, '').slice(0, 100),
       kategori, req.file.size, req.file.mimetype, req.user.id, isEmriId]);
    const [sonuc] = await urlEkle(req, [f]);
    res.status(201).json({ ...sonuc, yukleyen_ad: req.user.ad_soyad, yukleyen_rol: req.user.rol });
  } catch (err) { next(err); }
});

// PATCH /api/fotograflar/:dosyaId/:fotoId { etiket?, kategori? }
router.patch('/:dosyaId/:fotoId', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const b = req.body || {};
    const set = [], params = [];
    if (b.etiket !== undefined) { params.push(etiketAl(b.etiket)); set.push(`etiket=$${params.length}`); }
    if (b.kategori !== undefined) { params.push(kategoriAl(b.kategori)); set.push(`kategori=$${params.length}`); }
    if (!set.length) return res.status(400).json({ error: 'Güncellenecek alan yok' });
    params.push(req.params.fotoId, req.params.dosyaId);
    const { rows: [f] } = await query(
      `UPDATE fotograflar SET ${set.join(', ')} WHERE id=$${params.length - 1} AND dosya_id=$${params.length}
       RETURNING id, etiket, kategori`, params);
    if (!f) return res.status(404).json({ error: 'Fotoğraf bulunamadı' });
    res.json(f);
  } catch (err) { next(err); }
});

// DELETE /api/fotograflar/:dosyaId/:fotoId
router.delete('/:dosyaId/:fotoId', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const { rows: [mevcut] } = await query(
      'SELECT yukleyen_id FROM fotograflar WHERE id=$1 AND dosya_id=$2', [req.params.fotoId, req.params.dosyaId]);
    if (!mevcut) return res.status(404).json({ error: 'Fotoğraf bulunamadı' });
    // Servis yalnız kendi yüklediğini siler; admin'in yüklediği kaza/ekspertiz kanıtı korunur
    if (req.user.rol === 'servis' && mevcut.yukleyen_id !== req.user.id)
      return res.status(403).json({ error: 'Yalnız kendi yüklediğiniz fotoğrafı silebilirsiniz' });
    const { rows: [f] } = await query(
      'DELETE FROM fotograflar WHERE id=$1 AND dosya_id=$2 RETURNING url', [req.params.fotoId, req.params.dosyaId]);
    if (!f) return res.status(404).json({ error: 'Fotoğraf bulunamadı' });
    // Kayıt silindi; depodan silme hatası kullanıcıyı etkilemez, loglanır
    await depo.sil([f.url]).catch((e) => console.error('Depo silme hatası:', e.message));
    res.json({ mesaj: 'Fotoğraf silindi' });
  } catch (err) { next(err); }
});

module.exports = router;
