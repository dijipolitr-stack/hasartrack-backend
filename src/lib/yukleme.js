// Çok parçalı dosya yükleme (multer, bellekte). Vercel istek sınırı 4.5 MB; sınır 4 MB.
// Ön yüz fotoğrafları yüklemeden önce küçültür.
const crypto = require('crypto');
const multer = require('multer');
const { httpHata } = require('./dogrula');

const MAKS_BAYT = 4 * 1024 * 1024;
const UZANTI = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const GORSEL = ['image/jpeg', 'image/png', 'image/webp'];
const BELGE = [...GORSEL, 'application/pdf'];

// alan adı "dosya"; izinli mime dışı 400, büyük dosya 413
const tekDosya = (izinli) => (req, res, next) => {
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAKS_BAYT, files: 1 },
    fileFilter: (r, f, cb) => cb(izinli.includes(f.mimetype)
      ? null : httpHata(400, 'Desteklenmeyen dosya türü (JPG, PNG, WEBP' + (izinli.includes('application/pdf') ? ', PDF' : '') + ')'), true),
  }).single('dosya')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return next(httpHata(413, 'Dosya en fazla 4 MB olabilir'));
    if (err?.name === 'MulterError') return next(httpHata(400, 'Dosya yüklenemedi'));
    if (err) return next(err);
    if (!req.file) return next(httpHata(400, 'Dosya seçilmedi ("dosya" alanı)'));
    next();
  });
};

const anahtarUret = (dosyaId, tur, mime) =>
  `dosyalar/${dosyaId}/${tur}/${crypto.randomUUID()}.${UZANTI[mime] || 'bin'}`;

// İstek tabanı (yerel imzalı URL için)
const tabanUrl = (req) => `${req.protocol}://${req.get('host')}`;

// multer dosya adını latin1 okur; UTF-8'e çevir (Türkçe karakterler)
const dosyaAdi = (f) => Buffer.from(f.originalname || '', 'latin1').toString('utf8').slice(0, 255);

module.exports = { tekDosya, anahtarUret, tabanUrl, dosyaAdi, GORSEL, BELGE };
