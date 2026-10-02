require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { pool } = require('./index');

// Şema yoksa schema.sql'i tek transaction'da uygular; varsa atlar.
// Not: artımlı migration değildir.
async function main() {
  const { rows } = await pool.query(
    "SELECT to_regclass('public.kullanicilar') AS t"
  );
  if (rows[0].t) {
    console.log('Şema var, atlandı.');
  } else {
    await semaUygula();
  }
  await ekMigrasyonlar();
  await rlsAc();
}

// backend/migrations/*.sql dosyalarını ad sırasıyla, her birini BİR KEZ uygular (schema_migrations).
// Dosya ve kaydı aynı transaction'da; yarıda kalan migration kaydedilmez. Dosyalar yine de
// idempotent yazılır (IF NOT EXISTS / OR REPLACE). Mevcut canlı DB'ye değişiklik eklemenin yolu budur.
async function ekMigrasyonlar() {
  const klasor = path.join(__dirname, '..', '..', 'migrations');
  if (!fs.existsSync(klasor)) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    ad TEXT PRIMARY KEY, uygulama_trh TIMESTAMPTZ DEFAULT NOW())`);
  const { rows } = await pool.query('SELECT ad FROM schema_migrations');
  const uygulanan = new Set(rows.map((r) => r.ad));
  const dosyalar = fs.readdirSync(klasor).filter((f) => f.endsWith('.sql')).sort();
  for (const f of dosyalar) {
    if (uygulanan.has(f)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(klasor, f), 'utf8'));
      await client.query('INSERT INTO schema_migrations (ad) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log(`Migration uygulandı: ${f}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`${f}: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

async function semaUygula() {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('Şema uygulandı.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Supabase Data API anon anahtarla tabloları açar; RLS açık ve politikasız tablo erişime kapalıdır.
// API postgres sahibi olarak bağlanır, RLS'i atlar. Idempotent.
async function rlsAc() {
  const { rows } = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
  );
  for (const { tablename } of rows) {
    await pool.query(`ALTER TABLE public."${tablename}" ENABLE ROW LEVEL SECURITY`);
  }
  console.log(`RLS açık: ${rows.length} tablo.`);
}

main()
  .catch((err) => {
    console.error('Migrate hatası:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
