require('dotenv').config();
const { pool, withTransaction } = require('./index');

// Demo kayıtlar: gerçek fotoğraflı 3 hasar dosyası (Unsplash, ücretsiz lisans; görseller
// images.unsplash.com'dan gösterilir). Idempotent: DEMO- ile başlayan dosya varsa atlar.
//   npm run db:demo          -> oluşturur
//   npm run db:demo -- --sil -> DEMO- dosyalarını ve bağlı her şeyi siler
//   npm run db:demo -- --mevcut -> fotoğrafsız mevcut dosyalara demo fotoğraf bağlar
const U = (id) => `https://images.unsplash.com/photo-${id}?w=1600&q=80&auto=format&fit=crop`;
const DEMOLAR = [
  {
    no: 'DEMO-2026-001', oncelik: 'Yüksek', muallak: 48500,
    arac: { plaka: '34 DMO 101', marka: 'Volkswagen', model: 'Tiguan', yil: 2019, renk: 'Gri', kaza: 'Kavşakta sol ön köşeden çarpma.' },
    sahip: { ad: 'Elif Demir', tel: '05320000101' },
    sigorta: { sirket: 'Anadolu Sigorta', hasar: 'DEMO-H-101', muafiyet: 2000 },
    eksper: 'Ahmet Çelik',
    kalemler: [
      ['Parça', 'Sol ön çamurluk', 1, 9800, 'sigorta'], ['Parça', 'Sol far komple', 1, 14500, 'sigorta'],
      ['Kaporta', 'Ön panel düzeltme', 1, 6200, 'sigorta'], ['Boya', 'Çamurluk ve tampon boya', 1, 8400, 'sigorta'],
      ['Diğer', 'Cam filmi yenileme (sigorta harici)', 1, 1800, 'musteri'],
    ],
    onay: 'onaylandi',
    gorevler: [['kaporta', 'Sol ön çamurluk değişimi', 'Mehmet Usta', 1], ['boya', 'Çamurluk ve tampon boya', 'Hasan Usta', 0]],
    fotolar: [
      ['1673187139612-6bf684a74815', 'Sol ön genel görünüm', 'kaza'],
      ['1597328290883-50c5787b7c7e', 'Far ve kaput detay', 'ekspertiz'],
      ['1767681092416-bccf9410bda4', 'Atölyede söküm', 'onarim'],
    ],
  },
  {
    no: 'DEMO-2026-002', oncelik: 'Normal', muallak: 31200,
    arac: { plaka: '34 DMO 202', marka: 'Opel', model: 'Corsa', yil: 2021, renk: 'Kırmızı', kaza: 'Park halindeyken sağ arkadan çarpıldı.' },
    sahip: { ad: 'Murat Kaya', tel: '05320000202' },
    sigorta: { sirket: 'Allianz Sigorta', hasar: 'DEMO-H-202', muafiyet: 0 },
    eksper: 'Zeynep Arslan',
    kalemler: [
      ['Kaporta', 'Sağ arka çamurluk düzeltme', 1, 7400, 'sigorta'], ['Parça', 'Arka tampon', 1, 6900, 'sigorta'],
      ['Mekanik', 'Arka süspansiyon kontrolü', 1, 2500, 'sigorta'],
    ],
    onay: 'bekliyor',
    gorevler: [['sokum', 'Arka tampon söküm', 'Ali Usta', 1]],
    fotolar: [
      ['1673187139211-1e7ec3dd60ec', 'Çekici ile geliş', 'kaza'],
      ['1702146713858-8e7d1cc29fe8', 'Alt takım kontrolü', 'ekspertiz'],
    ],
  },
  {
    no: 'DEMO-2026-003', oncelik: 'Acil', muallak: 92000,
    arac: { plaka: '34 DMO 303', marka: 'Toyota', model: 'Corolla', yil: 2022, renk: 'Beyaz', kaza: 'Önden çarpışma, ön takım ağır hasarlı.' },
    sahip: { ad: 'Ayşe Yıldız', tel: '05320000303' },
    sigorta: { sirket: 'Axa Sigorta', hasar: 'DEMO-H-303', muafiyet: 5000 },
    eksper: null,
    kalemler: [],
    onay: 'taslak',
    gorevler: [],
    fotolar: [
      ['1687867451910-28941a460f35', 'Ön sağ hasar', 'kaza'],
      ['1713623311317-d3c43a4be4cf', 'Kaza yeri', 'kaza'],
      ['1615906655593-ad0386982a0f', 'Motor bölmesi inceleme', 'ekspertiz'],
      ['1632733711679-529326f6db12', 'Sigorta kutusu kontrolü', 'ekspertiz'],
    ],
  },
];
const ADIMLAR = ['Araç Kabulü', 'Ön Hasar Tespiti', 'Ekspertiz İncelemesi', 'Teklif / Onay',
  'Parça Temini', 'Onarım', 'Boya & Son Kontrol', 'Araç Teslimi'];
const EVRAK = [['Kaza Tespit Tutanağı', 'Araç Sahibi'], ['Ehliyet Fotokopisi', 'Araç Sahibi'],
  ['Ruhsat Fotokopisi', 'Araç Sahibi'], ['Poliçe Kopyası', 'Sigorta Şirketi'], ['Eksper Raporu', 'Eksper'],
  ['Fotoğraflı Hasar Formu', 'Servis'], ['Maliyet Teklifi (Proforma)', 'Servis'],
  ['Sigorta Onay Yazısı', 'Sigorta Şirketi'], ['Teslim Tutanağı', 'Servis']];
const BOLUM_ADIM = { kaporta: ['Düzeltme / değişim', 'Montaj hazırlığı'], boya: ['Hazırlık (macun, astar)', 'Boya', 'Pasta-cila'],
  sokum: ['Söküm', 'Gizli hasar kontrolü'] };

async function sil() {
  const r = await pool.query(`DELETE FROM dosyalar WHERE dosya_no LIKE 'DEMO-%'`);
  console.log(`Demo dosyalar silindi: ${r.rowCount}`);
}

async function olustur() {
  const { rowCount } = await pool.query(`SELECT 1 FROM dosyalar WHERE dosya_no LIKE 'DEMO-%'`);
  if (rowCount) { console.log('Demo kayıtlar zaten var, atlandı.'); return; }
  const { rows: [srv] } = await pool.query('SELECT id, ad FROM servisler WHERE aktif ORDER BY created_at LIMIT 1');
  for (const [di, d] of DEMOLAR.entries()) {
    await withTransaction(async (c) => {
      const q = (s, p) => c.query(s, p);
      const { rows: [dosya] } = await q(
        `INSERT INTO dosyalar (dosya_no, oncelik, sigorta_bransi, muallak_hasar, atanan_servis, created_at)
         VALUES ($1,$2,'Kasko',$3,$4, NOW() - ($5 || ' days')::interval) RETURNING id`,
        [d.no, d.oncelik, d.muallak, di < 2 ? srv?.id ?? null : null, String(6 - di * 2)]);
      const id = dosya.id;
      await q(`INSERT INTO arac (dosya_id, plaka, marka, model, yil, renk, kaza_tarihi, kaza_aciklama)
               VALUES ($1,$2,$3,$4,$5,$6, CURRENT_DATE - 7, $7)`,
        [id, d.arac.plaka, d.arac.marka, d.arac.model, d.arac.yil, d.arac.renk, d.arac.kaza]);
      await q('INSERT INTO sahip (dosya_id, ad_soyad, telefon) VALUES ($1,$2,$3)', [id, d.sahip.ad, d.sahip.tel]);
      await q('INSERT INTO sigorta (dosya_id, sirket_ad, hasar_no, muafiyet) VALUES ($1,$2,$3,$4)',
        [id, d.sigorta.sirket, d.sigorta.hasar, d.sigorta.muafiyet]);
      if (d.eksper) await q('INSERT INTO eksper (dosya_id, ad_soyad, firma) VALUES ($1,$2,$3)', [id, d.eksper, 'Demo Ekspertiz']);
      await q('INSERT INTO muhasebe (dosya_id) VALUES ($1)', [id]);
      // Onay durumuna göre ilk adımlar tamamlanmış görünsün
      const biten = { onaylandi: 5, bekliyor: 3, taslak: 1 }[d.onay];
      for (const [i, ad] of ADIMLAR.entries()) {
        const durum = i < biten ? 'tamamlandi' : i === biten ? 'aktif' : 'bekliyor';
        await q(`INSERT INTO onarim_adimlari (dosya_id, sira, ad, durum, tamamlanma_trh) VALUES ($1,$2,$3,$4,$5)`,
          [id, i + 1, ad, durum, durum === 'tamamlandi' ? new Date() : null]);
      }
      for (const [i, [ad, kaynak]] of EVRAK.entries())
        await q(`INSERT INTO evrak (dosya_id, ad, kaynak, sira, durum) VALUES ($1,$2,$3,$4,$5)`,
          [id, ad, kaynak, i + 1, i < 4 ? 'tamam' : 'bekliyor']);
      const { rows: [ie] } = await q(
        `INSERT INTO is_emirleri (dosya_id, no, tur, onay_durumu, gonderim_trh, karar_trh, eksper_ad)
         VALUES ($1,1,'ana',$2,$3,$4,$5) RETURNING id`,
        [id, d.onay, d.onay === 'taslak' ? null : new Date(Date.now() - 2 * 864e5),
         d.onay === 'onaylandi' ? new Date(Date.now() - 864e5) : null, d.onay === 'onaylandi' ? d.eksper : null]);
      let onaylanan = 0;
      for (const [kat, aciklama, miktar, fiyat, odeyen] of d.kalemler) {
        const onayli = d.onay === 'onaylandi';
        if (onayli) onaylanan += miktar * fiyat;
        await q(`INSERT INTO islemler (dosya_id, is_emri_id, kategori, aciklama, miktar, birim_fiyat, odeyen, durum,
                   onaylayan_tip, onaylayan_ad, karar_trh)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, ie.id, kat, aciklama, miktar, fiyat, odeyen, onayli ? 'onaylandi' : 'bekliyor',
           onayli ? (odeyen === 'musteri' ? 'musteri' : 'eksper') : null,
           onayli ? (odeyen === 'musteri' ? d.sahip.ad : d.eksper) : null, onayli ? new Date() : null]);
      }
      if (onaylanan) await q('UPDATE muhasebe SET onaylanan_tutar=$1 WHERE dosya_id=$2', [onaylanan, id]);
      for (const [bolum, aciklama, usta, bitenAdim] of d.gorevler) {
        const adimlar = BOLUM_ADIM[bolum];
        const durum = bitenAdim >= adimlar.length ? 'tamam' : bitenAdim > 0 ? 'devam' : 'bekliyor';
        const { rows: [g] } = await q(
          `INSERT INTO bolum_gorevleri (is_emri_id, dosya_id, bolum, aciklama, sorumlu_usta, durum, baslama_trh, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() - interval '2 days') RETURNING id`,
          [ie.id, id, bolum, aciklama, usta, durum, bitenAdim > 0 ? new Date(Date.now() - 864e5) : null]);
        for (const [i, ad] of adimlar.entries())
          await q(`INSERT INTO gorev_adimlari (gorev_id, sira, ad, durum, tamamlanma_trh, tamamlayan_usta)
                   VALUES ($1,$2,$3,$4,$5,$6)`,
            [g.id, i + 1, ad, i < bitenAdim ? 'tamam' : 'bekliyor', i < bitenAdim ? new Date() : null, i < bitenAdim ? usta : null]);
      }
      for (const [foto, etiket, kategori] of d.fotolar)
        await q(`INSERT INTO fotograflar (dosya_id, url, dosya_adi, etiket, kategori) VALUES ($1,$2,$3,$4,$5)`,
          [id, U(foto), `Unsplash ${foto}`, etiket, kategori]);
    });
    console.log(`Demo dosya oluşturuldu: ${d.no}`);
  }
  console.log(srv ? `İlk iki dosya "${srv.ad}" servisine atandı.` : 'Aktif servis yok, dosyalar servissiz.');
}

// Fotoğrafı olmayan mevcut dosyalara sırayla demo fotoğraf bağlar (kaza + ekspertiz + onarım).
// Tekrar çalıştırılırsa fotoğrafı olan dosyalara dokunmaz.
const FOTO_SETLERI = [
  [['1673187139612-6bf684a74815', 'Ön sol genel görünüm', 'kaza'], ['1597328290883-50c5787b7c7e', 'Far ve kaput detay', 'ekspertiz'], ['1767681092416-bccf9410bda4', 'Atölyede söküm', 'onarim']],
  [['1673187139211-1e7ec3dd60ec', 'Çekici ile geliş', 'kaza'], ['1702146713858-8e7d1cc29fe8', 'Alt takım kontrolü', 'ekspertiz']],
  [['1687867451910-28941a460f35', 'Ön sağ hasar', 'kaza'], ['1615906655593-ad0386982a0f', 'Motor bölmesi inceleme', 'ekspertiz']],
  [['1713623311317-d3c43a4be4cf', 'Kaza yeri', 'kaza'], ['1632733711679-529326f6db12', 'Sigorta kutusu kontrolü', 'ekspertiz']],
];
async function mevcutlaraFoto() {
  // Gerçek hasar dosyalarına sahte kanıt fotoğrafı eklenmesin diye açık onay ister
  if (process.env.DEMO_FOTO_ONAY !== 'evet')
    throw new Error('Bu komut fotoğrafsız TÜM dosyalara demo fotoğraf ekler. Yalnız demo verisinde DEMO_FOTO_ONAY=evet ile çalıştırın.');
  const { rows } = await pool.query(
    `SELECT d.id, d.dosya_no FROM dosyalar d
     WHERE NOT EXISTS (SELECT 1 FROM fotograflar f WHERE f.dosya_id=d.id) ORDER BY d.created_at`);
  for (const [i, d] of rows.entries()) {
    for (const [foto, etiket, kategori] of FOTO_SETLERI[i % FOTO_SETLERI.length])
      await pool.query(`INSERT INTO fotograflar (dosya_id, url, dosya_adi, etiket, kategori) VALUES ($1,$2,$3,$4,$5)`,
        [d.id, U(foto), `Unsplash ${foto}`, etiket, kategori]);
    console.log(`Fotoğraf eklendi: ${d.dosya_no}`);
  }
  if (!rows.length) console.log('Fotoğrafsız dosya yok, atlandı.');
}

(process.argv.includes('--sil') ? sil() : process.argv.includes('--mevcut') ? mevcutlaraFoto() : olustur())
  .catch((err) => { console.error('Demo hatası:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
