-- Lastik talepleri: servis açar, admin görür ve durumunu yönetir.
CREATE TABLE IF NOT EXISTS lastik_talepleri (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  servis_id    UUID NOT NULL REFERENCES servisler(id) ON DELETE CASCADE,
  olusturan_id UUID REFERENCES kullanicilar(id) ON DELETE SET NULL,
  plaka        VARCHAR(20),
  marka        VARCHAR(50) NOT NULL,
  model        VARCHAR(100),
  ebat         VARCHAR(30) NOT NULL,
  mevsim       VARCHAR(10) NOT NULL CHECK (mevsim IN ('yaz','kis','dort')),
  adet         INTEGER NOT NULL CHECK (adet BETWEEN 1 AND 50),
  notlar       TEXT,
  durum        VARCHAR(12) NOT NULL DEFAULT 'bekliyor'
               CHECK (durum IN ('bekliyor','islemde','tamamlandi','iptal')),
  admin_notu   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lastik_talep_servis ON lastik_talepleri(servis_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lastik_talep_durum ON lastik_talepleri(durum);
ALTER TABLE lastik_talepleri ENABLE ROW LEVEL SECURITY;
