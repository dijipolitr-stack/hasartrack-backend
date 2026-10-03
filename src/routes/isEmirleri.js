// İş emirleri, bölüm görevleri ve görev adımları. Servis tek hesapla girer; görev adımını
// bitiren usta adıyla bildirir. Bildirilmeyen görev açık kalır.
const router = require('express').Router();
const { query, withTransaction } = require('../db');
const { authMiddleware, adminOrServis, notMusteri, dosyaErisim } = require('../middleware/auth');
const { uuidParam, httpHata } = require('../lib/dogrula');
const { BOLUMLER, anaIsEmri, isEmriBul } = require('../lib/isEmri');

router.use(authMiddleware);
router.param('dosyaId', uuidParam('dosyaId'));
router.param('isEmriId', uuidParam('isEmriId'));
router.param('gorevId', uuidParam('gorevId'));
router.param('adimId', uuidParam('adimId'));

const metin = (v, ad, maks, zorunlu) => {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
    if (zorunlu) throw httpHata(400, `${ad} gerekli`);
    return null;
  }
  if (typeof v !== 'string') throw httpHata(400, `${ad} geçersiz`);
  const t = v.trim();
  if (maks && t.length > maks) throw httpHata(400, `${ad} en fazla ${maks} karakter olabilir`);
  return t;
};
const GUN = `GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - %s)) / 86400))::int`;
const gun = (kolon) => GUN.replace('%s', kolon);

// GET /api/is-emirleri/bolumler — sabit bölüm listesi ve varsayılan adımlar
router.get('/bolumler', notMusteri, (req, res) => res.json({ bolumler: BOLUMLER }));

// GET /api/is-emirleri/pano — açık bölüm görevleri (servis: kendi dosyaları)
router.get('/pano', adminOrServis, async (req, res, next) => {
  try {
    const params = [];
    let filtre = '';
    if (req.user.rol === 'servis') { params.push(req.user.servis_id); filtre = 'AND d.atanan_servis=$1'; }
    const { rows } = await query(`
      SELECT g.id, g.bolum, g.aciklama, g.sorumlu_usta, g.durum, g.bekleme_nedeni,
             g.baslama_trh, g.created_at, g.is_emri_id, ie.no AS is_emri_no, ie.tur AS is_emri_tur,
             d.id AS dosya_id, d.dosya_no, a.plaka, a.marka, a.model, srv.ad AS servis_ad,
             (SELECT ad FROM gorev_adimlari WHERE gorev_id=g.id AND durum='bekliyor' ORDER BY sira LIMIT 1) AS aktif_adim,
             (SELECT COUNT(*) FROM gorev_adimlari WHERE gorev_id=g.id)::int AS adim_sayisi,
             (SELECT COUNT(*) FROM gorev_adimlari WHERE gorev_id=g.id AND durum='tamam')::int AS biten_adim,
             ${gun('COALESCE(g.baslama_trh, g.created_at)')} AS gun
      FROM bolum_gorevleri g
      JOIN is_emirleri ie ON ie.id=g.is_emri_id AND ie.durum<>'iptal'
      JOIN dosyalar d ON d.id=g.dosya_id AND d.durum NOT IN ('Tamamlandı','İptal')
      LEFT JOIN arac a ON a.dosya_id=d.id
      LEFT JOIN servisler srv ON srv.id=d.atanan_servis
      WHERE g.durum<>'tamam' ${filtre}
      ORDER BY gun DESC, g.created_at`, params);
    res.json({ gorevler: rows });
  } catch (err) { next(err); }
});

// GET /api/is-emirleri/bekleyen-onaylar — onay bekleyen iş emirleri, kaç gündür bekliyor
router.get('/bekleyen-onaylar', adminOrServis, async (req, res, next) => {
  try {
    const params = [];
    const f = req.user.rol === 'servis' ? (params.push(req.user.servis_id), ' AND d.atanan_servis=$1') : '';
    const { rows } = await query(`
      SELECT ie.id, ie.no, ie.tur, ie.aciklama, ie.gonderim_trh, ${gun('ie.gonderim_trh')} AS gun,
             d.id AS dosya_id, d.dosya_no, a.plaka, srv.ad AS servis_ad,
             (SELECT COALESCE(SUM(miktar*birim_fiyat),0) FROM islemler WHERE is_emri_id=ie.id) AS tutar,
             (SELECT COUNT(*) FROM islemler WHERE is_emri_id=ie.id)::int AS kalem_sayisi
      FROM is_emirleri ie
      JOIN dosyalar d ON d.id=ie.dosya_id
      LEFT JOIN arac a ON a.dosya_id=d.id
      LEFT JOIN servisler srv ON srv.id=d.atanan_servis
      WHERE ie.onay_durumu='bekliyor' AND ie.durum<>'iptal'${f}
      ORDER BY ie.gonderim_trh`, params);
    res.json({ onaylar: rows });
  } catch (err) { next(err); }
});

// Görevleri adımlarıyla birlikte döner
const gorevleriGetir = async (where, params) => {
  const { rows: gorevler } = await query(
    `SELECT g.*, ${gun('COALESCE(g.baslama_trh, g.created_at)')} AS gun
     FROM bolum_gorevleri g WHERE ${where} ORDER BY g.created_at`, params);
  if (!gorevler.length) return [];
  const { rows: adimlar } = await query(
    'SELECT * FROM gorev_adimlari WHERE gorev_id = ANY($1) ORDER BY sira', [gorevler.map((g) => g.id)]);
  return gorevler.map((g) => ({ ...g, adimlar: adimlar.filter((a) => a.gorev_id === g.id) }));
};

// GET /api/is-emirleri/:dosyaId — iş emirleri + görevler + kalem özetleri
router.get('/:dosyaId', notMusteri, dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    await anaIsEmri(dosyaId);
    const { rows: isEmirleri } = await query(`
      SELECT ie.*,
             (SELECT COUNT(*) FROM islemler WHERE is_emri_id=ie.id)::int AS kalem_sayisi,
             (SELECT COALESCE(SUM(miktar*birim_fiyat),0) FROM islemler WHERE is_emri_id=ie.id) AS kalem_toplam,
             ${gun('ie.gonderim_trh')} AS bekleme_gun
      FROM is_emirleri ie WHERE ie.dosya_id=$1 ORDER BY ie.no`, [dosyaId]);
    const gorevler = await gorevleriGetir('g.dosya_id=$1', [dosyaId]);
    res.json({
      is_emirleri: isEmirleri.map((ie) => ({ ...ie, gorevler: gorevler.filter((g) => g.is_emri_id === ie.id) })),
      bolumler: BOLUMLER,
    });
  } catch (err) { next(err); }
});

// POST /api/is-emirleri/:dosyaId — ek hasar iş emri { aciklama }
// Ana iş emri onaylandıktan sonra açılır; kendi onay turu vardır.
router.post('/:dosyaId', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const aciklama = metin(req.body?.aciklama, 'Ek hasar açıklaması', 1000, true);
    const { rows: [dosya] } = await query('SELECT durum FROM dosyalar WHERE id=$1', [dosyaId]);
    if (['Tamamlandı', 'İptal'].includes(dosya.durum))
      return res.status(409).json({ error: `Dosya ${dosya.durum.toLocaleLowerCase('tr-TR')}, ek hasar açılamaz` });
    const ana = await anaIsEmri(dosyaId);
    if (ana.onay_durumu !== 'onaylandi')
      return res.status(409).json({ error: 'Ek hasar, ana iş emri onaylandıktan sonra bildirilir' });
    const ie = await withTransaction(async (client) => {
      await client.query('SELECT id FROM dosyalar WHERE id=$1 FOR UPDATE', [dosyaId]);
      const { rows: [{ no }] } = await client.query(
        'SELECT COALESCE(MAX(no),0)+1 AS no FROM is_emirleri WHERE dosya_id=$1', [dosyaId]);
      const { rows: [yeni] } = await client.query(
        `INSERT INTO is_emirleri (dosya_id, no, tur, aciklama, olusturan_id)
         VALUES ($1,$2,'ek_hasar',$3,$4) RETURNING *`, [dosyaId, no, aciklama, req.user.id]);
      await client.query(
        `INSERT INTO audit_log (dosya_id, kullanici_id, eylem, detay) VALUES ($1,$2,'EK_HASAR',$3)`,
        [dosyaId, req.user.id, JSON.stringify({ is_emri_no: no })]);
      return yeni;
    });
    res.status(201).json(ie);
  } catch (err) { next(err); }
});

// PATCH /api/is-emirleri/:dosyaId/:isEmriId — { aciklama?, durum?: 'iptal' }
// İptal yalnız onaya gönderilmemiş ek hasar iş emrinde.
router.patch('/:dosyaId/:isEmriId', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const ie = await isEmriBul(req.params.dosyaId, req.params.isEmriId);
    const b = req.body || {};
    const set = [], params = [];
    if (b.aciklama !== undefined) { params.push(metin(b.aciklama, 'Açıklama', 1000)); set.push(`aciklama=$${params.length}`); }
    if (b.durum !== undefined) {
      if (b.durum !== 'iptal') return res.status(400).json({ error: 'Durum yalnız "iptal" olabilir' });
      if (ie.tur !== 'ek_hasar' || !['taslak', 'reddedildi'].includes(ie.onay_durumu))
        return res.status(409).json({ error: 'Yalnız onaya gönderilmemiş ek hasar iş emri iptal edilir' });
      set.push(`durum='iptal'`);
    }
    if (!set.length) return res.status(400).json({ error: 'Güncellenecek alan yok' });
    params.push(ie.id);
    const { rows: [g] } = await query(
      `UPDATE is_emirleri SET ${set.join(', ')} WHERE id=$${params.length} RETURNING *`, params);
    res.json(g);
  } catch (err) { next(err); }
});

// ── BÖLÜM GÖREVLERİ ─────────────────────────────────────────
// POST /api/is-emirleri/:dosyaId/:isEmriId/gorevler { bolum, aciklama?, sorumlu_usta? }
router.post('/:dosyaId/:isEmriId/gorevler', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const ie = await isEmriBul(req.params.dosyaId, req.params.isEmriId);
    if (ie.durum === 'iptal') return res.status(409).json({ error: 'İş emri iptal edildi' });
    const b = req.body || {};
    if (typeof b.bolum !== 'string' || !Object.prototype.hasOwnProperty.call(BOLUMLER, b.bolum))
      return res.status(400).json({ error: 'Geçersiz bölüm' });
    const aciklama = metin(b.aciklama, 'Açıklama', 1000);
    const usta = metin(b.sorumlu_usta, 'Sorumlu usta', 100);
    const gorev = await withTransaction(async (client) => {
      const { rows: [g] } = await client.query(
        `INSERT INTO bolum_gorevleri (is_emri_id, dosya_id, bolum, aciklama, sorumlu_usta, olusturan_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ie.id, ie.dosya_id, b.bolum, aciklama, usta, req.user.id]);
      const adimlar = [];
      for (const [i, ad] of BOLUMLER[b.bolum].adimlar.entries()) {
        const { rows: [a] } = await client.query(
          'INSERT INTO gorev_adimlari (gorev_id, sira, ad) VALUES ($1,$2,$3) RETURNING *', [g.id, i + 1, ad]);
        adimlar.push(a);
      }
      return { ...g, gun: 0, adimlar };
    });
    res.status(201).json(gorev);
  } catch (err) { next(err); }
});

const gorevBul = async (req) => {
  const { rows: [g] } = await query(
    `SELECT g.* FROM bolum_gorevleri g JOIN is_emirleri ie ON ie.id=g.is_emri_id
     WHERE g.id=$1 AND g.is_emri_id=$2 AND ie.dosya_id=$3`,
    [req.params.gorevId, req.params.isEmriId, req.params.dosyaId]);
  if (!g) throw httpHata(404, 'Görev bulunamadı');
  return g;
};
const gorevDon = async (id) => (await gorevleriGetir('g.id=$1', [id]))[0];

// PATCH .../gorevler/:gorevId { durum?: bekliyor|devam|beklemede, bekleme_nedeni?, sorumlu_usta?, aciklama? }
// "tamam" buradan verilmez: görev, son adımı usta bildirince kapanır.
router.patch('/:dosyaId/:isEmriId/gorevler/:gorevId', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const g = await gorevBul(req);
    if (g.durum === 'tamam') return res.status(409).json({ error: 'Tamamlanan görev değiştirilemez' });
    const b = req.body || {};
    const set = [], params = [];
    const ekle = (kolon, v) => { params.push(v); set.push(`${kolon}=$${params.length}`); };
    if (b.durum !== undefined) {
      if (!['bekliyor', 'devam', 'beklemede'].includes(b.durum))
        return res.status(400).json({ error: 'Durum bekliyor, devam veya beklemede olabilir' });
      ekle('durum', b.durum);
      if (b.durum === 'beklemede') ekle('bekleme_nedeni', metin(b.bekleme_nedeni, 'Bekleme nedeni', 500, true));
      else ekle('bekleme_nedeni', null);
      if (b.durum === 'devam' && !g.baslama_trh) set.push('baslama_trh=NOW()');
    }
    if (b.sorumlu_usta !== undefined) ekle('sorumlu_usta', metin(b.sorumlu_usta, 'Sorumlu usta', 100));
    if (b.aciklama !== undefined) ekle('aciklama', metin(b.aciklama, 'Açıklama', 1000));
    if (!set.length) return res.status(400).json({ error: 'Güncellenecek alan yok' });
    params.push(g.id);
    await query(`UPDATE bolum_gorevleri SET ${set.join(', ')} WHERE id=$${params.length}`, params);
    res.json(await gorevDon(g.id));
  } catch (err) { next(err); }
});

// DELETE .../gorevler/:gorevId — yalnız hiç adımı bitmemiş görev
router.delete('/:dosyaId/:isEmriId/gorevler/:gorevId', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const g = await gorevBul(req);
    const { rowCount } = await query(
      `SELECT 1 FROM gorev_adimlari WHERE gorev_id=$1 AND durum='tamam'`, [g.id]);
    if (rowCount) return res.status(409).json({ error: 'Adımı bitmiş görev silinemez' });
    await query('DELETE FROM bolum_gorevleri WHERE id=$1', [g.id]);
    res.json({ mesaj: 'Görev silindi' });
  } catch (err) { next(err); }
});

// POST .../gorevler/:gorevId/adimlar/:adimId/tamamla { usta } — usta işi bitirdiğini bildirir
// Son adım bitince görev "tamam" olur.
router.post('/:dosyaId/:isEmriId/gorevler/:gorevId/adimlar/:adimId/tamamla', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const usta = metin(req.body?.usta, 'Usta adı', 100, true);
    const g = await gorevBul(req);
    await withTransaction(async (client) => {
      // Görev satırı kilitlenir: aynı anda bildirilen son iki adım görevi açık bırakmasın
      await client.query('SELECT id FROM bolum_gorevleri WHERE id=$1 FOR UPDATE', [g.id]);
      const { rows: [a] } = await client.query(
        'SELECT * FROM gorev_adimlari WHERE id=$1 AND gorev_id=$2 FOR UPDATE', [req.params.adimId, g.id]);
      if (!a) throw httpHata(404, 'Adım bulunamadı');
      if (a.durum === 'tamam') throw httpHata(409, 'Adım zaten tamamlandı');
      await client.query(
        `UPDATE gorev_adimlari SET durum='tamam', tamamlanma_trh=NOW(), tamamlayan_usta=$1, tamamlayan_id=$2
         WHERE id=$3`, [usta, req.user.id, a.id]);
      const { rows: [{ kalan }] } = await client.query(
        `SELECT COUNT(*)::int AS kalan FROM gorev_adimlari WHERE gorev_id=$1 AND durum<>'tamam'`, [g.id]);
      if (kalan === 0) {
        await client.query(
          `UPDATE bolum_gorevleri SET durum='tamam', bitis_trh=NOW(), bitiren_usta=$1, bekleme_nedeni=NULL,
             baslama_trh=COALESCE(baslama_trh, NOW()) WHERE id=$2`, [usta, g.id]);
      } else {
        await client.query(
          `UPDATE bolum_gorevleri SET durum='devam', bekleme_nedeni=NULL,
             baslama_trh=COALESCE(baslama_trh, NOW()) WHERE id=$1`, [g.id]);
      }
    });
    res.json(await gorevDon(g.id));
  } catch (err) { next(err); }
});

module.exports = router;
