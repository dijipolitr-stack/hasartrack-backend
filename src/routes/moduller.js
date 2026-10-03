// Panel modülleri için özet listeler (yalnız okuma). Admin tüm dosyaları, servis yalnız kendine
// atananları görür. Her uç mevcut tablolardan derlenir; yeni kayıt yazmaz.
const router = require('express').Router();
const { query } = require('../db');
const { authMiddleware, adminOrServis } = require('../middleware/auth');
const { httpHata } = require('../lib/dogrula');
const { BOLUMLER } = require('../lib/isEmri');

router.use(authMiddleware, adminOrServis);

// Servis için "AND d.atanan_servis = $n" filtresi; params dizisine ekler
const kapsam = (req, params) => {
  if (req.user.rol !== 'servis') return '';
  params.push(req.user.servis_id);
  return ` AND d.atanan_servis = $${params.length}`;
};
const GUN = (kolon) => `GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - ${kolon})) / 86400))::int`;

// GET /api/moduller/kabul-teslim — kabul ve teslim tutanağı durumu
router.get('/kabul-teslim', async (req, res, next) => {
  try {
    const params = [];
    const f = kapsam(req, params);
    const { rows } = await query(`
      SELECT d.id AS dosya_id, d.dosya_no, d.durum, a.plaka, a.marka, a.model, sa.ad_soyad AS sahip_ad,
             srv.ad AS servis_ad, om.arac_giris_trh, om.tahmini_teslimat,
             k.km AS kabul_km, k.yakit_yuzde AS kabul_yakit, k.personel_ad AS kabul_personel, k.created_at AS kabul_trh,
             t.km AS teslim_km, t.musteri_ad AS teslim_alan, t.created_at AS teslim_trh,
             (SELECT COUNT(*) FROM onarim_adimlari x WHERE x.dosya_id=d.id AND x.durum<>'tamamlandi')::int AS kalan_adim,
             (SELECT ad FROM onarim_adimlari x WHERE x.dosya_id=d.id AND x.durum='aktif' ORDER BY sira LIMIT 1) AS aktif_adim
      FROM dosyalar d
      LEFT JOIN arac a ON a.dosya_id=d.id
      LEFT JOIN sahip sa ON sa.dosya_id=d.id
      LEFT JOIN servisler srv ON srv.id=d.atanan_servis
      LEFT JOIN onarim_merkezi om ON om.dosya_id=d.id
      LEFT JOIN arac_tutanaklari k ON k.dosya_id=d.id AND k.tip='kabul'
      LEFT JOIN arac_tutanaklari t ON t.dosya_id=d.id AND t.tip='teslim'
      WHERE d.durum<>'İptal'${f}
      ORDER BY COALESCE(t.created_at, k.created_at, d.created_at) DESC
      LIMIT 300`, params);
    res.json({ dosyalar: rows });
  } catch (err) { next(err); }
});

// GET /api/moduller/ekspertiz — eksper, sigorta ve onay özeti
router.get('/ekspertiz', async (req, res, next) => {
  try {
    const params = [];
    const f = kapsam(req, params);
    const { rows } = await query(`
      SELECT d.id AS dosya_id, d.dosya_no, d.durum, d.sigorta_bransi, d.muallak_hasar,
             a.plaka, a.marka, a.model, srv.ad AS servis_ad,
             si.sirket_ad, si.hasar_no, si.police_no, si.muafiyet,
             ex.ad_soyad AS eksper_ad, ex.firma AS eksper_firma, ex.inceleme_tarihi, ex.tahmini_hasar,
             COALESCE(ex.onay_durumu, 'Beklemede') AS eksper_onay,
             (SELECT COALESCE(SUM(i.miktar*i.birim_fiyat),0) FROM islemler i JOIN is_emirleri ie ON ie.id=i.is_emri_id
              WHERE i.dosya_id=d.id AND ie.durum<>'iptal' AND i.durum<>'reddedildi') AS teklif_tutar,
             (SELECT COALESCE(SUM(i.miktar*i.birim_fiyat),0) FROM islemler i JOIN is_emirleri ie ON ie.id=i.is_emri_id
              WHERE i.dosya_id=d.id AND ie.durum<>'iptal' AND i.durum='onaylandi') AS onaylanan_tutar,
             -- Bekleyen tur yoksa NULL (GREATEST NULL'u yok sayar, CASE şart)
             (SELECT CASE WHEN MIN(ie.gonderim_trh) IS NULL THEN NULL ELSE ${GUN('MIN(ie.gonderim_trh)')} END
              FROM is_emirleri ie
              WHERE ie.dosya_id=d.id AND ie.onay_durumu='bekliyor' AND ie.durum<>'iptal') AS onay_bekleme_gun,
             (SELECT COUNT(*) FROM is_emirleri ie WHERE ie.dosya_id=d.id AND ie.durum<>'iptal')::int AS is_emri_sayisi
      FROM dosyalar d
      LEFT JOIN arac a ON a.dosya_id=d.id
      LEFT JOIN servisler srv ON srv.id=d.atanan_servis
      LEFT JOIN sigorta si ON si.dosya_id=d.id
      LEFT JOIN eksper ex ON ex.dosya_id=d.id
      WHERE d.durum<>'İptal'${f}
      ORDER BY d.created_at DESC
      LIMIT 300`, params);
    res.json({ dosyalar: rows });
  } catch (err) { next(err); }
});

// GET /api/moduller/bolum/:bolum — bir bölümün açık ve son 30 günde biten görevleri
router.get('/bolum/:bolum', async (req, res, next) => {
  try {
    const { bolum } = req.params;
    if (!BOLUMLER[bolum]) throw httpHata(400, 'Geçersiz bölüm');
    const params = [bolum];
    const f = kapsam(req, params);
    const { rows } = await query(`
      SELECT g.id, g.bolum, g.aciklama, g.sorumlu_usta, g.durum, g.bekleme_nedeni,
             g.baslama_trh, g.bitis_trh, g.bitiren_usta, g.created_at,
             d.id AS dosya_id, d.dosya_no, a.plaka, a.marka, a.model, srv.ad AS servis_ad,
             (SELECT ad FROM gorev_adimlari WHERE gorev_id=g.id AND durum='bekliyor' ORDER BY sira LIMIT 1) AS aktif_adim,
             (SELECT COUNT(*) FROM gorev_adimlari WHERE gorev_id=g.id)::int AS adim_sayisi,
             (SELECT COUNT(*) FROM gorev_adimlari WHERE gorev_id=g.id AND durum='tamam')::int AS biten_adim,
             ${GUN('COALESCE(g.baslama_trh, g.created_at)')} AS gun,
             CASE WHEN g.bitis_trh IS NOT NULL THEN
               ROUND(EXTRACT(EPOCH FROM (g.bitis_trh - COALESCE(g.baslama_trh, g.created_at))) / 3600.0, 1) END AS sure_saat
      FROM bolum_gorevleri g
      JOIN is_emirleri ie ON ie.id=g.is_emri_id AND ie.durum<>'iptal'
      JOIN dosyalar d ON d.id=g.dosya_id AND d.durum<>'İptal'
      LEFT JOIN arac a ON a.dosya_id=d.id
      LEFT JOIN servisler srv ON srv.id=d.atanan_servis
      WHERE g.bolum=$1 AND (g.durum<>'tamam' OR g.bitis_trh > NOW() - INTERVAL '30 days')${f}
      ORDER BY (g.durum='tamam'), gun DESC, g.created_at`, params);
    res.json({ bolum: { id: bolum, ...BOLUMLER[bolum] }, gorevler: rows });
  } catch (err) { next(err); }
});

// GET /api/moduller/medya — dosya başına fotoğraf ve evrak durumu
router.get('/medya', async (req, res, next) => {
  try {
    const params = [];
    const f = kapsam(req, params);
    const { rows } = await query(`
      SELECT d.id AS dosya_id, d.dosya_no, d.durum, a.plaka, a.marka, a.model, srv.ad AS servis_ad,
             (SELECT COUNT(*) FROM fotograflar x WHERE x.dosya_id=d.id)::int AS foto_sayisi,
             (SELECT MAX(created_at) FROM fotograflar x WHERE x.dosya_id=d.id) AS son_foto,
             (SELECT COUNT(*) FROM evrak e WHERE e.dosya_id=d.id)::int AS evrak_toplam,
             (SELECT COUNT(*) FROM evrak e WHERE e.dosya_id=d.id AND e.durum='tamam')::int AS evrak_tamam,
             (SELECT COUNT(*) FROM evrak e WHERE e.dosya_id=d.id AND e.durum='eksik')::int AS evrak_eksik,
             (SELECT COALESCE(array_agg(e.ad ORDER BY e.sira NULLS LAST, e.ad), '{}') FROM evrak e
              WHERE e.dosya_id=d.id AND e.durum='eksik') AS eksik_liste,
             (SELECT COALESCE(array_agg(e.ad ORDER BY e.sira NULLS LAST, e.ad), '{}') FROM evrak e
              WHERE e.dosya_id=d.id AND e.durum='bekliyor') AS bekleyen_liste
      FROM dosyalar d
      LEFT JOIN arac a ON a.dosya_id=d.id
      LEFT JOIN servisler srv ON srv.id=d.atanan_servis
      WHERE d.durum<>'İptal'${f}
      ORDER BY d.created_at DESC
      LIMIT 300`, params);
    res.json({ dosyalar: rows });
  } catch (err) { next(err); }
});

// GET /api/moduller/portal — müşteri takip linkleri (token dönmez) + linki olmayan aktif dosyalar
router.get('/portal', async (req, res, next) => {
  try {
    const params = [];
    const f = kapsam(req, params);
    const [{ rows: linkler }, { rows: linksiz }] = await Promise.all([
      query(`
        SELECT t.id, t.dosya_id, d.dosya_no, d.durum, a.plaka, a.marka, a.model, sa.ad_soyad AS sahip_ad,
               sa.telefon AS sahip_tel, t.son_gecerlilik, t.iptal_trh, t.son_erisim, t.erisim_sayisi, t.created_at,
               k.ad_soyad AS olusturan_ad, k.rol AS olusturan_rol,
               (t.iptal_trh IS NULL AND t.son_gecerlilik > NOW()) AS aktif
        FROM takip_linkleri t
        JOIN dosyalar d ON d.id=t.dosya_id
        LEFT JOIN arac a ON a.dosya_id=d.id
        LEFT JOIN sahip sa ON sa.dosya_id=d.id
        LEFT JOIN kullanicilar k ON k.id=t.olusturan_id
        WHERE TRUE${f}
        ORDER BY t.created_at DESC
        LIMIT 300`, params),
      query(`
        SELECT d.id AS dosya_id, d.dosya_no, a.plaka, a.marka, a.model, sa.ad_soyad AS sahip_ad, sa.telefon AS sahip_tel
        FROM dosyalar d
        LEFT JOIN arac a ON a.dosya_id=d.id
        LEFT JOIN sahip sa ON sa.dosya_id=d.id
        WHERE d.durum='Aktif'${f}
          AND NOT EXISTS (SELECT 1 FROM takip_linkleri t WHERE t.dosya_id=d.id
                          AND t.iptal_trh IS NULL AND t.son_gecerlilik > NOW())
        ORDER BY d.created_at DESC`, params),
    ]);
    res.json({ linkler, linksiz });
  } catch (err) { next(err); }
});

module.exports = router;
