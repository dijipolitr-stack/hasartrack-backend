-- Servis deposu ve parça siparişleri. Her kayıt bir servise aittir; servis yazar, admin okur.
-- Stok miktarı tutulmaz, stok_hareketleri'nden hesaplanır (giriş +, çıkış -, düzeltme ±).
CREATE TABLE IF NOT EXISTS tedarikciler (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  servis_id   UUID NOT NULL REFERENCES servisler(id) ON DELETE CASCADE,
  ad          VARCHAR(150) NOT NULL,
  telefon     VARCHAR(30),
  email       VARCHAR(150),
  vkn         VARCHAR(11),
  notlar      TEXT,
  aktif       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tedarikciler_servis ON tedarikciler(servis_id);

CREATE TABLE IF NOT EXISTS parcalar (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  servis_id   UUID NOT NULL REFERENCES servisler(id) ON DELETE CASCADE,
  ad          VARCHAR(200) NOT NULL,
  oem_no      VARCHAR(60),
  kategori    VARCHAR(50),
  birim       VARCHAR(20) NOT NULL DEFAULT 'Adet',
  min_stok    NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (min_stok >= 0),
  aktif       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parcalar_servis ON parcalar(servis_id);

CREATE TABLE IF NOT EXISTS parca_siparisleri (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  servis_id      UUID NOT NULL REFERENCES servisler(id) ON DELETE CASCADE,
  tedarikci_id   UUID REFERENCES tedarikciler(id) ON DELETE SET NULL,
  dosya_id       UUID REFERENCES dosyalar(id) ON DELETE SET NULL,   -- belirli bir araç için ise
  siparis_no     VARCHAR(50),
  siparis_trh    DATE NOT NULL DEFAULT CURRENT_DATE,
  tahmini_gelis  DATE,
  durum          VARCHAR(20) NOT NULL DEFAULT 'siparis'
                   CHECK (durum IN ('siparis','yolda','kismi','geldi','iptal')),
  gelis_trh      DATE,
  fatura_no      VARCHAR(50),
  notlar         TEXT,
  olusturan_id   UUID REFERENCES kullanicilar(id),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_siparisler_servis ON parca_siparisleri(servis_id, durum);
CREATE INDEX IF NOT EXISTS idx_siparisler_dosya ON parca_siparisleri(dosya_id);
CREATE OR REPLACE TRIGGER trg_parca_siparisleri_updated BEFORE UPDATE ON parca_siparisleri
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS siparis_kalemleri (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  siparis_id   UUID NOT NULL REFERENCES parca_siparisleri(id) ON DELETE CASCADE,
  parca_id     UUID NOT NULL REFERENCES parcalar(id),
  adet         NUMERIC(10,2) NOT NULL CHECK (adet > 0),
  birim_fiyat  NUMERIC(12,2) CHECK (birim_fiyat >= 0),          -- KDV hariç
  gelen_adet   NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (gelen_adet >= 0)
);
CREATE INDEX IF NOT EXISTS idx_siparis_kalemleri ON siparis_kalemleri(siparis_id);

CREATE TABLE IF NOT EXISTS stok_hareketleri (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  servis_id      UUID NOT NULL REFERENCES servisler(id) ON DELETE CASCADE,
  parca_id       UUID NOT NULL REFERENCES parcalar(id) ON DELETE CASCADE,
  tip            VARCHAR(20) NOT NULL CHECK (tip IN ('giris','cikis','duzeltme')),
  adet           NUMERIC(10,2) NOT NULL CHECK (adet <> 0),       -- düzeltmede eksi olabilir
  birim_maliyet  NUMERIC(12,2) CHECK (birim_maliyet >= 0),       -- girişte, KDV hariç
  siparis_id     UUID REFERENCES parca_siparisleri(id) ON DELETE SET NULL,
  dosya_id       UUID REFERENCES dosyalar(id) ON DELETE SET NULL, -- çıkışta: takıldığı araç
  aciklama       TEXT,
  kullanici_id   UUID REFERENCES kullanicilar(id),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  CHECK (tip = 'duzeltme' OR adet > 0)
);
CREATE INDEX IF NOT EXISTS idx_hareketler_parca ON stok_hareketleri(parca_id);
CREATE INDEX IF NOT EXISTS idx_hareketler_dosya ON stok_hareketleri(dosya_id);
CREATE INDEX IF NOT EXISTS idx_hareketler_servis ON stok_hareketleri(servis_id, created_at DESC);
