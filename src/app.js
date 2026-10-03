require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');

const authRoutes    = require('./routes/auth');
const dosyaRoutes   = require('./routes/dosyalar');
const islemRoutes   = require('./routes/islemler');
const fotoRoutes    = require('./routes/fotograflar');
const evrakRoutes   = require('./routes/evrak');
const mesajRoutes   = require('./routes/mesajlar');
const smsRoutes     = require('./routes/sms');
const servisRoutes  = require('./routes/servisler');
const faturaRoutes  = require('./routes/faturalar');
const isEmriRoutes  = require('./routes/isEmirleri');
const stokRoutes    = require('./routes/stok');
const raporRoutes   = require('./routes/raporlar');
const takipRoutes   = require('./routes/takip');
const tutanakRoutes = require('./routes/tutanak');
const modulRoutes   = require('./routes/moduller');
const dviRoutes     = require('./routes/dvi');
const protokolRoutes = require('./routes/protokoller');
const ikameRoutes   = require('./routes/ikame');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  // Serverless'ta process.exit işe yaramaz; throw hem yerelde (çıkış kodu 1) hem Vercel'de net hata verir
  throw new Error('JWT_SECRET tanımlı değil veya 32 karakterden kısa.');
}

const app  = express();

// FRONTEND_URL virgüllü liste olabilir; boşluk ve sondaki "/" temizlenir
const izinliOriginler = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

// ── GÜVENLİK ────────────────────────────────────────────────
app.set('trust proxy', 1);  // Vercel proxy arkasında gerçek istemci IP'si
app.use(helmet());
app.use(cors({
  origin: (origin, cb) => {
    // Origin başlığı olmayan istekler (curl, sağlık kontrolü) geçer
    if (!origin || izinliOriginler.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 dk
  max: Number(process.env.RATE_LIMIT_MAX) || 300, // testlerde yükseltilir
  message: { error: 'Çok fazla istek. 15 dakika bekleyin.' },
}));

// ── MIDDLEWARE ───────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── ROUTES ───────────────────────────────────────────────────
// Yerel depo için imzalı dosya servisi (canlıda Supabase imzalı URL kullanılır)
app.get('/api/medya/*', require('./lib/depo').yerelServis);
app.use('/api/auth',       authRoutes);
app.use('/api/dosyalar',   dosyaRoutes);
app.use('/api/islemler',   islemRoutes);
app.use('/api/fotograflar',fotoRoutes);
app.use('/api/evrak',      evrakRoutes);
app.use('/api/mesajlar',   mesajRoutes);
app.use('/api/sms',        smsRoutes);
app.use('/api/servisler',  servisRoutes);
app.use('/api/faturalar',  faturaRoutes);
app.use('/api/is-emirleri', isEmriRoutes);
app.use('/api/stok',     stokRoutes);
app.use('/api/raporlar',   raporRoutes);
app.use('/api/takip',      takipRoutes);
app.use('/api/tutanaklar', tutanakRoutes);
app.use('/api/moduller',  modulRoutes);
app.use('/api/dvi',       dviRoutes);
app.use('/api/protokoller', protokolRoutes);
app.use('/api/ikame',     ikameRoutes);

// ── SAĞLIK KONTROLÜ ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', time: new Date().toISOString() });
});

// ── HATA YÖNETİMİ ───────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ERROR:`, err.message);
  if (process.env.NODE_ENV !== 'production') console.error(err.stack);
  // Geçersiz tip girdileri (UUID, tarih, sayı) 400; tekil kayıt çakışması 409
  const PG_400 = ['22P02', '22007', '22008', '22003'];
  let durum = err.status || 500;
  if (!err.status && PG_400.includes(err.code)) { durum = 400; err.message = 'Geçersiz değer'; }
  else if (!err.status && err.code === '23505') { durum = 409; err.message = 'Kayıt zaten var'; }
  else if (!err.status && err.code === '22001') { durum = 400; err.message = 'Metin çok uzun'; }
  else if (!err.status && err.code === '23514') { durum = 400; err.message = 'Geçersiz değer'; }
  // Production'da 5xx yanıtı iç ayrıntı sızdırmaz; mesaj yalnız loga yazılır
  const mesaj = durum >= 500 && process.env.NODE_ENV === 'production'
    ? 'Sunucu hatası'
    : (err.message || 'Sunucu hatası');
  res.status(durum).json({
    error: mesaj,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Sayfa bulunamadı' });
});

module.exports = app;
