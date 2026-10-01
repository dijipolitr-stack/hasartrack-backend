// Kapsam dışı bulgu (iş 2026-10-01-yeni-deploy, Tur 2): müşteri rolüyle GET /api/dosyalar.
// Beklenen doğru davranış 200'dür; kod düzeltilene kadar bu test KALIR. Ana A grubu paketine dahil değildir.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { Client } = require('pg');
const ROOT = path.join(__dirname, '..');
const { TEST_DATABASE_URL: DB, TEST_JWT_SECRET: JWT } = process.env;
if (!DB || !JWT) throw new Error('TEST_DATABASE_URL ve TEST_JWT_SECRET gerekli (şema kurulu DB)');

test('musteri rolü GET /api/dosyalar 500 vermemeli', async () => {
  const c = new Client({ connectionString: DB }); await c.connect();
  const { rows } = await c.query(
    "INSERT INTO kullanicilar (ad_soyad,email,sifre_hash,rol,tc_no) VALUES ('Musteri T','musteri-t@example.com','x','musteri','11111111111') RETURNING id");
  const env = { ...process.env, DATABASE_URL: DB, JWT_SECRET: JWT, PORT: '3997' };
  const srv = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch('http://127.0.0.1:3997/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
    const t = jwt.sign({ id: rows[0].id, rol: 'musteri' }, JWT);
    const r = await fetch('http://127.0.0.1:3997/api/dosyalar', { headers: { Authorization: `Bearer ${t}` } });
    assert.equal(r.status, 200, `${r.status} ${await r.text()}`.slice(0, 200));
  } finally {
    srv.kill(); await c.query("DELETE FROM kullanicilar WHERE email='musteri-t@example.com'"); await c.end();
  }
});
