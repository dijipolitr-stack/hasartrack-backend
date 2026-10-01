require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool } = require('./index');

// İlk admin kullanıcıyı oluşturur. Idempotent: e-posta varsa atlar.
async function main() {
  const email = (process.env.ADMIN_EMAIL || 'admin@hasartrack.com').trim().toLowerCase();

  const var_ = await pool.query('SELECT 1 FROM kullanicilar WHERE email = $1', [email]);
  if (var_.rowCount > 0) {
    console.log('Admin zaten var, atlandı.');
    return;
  }

  const sifre = process.env.ADMIN_PASSWORD;
  if (!sifre) throw new Error('ADMIN_PASSWORD tanımlı olmalı (en az 12 karakter).');
  if (sifre.length < 12) throw new Error('ADMIN_PASSWORD en az 12 karakter olmalı.');

  const hash = await bcrypt.hash(sifre, 12);
  const r = await pool.query(
    `INSERT INTO kullanicilar (ad_soyad, email, sifre_hash, rol)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (email) DO NOTHING`,
    ['Hasar Admin', email, hash]
  );

  if (r.rowCount === 0) {
    console.log('Admin zaten var, atlandı.');
    return;
  }
  console.log(`Admin oluşturuldu: ${email}`);
}

main()
  .catch((err) => {
    console.error('Seed hatası:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
