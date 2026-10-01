// Girdi doğrulama yardımcıları (UUID, alan tipleri, HTTP hatası)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const httpHata = (status, mesaj) => {
  const err = new Error(mesaj);
  err.status = status;
  return err;
};

// router.param için: geçersiz UUID SQL'e ulaşmadan 400 olur
const uuidParam = (ad) => (req, res, next, deger) => {
  if (!UUID_RE.test(deger)) return next(httpHata(400, 'Geçersiz kimlik'));
  next();
};

const TARIH_RE = /^\d{4}-\d{2}-\d{2}$/;

// tip: { t: 'metin'|'sayi'|'tamsayi'|'tarih'|'enum', min, max, secenekler, bos }
// '' ve null -> null (bos:false ise 400). Geçersiz değer -> 400.
const alanDegeri = (tip, deger, ad = 'Alan') => {
  if (deger === '' || deger === null || deger === undefined) {
    if (tip.bos === false) throw httpHata(400, `${ad} boş olamaz`);
    return null;
  }
  switch (tip.t) {
    case 'metin': {
      if (typeof deger !== 'string' && typeof deger !== 'number')
        throw httpHata(400, `${ad} geçersiz`);
      return String(deger);
    }
    case 'sayi': {
      const n = typeof deger === 'number' ? deger : Number(String(deger).trim());
      if (!Number.isFinite(n) || n < 0 || n >= 1e10) throw httpHata(400, `${ad} geçerli bir sayı olmalı`);
      return n;
    }
    case 'tamsayi': {
      const n = typeof deger === 'number' ? deger : Number(String(deger).trim());
      if (!Number.isInteger(n) || n < (tip.min ?? 0) || n > (tip.max ?? 2147483647))
        throw httpHata(400, `${ad} geçerli bir tam sayı olmalı`);
      return n;
    }
    case 'tarih': {
      if (typeof deger !== 'string' || !TARIH_RE.test(deger) || Number.isNaN(Date.parse(deger)))
        throw httpHata(400, `${ad} YYYY-AA-GG biçiminde olmalı`);
      return deger;
    }
    case 'enum': {
      if (!tip.secenekler.includes(deger)) throw httpHata(400, `${ad} geçersiz değer`);
      return deger;
    }
    default:
      throw httpHata(400, `${ad} geçersiz`);
  }
};

module.exports = { UUID_RE, uuidParam, httpHata, alanDegeri };
