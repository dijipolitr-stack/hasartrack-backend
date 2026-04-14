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
const raporRoutes   = require('./routes/raporlar');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── GÜVENLİK ────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 dk
  max: 300,
  message: { error: 'Çok fazla istek. 15 dakika bekleyin.' },
}));

// ── MIDDLEWARE ───────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── ROUTES ───────────────────────────────────────────────────
app.use('/api/auth',       authRoutes);
app.use('/api/dosyalar',   dosyaRoutes);
app.use('/api/islemler',   islemRoutes);
app.use('/api/fotograflar',fotoRoutes);
app.use('/api/evrak',      evrakRoutes);
app.use('/api/mesajlar',   mesajRoutes);
app.use('/api/sms',        smsRoutes);
app.use('/api/servisler',  servisRoutes);
app.use('/api/raporlar',   raporRoutes);

// ── SAĞLIK KONTROLÜ ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', time: new Date().toISOString() });
});

// ── HATA YÖNETİMİ ───────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ERROR:`, err.message);
  if (process.env.NODE_ENV !== 'production') console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Sunucu hatası',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Sayfa bulunamadı' });
});

app.listen(PORT, () => {
  console.log(`🛡️  HasarTrack API — port ${PORT} (${process.env.NODE_ENV || 'development'})`);
});

module.exports = app;
