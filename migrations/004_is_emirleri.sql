-- Faz 2 + 3: iş emirleri, bölüm görevleri ve iş emri başına onay turu.
-- Bir dosyada bir ana iş emri (no=1) ve ek hasar iş emirleri (no=2..) olur.
-- Onay artık iş emri başına; eski islem_onay tablosu yalnız geçmiş için kalır.
CREATE TABLE IF NOT EXISTS is_emirleri (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id       UUID NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  no             SMALLINT NOT NULL,
  tur            VARCHAR(20) NOT NULL DEFAULT 'ana' CHECK (tur IN ('ana','ek_hasar')),
  aciklama       TEXT,
  durum          VARCHAR(20) NOT NULL DEFAULT 'acik' CHECK (durum IN ('acik','iptal')),
  onay_durumu    VARCHAR(20) NOT NULL DEFAULT 'taslak'
                   CHECK (onay_durumu IN ('taslak','bekliyor','onaylandi','reddedildi')),
  gonderen_id    UUID REFERENCES kullanicilar(id),
  gonderim_trh   TIMESTAMPTZ,
  karar_veren_id UUID REFERENCES kullanicilar(id),
  karar_trh      TIMESTAMPTZ,
  karar_notu     TEXT,
  eksper_ad      VARCHAR(150),   -- sigorta kalemlerini onaylayan eksper
  musteri_ad     VARCHAR(150),   -- sigorta harici kalemleri onaylayan müşteri
  olusturan_id   UUID REFERENCES kullanicilar(id),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (dosya_id, no)
);
CREATE INDEX IF NOT EXISTS idx_is_emirleri_onay ON is_emirleri(onay_durumu);
CREATE OR REPLACE TRIGGER trg_is_emirleri_updated BEFORE UPDATE ON is_emirleri
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Bölüm görevleri: iş emrinin bir bölümdeki parçası. Adımları gorev_adimlari'nda.
CREATE TABLE IF NOT EXISTS bolum_gorevleri (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  is_emri_id     UUID NOT NULL REFERENCES is_emirleri(id) ON DELETE CASCADE,
  dosya_id       UUID NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  bolum          VARCHAR(20) NOT NULL
                   CHECK (bolum IN ('sokum','kaporta','boya','mekanik','elektrik','montaj','dis_hizmet')),
  aciklama       TEXT,
  sorumlu_usta   VARCHAR(100),
  durum          VARCHAR(20) NOT NULL DEFAULT 'bekliyor'
                   CHECK (durum IN ('bekliyor','devam','beklemede','tamam')),
  bekleme_nedeni TEXT,
  baslama_trh    TIMESTAMPTZ,
  bitis_trh      TIMESTAMPTZ,
  bitiren_usta   VARCHAR(100),
  olusturan_id   UUID REFERENCES kullanicilar(id),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bolum_gorevleri_is_emri ON bolum_gorevleri(is_emri_id);
CREATE INDEX IF NOT EXISTS idx_bolum_gorevleri_acik ON bolum_gorevleri(dosya_id) WHERE durum <> 'tamam';
CREATE OR REPLACE TRIGGER trg_bolum_gorevleri_updated BEFORE UPDATE ON bolum_gorevleri
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS gorev_adimlari (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gorev_id        UUID NOT NULL REFERENCES bolum_gorevleri(id) ON DELETE CASCADE,
  sira            SMALLINT NOT NULL,
  ad              VARCHAR(100) NOT NULL,
  durum           VARCHAR(20) NOT NULL DEFAULT 'bekliyor' CHECK (durum IN ('bekliyor','tamam')),
  tamamlanma_trh  TIMESTAMPTZ,
  tamamlayan_usta VARCHAR(100),   -- işi bildiren usta (servis tek hesapla girer)
  tamamlayan_id   UUID REFERENCES kullanicilar(id),
  UNIQUE (gorev_id, sira)
);

-- Kalemler ve dış faturalar iş emrine bağlanır; kalem bazında onaylayan kaydedilir
ALTER TABLE islemler ADD COLUMN IF NOT EXISTS is_emri_id UUID REFERENCES is_emirleri(id) ON DELETE CASCADE;
ALTER TABLE islemler ADD COLUMN IF NOT EXISTS onaylayan_tip VARCHAR(20);
ALTER TABLE islemler ADD COLUMN IF NOT EXISTS onaylayan_ad VARCHAR(150);
ALTER TABLE islemler ADD COLUMN IF NOT EXISTS karar_trh TIMESTAMPTZ;
ALTER TABLE dis_faturalar ADD COLUMN IF NOT EXISTS is_emri_id UUID REFERENCES is_emirleri(id) ON DELETE CASCADE;

-- Mevcut dosyalar için ana iş emri; onay durumu eski islem_onay'dan taşınır
INSERT INTO is_emirleri (dosya_id, no, tur, onay_durumu, gonderen_id, gonderim_trh,
                         karar_veren_id, karar_trh, karar_notu)
SELECT d.id, 1, 'ana', COALESCE(io.durum, 'taslak'), io.gonderen_id, io.gonderim_trh,
       io.karar_veren, io.karar_trh, io.admin_not
FROM dosyalar d
LEFT JOIN islem_onay io ON io.dosya_id = d.id
WHERE NOT EXISTS (SELECT 1 FROM is_emirleri ie WHERE ie.dosya_id = d.id);

UPDATE islemler i SET is_emri_id = ie.id
FROM is_emirleri ie WHERE ie.dosya_id = i.dosya_id AND ie.no = 1 AND i.is_emri_id IS NULL;
UPDATE dis_faturalar f SET is_emri_id = ie.id
FROM is_emirleri ie WHERE ie.dosya_id = f.dosya_id AND ie.no = 1 AND f.is_emri_id IS NULL;

ALTER TABLE islemler ALTER COLUMN is_emri_id SET NOT NULL;
ALTER TABLE dis_faturalar ALTER COLUMN is_emri_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_islemler_is_emri ON islemler(is_emri_id);
