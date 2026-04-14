# HasarTrack — Kurulum ve Deployment Rehberi

## Mimari

```
┌─────────────────────────────────────────────────────────────┐
│                     KULLANICI TARAYICISI                    │
│              index.html  (GitHub Pages)                     │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS API çağrıları
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              NODE.JS / EXPRESS API SERVER                   │
│         DigitalOcean Droplet veya Railway.app               │
│                     Port: 3001                              │
└──────────┬────────────────────────┬────────────────────────┘
           │                        │
           ▼                        ▼
┌──────────────────┐   ┌────────────────────────────────────┐
│   PostgreSQL DB  │   │    AWS S3 / Cloudflare R2          │
│  (Managed DB veya│   │    Fotoğraf & Belge Depolama       │
│   Docker)        │   └────────────────────────────────────┘
└──────────────────┘
```

---

## 1. Yerel Geliştirme (Docker ile)

```bash
# Repoyu klonla
git clone https://github.com/KULLANICIADINIZ/hasartrack-backend
cd hasartrack-backend

# Bağımlılıkları yükle
npm install

# Ortam dosyasını hazırla
cp .env.example .env
# .env dosyasını düzenle (DB bağlantısı vb.)

# Docker ile başlat (PostgreSQL + API + pgAdmin)
docker-compose up -d

# API çalışıyor mu?
curl http://localhost:3001/health
# → {"status":"ok","version":"1.0.0",...}

# pgAdmin: http://localhost:5050
# Email: admin@hasartrack.com  /  Şifre: admin123
```

---

## 2. Production Deployment — Railway.app (En Kolay)

Railway.app ücretsiz $5/ay krediyle başlar, kurulum 10 dakika:

```bash
# Railway CLI kur
npm install -g @railway/cli

# Giriş yap
railway login

# Proje oluştur
railway init

# PostgreSQL ekle
railway add postgresql

# Deploy et
railway up

# Environment variables ayarla
railway variables set JWT_SECRET="$(openssl rand -hex 64)"
railway variables set NODE_ENV=production
railway variables set FRONTEND_URL=https://dijipolitr-stack.github.io
```

---

## 3. Production Deployment — DigitalOcean Droplet

### 3a. Sunucu Kurulumu
```bash
# Ubuntu 22.04 Droplet ($12/ay — 2GB RAM yeterli)
# SSH ile bağlan
ssh root@SUNUCU_IP

# Node.js 20 kur
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# PostgreSQL kur
sudo apt install postgresql postgresql-contrib -y
sudo systemctl enable postgresql

# Nginx kur (reverse proxy)
sudo apt install nginx -y
sudo systemctl enable nginx

# PM2 kur (process manager)
npm install -g pm2
```

### 3b. Veritabanı Kurulumu
```bash
sudo -u postgres psql
CREATE USER hasartrack WITH PASSWORD 'GUCLU_SIFRE_YAZIN';
CREATE DATABASE hasartrack_db OWNER hasartrack;
GRANT ALL PRIVILEGES ON DATABASE hasartrack_db TO hasartrack;
\q

# Şemayı yükle
psql postgresql://hasartrack:GUCLU_SIFRE_YAZIN@localhost/hasartrack_db -f schema.sql
```

### 3c. API Deploy
```bash
# Kodu çek
git clone https://github.com/KULLANICIADINIZ/hasartrack-backend /app
cd /app
npm install --production

# .env dosyasını oluştur
nano .env
# (tüm değerleri doldur)

# PM2 ile başlat
pm2 start src/server.js --name hasartrack-api
pm2 startup
pm2 save

# Durumu kontrol et
pm2 status
```

### 3d. Nginx Reverse Proxy
```nginx
# /etc/nginx/sites-available/hasartrack
server {
    listen 80;
    server_name api.hasartrack.com;   # Kendi domain'inizi yazın

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 50M;   # Fotoğraf yüklemeleri için
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/hasartrack /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# SSL (ücretsiz Let's Encrypt)
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d api.hasartrack.com
```

---

## 4. Frontend'i API'ye Bağlama

`index.html`'de API_URL sabitini güncelleyin:

```javascript
const API_URL = 'https://api.hasartrack.com/api';  // production
// const API_URL = 'http://localhost:3001/api';     // development
```

Örnek API çağrısı:
```javascript
// Giriş
const res = await fetch(`${API_URL}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@hasartrack.com', sifre: 'admin123' })
});
const { token, kullanici } = await res.json();
localStorage.setItem('ht_token', token);

// Dosya listesi
const dosyalar = await fetch(`${API_URL}/dosyalar`, {
  headers: { 'Authorization': `Bearer ${localStorage.getItem('ht_token')}` }
}).then(r => r.json());
```

---

## 5. Güvenlik Kontrol Listesi (Production)

- [ ] `.env` dosyasında gerçek, güçlü değerler
- [ ] `JWT_SECRET` en az 64 karakter rastgele string
- [ ] PostgreSQL şifresi güçlü, dışarıya kapalı port
- [ ] HTTPS zorunlu (Certbot ile)
- [ ] `FRONTEND_URL` sadece kendi domain'iniz
- [ ] Admin kullanıcı şifresi değiştirilmiş (schema'daki placeholder silindi)
- [ ] Fotoğraf bucket'ı public değil, signed URL kullanılıyor
- [ ] Rate limiting aktif
- [ ] Audit log aktif — kim ne yaptı takip ediliyor
- [ ] Düzenli DB backup (DigitalOcean otomatik snapshot veya pg_dump cron)

---

## 6. Kullanıcı Yönetimi

Admin panelinden kullanıcı ekleme (API):
```bash
# Yeni servis kullanıcısı
curl -X POST https://api.hasartrack.com/api/auth/register \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ad_soyad": "Murat Doğan",
    "email": "murat@boschkadikoy.com",
    "sifre": "GucluSifre123!",
    "rol": "servis",
    "servis_id": "11111111-0000-0000-0000-000000000001"
  }'
```

---

## 7. Bakım

```bash
# Log izle
pm2 logs hasartrack-api

# DB yedek al
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql

# Güncelleme
git pull && npm install && pm2 restart hasartrack-api
```
