-- Araç kabul ve teslim tutanakları. Dosya başına en çok bir kabul, bir teslim.
-- Kabul teslimden önce düzeltilebilir; teslim kaydedilince ikisi de kilitlenir.
CREATE TABLE IF NOT EXISTS arac_tutanaklari (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id      UUID NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  tip           VARCHAR(10) NOT NULL CHECK (tip IN ('kabul','teslim')),
  km            INTEGER NOT NULL CHECK (km >= 0),
  yakit_yuzde   SMALLINT CHECK (yakit_yuzde BETWEEN 0 AND 100),
  aksesuarlar   JSONB NOT NULL DEFAULT '{}',   -- { "Ruhsat": true, ... }
  kontrol       JSONB NOT NULL DEFAULT '{}',   -- teslim: { "madde": "tamam" | "yok" }
  aciklama      TEXT,                          -- kabul: mevcut hasar notu; teslim: eksik/ek not
  musteri_ad    VARCHAR(100) NOT NULL,         -- kabul: aracı getiren; teslim: aracı teslim alan
  personel_ad   VARCHAR(100) NOT NULL,         -- servis tarafında imzalayan
  olusturan_id  UUID REFERENCES kullanicilar(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (dosya_id, tip)
);
