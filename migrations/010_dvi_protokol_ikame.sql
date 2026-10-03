-- Paket 3: hasar haritası (DVI), sigorta protokolleri, ikame araç filosu.

-- Hasar noktası: aracın bir bölgesindeki hasar, şiddeti ve onarım kararı
CREATE TABLE IF NOT EXISTS hasar_noktalari (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id      UUID NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  bolge         VARCHAR(30) NOT NULL CHECK (bolge IN (
                  'on_tampon','kaput','on_cam','tavan','arka_cam','bagaj','arka_tampon',
                  'sol_on_camurluk','sol_on_kapi','sol_arka_kapi','sol_arka_camurluk','sol_marspiyel','sol_ayna',
                  'sag_on_camurluk','sag_on_kapi','sag_arka_kapi','sag_arka_camurluk','sag_marspiyel','sag_ayna',
                  'jant_lastik','alt_takim','diger')),
  hasar_tipi    VARCHAR(20) NOT NULL CHECK (hasar_tipi IN ('cizik','gocuk','kirik','catlak','boya','korozyon','diger')),
  siddet        VARCHAR(10) NOT NULL DEFAULT 'orta' CHECK (siddet IN ('hafif','orta','agir')),
  karar         VARCHAR(20) NOT NULL DEFAULT 'onarim' CHECK (karar IN ('onarim','degisim','boya','kontrol','islem_yok')),
  notlar        TEXT,
  olusturan_id  UUID REFERENCES kullanicilar(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hasar_noktalari_dosya ON hasar_noktalari(dosya_id);

-- Sigorta protokolü: şirkete göre işçilik saat ücreti, iskonto oranları, muafiyet
CREATE TABLE IF NOT EXISTS sigorta_protokolleri (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sirket_ad              VARCHAR(100) NOT NULL,
  baslangic              DATE NOT NULL DEFAULT CURRENT_DATE,
  bitis                  DATE,
  iscilik_saat_ucreti    NUMERIC(10,2) CHECK (iscilik_saat_ucreti >= 0),
  parca_iskonto_yuzde    NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (parca_iskonto_yuzde BETWEEN 0 AND 100),
  malzeme_iskonto_yuzde  NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (malzeme_iskonto_yuzde BETWEEN 0 AND 100),
  muafiyet               NUMERIC(10,2) CHECK (muafiyet >= 0),
  notlar                 TEXT,
  aktif                  BOOLEAN NOT NULL DEFAULT TRUE,
  olusturan_id           UUID REFERENCES kullanicilar(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  CHECK (bitis IS NULL OR bitis >= baslangic)
);
CREATE INDEX IF NOT EXISTS idx_sigorta_protokolleri_sirket ON sigorta_protokolleri(lower(sirket_ad));

-- İkame araç filosu ve kullanım kayıtları (bir araç aynı anda tek açık kullanımda)
CREATE TABLE IF NOT EXISTS ikame_araclar (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  plaka        VARCHAR(20) NOT NULL UNIQUE,
  marka        VARCHAR(50),
  model        VARCHAR(100),
  yil          SMALLINT,
  km           INTEGER NOT NULL DEFAULT 0 CHECK (km >= 0),
  yakit_yuzde  SMALLINT CHECK (yakit_yuzde BETWEEN 0 AND 100),
  durum        VARCHAR(15) NOT NULL DEFAULT 'musait' CHECK (durum IN ('musait','verildi','bakimda','pasif')),
  notlar       TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS ikame_kullanimlari (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  arac_id        UUID NOT NULL REFERENCES ikame_araclar(id) ON DELETE CASCADE,
  dosya_id       UUID REFERENCES dosyalar(id) ON DELETE SET NULL,
  surucu_ad      VARCHAR(100) NOT NULL,
  surucu_tel     VARCHAR(20),
  verilis_trh    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verilis_km     INTEGER NOT NULL CHECK (verilis_km >= 0),
  verilis_yakit  SMALLINT CHECK (verilis_yakit BETWEEN 0 AND 100),
  iade_trh       TIMESTAMPTZ,
  iade_km        INTEGER,
  iade_yakit     SMALLINT CHECK (iade_yakit BETWEEN 0 AND 100),
  hgs_tutar      NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (hgs_tutar >= 0),
  ceza_tutar     NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (ceza_tutar >= 0),
  hasar_notu     TEXT,
  olusturan_id   UUID REFERENCES kullanicilar(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  CHECK (iade_km IS NULL OR iade_km >= verilis_km)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ikame_acik_kullanim ON ikame_kullanimlari(arac_id) WHERE iade_trh IS NULL;
CREATE INDEX IF NOT EXISTS idx_ikame_kullanim_dosya ON ikame_kullanimlari(dosya_id);
