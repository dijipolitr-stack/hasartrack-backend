// Onarım adımı tamamlama: elle tamamlama (routes/dosyalar.js) ve teslim tutanağı (routes/tutanak.js)
// aynı kuralları kullanır. Açık bir transaction client'ı ile çağrılır.
const { httpHata } = require('./dogrula');
const { BOLUMLER } = require('./isEmri');

const TESLIM_ADIMI = 'Araç Teslimi';

async function adimTamamla(client, { dosyaId, adimId, kullaniciId }) {
  const { rows: [adim] } = await client.query(
    'SELECT id, sira, ad, durum, oto_sms FROM onarim_adimlari WHERE id=$1 AND dosya_id=$2 FOR UPDATE',
    [adimId, dosyaId]
  );
  if (!adim) throw httpHata(404, 'Adım bulunamadı');
  if (adim.durum === 'tamamlandi') throw httpHata(409, 'Adım zaten tamamlandı');
  // Onarım adımı, usta tarafından bitirildiği bildirilmemiş bölüm görevi varken kapanmaz
  if (adim.ad === 'Onarım') {
    const { rows: acik } = await client.query(
      `SELECT g.bolum, COUNT(*)::int AS sayi FROM bolum_gorevleri g
       JOIN is_emirleri ie ON ie.id=g.is_emri_id AND ie.durum<>'iptal'
       WHERE g.dosya_id=$1 AND g.durum<>'tamam' GROUP BY g.bolum`, [dosyaId]);
    if (acik.length) {
      const liste = acik.map((r) => `${BOLUMLER[r.bolum]?.ad || r.bolum} (${r.sayi})`).join(', ');
      throw httpHata(409, `Açık bölüm görevi var: ${liste}. Usta işi bitirdiğini bildirmeden onarım kapanmaz.`);
    }
  }
  // Araç teslimi yalnız teslim tutanağıyla kapanır
  if (adim.ad === TESLIM_ADIMI) {
    const { rowCount } = await client.query(
      "SELECT 1 FROM arac_tutanaklari WHERE dosya_id=$1 AND tip='teslim'", [dosyaId]);
    if (!rowCount) throw httpHata(409, 'Teslim tutanağı doldurulmadan araç teslim edilemez.');
  }

  await client.query(
    `UPDATE onarim_adimlari SET durum='tamamlandi', tamamlanma_trh=NOW(), tamamlayan_id=$1 WHERE id=$2`,
    [kullaniciId, adimId]
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
  const { rows: adimlar } = await client.query(
    'SELECT * FROM onarim_adimlari WHERE dosya_id=$1 ORDER BY sira', [dosyaId]);
  const bitti = adimlar.filter((a) => a.durum === 'tamamlandi').length;
  return { onarim_adimlari: adimlar, ilerleme: adimlar.length ? Math.round((bitti / adimlar.length) * 100) : 0 };
}

module.exports = { adimTamamla, TESLIM_ADIMI };
