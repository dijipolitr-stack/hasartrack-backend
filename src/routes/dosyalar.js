const router = require('express').Router();
const { query, withTransaction } = require('../db');
const { authMiddleware, adminOrServis, onlyAdmin, notMusteri, dosyaErisim } = require('../middleware/auth');
const { uuidParam, httpHata, alanDegeri, UUID_RE } = require('../lib/dogrula');
const { adimTamamla } = require('../lib/adim');

router.use(authMiddleware);
router.param('dosyaId', uuidParam('dosyaId'));
router.param('adimId', uuidParam('adimId'));

// ── LİSTE ────────────────────────────────────────────────────
// GET /api/dosyalar
router.get('/', async (req, res, next) => {
  try {
    const { durum, servis_id, arama } = req.query;
    const sayfa = Math.max(parseInt(req.query.sayfa, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
    const offset = (sayfa - 1) * limit;
    const params = [];
    const where = ['1=1'];

    // Servis kendi dosyalarını görür
    if (req.user.rol === 'servis') {
      params.push(req.user.servis_id);
      where.push(`d.atanan_servis = $${params.length}`);
    }
    // Müşteri kendi dosyalarını görür
    if (req.user.rol === 'musteri') {
      params.push(req.user.tc_no);
      where.push(`sa.tc_vergi = $${params.length}`);
    }
    if (durum) { params.push(durum); where.push(`d.durum = $${params.length}`); }
    if (servis_id && req.user.rol === 'admin') { params.push(servis_id); where.push(`d.atanan_servis = $${params.length}`); }
    if (arama) {
      params.push(`%${arama}%`);
      where.push(`(d.dosya_no ILIKE $${params.length} OR a.plaka ILIKE $${params.length} OR sa.ad_soyad ILIKE $${params.length})`);
    }

    const sql = `
      SELECT d.id, d.dosya_no, d.durum, d.oncelik, d.sigorta_bransi,
             d.muallak_hasar, d.created_at,
             a.plaka, a.marka, a.model, a.yil,
             sa.ad_soyad as sahip_ad, sa.telefon as sahip_tel,
             si.sirket_ad as sigorta, si.hasar_no,
             d.atanan_servis, srv.ad as servis_ad,
             om.arac_giris_trh, om.tahmini_teslimat,
             COALESCE(oa.aktif_adim, '') as aktif_adim,
             COALESCE(oa.ilerleme, 0) as ilerleme,
             -- Bekleyen bir onay turu (ek hasar dahil) varsa "bekliyor", yoksa ana iş emrinin durumu
             CASE WHEN EXISTS (SELECT 1 FROM is_emirleri b WHERE b.dosya_id=d.id
                               AND b.onay_durumu='bekliyor' AND b.durum<>'iptal')
                  THEN 'bekliyor' ELSE ana.onay_durumu END as onay_durumu
      FROM dosyalar d
      LEFT JOIN arac a ON a.dosya_id = d.id
      LEFT JOIN sahip sa ON sa.dosya_id = d.id
      LEFT JOIN sigorta si ON si.dosya_id = d.id
      LEFT JOIN servisler srv ON srv.id = d.atanan_servis
      LEFT JOIN onarim_merkezi om ON om.dosya_id = d.id
      LEFT JOIN (
        SELECT dosya_id,
          (SELECT ad FROM onarim_adimlari WHERE dosya_id=oa2.dosya_id AND durum='aktif' ORDER BY sira LIMIT 1) as aktif_adim,
          ROUND(COUNT(*) FILTER (WHERE durum='tamamlandi')::NUMERIC / NULLIF(COUNT(*),0) * 100) as ilerleme
        FROM onarim_adimlari oa2 GROUP BY dosya_id
      ) oa ON oa.dosya_id = d.id
      LEFT JOIN is_emirleri ana ON ana.dosya_id = d.id AND ana.no = 1
      WHERE ${where.join(' AND ')}
      ORDER BY d.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    params.push(limit, offset);
    const { rows } = await query(sql, params);

    // Toplam sayı
    const countSql = `
      SELECT COUNT(*) FROM dosyalar d
      LEFT JOIN arac a ON a.dosya_id = d.id
      LEFT JOIN sahip sa ON sa.dosya_id = d.id
      WHERE ${where.join(' AND ')}`;
    const { rows: countRows } = await query(countSql, params.slice(0, -2));

    res.json({ dosyalar: rows, toplam: parseInt(countRows[0].count), sayfa, limit });
  } catch (err) { next(err); }
});

// ── TEK DOSYA ────────────────────────────────────────────────
// GET /api/dosyalar/:dosyaId
router.get('/:dosyaId', dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const { rows } = await query(`
      SELECT d.*,
             row_to_json(a.*) as arac,
             row_to_json(sa.*) as sahip,
             row_to_json(si.*) as sigorta,
             row_to_json(ex.*) as eksper,
             row_to_json(om.*) as onarim_merkezi,
             row_to_json(m.*) as muhasebe,
             row_to_json(srv.*) as servis
      FROM dosyalar d
      LEFT JOIN arac a ON a.dosya_id=d.id
      LEFT JOIN sahip sa ON sa.dosya_id=d.id
      LEFT JOIN sigorta si ON si.dosya_id=d.id
      LEFT JOIN eksper ex ON ex.dosya_id=d.id
      LEFT JOIN onarim_merkezi om ON om.dosya_id=d.id
      LEFT JOIN muhasebe m ON m.dosya_id=d.id
      LEFT JOIN servisler srv ON srv.id=d.atanan_servis
      WHERE d.id=$1`, [dosyaId]);

    if (!rows.length) return res.status(404).json({ error: 'Dosya bulunamadı' });

    // Adımlar
    const { rows: adimlar } = await query(
      'SELECT * FROM onarim_adimlari WHERE dosya_id=$1 ORDER BY sira', [dosyaId]);
    rows[0].onarim_adimlari = adimlar;

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── YENİ DOSYA ────────────────────────────────────────────────
// POST /api/dosyalar — admin veya servis; servisin açtığı dosya kendisine atanır
router.post('/', adminOrServis, async (req, res, next) => {
  try {
    const { arac: aracData, sahip: sahipData, sigorta: sigortaData, kaza } = req.body;
    if (!sahipData?.telefon)
      return res.status(400).json({ error: 'Araç sahibi telefonu zorunludur' });

    const result = await withTransaction(async (client) => {
      // Ana dosya
      const dosyaNo = (await client.query('SELECT next_dosya_no() as no')).rows[0].no;
      const { rows: [dosya] } = await client.query(
        `INSERT INTO dosyalar (dosya_no, sigorta_bransi, muallak_hasar, olusturan_id, atanan_servis)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [dosyaNo, sigortaData?.bransi, sigortaData?.muallakHasar, req.user.id,
         req.user.rol === 'servis' ? req.user.servis_id : null]
      );

      // Araç
      await client.query(
        `INSERT INTO arac (dosya_id, plaka, marka, model, yil, renk, sase_no, motor_no, ruhsat_seri, kaza_tarihi, kaza_aciklama)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [dosya.id, aracData?.plaka, aracData?.marka, aracData?.model, aracData?.yil,
         aracData?.renk, aracData?.saseNo, aracData?.motorNo, aracData?.ruhsatSeri,
         kaza?.tarih || null, kaza?.aciklama]
      );

      // Sahip
      await client.query(
        `INSERT INTO sahip (dosya_id, ad_soyad, tc_vergi, telefon, email)
         VALUES ($1,$2,$3,$4,$5)`,
        [dosya.id, sahipData.adSoyad, sahipData.tcVergi, sahipData.telefon, sahipData.email]
      );

      // Sigorta
      if (sigortaData) {
        await client.query(
          `INSERT INTO sigorta (dosya_id, sirket_ad, hasar_no, police_no, teminat_turu, muafiyet)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [dosya.id, sigortaData.sirketAd, sigortaData.hasarNo, sigortaData.policeNo,
           sigortaData.teminatTuru, sigortaData.muafiyet]
        );
      }

      // Varsayılan onarım adımları
      const adimlar = [
        { sira: 1, ad: 'Araç Kabulü',          oto_sms: false },
        { sira: 2, ad: 'Ön Hasar Tespiti',       oto_sms: false },
        { sira: 3, ad: 'Ekspertiz İncelemesi',   oto_sms: true  },
        { sira: 4, ad: 'Teklif / Onay',           oto_sms: true  },
        { sira: 5, ad: 'Parça Temini',            oto_sms: false },
        { sira: 6, ad: 'Onarım',                  oto_sms: true  },
        { sira: 7, ad: 'Boya & Son Kontrol',       oto_sms: true  },
        { sira: 8, ad: 'Araç Teslimi',             oto_sms: true  },
      ];
      for (const a of adimlar) {
        await client.query(
          `INSERT INTO onarim_adimlari (dosya_id, sira, ad, durum, oto_sms)
           VALUES ($1,$2,$3,$4,$5)`,
          [dosya.id, a.sira, a.ad, a.sira === 1 ? 'aktif' : 'bekliyor', a.oto_sms]
        );
      }

      // Muhasebe kaydı başlat
      await client.query('INSERT INTO muhasebe (dosya_id) VALUES ($1)', [dosya.id]);

      // Varsayılan evrak kontrol listesi (migrations/005 ile aynı)
      const evraklar = [
        ['Kaza Tespit Tutanağı', 'Araç Sahibi'], ['Ehliyet Fotokopisi', 'Araç Sahibi'],
        ['Ruhsat Fotokopisi', 'Araç Sahibi'], ['Poliçe Kopyası', 'Sigorta Şirketi'],
        ['Eksper Raporu', 'Eksper'], ['Fotoğraflı Hasar Formu', 'Servis'],
        ['Maliyet Teklifi (Proforma)', 'Servis'], ['Sigorta Onay Yazısı', 'Sigorta Şirketi'],
        ['Teslim Tutanağı', 'Servis'],
      ];
      for (const [i, [ad, kaynak]] of evraklar.entries()) {
        await client.query('INSERT INTO evrak (dosya_id, ad, kaynak, sira) VALUES ($1,$2,$3,$4)',
          [dosya.id, ad, kaynak, i + 1]);
      }

      // Ana iş emri (onay turu iş emri başınadır)
      await client.query(
        `INSERT INTO is_emirleri (dosya_id, no, tur, olusturan_id) VALUES ($1, 1, 'ana', $2)`,
        [dosya.id, req.user.id]);

      // Audit log
      await client.query(
        `INSERT INTO audit_log (dosya_id, kullanici_id, eylem, detay)
         VALUES ($1,$2,'DOSYA_OLUSTUR',$3)`,
        [dosya.id, req.user.id, JSON.stringify({ dosya_no: dosyaNo, plaka: aracData?.plaka })]
      );

      return dosya;
    });

    res.status(201).json(result);
  } catch (err) { next(err); }
});

// ── DOSYA GÜNCELLE ────────────────────────────────────────────
// PATCH /api/dosyalar/:dosyaId  { alt_tablo?, alan, deger }
// Tablo ve kolon yalnız bu haritadan alınır; istemci metni SQL'e yazılmaz.
const M = { t: 'metin' };
const SAYI = { t: 'sayi' };
const TARIH = { t: 'tarih' };
const ALANLAR = {
  dosyalar: {
    durum: { t: 'enum', secenekler: ['Aktif', 'Tamamlandı', 'İptal', 'Askıda'], bos: false },
    oncelik: { t: 'enum', secenekler: ['Normal', 'Yüksek', 'Acil'], bos: false },
    sigorta_bransi: M, muallak_hasar: SAYI, atama_notu: M,
  },
  arac: {
    plaka: M, marka: M, model: M, yil: { t: 'tamsayi', min: 1900, max: 2100 }, renk: M,
    sase_no: M, motor_no: M, ruhsat_seri: M, kaza_tarihi: TARIH, kaza_aciklama: M,
  },
  sahip: {
    ad_soyad: M, tc_vergi: M, telefon: { t: 'metin', bos: false }, email: M, adres: M,
  },
  sigorta: {
    sirket_ad: M, hasar_no: M, temsilci_ad: M, temsilci_tel: M, temsilci_mail: M,
    police_no: M, teminat_turu: M, muafiyet: SAYI,
  },
  eksper: {
    ad_soyad: M, firma: M, lisans_no: M, telefon: M, email: M,
    inceleme_tarihi: TARIH, tahmini_hasar: SAYI, onay_durumu: M,
  },
  onarim_merkezi: {
    ad: M, yetkili_kisi: M, telefon: M, email: M, adres: M,
    arac_giris_trh: TARIH, tahmini_teslimat: TARIH,
  },
  // onaylanan_tutar yazılamaz: yalnız admin-karar belirler
  // servis_fatura_* eski alanlar yazılmaz: faturalar servis_faturalari tablosunda (/api/faturalar)
  muhasebe: {
    sigorta_odeme_tutar: SAYI, sigorta_odeme_trh: TARIH, notlar: M,
  },
};
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

// Servis yalnız kendi dosyasında (dosyaErisim); atanan_servis bu uçtan değişmez
router.patch('/:dosyaId', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const { alan, deger } = req.body || {};
    const altTablo = req.body?.alt_tablo;
    const tablo = (altTablo === undefined || altTablo === null || altTablo === '') ? 'dosyalar' : altTablo;
    if (!own(ALANLAR, tablo)) return res.status(400).json({ error: 'Geçersiz tablo' });
    if (!own(ALANLAR[tablo], alan)) return res.status(400).json({ error: 'Geçersiz alan' });

    const v = alanDegeri(ALANLAR[tablo][alan], deger, alan);
    let rows;
    if (tablo === 'dosyalar') {
      ({ rows } = await query(
        `UPDATE dosyalar SET "${alan}"=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [v, dosyaId]));
    } else if (tablo === 'sahip') {
      // Satır POST'ta hep oluşur; yoksa 404
      ({ rows } = await query(
        `UPDATE sahip SET "${alan}"=$1, updated_at=NOW() WHERE dosya_id=$2 RETURNING *`, [v, dosyaId]));
    } else {
      ({ rows } = await query(
        `INSERT INTO ${tablo} (dosya_id, "${alan}") VALUES ($2, $1)
         ON CONFLICT (dosya_id) DO UPDATE SET "${alan}"=EXCLUDED."${alan}", updated_at=NOW()
         RETURNING *`, [v, dosyaId]));
    }
    if (!rows.length) return res.status(404).json({ error: 'Kayıt bulunamadı' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── SERVİS ATA ────────────────────────────────────────────────
// POST /api/dosyalar/:dosyaId/servis-ata
router.post('/:dosyaId/servis-ata', onlyAdmin, dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const { servis_id, not_metni } = req.body || {};
    if (typeof servis_id !== 'string' || !UUID_RE.test(servis_id))
      return res.status(400).json({ error: 'Geçersiz servis kimliği' });

    const servis = await withTransaction(async (client) => {
      const { rows: [srv] } = await client.query('SELECT id, ad, aktif FROM servisler WHERE id=$1', [servis_id]);
      if (!srv) throw httpHata(404, 'Servis bulunamadı');
      if (!srv.aktif) throw httpHata(409, 'Servis pasif');
      const { rowCount } = await client.query(
        'UPDATE dosyalar SET atanan_servis=$1, atama_notu=$2, updated_at=NOW() WHERE id=$3',
        [servis_id, not_metni ?? null, dosyaId]
      );
      if (!rowCount) throw httpHata(404, 'Dosya bulunamadı');
      await client.query(
        `INSERT INTO audit_log (dosya_id, kullanici_id, eylem, detay)
         VALUES ($1,$2,'SERVIS_ATA',$3)`,
        [dosyaId, req.user.id, JSON.stringify({ servis_id })]
      );
      return srv;
    });
    res.json({ mesaj: 'Servis atandı', atanan_servis: servis.id, servis_ad: servis.ad });
  } catch (err) { next(err); }
});

// ── ADIM TAMAMLA ─────────────────────────────────────────────
// POST /api/dosyalar/:dosyaId/adim/:adimId/tamamla
router.post('/:dosyaId/adim/:adimId/tamamla', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId, adimId } = req.params;
    const sonuc = await withTransaction((client) =>
      adimTamamla(client, { dosyaId, adimId, kullaniciId: req.user.id }));
    res.json({ mesaj: 'Adım tamamlandı', ...sonuc });
  } catch (err) { next(err); }
});

module.exports = router;
