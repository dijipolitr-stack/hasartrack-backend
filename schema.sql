-- ============================================================
-- HasarTrack — PostgreSQL Şema
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── KULLANICILAR ─────────────────────────────────────────────
CREATE TABLE servisler (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ad          VARCHAR(200) NOT NULL,
  adres       TEXT,
  telefon     VARCHAR(20),
  email       VARCHAR(100),
  aktif       BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE kullanicilar (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ad_soyad     VARCHAR(100),
  email        VARCHAR(150) UNIQUE NOT NULL,
  sifre_hash   VARCHAR(255) NOT NULL,
  rol          VARCHAR(20) NOT NULL CHECK (rol IN ('admin','servis','acente','musteri')),
  servis_id    UUID REFERENCES servisler(id) ON DELETE SET NULL,
  -- müşteri için
  tc_no        VARCHAR(20),
  telefon      VARCHAR(20),
  aktif        BOOLEAN DEFAULT TRUE,
  son_giris    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_kullanicilar_rol ON kullanicilar(rol);

-- ── HASAR DOSYALARI ──────────────────────────────────────────
CREATE TABLE dosyalar (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_no       VARCHAR(30) UNIQUE NOT NULL,        -- HSR-2024-0847
  durum          VARCHAR(30) DEFAULT 'Aktif'
                   CHECK (durum IN ('Aktif','Tamamlandı','İptal','Askıda')),
  oncelik        VARCHAR(20) DEFAULT 'Normal'
                   CHECK (oncelik IN ('Normal','Yüksek','Acil')),
  sigorta_bransi VARCHAR(50),
  muallak_hasar  NUMERIC(12,2),
  atanan_servis  UUID REFERENCES servisler(id) ON DELETE SET NULL,
  atama_notu     TEXT,
  olusturan_id   UUID REFERENCES kullanicilar(id),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_dosyalar_durum    ON dosyalar(durum);
CREATE INDEX idx_dosyalar_servis   ON dosyalar(atanan_servis);
CREATE INDEX idx_dosyalar_created  ON dosyalar(created_at DESC);

-- Dosya no otomatik üretme
CREATE SEQUENCE dosya_no_seq START 1;
CREATE OR REPLACE FUNCTION next_dosya_no()
RETURNS TEXT AS $$
BEGIN
  RETURN 'HSR-' || TO_CHAR(NOW(), 'YYYY') || '-' ||
         LPAD(nextval('dosya_no_seq')::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

-- ── ARAÇ BİLGİLERİ ───────────────────────────────────────────
CREATE TABLE arac (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id      UUID UNIQUE NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  plaka         VARCHAR(20),
  marka         VARCHAR(50),
  model         VARCHAR(100),
  yil           SMALLINT,
  renk          VARCHAR(50),
  sase_no       VARCHAR(50),
  motor_no      VARCHAR(50),
  ruhsat_seri   VARCHAR(30),
  kaza_tarihi   DATE,
  kaza_aciklama TEXT,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── ARAÇ SAHİBİ ──────────────────────────────────────────────
CREATE TABLE sahip (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id  UUID UNIQUE NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  ad_soyad  VARCHAR(100),
  tc_vergi  VARCHAR(20),
  telefon   VARCHAR(20) NOT NULL,
  email     VARCHAR(150),
  adres     TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── SİGORTA ŞİRKETİ ──────────────────────────────────────────
CREATE TABLE sigorta (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id      UUID UNIQUE NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  sirket_ad     VARCHAR(100),
  hasar_no      VARCHAR(50),
  temsilci_ad   VARCHAR(100),
  temsilci_tel  VARCHAR(20),
  temsilci_mail VARCHAR(150),
  police_no     VARCHAR(50),
  teminat_turu  VARCHAR(50),
  muafiyet      NUMERIC(10,2),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── EKSPER ───────────────────────────────────────────────────
CREATE TABLE eksper (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id        UUID UNIQUE NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  ad_soyad        VARCHAR(100),
  firma           VARCHAR(150),
  lisans_no       VARCHAR(30),
  telefon         VARCHAR(20),
  email           VARCHAR(150),
  inceleme_tarihi DATE,
  tahmini_hasar   NUMERIC(12,2),
  onay_durumu     VARCHAR(30) DEFAULT 'Beklemede',
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── ONARIM MERKEZİ ───────────────────────────────────────────
CREATE TABLE onarim_merkezi (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id        UUID UNIQUE NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  ad              VARCHAR(200),
  yetkili_kisi    VARCHAR(100),
  telefon         VARCHAR(20),
  email           VARCHAR(150),
  adres           TEXT,
  arac_giris_trh  DATE,
  tahmini_teslimat DATE,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── ONARIM ADIMLARI ──────────────────────────────────────────
CREATE TABLE onarim_adimlari (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id      UUID NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  sira          SMALLINT NOT NULL,
  ad            VARCHAR(100) NOT NULL,
  durum         VARCHAR(20) DEFAULT 'bekliyor'
                  CHECK (durum IN ('bekliyor','aktif','tamamlandi')),
  tamamlanma_trh TIMESTAMPTZ,
  not_metni     TEXT,
  oto_sms       BOOLEAN DEFAULT FALSE,
  tamamlayan_id UUID REFERENCES kullanicilar(id),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(dosya_id, sira)
);
CREATE INDEX idx_adimlar_dosya ON onarim_adimlari(dosya_id, sira);

-- ── İŞLEM KALEMLERİ ──────────────────────────────────────────
CREATE TABLE islemler (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id     UUID NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  kategori     VARCHAR(50) NOT NULL,
  aciklama     TEXT NOT NULL,
  birim        VARCHAR(30) DEFAULT 'Adet',
  miktar       NUMERIC(10,2) DEFAULT 1,
  birim_fiyat  NUMERIC(12,2) NOT NULL,
  durum        VARCHAR(20) DEFAULT 'bekliyor'
                 CHECK (durum IN ('bekliyor','onaylandi','reddedildi')),
  giris_yapan  UUID REFERENCES kullanicilar(id),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_islemler_dosya ON islemler(dosya_id);

-- Onay talebi
CREATE TABLE islem_onay (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id     UUID NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  durum        VARCHAR(20) DEFAULT 'taslak'
                 CHECK (durum IN ('taslak','bekliyor','onaylandi','reddedildi')),
  gonderen_id  UUID REFERENCES kullanicilar(id),
  admin_not    TEXT,
  gonderim_trh TIMESTAMPTZ,
  karar_trh    TIMESTAMPTZ,
  karar_veren  UUID REFERENCES kullanicilar(id),
  UNIQUE(dosya_id)
);

-- ── MUHASEBE ─────────────────────────────────────────────────
CREATE TABLE muhasebe (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id            UUID UNIQUE NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  servis_fatura_no    VARCHAR(50),
  servis_fatura_trh   DATE,
  servis_fatura_tutar NUMERIC(12,2),
  onaylanan_tutar     NUMERIC(12,2),
  sigorta_odeme_tutar NUMERIC(12,2),
  sigorta_odeme_trh   DATE,
  notlar              TEXT,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── FOTOĞRAFLAR ───────────────────────────────────────────────
CREATE TABLE fotograflar (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id    UUID NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,         -- S3 / storage URL
  dosya_adi   VARCHAR(255),
  etiket      VARCHAR(100),
  kategori    VARCHAR(30) DEFAULT 'kaza',
  boyut_byte  INTEGER,
  yukleyen_id UUID REFERENCES kullanicilar(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_fotograflar_dosya ON fotograflar(dosya_id);

-- ── EVRAK ────────────────────────────────────────────────────
CREATE TABLE evrak (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id    UUID NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  ad          VARCHAR(200) NOT NULL,
  kaynak      VARCHAR(50),
  durum       VARCHAR(20) DEFAULT 'bekliyor'
                CHECK (durum IN ('bekliyor','tamam','eksik')),
  url         TEXT,
  yukleyen_id UUID REFERENCES kullanicilar(id),
  teslim_trh  TIMESTAMPTZ,
  uyari_not   TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_evrak_dosya ON evrak(dosya_id);

-- ── MESAJLAR ─────────────────────────────────────────────────
CREATE TABLE mesajlar (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id       UUID NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  gonderen_id    UUID REFERENCES kullanicilar(id),
  gonderen_rol   VARCHAR(20),
  hedef_rol      VARCHAR(20),
  mesaj          TEXT NOT NULL,
  okundu         BOOLEAN DEFAULT FALSE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_mesajlar_dosya ON mesajlar(dosya_id, created_at);

-- ── SMS LOG ──────────────────────────────────────────────────
CREATE TABLE sms_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id    UUID REFERENCES dosyalar(id) ON DELETE SET NULL,
  alici_tel   VARCHAR(20) NOT NULL,
  mesaj       TEXT NOT NULL,
  adim_adi    VARCHAR(100),
  durum       VARCHAR(20) DEFAULT 'bekliyor',
  oto         BOOLEAN DEFAULT FALSE,
  gonderim_trh TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── AUDİT LOG ────────────────────────────────────────────────
CREATE TABLE audit_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id    UUID REFERENCES dosyalar(id),
  kullanici_id UUID REFERENCES kullanicilar(id),
  eylem       VARCHAR(100) NOT NULL,   -- 'DOSYA_OLUSTUR', 'ADIM_TAMAMLA' ...
  detay       JSONB,
  ip_adresi   INET,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_dosya    ON audit_log(dosya_id, created_at DESC);
CREATE INDEX idx_audit_kullanici ON audit_log(kullanici_id, created_at DESC);

-- ── UPDATED_AT TETİKLEYİCİLER ────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['dosyalar','arac','sahip','sigorta','eksper',
    'onarim_merkezi','muhasebe','islemler'])
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %s
       FOR EACH ROW EXECUTE FUNCTION update_updated_at()', t, t);
  END LOOP;
END $$;

-- ── ÖRNEK VERİ ────────────────────────────────────────────────
-- Servisler
INSERT INTO servisler (id, ad, adres, telefon) VALUES
  ('11111111-0000-0000-0000-000000000001', 'Bosch Car Service – Kadıköy', 'Moda Cad. No:45, Kadıköy', '0216 450 30 20'),
  ('11111111-0000-0000-0000-000000000002', 'Yetkili Oto Servis – Üsküdar', 'Bağlarbaşı Mah. No:12, Üsküdar', '0216 320 11 00'),
  ('11111111-0000-0000-0000-000000000003', 'Pro Kaporta & Boya – Maltepe', 'Cevizli Mah. No:88, Maltepe', '0216 455 77 88');

-- Admin kullanıcı (şifre: admin123)
INSERT INTO kullanicilar (ad_soyad, email, sifre_hash, rol) VALUES
  ('Hasar Admin', 'admin@hasartrack.com',
   '$2b$12$placeholder_hash_replace_with_real', 'admin');
