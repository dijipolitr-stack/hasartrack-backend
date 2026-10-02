-- audit_log.dosya_id: dosya silinince kayıt kalsın, bağ NULL olsun (eskiden silmeyi engelliyordu).
DO $$
DECLARE ad TEXT;
BEGIN
  SELECT c.conname INTO ad FROM pg_constraint c
  WHERE c.conrelid = 'public.audit_log'::regclass AND c.contype = 'f'
    AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.audit_log'::regclass AND attname = 'dosya_id')]
    AND c.confdeltype <> 'n';
  IF ad IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.audit_log DROP CONSTRAINT %I', ad);
    ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_dosya_id_fkey
      FOREIGN KEY (dosya_id) REFERENCES public.dosyalar(id) ON DELETE SET NULL;
  END IF;
END $$;
