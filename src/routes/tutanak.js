// Araç kabul ve teslim tutanağı. Yazma admin + atanmış servis; okuma müşteri hariç dosyaya erişen herkes.
// Teslim: kabul var, teslim dışındaki adımlar bitmiş, km >= kabul km, kontrol listesi tam olmalı.
// Teslim kaydı "Araç Teslimi" adımını aynı transaction'da tamamlar ve iki tutanağı kilitler.
const router = require('express').Router();
const { query, withTransaction } = require('../db');
const { authMiddleware, adminOrServis, notMusteri, dosyaErisim } = require('../middleware/auth');
const { uuidParam, httpHata, alanDegeri } = require('../lib/dogrula');
const { adimTamamla, TESLIM_ADIMI } = require('../lib/adim');

const AKSESUARLAR = ['Ruhsat', 'Yedek anahtar', 'Stepne', 'Kriko ve bijon anahtarı', 'Reflektör',
  'Yangın tüpü', 'İlk yardım çantası', 'Paspaslar', 'Anten'];
const TESLIM_KONTROL = ['Onarılan bölgeler kontrol edildi', 'Boya ve renk uyumu kontrol edildi',
  'Göstergede uyarı lambası yok', 'Araç temizlendi', 'Fatura ve evraklar teslim edildi', 'Anahtar teslim edildi'];

router.use(authMiddleware);
router.param('dosyaId', uuidParam('dosyaId'));

const tutanaklar = async (db, dosyaId) => {
  const { rows } = await db.query(
    `SELECT t.id, t.tip, t.km, t.yakit_yuzde, t.aksesuarlar, t.kontrol, t.aciklama, t.musteri_ad, t.personel_ad,
            t.created_at, t.updated_at, k.ad_soyad AS olusturan_ad
     FROM arac_tutanaklari t LEFT JOIN kullanicilar k ON k.id = t.olusturan_id
     WHERE t.dosya_id = $1`, [dosyaId]);
  return { kabul: rows.find((r) => r.tip === 'kabul') || null, teslim: rows.find((r) => r.tip === 'teslim') || null };
};

// Kırpılmış metin; boşsa null (zorunluysa 400), uzunsa 400
const metin = (deger, ad, max, zorunlu = false) => {
  const v = alanDegeri({ t: 'metin', bos: !zorunlu }, typeof deger === 'string' ? deger.trim() : deger, ad);
  if (v && v.length > max) throw httpHata(400, `${ad} en çok ${max} karakter olabilir`);
  return v;
};

// Ortak alanlar; bilinmeyen aksesuar adı 400
const ortakAlanlar = (b) => {
  const aks = b.aksesuarlar ?? {};
  if (typeof aks !== 'object' || Array.isArray(aks)) throw httpHata(400, 'Aksesuarlar geçersiz');
  const aksesuarlar = {};
  for (const [ad, var_] of Object.entries(aks)) {
    if (!AKSESUARLAR.includes(ad)) throw httpHata(400, `Bilinmeyen aksesuar: ${ad}`);
    aksesuarlar[ad] = var_ === true;
  }
  return {
    km: alanDegeri({ t: 'tamsayi', min: 0, max: 5000000, bos: false }, b.km, 'Kilometre'),
    yakit_yuzde: alanDegeri({ t: 'tamsayi', min: 0, max: 100 }, b.yakit_yuzde, 'Yakıt'),
    aksesuarlar,
    aciklama: metin(b.aciklama, 'Açıklama', 2000),
    musteri_ad: metin(b.musteri_ad, 'Müşteri adı', 100, true),
    personel_ad: metin(b.personel_ad, 'Personel adı', 100, true),
  };
};

// GET /api/tutanaklar/:dosyaId
router.get('/:dosyaId', notMusteri, dosyaErisim, async (req, res, next) => {
  try {
    res.json({ ...(await tutanaklar({ query }, req.params.dosyaId)), secenekler: { aksesuarlar: AKSESUARLAR, teslim_kontrol: TESLIM_KONTROL } });
  } catch (err) { next(err); }
});

// PUT /api/tutanaklar/:dosyaId/kabul  (oluştur veya düzelt; teslimden sonra 409)
router.put('/:dosyaId/kabul', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const v = ortakAlanlar(req.body || {});
    const sonuc = await withTransaction(async (client) => {
      await client.query('SELECT id FROM dosyalar WHERE id=$1 FOR UPDATE', [dosyaId]);
      if ((await tutanaklar(client, dosyaId)).teslim) throw httpHata(409, 'Araç teslim edildi, kabul tutanağı değiştirilemez');
      await client.query(
        `INSERT INTO arac_tutanaklari (dosya_id, tip, km, yakit_yuzde, aksesuarlar, aciklama, musteri_ad, personel_ad, olusturan_id)
         VALUES ($1,'kabul',$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (dosya_id, tip) DO UPDATE SET km=EXCLUDED.km, yakit_yuzde=EXCLUDED.yakit_yuzde,
           aksesuarlar=EXCLUDED.aksesuarlar, aciklama=EXCLUDED.aciklama, musteri_ad=EXCLUDED.musteri_ad,
           personel_ad=EXCLUDED.personel_ad, updated_at=NOW()`,
        [dosyaId, v.km, v.yakit_yuzde, JSON.stringify(v.aksesuarlar), v.aciklama, v.musteri_ad, v.personel_ad, req.user.id]);
      // Servise giriş tarihi boşsa bugün
      await client.query(
        `INSERT INTO onarim_merkezi (dosya_id, arac_giris_trh) VALUES ($1, CURRENT_DATE)
         ON CONFLICT (dosya_id) DO UPDATE SET arac_giris_trh = COALESCE(onarim_merkezi.arac_giris_trh, CURRENT_DATE)`,
        [dosyaId]);
      return tutanaklar(client, dosyaId);
    });
    res.json(sonuc);
  } catch (err) { next(err); }
});

// POST /api/tutanaklar/:dosyaId/teslim  (bir kez; düzeltilemez)
router.post('/:dosyaId/teslim', adminOrServis, dosyaErisim, async (req, res, next) => {
  try {
    const { dosyaId } = req.params;
    const b = req.body || {};
    const v = ortakAlanlar(b);
    const k = b.kontrol ?? {};
    if (typeof k !== 'object' || Array.isArray(k)) throw httpHata(400, 'Kontrol listesi geçersiz');
    const eksikMadde = TESLIM_KONTROL.filter((m) => !['tamam', 'yok'].includes(k[m]));
    if (eksikMadde.length) throw httpHata(400, `Kontrol listesi tamamlanmadı: ${eksikMadde.join(', ')}`);
    const kontrol = Object.fromEntries(TESLIM_KONTROL.map((m) => [m, k[m]]));

    const sonuc = await withTransaction(async (client) => {
      await client.query('SELECT id FROM dosyalar WHERE id=$1 FOR UPDATE', [dosyaId]);
      const mevcut = await tutanaklar(client, dosyaId);
      if (!mevcut.kabul) throw httpHata(409, 'Önce kabul tutanağı doldurulmalı');
      if (mevcut.teslim) throw httpHata(409, 'Teslim tutanağı zaten var');
      if (v.km < mevcut.kabul.km) throw httpHata(400, `Kilometre kabuldekinden (${mevcut.kabul.km}) düşük olamaz`);
      const eksikAks = Object.entries(mevcut.kabul.aksesuarlar).filter(([ad, var_]) => var_ && !v.aksesuarlar[ad]).map(([ad]) => ad);
      if (eksikAks.length && !v.aciklama)
        throw httpHata(400, `Kabulde olup teslimde olmayan aksesuar var: ${eksikAks.join(', ')}. Açıklama yazın.`);

      const { rows: adimlar } = await client.query(
        'SELECT id, ad, durum FROM onarim_adimlari WHERE dosya_id=$1 ORDER BY sira', [dosyaId]);
      const bekleyen = adimlar.filter((a) => a.ad !== TESLIM_ADIMI && a.durum !== 'tamamlandi');
      if (bekleyen.length) throw httpHata(409, `Bitmemiş adım var: ${bekleyen.map((a) => a.ad).join(', ')}`);

      await client.query(
        `INSERT INTO arac_tutanaklari (dosya_id, tip, km, yakit_yuzde, aksesuarlar, kontrol, aciklama, musteri_ad, personel_ad, olusturan_id)
         VALUES ($1,'teslim',$2,$3,$4,$5,$6,$7,$8,$9)`,
        [dosyaId, v.km, v.yakit_yuzde, JSON.stringify(v.aksesuarlar), JSON.stringify(kontrol), v.aciklama, v.musteri_ad, v.personel_ad, req.user.id]);
      const teslimAdimi = adimlar.find((a) => a.ad === TESLIM_ADIMI);
      if (teslimAdimi && teslimAdimi.durum !== 'tamamlandi')
        await adimTamamla(client, { dosyaId, adimId: teslimAdimi.id, kullaniciId: req.user.id });
      return tutanaklar(client, dosyaId);
    });
    res.status(201).json(sonuc);
  } catch (err) { next(err); }
});

module.exports = router;
