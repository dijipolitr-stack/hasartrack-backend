# HasarTrack — Kurulum ve Deployment Rehberi

## Mimari

```
Tarayıcı (index.html, GitHub Pages)
        │ HTTPS
        ▼
Vercel: Express serverless (api/index.js)  ──▶  Supabase Postgres (pooler)
```

Şema ve admin seed deployda değil, yerelden bir kez Node betiğiyle kurulur (psql gerekmez).

---

## 1. Yerel geliştirme

```bash
cd backend
npm install
cp .env.example .env        # değerleri doldur (JWT_SECRET en az 32 karakter)
docker-compose up -d        # PostgreSQL + API (node:22-slim) + pgAdmin
npm run db:migrate          # şema yoksa kurar, RLS'i açar; tekrar çalıştırmak güvenli
ADMIN_PASSWORD="<en-az-12-karakter>" npm run db:seed
curl http://localhost:3001/health
```

- Docker'sız: kendi PostgreSQL'ine `DATABASE_URL` ver, `npm start`.
- `ADMIN_PASSWORD` zorunludur (en az 12 karakter); yoksa seed hata verip çıkar. Varsayılan şifre yoktur.
- `vercel dev` ile serverless biçimi yerelde denenebilir.
- pgAdmin: http://localhost:5050 (giriş bilgisi `docker-compose.yml` içinde, yalnız yerel kullanım).

---

## 2. Canlıya alma: Vercel + Supabase

1. Supabase: yeni proje (bölge eu-central). Ücretsiz katmanda en fazla 2 aktif proje vardır. Project Settings > Data API bölümünden Data API'yi kapat (tek seçenek; `next_dosya_no()` gibi fonksiyonlar açık kalırsa rpc ile çağrılabilir).
2. Yerelden, session pooler URL (5432) ile: `npm run db:migrate`, sonra `ADMIN_PASSWORD` (zorunlu) oturum env'inde `npm run db:seed`.
3. `backend/` içinde `vercel link`; değişkenleri `vercel env add` ile ekle (değer dosyaya yazılmaz):

| Değişken | Açıklama |
|---|---|
| `DATABASE_URL` | Supabase transaction pooler (6543) |
| `DATABASE_SSL` | `true` |
| `DB_POOL_MAX` | `3` |
| `JWT_SECRET` | En az 32, önerilen 64+ rastgele karakter. Yoksa istekler 500 döner |
| `JWT_EXPIRES` | `8h` |
| `NODE_ENV` | `production` |
| `FRONTEND_URL` | `https://dijipolitr-stack.github.io` (virgülle birden fazla; yol ve sonda `/` yok) |

`ADMIN_*` Vercel'e girilmez; yalnız yerel seed için.

4. `vercel --prod`; `GET <adres>/health` 200 dönmeli.
5. `frontend/index.html` içindeki `API_URL_CANLI` sabitine `https://<adres>/api` yaz ve ön yüzü yayınla.
6. Admin girişi yap, şifreyi `POST /api/auth/sifre-degistir` ile değiştir.

### Sınırlar
- `db:migrate` artımlı değildir; şema değişirse ayrı migration gerekir.
- Rate limit bellek içidir, her serverless örneği ayrı sayar; giriş kaba kuvvet koruması zayıftır.
- Supabase ücretsiz proje 7 gün hareketsizlikte duraklar; panelden elle açılır. Otomatik yedek sınırlıdır.
- Vercel Hobby ticari kullanıma kapalıdır; ticari kullanımda Pro gerekir.

---

## 3. Güvenlik kontrol listesi

- [ ] `JWT_SECRET` rastgele ve uzun
- [ ] Admin şifresi ilk girişten sonra değiştirildi
- [ ] `FRONTEND_URL` yalnız gerçek ön yüz origin'i
- [ ] `.env` repoya girmedi
- [ ] Düzenli yedek: `pg_dump "$DATABASE_URL" > backup_$(date +%Y%m%d).sql`
