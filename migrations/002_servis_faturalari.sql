-- Servis faturaları: servisin kestiği faturalar. Bir dosyada birden çok olabilir; alıcı sigorta,
-- müşteri, acente veya başka bir kurum. Tutar KDV hariç. Şimdilik yalnız kayıt (e-fatura yok).
CREATE TABLE IF NOT EXISTS servis_faturalari (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id     UUID NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  alici_tipi   VARCHAR(20) NOT NULL CHECK (alici_tipi IN ('sigorta','musteri','acente','diger')),
  alici_ad     VARCHAR(200) NOT NULL,
  alici_vkn    VARCHAR(11),                       -- VKN (10) veya TCKN (11)
  fatura_no    VARCHAR(50),
  fatura_trh   DATE,
  tutar        NUMERIC(12,2) NOT NULL CHECK (tutar >= 0),
  kdv_orani    NUMERIC(5,2) NOT NULL DEFAULT 20 CHECK (kdv_orani IN (0,1,10,20)),
  kdv_tutar    NUMERIC(12,2) GENERATED ALWAYS AS (ROUND(tutar * kdv_orani / 100, 2)) STORED,
  toplam       NUMERIC(12,2) GENERATED ALWAYS AS (tutar + ROUND(tutar * kdv_orani / 100, 2)) STORED,
  odenen_tutar NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (odenen_tutar >= 0),
  odeme_trh    DATE,
  notlar       TEXT,
  ekleyen_id   UUID REFERENCES kullanicilar(id),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_servis_faturalari_dosya ON servis_faturalari(dosya_id);
CREATE OR REPLACE TRIGGER trg_servis_faturalari_updated BEFORE UPDATE ON servis_faturalari
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Eski tek alanlı servis faturasını (muhasebe.servis_fatura_*) taşır. Alıcı bilinmediği için
-- sigorta kabul edilir. Dosyada zaten servis faturası varsa dokunmaz.
INSERT INTO servis_faturalari (dosya_id, alici_tipi, alici_ad, fatura_no, fatura_trh, tutar, notlar)
SELECT m.dosya_id, 'sigorta', COALESCE(NULLIF(si.sirket_ad, ''), 'Sigorta'),
       m.servis_fatura_no, m.servis_fatura_trh, m.servis_fatura_tutar, 'Eski kayıttan taşındı'
FROM muhasebe m
LEFT JOIN sigorta si ON si.dosya_id = m.dosya_id
WHERE m.servis_fatura_tutar IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM servis_faturalari sf WHERE sf.dosya_id = m.dosya_id);
