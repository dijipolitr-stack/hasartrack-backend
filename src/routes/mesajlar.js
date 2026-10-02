// Dosya bazında admin ↔ servis yazışması. Acente okur. Okununca karşı tarafın mesajları işaretlenir.
// Eksper / araç sahibi / sigortanın hesabı yok; onlara mesaj SMS/e-posta işidir (kapsam dışı).
const router = require('express').Router();
const { query } = require('../db');
const { authMiddleware, adminOrServis, notMusteri, dosyaErisim } = require('../middleware/auth');
const { uuidParam } = require('../lib/dogrula');

router.use(authMiddleware);
router.param('dosyaId', uuidParam('dosyaId'));

const MAKS = 2000;

// GET /api/mesajlar/okunmamis — bana gelen okunmamış mesaj sayısı, dosya başına
router.get('/okunmamis', adminOrServis, async (req, res, next) => {
  try {
    const params = [req.user.rol];
    let filtre = '';
    if (req.user.rol === 'servis') { params.push(req.user.servis_id); filtre = 'AND d.atanan_servis=$2'; }
    const { rows } = await query(
      `SELECT m.dosya_id, COUNT(*)::int AS sayi FROM mesajlar m JOIN dosyalar d ON d.id=m.dosya_id
       WHERE m.hedef_rol=$1 AND NOT m.okundu ${filtre} GROUP BY m.dosya_id`, params);
    res.json({ dosyalar: Object.fromEntries(rows.map((r) => [r.dosya_id, r.sayi])), toplam: rows.reduce((s, r) => s + r.sayi, 0) });
  } catch (err) { next(err); }
});

// GET /api/mesajlar/:dosyaId[?isaretle=hayir] — yazışma; admin/servis açınca kendine gelenler
// okundu olur (özet ekranı gibi yalnız gösterim için isaretle=hayir)
router.get('/:dosyaId', notMusteri, dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    if (['admin', 'servis'].includes(req.user.rol) && req.query.isaretle !== 'hayir')
      await query(`UPDATE mesajlar SET okundu=TRUE WHERE dosya_id=$1 AND hedef_rol=$2 AND NOT okundu`, [dosyaId, req.user.rol]);
    const { rows } = await query(
      `SELECT m.id, m.gonderen_rol, m.hedef_rol, m.mesaj, m.okundu, m.created_at, k.ad_soyad AS gonderen_ad
       FROM mesajlar m LEFT JOIN kullanicilar k ON k.id=m.gonderen_id
       WHERE m.dosya_id=$1 ORDER BY m.created_at`, [dosyaId]);
    res.json({ mesajlar: rows });
  } catch (err) { next(err); }
});

// POST /api/mesajlar/:dosyaId { mesaj } — admin → servis, servis → admin
router.post('/:dosyaId', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const metin = typeof req.body?.mesaj === 'string' ? req.body.mesaj.trim() : '';
    if (!metin) return res.status(400).json({ error: 'Mesaj boş olamaz' });
    if (metin.length > MAKS) return res.status(400).json({ error: `Mesaj en fazla ${MAKS} karakter olabilir` });
    const hedef = req.user.rol === 'admin' ? 'servis' : 'admin';
    if (hedef === 'servis') {
      const { rows: [d] } = await query('SELECT atanan_servis FROM dosyalar WHERE id=$1', [req.params.dosyaId]);
      if (!d.atanan_servis) return res.status(409).json({ error: 'Dosyaya servis atanmamış, mesaj iletilemez' });
    }
    const { rows: [m] } = await query(
      `INSERT INTO mesajlar (dosya_id, gonderen_id, gonderen_rol, hedef_rol, mesaj)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, gonderen_rol, hedef_rol, mesaj, okundu, created_at`,
      [req.params.dosyaId, req.user.id, req.user.rol, hedef, metin]);
    res.status(201).json({ ...m, gonderen_ad: req.user.ad_soyad });
  } catch (err) { next(err); }
});

module.exports = router;
