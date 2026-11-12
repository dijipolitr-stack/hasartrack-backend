// Lastik talepleri. Servis talep açar ve yalnız kendi taleplerini görür; admin tümünü görür,
// durum ve admin notunu günceller. Servis yalnız "bekliyor" durumundaki kendi talebini iptal edebilir.
const router = require('express').Router();
const { query } = require('../db');
const { authMiddleware, adminOrServis } = require('../middleware/auth');
const { uuidParam, httpHata, alanDegeri } = require('../lib/dogrula');

router.use(authMiddleware, adminOrServis);
router.param('id', uuidParam('id'));

const MEVSIM = ['yaz', 'kis', 'dort'];
const DURUM = ['bekliyor', 'islemde', 'tamamlandi', 'iptal'];

const metin = (v, ad, maks, zorunlu = false) => {
  const s = alanDegeri({ t: 'metin', bos: !zorunlu }, typeof v === 'string' ? v.trim() : v, ad);
  if (s && s.length > maks) throw httpHata(400, `${ad} en çok ${maks} karakter olabilir`);
  return s;
};

// GET /api/lastik-talepleri?durum=
router.get('/', async (req, res, next) => {
  try {
    const params = [];
    const kosul = [];
    if (req.user.rol === 'servis') {
      if (!req.user.servis_id) throw httpHata(403, 'Servis hesabı bağlı değil');
      params.push(req.user.servis_id);
      kosul.push(`t.servis_id = $${params.length}`);
    }
    if (req.query.durum) {
      params.push(alanDegeri({ t: 'enum', secenekler: DURUM, bos: false }, req.query.durum, 'Durum'));
      kosul.push(`t.durum = $${params.length}`);
    }
    const { rows } = await query(`
      SELECT t.*, s.ad AS servis_ad, k.ad_soyad AS olusturan_ad
      FROM lastik_talepleri t
      JOIN servisler s ON s.id = t.servis_id
      LEFT JOIN kullanicilar k ON k.id = t.olusturan_id
      ${kosul.length ? 'WHERE ' + kosul.join(' AND ') : ''}
      ORDER BY (t.durum IN ('bekliyor','islemde')) DESC, t.created_at DESC
      LIMIT 300`, params);
    res.json({ talepler: rows });
  } catch (err) { next(err); }
});

// POST /api/lastik-talepleri { plaka?, marka*, model?, ebat*, mevsim*, adet*, notlar? } — yalnız servis
router.post('/', async (req, res, next) => {
  try {
    if (req.user.rol !== 'servis' || !req.user.servis_id)
      throw httpHata(403, 'Lastik talebini servis hesabı açar');
    const b = req.body || {};
    const plaka = metin(b.plaka, 'Plaka', 20);
    const { rows: [t] } = await query(
      `INSERT INTO lastik_talepleri (servis_id, olusturan_id, plaka, marka, model, ebat, mevsim, adet, notlar)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.servis_id, req.user.id,
       plaka ? plaka.toUpperCase().replace(/\s+/g, ' ') : null,
       metin(b.marka, 'Marka', 50, true), metin(b.model, 'Model', 100),
       metin(b.ebat, 'Ebat', 30, true).toUpperCase(),
       alanDegeri({ t: 'enum', secenekler: MEVSIM, bos: false }, b.mevsim, 'Mevsim'),
       alanDegeri({ t: 'tamsayi', min: 1, max: 50, bos: false }, b.adet, 'Adet'),
       metin(b.notlar, 'Not', 1000)]);
    res.status(201).json(t);
  } catch (err) { next(err); }
});

// PATCH /api/lastik-talepleri/:id — admin: { durum?, admin_notu? }; servis: { durum: 'iptal' } (yalnız bekliyor iken)
router.patch('/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const { rows: [t] } = await query('SELECT * FROM lastik_talepleri WHERE id=$1', [req.params.id]);
    if (!t) throw httpHata(404, 'Talep bulunamadı');
    const d = {};
    if (req.user.rol === 'servis') {
      if (t.servis_id !== req.user.servis_id) throw httpHata(403, 'Bu talebe erişiminiz yok');
      if (b.durum !== 'iptal' || Object.keys(b).some((k) => k !== 'durum'))
        throw httpHata(403, 'Servis yalnız talebi iptal edebilir');
      if (t.durum !== 'bekliyor') throw httpHata(409, 'İşleme alınmış talep iptal edilemez');
      d.durum = 'iptal';
    } else {
      if (b.durum !== undefined) d.durum = alanDegeri({ t: 'enum', secenekler: DURUM, bos: false }, b.durum, 'Durum');
      if (b.admin_notu !== undefined) d.admin_notu = metin(b.admin_notu, 'Not', 1000);
    }
    const k = Object.keys(d);
    if (!k.length) throw httpHata(400, 'Güncellenecek alan yok');
    const { rows: [y] } = await query(
      `UPDATE lastik_talepleri SET ${k.map((x, i) => `${x}=$${i + 1}`).join(', ')}, updated_at=NOW()
       WHERE id=$${k.length + 1} RETURNING *`,
      [...k.map((x) => d[x]), t.id]);
    res.json(y);
  } catch (err) { next(err); }
});

module.exports = router;
