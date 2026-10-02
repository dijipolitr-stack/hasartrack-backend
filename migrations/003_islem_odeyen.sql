-- İş kalemini kim ödeyecek: sigorta, müşteri (sigorta harici iş), acente veya diğer.
ALTER TABLE islemler ADD COLUMN IF NOT EXISTS odeyen VARCHAR(20) NOT NULL DEFAULT 'sigorta'
  CHECK (odeyen IN ('sigorta','musteri','acente','diger'));
