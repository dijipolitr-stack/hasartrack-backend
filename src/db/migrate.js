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
  await rlsAc();
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
