// Dosya deposu. Canlıda Supabase Storage (özel bucket, imzalı URL), yerelde ve testte disk.
//   SUPABASE_URL + SUPABASE_SERVICE_KEY (+ SUPABASE_BUCKET, varsayılan "hasartrack") -> supabase
//   yoksa ve production değilse -> yerel disk (DEPO_KLASOR, varsayılan backend/.depo)
// Tarayıcı dosyayı imzalı ve süreli URL ile görür; anahtar veritabanında tutulur.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { httpHata } = require('./dogrula');

const SURE_SN = 60 * 60; // imzalı URL geçerliliği
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const BUCKET = process.env.SUPABASE_BUCKET || 'hasartrack';
const YEREL = path.resolve(process.env.DEPO_KLASOR || path.join(__dirname, '..', '..', '.depo'));

const saglayici = () => {
  if (SB_URL && SB_KEY) return 'supabase';
  if (process.env.NODE_ENV === 'production') return null;
  return 'yerel';
};

const sb = async (yol, opts = {}) => {
  const res = await fetch(`${SB_URL}/storage/v1${yol}`, {
    signal: AbortSignal.timeout(20000), // depo yavaşlarsa Vercel süre sınırına kadar asılı kalmasın
    ...opts,
    headers: { Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const metin = await res.text().catch(() => '');
    throw new Error(`Depo hatası ${res.status}: ${metin.slice(0, 200)}`);
  }
  return res;
};

// Anahtar yalnız sunucuda üretilir; yine de yol kaçışına karşı denetlenir
const anahtarGecerli = (k) => typeof k === 'string' && /^[a-z0-9_\-./]+$/i.test(k) && !k.includes('..');

const imza = (anahtar, bitis) =>
  crypto.createHmac('sha256', process.env.JWT_SECRET || '').update(`${anahtar}:${bitis}`).digest('hex').slice(0, 32);

async function yukle(anahtar, veri, mime) {
  const p = saglayici();
  if (!p) throw httpHata(503, 'Dosya deposu yapılandırılmamış');
  if (!anahtarGecerli(anahtar)) throw httpHata(400, 'Geçersiz dosya yolu');
  if (p === 'supabase') {
    await sb(`/object/${BUCKET}/${anahtar}`, {
      method: 'POST', body: veri, headers: { 'Content-Type': mime, 'x-upsert': 'true' },
    });
    return;
  }
  const hedef = path.join(YEREL, anahtar);
  await fs.promises.mkdir(path.dirname(hedef), { recursive: true });
  await fs.promises.writeFile(hedef, veri);
}

// anahtarlar -> { anahtar: url }. http(s) ile başlayan değerler (örn. demo görseller) olduğu gibi döner.
async function urlListesi(anahtarlar, tabanUrl) {
  const sonuc = {};
  const depodakiler = [...new Set(anahtarlar.filter((k) => k && !/^https?:\/\//.test(k)))];
  for (const k of anahtarlar) if (k && /^https?:\/\//.test(k)) sonuc[k] = k;
  if (!depodakiler.length) return sonuc;
  const p = saglayici();
  if (p === 'supabase') {
    const res = await sb(`/object/sign/${BUCKET}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: SURE_SN, paths: depodakiler }),
    });
    for (const r of await res.json()) if (r.signedURL) sonuc[r.path] = `${SB_URL}/storage/v1${r.signedURL}`;
  } else if (p === 'yerel') {
    const bitis = Math.floor(Date.now() / 1000) + SURE_SN;
    for (const k of depodakiler)
      sonuc[k] = `${tabanUrl}/api/medya/${k}?b=${bitis}&i=${imza(k, bitis)}`;
  }
  return sonuc;
}

async function sil(anahtarlar) {
  const liste = anahtarlar.filter((k) => k && !/^https?:\/\//.test(k) && anahtarGecerli(k));
  if (!liste.length) return;
  const p = saglayici();
  if (p === 'supabase') {
    await sb(`/object/${BUCKET}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: liste }),
    });
  } else if (p === 'yerel') {
    for (const k of liste) await fs.promises.rm(path.join(YEREL, k), { force: true });
  }
}

// Yerel sağlayıcı için imzalı dosya servisi (GET /api/medya/<anahtar>?b=&i=)
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
function yerelServis(req, res) {
  if (saglayici() !== 'yerel') return res.status(404).end();
  const anahtar = req.params[0];
  const bitis = parseInt(req.query.b, 10);
  const ok = anahtarGecerli(anahtar) && bitis > Date.now() / 1000 && typeof req.query.i === 'string'
    && /^[0-9a-f]{32}$/.test(req.query.i)
    && crypto.timingSafeEqual(Buffer.from(req.query.i), Buffer.from(imza(anahtar, bitis)));
  if (!ok) return res.status(403).json({ error: 'Bağlantı geçersiz veya süresi dolmuş' });
  const dosya = path.join(YEREL, anahtar);
  if (!fs.existsSync(dosya)) return res.status(404).end();
  res.type(MIME[path.extname(dosya).slice(1).toLowerCase()] || 'application/octet-stream');
  // Ön yüz başka origin'de; helmet'in varsayılan same-origin CORP'u görseli engeller
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  fs.createReadStream(dosya).pipe(res);
}

module.exports = { yukle, urlListesi, sil, yerelServis, saglayici };
