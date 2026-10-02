-- Dış hizmet faturaları: servisin dışarıdan aldığı hizmetlerin (cam, döşeme, rot-balans vb.)
-- faturaları. Servis faturasından ayrıdır; dosyaya (Faz 2'de iş emrine) ve isteğe bağlı bir
-- iş kalemine bağlanır. Tutar KDV hariç. Idempotent: her migrate'te güvenle çalışır.
CREATE TABLE IF NOT EXISTS dis_faturalar (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dosya_id    UUID NOT NULL REFERENCES dosyalar(id) ON DELETE CASCADE,
  islem_id    UUID REFERENCES islemler(id) ON DELETE SET NULL,
  firma       VARCHAR(150) NOT NULL,
  firma_vkn   VARCHAR(11),
  hizmet      VARCHAR(200) NOT NULL,
  fatura_no   VARCHAR(50),
  fatura_trh  DATE,
  tutar       NUMERIC(12,2) NOT NULL CHECK (tutar >= 0),
  kdv_orani   NUMERIC(5,2) NOT NULL DEFAULT 20 CHECK (kdv_orani IN (0,1,10,20)),
  kdv_tutar   NUMERIC(12,2) GENERATED ALWAYS AS (ROUND(tutar * kdv_orani / 100, 2)) STORED,
  toplam      NUMERIC(12,2) GENERATED ALWAYS AS (tutar + ROUND(tutar * kdv_orani / 100, 2)) STORED,
  yansitildi  BOOLEAN NOT NULL DEFAULT FALSE,   -- servis faturasına dahil edildi mi
  notlar      TEXT,
  ekleyen_id  UUID REFERENCES kullanicilar(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dis_faturalar_dosya ON dis_faturalar(dosya_id);
CREATE OR REPLACE TRIGGER trg_dis_faturalar_updated BEFORE UPDATE ON dis_faturalar
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
