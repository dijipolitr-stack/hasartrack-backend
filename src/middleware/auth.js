const jwt = require('jsonwebtoken');
const { query } = require('../db');

// ── JWT DOĞRULAMA ────────────────────────────────────────────
const authMiddleware = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token gerekli' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await query(
      'SELECT id, ad_soyad, email, rol, servis_id FROM kullanicilar WHERE id=$1 AND aktif=TRUE',
      [payload.id]
    );
    if (!rows.length) return res.status(401).json({ error: 'Kullanıcı bulunamadı' });
    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Geçersiz token' });
  }
};

// ── ROL KONTROLÜ ─────────────────────────────────────────────
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.rol)) {
    return res.status(403).json({ error: 'Bu işlem için yetkiniz yok' });
  }
  next();
};

// Kısa yollar
const onlyAdmin   = requireRole('admin');
const adminOrServis = requireRole('admin', 'servis');
const notMusteri  = requireRole('admin', 'servis', 'acente');

// ── DOSYA SAHİPLİĞİ KONTROLÜ ────────────────────────────────
// Servis yalnızca kendine atanmış dosyaları görebilir
const dosyaErisim = async (req, res, next) => {
  const { dosyaId } = req.params;
  const user = req.user;
  if (user.rol === 'admin' || user.rol === 'acente') return next();
  if (user.rol === 'servis') {
    const { rows } = await query(
      'SELECT id FROM dosyalar WHERE id=$1 AND atanan_servis=$2',
      [dosyaId, user.servis_id]
    );
    if (!rows.length) return res.status(403).json({ error: 'Bu dosyaya erişiminiz yok' });
    return next();
  }
  if (user.rol === 'musteri') {
    const { rows } = await query(
      'SELECT d.id FROM dosyalar d JOIN sahip s ON s.dosya_id=d.id WHERE d.id=$1 AND s.tc_vergi=$2',
      [dosyaId, user.tc_no]
    );
    if (!rows.length) return res.status(403).json({ error: 'Bu dosyaya erişiminiz yok' });
    return next();
  }
  return res.status(403).json({ error: 'Yetkisiz' });
};

module.exports = { authMiddleware, requireRole, onlyAdmin, adminOrServis, notMusteri, dosyaErisim };
