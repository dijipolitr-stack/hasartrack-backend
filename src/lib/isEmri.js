// İş emri yardımcıları ve sabit bölüm listesi (şimdilik her serviste aynı).
const { query } = require('../db');
const { httpHata, UUID_RE } = require('./dogrula');

const BOLUMLER = {
  sokum:      { ad: 'Söküm',      adimlar: ['Söküm', 'Gizli hasar kontrolü'] },
  kaporta:    { ad: 'Kaporta',    adimlar: ['Düzeltme / değişim', 'Montaj hazırlığı'] },
  boya:       { ad: 'Boya',       adimlar: ['Hazırlık (macun, astar)', 'Boya', 'Pasta-cila'] },
  mekanik:    { ad: 'Mekanik',    adimlar: ['Arıza tespiti', 'Parça değişimi', 'Test'] },
  elektrik:   { ad: 'Elektrik',   adimlar: ['Arıza tespiti', 'Onarım', 'Test'] },
  montaj:     { ad: 'Montaj',     adimlar: ['Montaj', 'Ayar'] },
  dis_hizmet: { ad: 'Dış hizmet', adimlar: ['Gönderildi', 'Geri geldi'] },
};

// Dosyanın ana iş emrini döner; yoksa oluşturur (eski dosyalar ve yarış durumu için güvenli)
const anaIsEmri = async (dosyaId, db = { query }) => {
  await db.query(
    `INSERT INTO is_emirleri (dosya_id, no, tur) VALUES ($1, 1, 'ana')
     ON CONFLICT (dosya_id, no) DO NOTHING`, [dosyaId]);
  const { rows: [ie] } = await db.query('SELECT * FROM is_emirleri WHERE dosya_id=$1 AND no=1', [dosyaId]);
  return ie;
};

// isEmriId verilmişse dosyaya ait olmalı (yoksa 404); verilmemişse ana iş emri
const isEmriBul = async (dosyaId, isEmriId, db = { query }) => {
  if (isEmriId === undefined || isEmriId === null || isEmriId === '') return anaIsEmri(dosyaId, db);
  if (typeof isEmriId !== 'string' || !UUID_RE.test(isEmriId)) throw httpHata(400, 'Geçersiz iş emri');
  const { rows: [ie] } = await db.query(
    'SELECT * FROM is_emirleri WHERE id=$1 AND dosya_id=$2', [isEmriId, dosyaId]);
  if (!ie) throw httpHata(404, 'İş emri bulunamadı');
  return ie;
};

// Kalem eklenip değiştirilebilir mi: taslak veya reddedilmiş, iptal değil
const kalemDuzenlenebilir = (ie) => ie.durum !== 'iptal' && ['taslak', 'reddedildi'].includes(ie.onay_durumu);

module.exports = { BOLUMLER, anaIsEmri, isEmriBul, kalemDuzenlenebilir };
