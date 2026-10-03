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

// ── Paket 2 ──────────────────────────────────────────────────

// GET /api/moduller/finans — servis faturaları (alacak) ve dış hizmet faturaları (gider)
router.get('/finans', async (req, res, next) => {
  try {
    const params = [];
    const f = kapsam(req, params);
    const [{ rows: faturalar }, { rows: dis }] = await Promise.all([
      query(`
        SELECT sf.id, sf.dosya_id, d.dosya_no, a.plaka, srv.ad AS servis_ad, sf.alici_tipi, sf.alici_ad,
               sf.fatura_no, sf.fatura_trh, sf.tutar, sf.kdv_tutar, sf.toplam, sf.odenen_tutar, sf.odeme_trh,
               (sf.toplam - sf.odenen_tutar) AS kalan, ${GUN('COALESCE(sf.fatura_trh, sf.created_at::date)')} AS yas_gun
        FROM servis_faturalari sf
        JOIN dosyalar d ON d.id=sf.dosya_id
        LEFT JOIN arac a ON a.dosya_id=d.id
        LEFT JOIN servisler srv ON srv.id=d.atanan_servis
        WHERE TRUE${f}
        ORDER BY COALESCE(sf.fatura_trh, sf.created_at::date) DESC
        LIMIT 500`, params),
      query(`
        SELECT df.id, df.dosya_id, d.dosya_no, a.plaka, srv.ad AS servis_ad, df.firma, df.hizmet,
               df.fatura_no, df.fatura_trh, df.tutar, df.toplam, df.yansitildi
        FROM dis_faturalar df
        JOIN dosyalar d ON d.id=df.dosya_id
        LEFT JOIN arac a ON a.dosya_id=d.id
        LEFT JOIN servisler srv ON srv.id=d.atanan_servis
        WHERE TRUE${f}
        ORDER BY COALESCE(df.fatura_trh, df.created_at::date) DESC
        LIMIT 500`, params),
    ]);
    res.json({ faturalar, dis_faturalar: dis });
  } catch (err) { next(err); }
});

// GET /api/moduller/plan — Gantt: aktif dosyaların giriş/teslim aralığı, adımlar ve bölüm görevleri
router.get('/plan', async (req, res, next) => {
  try {
    const params = [];
    const f = kapsam(req, params);
    const { rows: dosyalar } = await query(`
      SELECT d.id AS dosya_id, d.dosya_no, a.plaka, a.marka, a.model, srv.ad AS servis_ad,
             om.arac_giris_trh, om.tahmini_teslimat, d.created_at,
             (SELECT ad FROM onarim_adimlari x WHERE x.dosya_id=d.id AND x.durum='aktif' ORDER BY sira LIMIT 1) AS aktif_adim,
             (SELECT ROUND(COUNT(*) FILTER (WHERE durum='tamamlandi')::numeric / NULLIF(COUNT(*),0) * 100)
              FROM onarim_adimlari x WHERE x.dosya_id=d.id)::int AS ilerleme
      FROM dosyalar d
      LEFT JOIN arac a ON a.dosya_id=d.id
      LEFT JOIN servisler srv ON srv.id=d.atanan_servis
      LEFT JOIN onarim_merkezi om ON om.dosya_id=d.id
      WHERE d.durum='Aktif'${f}
      ORDER BY COALESCE(om.tahmini_teslimat, '9999-12-31'), d.created_at`, params);
    const ids = dosyalar.map((x) => x.dosya_id);
    const { rows: gorevler } = ids.length ? await query(`
      SELECT g.id, g.dosya_id, g.bolum, g.aciklama, g.sorumlu_usta, g.durum, g.baslama_trh, g.bitis_trh, g.created_at
      FROM bolum_gorevleri g JOIN is_emirleri ie ON ie.id=g.is_emri_id AND ie.durum<>'iptal'
      WHERE g.dosya_id = ANY($1) ORDER BY g.created_at`, [ids]) : { rows: [] };
    res.json({ dosyalar: dosyalar.map((x) => ({ ...x, gorevler: gorevler.filter((g) => g.dosya_id === x.dosya_id) })) });
  } catch (err) { next(err); }
});

// Sipariş satırı + toplam tutar; geciken = açık ve tahmini geliş geçmiş
const SIPARIS_SQL = `
  SELECT s.id, s.servis_id, srv.ad AS servis_ad, s.tedarikci_id, t.ad AS tedarikci_ad, s.dosya_id, d.dosya_no, a.plaka,
         s.siparis_no, s.siparis_trh, s.tahmini_gelis, s.gelis_trh, s.durum, s.fatura_no,
         (s.durum IN ('siparis','yolda','kismi') AND s.tahmini_gelis < CURRENT_DATE) AS geciken,
         (SELECT COALESCE(SUM(k.adet * COALESCE(k.birim_fiyat,0)),0) FROM siparis_kalemleri k WHERE k.siparis_id=s.id) AS toplam,
         (SELECT COUNT(*) FROM siparis_kalemleri k WHERE k.siparis_id=s.id)::int AS kalem_sayisi,
         (SELECT string_agg(p.ad, ', ' ORDER BY p.ad) FROM siparis_kalemleri k JOIN parcalar p ON p.id=k.parca_id WHERE k.siparis_id=s.id) AS parcalar
  FROM parca_siparisleri s
  JOIN servisler srv ON srv.id=s.servis_id
  LEFT JOIN tedarikciler t ON t.id=s.tedarikci_id
  LEFT JOIN dosyalar d ON d.id=s.dosya_id
  LEFT JOIN arac a ON a.dosya_id=s.dosya_id`;
const servisKapsam = (req, params) => {
  if (req.user.rol !== 'servis') return '';
  params.push(req.user.servis_id);
  return ` AND s.servis_id = $${params.length}`;
};

// GET /api/moduller/siparisler — tüm servislerin parça siparişleri (Satın Alma)
router.get('/siparisler', async (req, res, next) => {
  try {
    const params = [];
    const f = servisKapsam(req, params);
    const { rows } = await query(`${SIPARIS_SQL} WHERE TRUE${f} ORDER BY s.siparis_trh DESC, s.created_at DESC LIMIT 500`, params);
    res.json({ siparisler: rows });
  } catch (err) { next(err); }
});

// GET /api/moduller/tedarikciler — tedarikçi performansı (teslim süresi, gecikme)
router.get('/tedarikciler', async (req, res, next) => {
  try {
    const params = [];
    const f = req.user.rol === 'servis' ? (params.push(req.user.servis_id), ' AND t.servis_id = $1') : '';
    const { rows } = await query(`
      SELECT t.id, t.ad, t.telefon, t.aktif, srv.ad AS servis_ad,
             COUNT(s.id)::int AS siparis_sayisi,
             COUNT(s.id) FILTER (WHERE s.durum IN ('siparis','yolda','kismi'))::int AS acik_siparis,
             COUNT(s.id) FILTER (WHERE s.durum IN ('siparis','yolda','kismi') AND s.tahmini_gelis < CURRENT_DATE)::int AS geciken_acik,
             COUNT(s.id) FILTER (WHERE s.durum='geldi')::int AS gelen,
             COUNT(s.id) FILTER (WHERE s.durum='geldi' AND s.tahmini_gelis IS NOT NULL AND s.gelis_trh > s.tahmini_gelis)::int AS gec_gelen,
             ROUND(AVG(s.gelis_trh - s.siparis_trh) FILTER (WHERE s.durum='geldi' AND s.gelis_trh IS NOT NULL), 1) AS ort_teslim_gun,
             COALESCE(SUM(kt.tutar), 0) AS toplam_tutar,
             MAX(s.siparis_trh) AS son_siparis
      FROM tedarikciler t
      JOIN servisler srv ON srv.id=t.servis_id
      LEFT JOIN parca_siparisleri s ON s.tedarikci_id=t.id AND s.durum<>'iptal'
      LEFT JOIN (SELECT siparis_id, SUM(adet * COALESCE(birim_fiyat,0)) AS tutar FROM siparis_kalemleri GROUP BY siparis_id) kt
        ON kt.siparis_id=s.id
      WHERE TRUE${f}
      GROUP BY t.id, srv.ad
      ORDER BY siparis_sayisi DESC, t.ad`, params);
    res.json({ tedarikciler: rows });
  } catch (err) { next(err); }
});

// GET /api/moduller/operasyon — darboğazlar: adım süreleri, bekleyen onay, beklemedeki görev, geciken parça/teslim
router.get('/operasyon', async (req, res, next) => {
  try {
    const params = [];
    const f = kapsam(req, params);
    const p2 = [];
    const fs = servisKapsam(req, p2);
    const [{ rows: adimSure }, { rows: onaylar }, { rows: beklemede }, { rows: parca }, { rows: teslim }] = await Promise.all([
      // Bir adımın süresi: önceki adımın tamamlanmasından (ilk adımda servise girişten) bu adımın tamamlanmasına
      query(`
        WITH s AS (
          SELECT x.ad, x.sira, x.tamamlanma_trh,
                 LAG(x.tamamlanma_trh) OVER (PARTITION BY x.dosya_id ORDER BY x.sira) AS onceki,
                 om.arac_giris_trh
          FROM onarim_adimlari x JOIN dosyalar d ON d.id=x.dosya_id
          LEFT JOIN onarim_merkezi om ON om.dosya_id=d.id
          WHERE x.durum='tamamlandi' AND x.tamamlanma_trh IS NOT NULL AND d.durum<>'İptal'${f})
        SELECT ad, MIN(sira) AS sira, COUNT(*)::int AS adet,
               ROUND(AVG(EXTRACT(EPOCH FROM (tamamlanma_trh - COALESCE(onceki, arac_giris_trh::timestamptz))) / 86400.0)::numeric, 1) AS ort_gun
        FROM s WHERE COALESCE(onceki, arac_giris_trh::timestamptz) IS NOT NULL
        GROUP BY ad ORDER BY MIN(sira)`, params),
      query(`
        SELECT ie.id, d.id AS dosya_id, d.dosya_no, a.plaka, srv.ad AS servis_ad, ie.tur, ${GUN('ie.gonderim_trh')} AS gun
        FROM is_emirleri ie JOIN dosyalar d ON d.id=ie.dosya_id
        LEFT JOIN arac a ON a.dosya_id=d.id LEFT JOIN servisler srv ON srv.id=d.atanan_servis
        WHERE ie.onay_durumu='bekliyor' AND ie.durum<>'iptal'${f}
        ORDER BY ie.gonderim_trh`, params),
      query(`
        SELECT g.id, g.bolum, g.aciklama, g.bekleme_nedeni, g.sorumlu_usta, d.id AS dosya_id, d.dosya_no, a.plaka,
               ${GUN('g.updated_at')} AS gun
        FROM bolum_gorevleri g JOIN is_emirleri ie ON ie.id=g.is_emri_id AND ie.durum<>'iptal'
        JOIN dosyalar d ON d.id=g.dosya_id AND d.durum='Aktif'
        LEFT JOIN arac a ON a.dosya_id=d.id
        WHERE g.durum='beklemede'${f}
        ORDER BY g.updated_at`, params),
      query(`${SIPARIS_SQL} WHERE s.durum IN ('siparis','yolda','kismi') AND s.tahmini_gelis < CURRENT_DATE${fs}
             ORDER BY s.tahmini_gelis`, p2),
      query(`
        SELECT d.id AS dosya_id, d.dosya_no, a.plaka, srv.ad AS servis_ad, om.tahmini_teslimat,
               (CURRENT_DATE - om.tahmini_teslimat)::int AS gecikme_gun,
               (SELECT ad FROM onarim_adimlari x WHERE x.dosya_id=d.id AND x.durum='aktif' ORDER BY sira LIMIT 1) AS aktif_adim
        FROM dosyalar d JOIN onarim_merkezi om ON om.dosya_id=d.id
        LEFT JOIN arac a ON a.dosya_id=d.id LEFT JOIN servisler srv ON srv.id=d.atanan_servis
        WHERE d.durum='Aktif' AND om.tahmini_teslimat < CURRENT_DATE${f}
        ORDER BY om.tahmini_teslimat`, params),
    ]);
    res.json({ adim_sureleri: adimSure, bekleyen_onaylar: onaylar, beklemedeki_gorevler: beklemede, geciken_siparisler: parca, geciken_teslimler: teslim });
  } catch (err) { next(err); }
});

// GET /api/moduller/bi — yönetim özeti (yalnız admin)
router.get('/bi', async (req, res, next) => {
  try {
    if (req.user.rol !== 'admin') throw httpHata(403, 'Bu işlem için yetkiniz yok');
    // Onarım süresi: kabul tutanağından teslim tutanağına (yoksa servise girişten)
    const SURE = `EXTRACT(EPOCH FROM (t.created_at - COALESCE(k.created_at, om.arac_giris_trh::timestamptz))) / 86400.0`;
    const ONAYLANAN = 'tt.onaylanan';
    const TEKLIF = 'tt.teklif';
    const TEMEL = `
      FROM dosyalar d
      LEFT JOIN sigorta si ON si.dosya_id=d.id
      LEFT JOIN servisler srv ON srv.id=d.atanan_servis
      LEFT JOIN onarim_merkezi om ON om.dosya_id=d.id
      LEFT JOIN arac_tutanaklari k ON k.dosya_id=d.id AND k.tip='kabul'
      LEFT JOIN arac_tutanaklari t ON t.dosya_id=d.id AND t.tip='teslim'
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(i.miktar*i.birim_fiyat) FILTER (WHERE i.durum<>'reddedildi'),0) AS teklif,
               COALESCE(SUM(i.miktar*i.birim_fiyat) FILTER (WHERE i.durum='onaylandi'),0) AS onaylanan
        FROM islemler i JOIN is_emirleri ie ON ie.id=i.is_emri_id
        WHERE i.dosya_id=d.id AND ie.durum<>'iptal') tt ON TRUE
      WHERE d.durum<>'İptal'`;
    const [{ rows: aylik }, { rows: sigorta }, { rows: servis }, { rows: [genel] }] = await Promise.all([
      query(`
        SELECT TO_CHAR(ay, 'YYYY-MM') AS ay,
               (SELECT COUNT(*) FROM dosyalar d WHERE d.durum<>'İptal' AND date_trunc('month', d.created_at)=ay)::int AS acilan,
               (SELECT COUNT(*) FROM arac_tutanaklari t WHERE t.tip='teslim' AND date_trunc('month', t.created_at)=ay)::int AS teslim
        FROM generate_series(date_trunc('month', NOW()) - INTERVAL '11 months', date_trunc('month', NOW()), INTERVAL '1 month') ay
        ORDER BY ay`),
      query(`
        SELECT COALESCE(si.sirket_ad, 'Sigortasız') AS ad, COUNT(*)::int AS dosya,
               COALESCE(SUM(d.muallak_hasar),0) AS muallak, SUM(${TEKLIF}) AS teklif, SUM(${ONAYLANAN}) AS onaylanan,
               ROUND(AVG(${SURE}) FILTER (WHERE t.id IS NOT NULL)::numeric, 1) AS ort_sure_gun
        ${TEMEL} GROUP BY 1 ORDER BY onaylanan DESC, dosya DESC`),
      query(`
        SELECT COALESCE(srv.ad, 'Atanmadı') AS ad, COUNT(*) FILTER (WHERE d.durum='Aktif')::int AS aktif,
               COUNT(*) FILTER (WHERE d.durum='Tamamlandı')::int AS tamamlanan, SUM(${ONAYLANAN}) AS onaylanan,
               ROUND(AVG(${SURE}) FILTER (WHERE t.id IS NOT NULL)::numeric, 1) AS ort_sure_gun
        ${TEMEL} GROUP BY 1 ORDER BY aktif DESC, tamamlanan DESC`),
      query(`
        SELECT COUNT(*)::int AS dosya, COUNT(*) FILTER (WHERE d.durum='Aktif')::int AS aktif,
               COUNT(t.id)::int AS teslim, COALESCE(SUM(d.muallak_hasar),0) AS muallak,
               SUM(${TEKLIF}) AS teklif, SUM(${ONAYLANAN}) AS onaylanan,
               ROUND(AVG(${SURE}) FILTER (WHERE t.id IS NOT NULL)::numeric, 1) AS ort_sure_gun,
               (SELECT ROUND(AVG(EXTRACT(EPOCH FROM (ie.karar_trh - ie.gonderim_trh)) / 86400.0)::numeric, 1)
                FROM is_emirleri ie WHERE ie.karar_trh IS NOT NULL AND ie.gonderim_trh IS NOT NULL) AS ort_onay_gun
        ${TEMEL}`),
    ]);
    res.json({ genel, aylik, sigorta, servis });
  } catch (err) { next(err); }
});

// GET /api/moduller/sistem — kullanıcılar, servis hesapları, şema sürümü (yalnız admin; şifre özeti dönmez)
router.get('/sistem', async (req, res, next) => {
  try {
    if (req.user.rol !== 'admin') throw httpHata(403, 'Bu işlem için yetkiniz yok');
    const [{ rows: roller }, { rows: hesaplar }, { rows: migr }, { rows: [db] }, { rows: tablolar }] = await Promise.all([
      query(`SELECT rol, COUNT(*)::int AS toplam, COUNT(*) FILTER (WHERE aktif)::int AS aktif FROM kullanicilar GROUP BY rol ORDER BY rol`),
      query(`SELECT k.id, k.ad_soyad, k.email, k.rol, k.aktif, k.son_giris, k.created_at, s.ad AS servis_ad
             FROM kullanicilar k LEFT JOIN servisler s ON s.id=k.servis_id
             WHERE k.rol IN ('admin','servis') ORDER BY k.rol, s.ad NULLS FIRST, k.email`),
      query(`SELECT ad, uygulama_trh FROM schema_migrations ORDER BY ad`),
      query(`SELECT current_setting('server_version') AS surum, NOW() AS saat, pg_database_size(current_database()) AS boyut`),
      query(`SELECT COUNT(*)::int AS n FROM pg_tables WHERE schemaname='public'`),
    ]);
    res.json({ roller, hesaplar, migrations: migr, veritabani: { ...db, tablo: tablolar[0].n } });
  } catch (err) { next(err); }
});

module.exports = router;
