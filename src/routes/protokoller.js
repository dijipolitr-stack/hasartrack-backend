// Sigorta protokolleri ve dosya teklifinin protokole göre kontrolü.
// Protokol okuma ve yazma admin + servis. Kontrol: dosyaya erişen admin/servis.
const router = require('express').Router();
const { query } = require('../db');
const { authMiddleware, adminOrServis, dosyaErisim } = require('../middleware/auth');
const { uuidParam, httpHata, alanDegeri } = require('../lib/dogrula');

router.use(authMiddleware, adminOrServis);
router.param('id', uuidParam('id'));
router.param('dosyaId', uuidParam('dosyaId'));

const alanlar = (b, kismi) => {
  const d = {};
  const al = (ad, tip, etiket) => { if (kismi && b[ad] === undefined) return; d[ad] = alanDegeri(tip, b[ad], etiket); };
  if (!kismi || b.sirket_ad !== undefined) {
    const s = alanDegeri({ t: 'metin', bos: false }, typeof b.sirket_ad === 'string' ? b.sirket_ad.trim() : b.sirket_ad, 'Sigorta şirketi');
    if (s.length > 100) throw httpHata(400, 'Sigorta şirketi en çok 100 karakter olabilir');
    d.sirket_ad = s;
  }
  al('baslangic', { t: 'tarih', bos: false }, 'Başlangıç');
  al('bitis', { t: 'tarih' }, 'Bitiş');
  al('iscilik_saat_ucreti', { t: 'sayi' }, 'İşçilik saat ücreti');
  al('muafiyet', { t: 'sayi' }, 'Muafiyet');
  for (const [ad, etiket] of [['parca_iskonto_yuzde', 'Parça iskontosu'], ['malzeme_iskonto_yuzde', 'Malzeme iskontosu']]) {
    if (kismi && b[ad] === undefined) continue;
    const v = alanDegeri({ t: 'sayi' }, b[ad], etiket) ?? 0;
    if (v > 100) throw httpHata(400, `${etiket} 0 ile 100 arasında olmalı`);
    d[ad] = v;
  }
  if (!kismi || b.notlar !== undefined) d.notlar = alanDegeri({ t: 'metin' }, b.notlar, 'Not');
  if (b.aktif !== undefined) {
    if (typeof b.aktif !== 'boolean') throw httpHata(400, 'Aktif geçersiz');
    d.aktif = b.aktif;
  }
  if (d.baslangic && d.bitis && d.bitis < d.baslangic) throw httpHata(400, 'Bitiş başlangıçtan önce olamaz');
  return d;
};

// GET /api/protokoller
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT p.*, (p.aktif AND p.baslangic <= CURRENT_DATE AND (p.bitis IS NULL OR p.bitis >= CURRENT_DATE)) AS gecerli,
             (SELECT COUNT(*) FROM sigorta si JOIN dosyalar d ON d.id=si.dosya_id
              WHERE lower(trim(si.sirket_ad))=lower(trim(p.sirket_ad)) AND d.durum='Aktif')::int AS aktif_dosya
      FROM sigorta_protokolleri p ORDER BY p.aktif DESC, p.sirket_ad, p.baslangic DESC`);
    res.json({ protokoller: rows });
  } catch (err) { next(err); }
});

// POST /api/protokoller
router.post('/', async (req, res, next) => {
  try {
    const d = alanlar(req.body || {}, false);
    const k = Object.keys(d);
    const { rows: [p] } = await query(
      `INSERT INTO sigorta_protokolleri (${k.join(', ')}, olusturan_id) VALUES (${k.map((_, i) => `$${i + 1}`).join(', ')}, $${k.length + 1}) RETURNING *`,
      [...k.map((x) => d[x]), req.user.id]);
    res.status(201).json(p);
  } catch (err) { next(err); }
});

// PATCH /api/protokoller/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const d = alanlar(req.body || {}, true);
    const k = Object.keys(d);
    if (!k.length) throw httpHata(400, 'Güncellenecek alan yok');
    const { rows: [p] } = await query(
      `UPDATE sigorta_protokolleri SET ${k.map((x, i) => `${x}=$${i + 1}`).join(', ')}, updated_at=NOW() WHERE id=$${k.length + 1} RETURNING *`,
      [...k.map((x) => d[x]), req.params.id]);
    if (!p) throw httpHata(404, 'Protokol bulunamadı');
    res.json(p);
  } catch (err) { next(err); }
});

// GET /api/protokoller/dosya/:dosyaId — dosyanın teklifini geçerli protokole göre kontrol eder
router.get('/dosya/:dosyaId', dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const { rows: [si] } = await query('SELECT sirket_ad, muafiyet FROM sigorta WHERE dosya_id=$1', [dosyaId]);
    const { rows: [p] } = si?.sirket_ad ? await query(`
      SELECT * FROM sigorta_protokolleri
      WHERE aktif AND lower(trim(sirket_ad))=lower(trim($1)) AND baslangic <= CURRENT_DATE AND (bitis IS NULL OR bitis >= CURRENT_DATE)
      ORDER BY baslangic DESC LIMIT 1`, [si.sirket_ad]) : { rows: [] };
    if (!p) return res.json({ sirket_ad: si?.sirket_ad || null, protokol: null });

    const { rows: kalemler } = await query(`
      SELECT i.id, i.kategori, i.aciklama, i.birim, i.miktar, i.birim_fiyat, i.durum, i.odeyen
      FROM islemler i JOIN is_emirleri ie ON ie.id=i.is_emri_id AND ie.durum<>'iptal'
      WHERE i.dosya_id=$1 AND i.durum<>'reddedildi' ORDER BY i.created_at`, [dosyaId]);
    const n = (v) => Number(v || 0);
    const yuvarla = (v) => Math.round(v * 100) / 100;
    const sigortaKalemi = (k) => k.odeyen === 'sigorta';
    const toplam = (f) => yuvarla(kalemler.filter(sigortaKalemi).filter(f).reduce((s, k) => s + n(k.miktar) * n(k.birim_fiyat), 0));
    const saatUcreti = p.iscilik_saat_ucreti === null ? null : n(p.iscilik_saat_ucreti);
    const iscilikFazla = saatUcreti === null ? [] : kalemler
      .filter((k) => sigortaKalemi(k) && k.kategori === 'İşçilik' && /saat/i.test(k.birim || '') && n(k.birim_fiyat) > saatUcreti + 0.005)
      .map((k) => ({ id: k.id, aciklama: k.aciklama, miktar: n(k.miktar), birim_fiyat: n(k.birim_fiyat), protokol_fiyat: saatUcreti,
        fark: yuvarla((n(k.birim_fiyat) - saatUcreti) * n(k.miktar)) }));
    const teklif = toplam(() => true);
    const parca = toplam((k) => k.kategori === 'Parça');
    const malzeme = toplam((k) => k.kategori === 'Malzeme');
    const parcaIskonto = yuvarla(parca * n(p.parca_iskonto_yuzde) / 100);
    const malzemeIskonto = yuvarla(malzeme * n(p.malzeme_iskonto_yuzde) / 100);
    const iscilikFark = yuvarla(iscilikFazla.reduce((s, k) => s + k.fark, 0));
    res.json({
      sirket_ad: si.sirket_ad,
      protokol: p,
      kontrol: {
        teklif_sigorta: teklif, parca_toplam: parca, malzeme_toplam: malzeme,
        parca_iskonto: parcaIskonto, malzeme_iskonto: malzemeIskonto,
        iscilik_fazla: iscilikFazla, iscilik_fark: iscilikFark,
        beklenen: yuvarla(teklif - parcaIskonto - malzemeIskonto - iscilikFark),
        dosya_muafiyet: si.muafiyet === null ? null : n(si.muafiyet),
        muafiyet_uyumlu: p.muafiyet === null || si.muafiyet === null ? null : Math.abs(n(p.muafiyet) - n(si.muafiyet)) < 0.005,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
