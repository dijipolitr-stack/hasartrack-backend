const { Pool, types } = require('pg');

// DATE (1082) string kalır: saat dilimi kayması olmaz
types.setTypeParser(1082, (v) => v);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: false }
    : false,
  max: Number(process.env.DB_POOL_MAX || 10),  // Vercel'de 3
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL bağlantı hatası:', err.message);
});

// Kolaylık fonksiyonları
const query = (text, params) => pool.query(text, params);

const getClient = () => pool.connect();

// Transaction yardımcısı
const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { query, getClient, withTransaction, pool };
