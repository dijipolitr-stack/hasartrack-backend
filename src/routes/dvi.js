// DVI / hasar haritası: aracın bölgelerine işlenen hasar noktaları.
// Okuma: müşteri hariç dosyaya erişen herkes. Yazma: admin + atanmış servis.
const router = require('express').Router();
const { query } = require('../db');
const { authMiddleware, adminOrServis, notMusteri, dosyaErisim } = require('../middleware/auth');
const { uuidParam, httpHata, alanDegeri } = require('../lib/dogrula');

const BOLGELER = ['on_tampon', 'kaput', 'on_cam', 'tavan', 'arka_cam', 'bagaj', 'arka_tampon',
  'sol_on_camurluk', 'sol_on_kapi', 'sol_arka_kapi', 'sol_arka_camurluk', 'sol_marspiyel', 'sol_ayna',
  'sag_on_camurluk', 'sag_on_kapi', 'sag_arka_kapi', 'sag_arka_camurluk', 'sag_marspiyel', 'sag_ayna',
  'jant_lastik', 'alt_takim', 'diger'];
const TIPLER = ['cizik', 'gocuk', 'kirik', 'catlak', 'boya', 'korozyon', 'diger'];
const SIDDET = ['hafif', 'orta', 'agir'];
const KARAR = ['onarim', 'degisim', 'boya', 'kontrol', 'islem_yok'];

router.use(authMiddleware);
router.param('dosyaId', uuidParam('dosyaId'));
router.param('id', uuidParam('id'));

const alanlar = (b, kismi) => {
  const d = {};
  const al = (ad, tip, etiket) => {
    if (kismi && b[ad] === undefined) return;
    d[ad] = alanDegeri(tip, b[ad], etiket);
  };
  al('bolge', { t: 'enum', secenekler: BOLGELER, bos: false }, 'Bölge');
  al('hasar_tipi', { t: 'enum', secenekler: TIPLER, bos: false }, 'Hasar tipi');
  al('siddet', { t: 'enum', secenekler: SIDDET, bos: false }, 'Şiddet');
  al('karar', { t: 'enum', secenekler: KARAR, bos: false }, 'Karar');
  if (!kismi || b.notlar !== undefined) {
    const n = alanDegeri({ t: 'metin' }, typeof b.notlar === 'string' ? b.notlar.trim() : b.notlar, 'Not');
    if (n && n.length > 1000) throw httpHata(400, 'Not en çok 1000 karakter olabilir');
    d.notlar = n;
  }
  return d;
};

// GET /api/dvi/ozet — dosya başına nokta sayıları (admin tümü, servis kendi)
router.get('/ozet', adminOrServis, async (req, res, next) => {
  try {
    const params = [];
    let f = '';
    if (req.user.rol === 'servis') { params.push(req.user.servis_id); f = ' AND d.atanan_servis=$1'; }
    const { rows } = await query(`
      SELECT d.id AS dosya_id, d.dosya_no, d.durum, a.plaka, a.marka, a.model, srv.ad AS servis_ad,
             COUNT(h.id)::int AS nokta, COUNT(h.id) FILTER (WHERE h.siddet='agir')::int AS agir,
             COUNT(h.id) FILTER (WHERE h.karar='degisim')::int AS degisim, MAX(h.created_at) AS son_kayit
      FROM dosyalar d
      LEFT JOIN arac a ON a.dosya_id=d.id
      LEFT JOIN servisler srv ON srv.id=d.atanan_servis
      LEFT JOIN hasar_noktalari h ON h.dosya_id=d.id
      WHERE d.durum<>'İptal'${f}
      GROUP BY d.id, a.plaka, a.marka, a.model, srv.ad
      ORDER BY d.created_at DESC`, params);
    res.json({ dosyalar: rows });
  } catch (err) { next(err); }
});

// GET /api/dvi/:dosyaId
router.get('/:dosyaId', notMusteri, dosyaErisim, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT h.*, k.ad_soyad AS olusturan_ad FROM hasar_noktalari h LEFT JOIN kullanicilar k ON k.id=h.olusturan_id
       WHERE h.dosya_id=$1 ORDER BY h.created_at`, [req.params.dosyaId]);
    res.json({ noktalar: rows });
  } catch (err) { next(err); }
});

// POST /api/dvi/:dosyaId
router.post('/:dosyaId', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const d = alanlar(req.body || {}, false);
    const { rows: [h] } = await query(
      `INSERT INTO hasar_noktalari (dosya_id, bolge, hasar_tipi, siddet, karar, notlar, olusturan_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.dosyaId, d.bolge, d.hasar_tipi, d.siddet, d.karar, d.notlar, req.user.id]);
    res.status(201).json(h);
  } catch (err) { next(err); }
});

// PATCH /api/dvi/:dosyaId/:id
router.patch('/:dosyaId/:id', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const d = alanlar(req.body || {}, true);
    const k = Object.keys(d);
    if (!k.length) throw httpHata(400, 'Güncellenecek alan yok');
    const { rows: [h] } = await query(
      `UPDATE hasar_noktalari SET ${k.map((x, i) => `${x}=$${i + 1}`).join(', ')}, updated_at=NOW()
       WHERE id=$${k.length + 1} AND dosya_id=$${k.length + 2} RETURNING *`,
      [...k.map((x) => d[x]), req.params.id, req.params.dosyaId]);
    if (!h) throw httpHata(404, 'Hasar noktası bulunamadı');
    res.json(h);
  } catch (err) { next(err); }
});

// DELETE /api/dvi/:dosyaId/:id
router.delete('/:dosyaId/:id', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM hasar_noktalari WHERE id=$1 AND dosya_id=$2', [req.params.id, req.params.dosyaId]);
    if (!rowCount) throw httpHata(404, 'Hasar noktası bulunamadı');
    res.json({ mesaj: 'Silindi' });
  } catch (err) { next(err); }
});

module.exports = router;
