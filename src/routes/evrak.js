// Dosya evrakı: kontrol listesi + yüklenen belge. Okuma: admin/servis/acente.
// Belge yükleme ve durum: admin ve atanmış servis. Evrak ekleme/silme: admin.
const router = require('express').Router();
const { query } = require('../db');
const { authMiddleware, onlyAdmin, adminOrServis, notMusteri, dosyaErisim } = require('../middleware/auth');
const { uuidParam, httpHata } = require('../lib/dogrula');
const depo = require('../lib/depo');
const { tekDosya, anahtarUret, tabanUrl, dosyaAdi, BELGE } = require('../lib/yukleme');

router.use(authMiddleware);
router.param('dosyaId', uuidParam('dosyaId'));
router.param('evrakId', uuidParam('evrakId'));

const DURUM = ['bekliyor', 'tamam', 'eksik'];
const metin = (v, ad, maks, zorunlu) => {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
    if (zorunlu) throw httpHata(400, `${ad} gerekli`);
    return null;
  }
  if (typeof v !== 'string') throw httpHata(400, `${ad} geçersiz`);
  return v.trim().slice(0, maks);
};
const SECIM = `e.id, e.ad, e.kaynak, e.durum, e.url, e.dosya_adi, e.mime_tipi, e.boyut_byte, e.teslim_trh,
               e.uyari_not, e.sira, e.created_at, k.ad_soyad AS yukleyen_ad, k.rol AS yukleyen_rol`;

const urlEkle = async (req, satirlar) => {
  const urller = await depo.urlListesi(satirlar.map((e) => e.url).filter(Boolean), tabanUrl(req));
  return satirlar.map(({ url, ...e }) => ({ ...e, url: url ? urller[url] || null : null }));
};
const evrakGetir = async (req, id) => {
  const { rows } = await query(
    `SELECT ${SECIM} FROM evrak e LEFT JOIN kullanicilar k ON k.id=e.yukleyen_id WHERE e.id=$1`, [id]);
  return (await urlEkle(req, rows))[0];
};

// GET /api/evrak/:dosyaId
router.get('/:dosyaId', notMusteri, dosyaErisim, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ${SECIM} FROM evrak e LEFT JOIN kullanicilar k ON k.id=e.yukleyen_id
       WHERE e.dosya_id=$1 ORDER BY e.sira NULLS LAST, e.created_at`, [req.params.dosyaId]);
    res.json({ evrak: await urlEkle(req, rows) });
  } catch (err) { next(err); }
});

// POST /api/evrak/:dosyaId { ad, kaynak?, uyari_not? } — listeye yeni evrak
router.post('/:dosyaId', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const b = req.body || {};
    const { rows: [e] } = await query(
      `INSERT INTO evrak (dosya_id, ad, kaynak, uyari_not, sira)
       VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(sira),0)+1 FROM evrak WHERE dosya_id=$1)) RETURNING id`,
      [req.params.dosyaId, metin(b.ad, 'Evrak adı', 200, true), metin(b.kaynak, 'Kaynak', 50),
       metin(b.uyari_not, 'Not', 1000)]);
    res.status(201).json(await evrakGetir(req, e.id));
  } catch (err) { next(err); }
});

// POST /api/evrak/:dosyaId/:evrakId/yukle (multipart: dosya) — belgeyi yükler, durum "tamam"
router.post('/:dosyaId/:evrakId/yukle', adminOrServis, dosyaErisim, tekDosya(BELGE), async (req, res, next) => {
  try {
    const { dosyaId, evrakId } = req.params;
    const { rows: [eski] } = await query('SELECT url FROM evrak WHERE id=$1 AND dosya_id=$2', [evrakId, dosyaId]);
    if (!eski) return res.status(404).json({ error: 'Evrak bulunamadı' });
    const anahtar = anahtarUret(dosyaId, 'evrak', req.file.mimetype);
    await depo.yukle(anahtar, req.file.buffer, req.file.mimetype);
    await query(
      `UPDATE evrak SET url=$1, dosya_adi=$2, mime_tipi=$3, boyut_byte=$4, durum='tamam',
         teslim_trh=NOW(), yukleyen_id=$5, uyari_not=NULL WHERE id=$6`,
      [anahtar, dosyaAdi(req.file), req.file.mimetype, req.file.size, req.user.id, evrakId]);
    if (eski.url) await depo.sil([eski.url]).catch((e) => console.error('Depo silme hatası:', e.message));
    res.json(await evrakGetir(req, evrakId));
  } catch (err) { next(err); }
});

// PATCH /api/evrak/:dosyaId/:evrakId { durum?, uyari_not?, ad?, kaynak? }
router.patch('/:dosyaId/:evrakId', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const b = req.body || {};
    const set = [], params = [];
    const ekle = (k, v) => { params.push(v); set.push(`${k}=$${params.length}`); };
    if (b.durum !== undefined) {
      if (!DURUM.includes(b.durum)) return res.status(400).json({ error: 'Geçersiz durum' });
      ekle('durum', b.durum);
    }
    if (b.uyari_not !== undefined) ekle('uyari_not', metin(b.uyari_not, 'Not', 1000));
    if (b.ad !== undefined) ekle('ad', metin(b.ad, 'Evrak adı', 200, true));
    if (b.kaynak !== undefined) ekle('kaynak', metin(b.kaynak, 'Kaynak', 50));
    if (!set.length) return res.status(400).json({ error: 'Güncellenecek alan yok' });
    params.push(req.params.evrakId, req.params.dosyaId);
    const { rowCount } = await query(
      `UPDATE evrak SET ${set.join(', ')} WHERE id=$${params.length - 1} AND dosya_id=$${params.length}`, params);
    if (!rowCount) return res.status(404).json({ error: 'Evrak bulunamadı' });
    res.json(await evrakGetir(req, req.params.evrakId));
  } catch (err) { next(err); }
});

// DELETE /api/evrak/:dosyaId/:evrakId — yalnız admin
router.delete('/:dosyaId/:evrakId', onlyAdmin, dosyaErisim, async (req, res, next) => {
  try {
    const { rows: [e] } = await query(
      'DELETE FROM evrak WHERE id=$1 AND dosya_id=$2 RETURNING url', [req.params.evrakId, req.params.dosyaId]);
    if (!e) return res.status(404).json({ error: 'Evrak bulunamadı' });
    if (e.url) await depo.sil([e.url]).catch((x) => console.error('Depo silme hatası:', x.message));
    res.json({ mesaj: 'Evrak silindi' });
  } catch (err) { next(err); }
});

module.exports = router;
