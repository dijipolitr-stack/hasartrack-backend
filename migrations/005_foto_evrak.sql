-- Faz 4: fotoğraf ve evrak yükleme. Dosyalar depoda (Supabase Storage), tabloda yalnız depo anahtarı.
-- fotograflar.url / evrak.url: depo anahtarı (örn. dosyalar/<id>/foto/<uuid>.jpg) veya tam https adresi.
ALTER TABLE fotograflar ADD COLUMN IF NOT EXISTS is_emri_id UUID REFERENCES is_emirleri(id) ON DELETE SET NULL;
ALTER TABLE fotograflar ADD COLUMN IF NOT EXISTS mime_tipi VARCHAR(50);
ALTER TABLE evrak ADD COLUMN IF NOT EXISTS dosya_adi VARCHAR(255);
ALTER TABLE evrak ADD COLUMN IF NOT EXISTS mime_tipi VARCHAR(50);
ALTER TABLE evrak ADD COLUMN IF NOT EXISTS boyut_byte INTEGER;
ALTER TABLE evrak ADD COLUMN IF NOT EXISTS sira SMALLINT;

-- Evrak listesi olmayan dosyalara varsayılan kontrol listesi
INSERT INTO evrak (dosya_id, ad, kaynak, sira)
SELECT d.id, v.ad, v.kaynak, v.sira
FROM dosyalar d
CROSS JOIN (VALUES
  (1, 'Kaza Tespit Tutanağı', 'Araç Sahibi'),
  (2, 'Ehliyet Fotokopisi', 'Araç Sahibi'),
  (3, 'Ruhsat Fotokopisi', 'Araç Sahibi'),
  (4, 'Poliçe Kopyası', 'Sigorta Şirketi'),
  (5, 'Eksper Raporu', 'Eksper'),
  (6, 'Fotoğraflı Hasar Formu', 'Servis'),
  (7, 'Maliyet Teklifi (Proforma)', 'Servis'),
  (8, 'Sigorta Onay Yazısı', 'Sigorta Şirketi'),
  (9, 'Teslim Tutanağı', 'Servis')
) AS v(sira, ad, kaynak)
WHERE NOT EXISTS (SELECT 1 FROM evrak e WHERE e.dosya_id = d.id);
