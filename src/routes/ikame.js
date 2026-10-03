// İkame araç filosu: araçlar, verme ve iade. Admin ve servis kullanır; servis yalnız kendi dosyasına araç bağlar.
// Bir araç aynı anda tek açık kullanımda olur (DB'de kısmi benzersiz indeks).
const router = require('express').Router();
const { query, withTransaction } = require('../db');
const { authMiddleware, adminOrServis } = require('../middleware/auth');
const { uuidParam, httpHata, alanDegeri, UUID_RE } = require('../lib/dogrula');

router.use(authMiddleware, adminOrServis);
router.param('id', uuidParam('id'));

const metin = (v, ad, maks, zorunlu = false) => {
  const s = alanDegeri({ t: 'metin', bos: !zorunlu }, typeof v === 'string' ? v.trim() : v, ad);
  if (s && s.length > maks) throw httpHata(400, `${ad} en çok ${maks} karakter olabilir`);
  return s;
};
const yakit = (v, ad) => alanDegeri({ t: 'tamsayi', min: 0, max: 100 }, v, ad);
const km = (v, ad, zorunlu) => alanDegeri({ t: 'tamsayi', min: 0, max: 5000000, bos: !zorunlu }, v, ad);

// GET /api/ikame — araçlar, açık kullanımlar ve son 50 iade
router.get('/', async (req, res, next) => {
  try {
    const [{ rows: araclar }, { rows: kullanimlar }] = await Promise.all([
      query('SELECT * FROM ikame_araclar ORDER BY (durum=\'pasif\'), plaka'),
      query(`
        SELECT k.*, a.plaka, a.marka, a.model, d.dosya_no, da.plaka AS dosya_plaka,
               GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (COALESCE(k.iade_trh, NOW()) - k.verilis_trh)) / 86400))::int AS gun
        FROM ikame_kullanimlari k JOIN ikame_araclar a ON a.id=k.arac_id
        LEFT JOIN dosyalar d ON d.id=k.dosya_id LEFT JOIN arac da ON da.dosya_id=k.dosya_id
        ORDER BY (k.iade_trh IS NULL) DESC, COALESCE(k.iade_trh, k.verilis_trh) DESC
        LIMIT 100`),
    ]);
    res.json({ araclar, kullanimlar });
  } catch (err) { next(err); }
});

// POST /api/ikame/araclar
router.post('/araclar', async (req, res, next) => {
  try {
    const b = req.body || {};
    const plaka = metin(b.plaka, 'Plaka', 20, true).toUpperCase().replace(/\s+/g, ' ');
    const { rows: [a] } = await query(
      `INSERT INTO ikame_araclar (plaka, marka, model, yil, km, yakit_yuzde, notlar) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [plaka, metin(b.marka, 'Marka', 50), metin(b.model, 'Model', 100),
       alanDegeri({ t: 'tamsayi', min: 1950, max: 2100 }, b.yil, 'Yıl'), km(b.km, 'Kilometre') ?? 0, yakit(b.yakit_yuzde, 'Yakıt'), metin(b.notlar, 'Not', 1000)]);
    res.status(201).json(a);
  } catch (err) { next(err); }
});

// PATCH /api/ikame/araclar/:id { durum?: musait|bakimda|pasif, km?, yakit_yuzde?, notlar? } — verilmiş araç burada değişmez
router.patch('/araclar/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const { rows: [a] } = await query('SELECT * FROM ikame_araclar WHERE id=$1', [req.params.id]);
    if (!a) throw httpHata(404, 'Araç bulunamadı');
    const d = {};
    if (b.durum !== undefined) {
      d.durum = alanDegeri({ t: 'enum', secenekler: ['musait', 'bakimda', 'pasif'], bos: false }, b.durum, 'Durum');
      if (a.durum === 'verildi') throw httpHata(409, 'Araç müşteride, önce iade alın');
    }
    if (b.km !== undefined) { d.km = km(b.km, 'Kilometre', true); if (d.km < a.km) throw httpHata(400, 'Kilometre düşürülemez'); }
    if (b.yakit_yuzde !== undefined) d.yakit_yuzde = yakit(b.yakit_yuzde, 'Yakıt');
    if (b.notlar !== undefined) d.notlar = metin(b.notlar, 'Not', 1000);
    const k = Object.keys(d);
    if (!k.length) throw httpHata(400, 'Güncellenecek alan yok');
    const { rows: [y] } = await query(
      `UPDATE ikame_araclar SET ${k.map((x, i) => `${x}=$${i + 1}`).join(', ')}, updated_at=NOW() WHERE id=$${k.length + 1} RETURNING *`,
      [...k.map((x) => d[x]), a.id]);
    res.json(y);
  } catch (err) { next(err); }
});

// POST /api/ikame/ver { arac_id, dosya_id?, surucu_ad, surucu_tel?, verilis_km?, verilis_yakit? }
router.post('/ver', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (typeof b.arac_id !== 'string' || !UUID_RE.test(b.arac_id)) throw httpHata(400, 'Araç seçin');
    if (b.dosya_id !== undefined && b.dosya_id !== null && b.dosya_id !== '' && (typeof b.dosya_id !== 'string' || !UUID_RE.test(b.dosya_id)))
      throw httpHata(400, 'Geçersiz dosya');
    const surucu = metin(b.surucu_ad, 'Sürücü adı', 100, true);
    const tel = metin(b.surucu_tel, 'Telefon', 20);
    const sonuc = await withTransaction(async (c) => {
      const { rows: [a] } = await c.query('SELECT * FROM ikame_araclar WHERE id=$1 FOR UPDATE', [b.arac_id]);
      if (!a) throw httpHata(404, 'Araç bulunamadı');
      if (a.durum !== 'musait') throw httpHata(409, `Araç müsait değil (${a.durum})`);
      if (b.dosya_id) {
        const { rows: [d] } = await c.query('SELECT atanan_servis FROM dosyalar WHERE id=$1', [b.dosya_id]);
        if (!d) throw httpHata(404, 'Dosya bulunamadı');
        if (req.user.rol === 'servis' && d.atanan_servis !== req.user.servis_id) throw httpHata(403, 'Bu dosyaya erişiminiz yok');
      }
      const vkm = km(b.verilis_km, 'Veriliş kilometresi') ?? a.km;
      if (vkm < a.km) throw httpHata(400, `Kilometre aracın kaydından (${a.km}) düşük olamaz`);
      const { rows: [k] } = await c.query(
        `INSERT INTO ikame_kullanimlari (arac_id, dosya_id, surucu_ad, surucu_tel, verilis_km, verilis_yakit, olusturan_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [a.id, b.dosya_id || null, surucu, tel, vkm, yakit(b.verilis_yakit, 'Yakıt') ?? a.yakit_yuzde, req.user.id]);
      await c.query("UPDATE ikame_araclar SET durum='verildi', km=$1, updated_at=NOW() WHERE id=$2", [vkm, a.id]);
      return k;
    });
    res.status(201).json(sonuc);
  } catch (err) { next(err); }
});

// POST /api/ikame/iade/:id { iade_km, iade_yakit?, hgs_tutar?, ceza_tutar?, hasar_notu? }
router.post('/iade/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sonuc = await withTransaction(async (c) => {
      const { rows: [k] } = await c.query('SELECT * FROM ikame_kullanimlari WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!k) throw httpHata(404, 'Kullanım bulunamadı');
      if (k.iade_trh) throw httpHata(409, 'Araç zaten iade alındı');
      const ikm = km(b.iade_km, 'İade kilometresi', true);
      if (ikm < k.verilis_km) throw httpHata(400, `İade kilometresi verilişten (${k.verilis_km}) düşük olamaz`);
      const { rows: [y] } = await c.query(
        `UPDATE ikame_kullanimlari SET iade_trh=NOW(), iade_km=$1, iade_yakit=$2, hgs_tutar=$3, ceza_tutar=$4, hasar_notu=$5
         WHERE id=$6 RETURNING *`,
        [ikm, yakit(b.iade_yakit, 'Yakıt'), alanDegeri({ t: 'sayi' }, b.hgs_tutar, 'HGS') ?? 0,
         alanDegeri({ t: 'sayi' }, b.ceza_tutar, 'Ceza') ?? 0, metin(b.hasar_notu, 'Hasar notu', 1000), k.id]);
      await c.query("UPDATE ikame_araclar SET durum='musait', km=$1, yakit_yuzde=COALESCE($2, yakit_yuzde), updated_at=NOW() WHERE id=$3",
        [ikm, y.iade_yakit, k.arac_id]);
      return y;
    });
    res.json(sonuc);
  } catch (err) { next(err); }
});

module.exports = router;
