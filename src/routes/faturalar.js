// Servis faturaları ve dış hizmet faturaları. Tutarlar KDV hariç; KDV ve toplam DB'de hesaplanır.
// Okuma: dosyayı görebilen admin/servis/acente. Yazma: admin ve atanmış servis.
const router = require('express').Router();
const { query } = require('../db');
const { authMiddleware, adminOrServis, notMusteri, dosyaErisim } = require('../middleware/auth');
const { uuidParam, httpHata, alanDegeri, UUID_RE } = require('../lib/dogrula');
const { isEmriBul } = require('../lib/isEmri');

router.use(authMiddleware);
router.param('dosyaId', uuidParam('dosyaId'));
router.param('faturaId', uuidParam('faturaId'));

const TARAF = ['sigorta', 'musteri', 'acente', 'diger'];
const M = { t: 'metin' };
const ZORUNLU = { t: 'metin', bos: false };
const TUTAR = { t: 'sayi', bos: false };
const KDV = { t: 'enum', secenekler: [0, 1, 10, 20], bos: false };
const VKN = { t: 'vkn' };

// tablo -> yazılabilir alanlar. Kolon adları SQL'e yalnız buradan girer.
const TABLOLAR = {
  servis: {
    tablo: 'servis_faturalari',
    alanlar: {
      alici_tipi: { t: 'enum', secenekler: TARAF, bos: false }, alici_ad: ZORUNLU, alici_vkn: VKN,
      fatura_no: M, fatura_trh: { t: 'tarih' }, tutar: TUTAR, kdv_orani: KDV,
      odenen_tutar: TUTAR, odeme_trh: { t: 'tarih' }, notlar: M,
    },
    varsayilan: { kdv_orani: 20, odenen_tutar: 0 },
  },
  dis: {
    tablo: 'dis_faturalar',
    alanlar: {
      firma: ZORUNLU, firma_vkn: VKN, hizmet: ZORUNLU, is_emri_id: { t: 'uuid' }, islem_id: { t: 'uuid' },
      fatura_no: M, fatura_trh: { t: 'tarih' }, tutar: TUTAR, kdv_orani: KDV,
      yansitildi: { t: 'bool' }, notlar: M,
    },
    varsayilan: { kdv_orani: 20, yansitildi: false },
  },
};
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const deger = (tip, v, ad) => {
  if (tip.t === 'vkn') {
    const x = alanDegeri(M, v, ad);
    if (x === null) return null;
    const t = x.trim();
    if (t === '') return null;
    if (!/^\d{10,11}$/.test(t)) throw httpHata(400, `${ad} 10 (VKN) veya 11 (TCKN) haneli olmalı`);
    return t;
  }
  if (tip.t === 'bool') {
    if (typeof v !== 'boolean') throw httpHata(400, `${ad} true/false olmalı`);
    return v;
  }
  if (tip.t === 'uuid') {
    if (v === null || v === '' || v === undefined) return null;
    if (typeof v !== 'string' || !UUID_RE.test(v)) throw httpHata(400, `${ad} geçersiz`);
    return v;
  }
  if (tip.t === 'enum' && typeof v === 'string' && tip.secenekler.every((s) => typeof s === 'number'))
    v = Number(v);
  const x = alanDegeri(tip, v, ad);
  if (typeof x === 'string') {
    const t = x.trim();
    if (t === '' && tip.bos === false) throw httpHata(400, `${ad} boş olamaz`);
    return t === '' ? null : t;
  }
  return x;
};

// kismi=false: tüm zorunlu alanlar istenir, eksikler varsayılanla dolar
const degerler = (tanim, govde, kismi) => {
  const d = {};
  for (const [k, tip] of Object.entries(tanim.alanlar)) {
    if (!own(govde, k)) {
      if (kismi) continue;
      if (own(tanim.varsayilan, k)) { d[k] = tanim.varsayilan[k]; continue; }
    }
    d[k] = deger(tip, govde[k], k);
  }
  return d;
};

const odemeDurumu = (f) => {
  const odenen = Number(f.odenen_tutar), toplam = Number(f.toplam);
  return odenen <= 0 ? 'bekliyor' : odenen < toplam ? 'kismi' : 'odendi';
};
const yuvarla = (n) => Math.round(n * 100) / 100;

// GET /api/faturalar/:dosyaId — faturalar + pay özeti
// Pay: reddedilmemiş kalemler ödeyene göre toplanır; muafiyet sigorta payından düşülüp
// müşteri payına eklenir. Faturalanan: servis faturaları alıcı tipine göre (KDV hariç).
router.get('/:dosyaId', notMusteri, dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const [{ rows: servis }, { rows: dis }, { rows: kalem }, { rows: [sig] }] = await Promise.all([
      query('SELECT * FROM servis_faturalari WHERE dosya_id=$1 ORDER BY fatura_trh NULLS LAST, created_at', [dosyaId]),
      query(`SELECT f.* FROM dis_faturalar f JOIN is_emirleri ie ON ie.id=f.is_emri_id AND ie.durum<>'iptal'
             WHERE f.dosya_id=$1 ORDER BY f.fatura_trh NULLS LAST, f.created_at`, [dosyaId]),
      // Onay bekleyenler dahil (öneri); reddedilen kalemler ve iptal edilen iş emirleri hariç
      query(`SELECT i.odeyen, SUM(i.miktar*i.birim_fiyat) AS tutar FROM islemler i
             JOIN is_emirleri ie ON ie.id=i.is_emri_id AND ie.durum<>'iptal'
             WHERE i.dosya_id=$1 AND i.durum<>'reddedildi' GROUP BY i.odeyen`, [dosyaId]),
      query('SELECT muafiyet FROM sigorta WHERE dosya_id=$1', [dosyaId]),
    ]);
    const kalemToplam = Object.fromEntries(TARAF.map((t) => [t, 0]));
    for (const r of kalem) kalemToplam[r.odeyen] = yuvarla(Number(r.tutar));
    const muafiyet = Math.min(Number(sig?.muafiyet) || 0, kalemToplam.sigorta);
    const pay = { ...kalemToplam, sigorta: yuvarla(kalemToplam.sigorta - muafiyet), musteri: yuvarla(kalemToplam.musteri + muafiyet) };
    const faturalanan = Object.fromEntries(TARAF.map((t) => [t, 0]));
    for (const f of servis) faturalanan[f.alici_tipi] = yuvarla(faturalanan[f.alici_tipi] + Number(f.tutar));

    res.json({
      servis_faturalari: servis.map((f) => ({ ...f, odeme_durumu: odemeDurumu(f) })),
      dis_faturalar: dis,
      ozet: {
        kalem_toplam: kalemToplam, muafiyet, pay, faturalanan,
        kalan: Object.fromEntries(TARAF.map((t) => [t, yuvarla(pay[t] - faturalanan[t])])),
        dis_toplam: yuvarla(dis.reduce((s, f) => s + Number(f.tutar), 0)),
        tahsil_edilen: yuvarla(servis.reduce((s, f) => s + Number(f.odenen_tutar), 0)),
      },
    });
  } catch (err) { next(err); }
});

// Kalem bağlantısı aynı dosyanın kalemi olmalı
const islemKontrol = async (dosyaId, islemId) => {
  if (!islemId) return;
  const { rowCount } = await query('SELECT 1 FROM islemler WHERE id=$1 AND dosya_id=$2', [islemId, dosyaId]);
  if (!rowCount) throw httpHata(400, 'İş kalemi bu dosyaya ait değil');
};

for (const [tur, tanim] of Object.entries(TABLOLAR)) {
  // POST /api/faturalar/:dosyaId/{servis|dis}
  router.post(`/:dosyaId/${tur}`, adminOrServis, dosyaErisim, async (req, res, next) => {
    try {
      const d = degerler(tanim, req.body || {}, false);
      await islemKontrol(req.params.dosyaId, d.islem_id);
      // Dış fatura bir iş emrine bağlanır; verilmezse ana iş emri
      if (tur === 'dis') d.is_emri_id = (await isEmriBul(req.params.dosyaId, d.is_emri_id)).id;
      const kol = Object.keys(d);
      const { rows: [f] } = await query(
        `INSERT INTO ${tanim.tablo} (dosya_id, ekleyen_id, ${kol.map((k) => `"${k}"`).join(', ')})
         VALUES ($1, $2, ${kol.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING *`,
        [req.params.dosyaId, req.user.id, ...kol.map((k) => d[k])]);
      res.status(201).json(tur === 'servis' ? { ...f, odeme_durumu: odemeDurumu(f) } : f);
    } catch (err) { next(err); }
  });

  // PATCH /api/faturalar/:dosyaId/{servis|dis}/:faturaId
  router.patch(`/:dosyaId/${tur}/:faturaId`, adminOrServis, dosyaErisim, async (req, res, next) => {
    try {
      const d = degerler(tanim, req.body || {}, true);
      const kol = Object.keys(d);
      if (!kol.length) return res.status(400).json({ error: 'Güncellenecek alan yok' });
      if (own(d, 'islem_id')) await islemKontrol(req.params.dosyaId, d.islem_id);
      if (own(d, 'is_emri_id')) d.is_emri_id = (await isEmriBul(req.params.dosyaId, d.is_emri_id)).id;
      const { rows: [f] } = await query(
        `UPDATE ${tanim.tablo} SET ${kol.map((k, i) => `"${k}"=$${i + 1}`).join(', ')}
         WHERE id=$${kol.length + 1} AND dosya_id=$${kol.length + 2} RETURNING *`,
        [...kol.map((k) => d[k]), req.params.faturaId, req.params.dosyaId]);
      if (!f) return res.status(404).json({ error: 'Fatura bulunamadı' });
      res.json(tur === 'servis' ? { ...f, odeme_durumu: odemeDurumu(f) } : f);
    } catch (err) { next(err); }
  });

  // DELETE /api/faturalar/:dosyaId/{servis|dis}/:faturaId
  router.delete(`/:dosyaId/${tur}/:faturaId`, adminOrServis, dosyaErisim, async (req, res, next) => {
    try {
      const { rowCount } = await query(
        `DELETE FROM ${tanim.tablo} WHERE id=$1 AND dosya_id=$2`, [req.params.faturaId, req.params.dosyaId]);
      if (!rowCount) return res.status(404).json({ error: 'Fatura bulunamadı' });
      res.json({ mesaj: 'Fatura silindi' });
    } catch (err) { next(err); }
  });
}

module.exports = router;
