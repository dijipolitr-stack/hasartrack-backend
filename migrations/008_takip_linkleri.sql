-- Müşteri takip linkleri. Link sahibi giriş yapmadan dosyanın onarım durumunu görür.
-- Token düz saklanmaz; yalnız SHA-256 özeti tutulur. Link süreli ve iptal edilebilir.
CREATE TABLE IF NOT EXISTS takip_linkleri (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id       UUID NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  token_ozet     CHAR(64) NOT NULL UNIQUE,
  son_gecerlilik TIMESTAMPTZ NOT NULL,
  iptal_trh      TIMESTAMPTZ,
  olusturan_id   UUID REFERENCES kullanicilar(id) ON DELETE SET NULL,
  son_erisim     TIMESTAMPTZ,
  erisim_sayisi  INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_takip_linkleri_dosya ON takip_linkleri(dosya_id);
