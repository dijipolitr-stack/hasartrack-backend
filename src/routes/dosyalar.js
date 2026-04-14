const router = require('express').Router();
const { query, withTransaction } = require('../db');
const { authMiddleware, onlyAdmin, notMusteri, dosyaErisim } = require('../middleware/auth');

router.use(authMiddleware);

// ── LİSTE ────────────────────────────────────────────────────
// GET /api/dosyalar
router.get('/', async (req, res, next) => {
  try {
    const { durum, servis_id, arama, sayfa = 1, limit = 20 } = req.query;
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
      where.push(`s.tc_vergi = $${params.length}`);
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
             srv.ad as servis_ad,
             COALESCE(oa.aktif_adim, '') as aktif_adim,
             COALESCE(oa.ilerleme, 0) as ilerleme,
             io.durum as onay_durumu
      FROM dosyalar d
      LEFT JOIN arac a ON a.dosya_id = d.id
      LEFT JOIN sahip sa ON sa.dosya_id = d.id
      LEFT JOIN sigorta si ON si.dosya_id = d.id
      LEFT JOIN servisler srv ON srv.id = d.atanan_servis
      LEFT JOIN (
        SELECT dosya_id,
          (SELECT ad FROM onarim_adimlari WHERE dosya_id=oa2.dosya_id AND durum='aktif' ORDER BY sira LIMIT 1) as aktif_adim,
          ROUND(COUNT(*) FILTER (WHERE durum='tamamlandi')::NUMERIC / NULLIF(COUNT(*),0) * 100) as ilerleme
        FROM onarim_adimlari oa2 GROUP BY dosya_id
      ) oa ON oa.dosya_id = d.id
      LEFT JOIN islem_onay io ON io.dosya_id = d.id
      WHERE ${where.join(' AND ')}
      ORDER BY d.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    params.push(limit, offset);
    const { rows } = await query(sql, params);

    // Toplam sayı
    const countSql = `
      SELECT COUNT(*) FROM dosyalar d
      LEFT JOIN sahip s ON s.dosya_id = d.id
      WHERE ${where.slice(0, -2).join(' AND ')}`;
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
// POST /api/dosyalar
router.post('/', onlyAdmin, async (req, res, next) => {
  try {
    const { arac: aracData, sahip: sahipData, sigorta: sigortaData, kaza } = req.body;
    if (!sahipData?.telefon)
      return res.status(400).json({ error: 'Araç sahibi telefonu zorunludur' });

    const result = await withTransaction(async (client) => {
      // Ana dosya
      const dosyaNo = (await client.query('SELECT next_dosya_no() as no')).rows[0].no;
      const { rows: [dosya] } = await client.query(
        `INSERT INTO dosyalar (dosya_no, sigorta_bransi, muallak_hasar, olusturan_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [dosyaNo, sigortaData?.bransi, sigortaData?.muallakHasar, req.user.id]
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

      // Onay kaydı başlat
      await client.query('INSERT INTO islem_onay (dosya_id) VALUES ($1)', [dosya.id]);

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
// PATCH /api/dosyalar/:dosyaId
router.patch('/:dosyaId', onlyAdmin, dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const { alan, deger, alt_tablo } = req.body;
    // Güvenlik: sadece izin verilen tablolara yazılır
    const izinliTablolar = { arac: 'arac', sahip: 'sahip', sigorta: 'sigorta',
      eksper: 'eksper', onarim_merkezi: 'onarim_merkezi', muhasebe: 'muhasebe' };
    const tablo = izinliTablolar[alt_tablo] || 'dosyalar';

    await query(`UPDATE ${tablo} SET ${alan}=$1, updated_at=NOW() WHERE dosya_id=$2`, [deger, dosyaId]);
    res.json({ mesaj: 'Güncellendi' });
  } catch (err) { next(err); }
});

// ── SERVİS ATA ────────────────────────────────────────────────
// POST /api/dosyalar/:dosyaId/servis-ata
router.post('/:dosyaId/servis-ata', onlyAdmin, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const { servis_id, not_metni } = req.body;
    await query(
      'UPDATE dosyalar SET atanan_servis=$1, atama_notu=$2, updated_at=NOW() WHERE id=$3',
      [servis_id, not_metni, dosyaId]
    );
    await query(
      `INSERT INTO audit_log (dosya_id, kullanici_id, eylem, detay)
       VALUES ($1,$2,'SERVIS_ATA',$3)`,
      [dosyaId, req.user.id, JSON.stringify({ servis_id })]
    );
    res.json({ mesaj: 'Servis atandı' });
  } catch (err) { next(err); }
});

// ── ADIM TAMAMLA ─────────────────────────────────────────────
// POST /api/dosyalar/:dosyaId/adim/:adimId/tamamla
router.post('/:dosyaId/adim/:adimId/tamamla', dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId, adimId } = req.params;
    await withTransaction(async (client) => {
      // Adımı tamamla
      const { rows: [adim] } = await client.query(
        `UPDATE onarim_adimlari SET durum='tamamlandi', tamamlanma_trh=NOW(),
         tamamlayan_id=$1 WHERE id=$2 AND dosya_id=$3 RETURNING sira, ad, oto_sms`,
        [req.user.id, adimId, dosyaId]
      );
      // Sonraki adımı aktif yap
      await client.query(
        `UPDATE onarim_adimlari SET durum='aktif'
         WHERE dosya_id=$1 AND sira=$2 AND durum='bekliyor'`,
        [dosyaId, adim.sira + 1]
      );
      // Oto-SMS kuyruğa ekle
      if (adim.oto_sms) {
        const { rows: [sahip] } = await client.query(
          'SELECT telefon FROM sahip WHERE dosya_id=$1', [dosyaId]);
        if (sahip) {
          await client.query(
            `INSERT INTO sms_log (dosya_id, alici_tel, mesaj, adim_adi, oto, durum)
             VALUES ($1,$2,$3,$4,TRUE,'bekliyor')`,
            [dosyaId, sahip.telefon, `Aracınız için "${adim.ad}" adımı tamamlandı.`, adim.ad]
          );
        }
      }
    });
    res.json({ mesaj: 'Adım tamamlandı' });
  } catch (err) { next(err); }
});

module.exports = router;
