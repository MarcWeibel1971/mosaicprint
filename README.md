# MosaicPrint – Standalone Web Application

Photo mosaic generator and print shop. Fully independent from HeartMosaic.

## Tech Stack

- **Frontend**: React 18 + Vite + TailwindCSS + Framer Motion
- **Backend**: Express.js + tRPC + PostgreSQL
- **Deployment**: Railway.app (or any Node.js host)

## Quick Start (Local Development)

```bash
# 1. Install dependencies
pnpm install

# 2. Create .env file
cp .env.example .env
# Edit .env with your DATABASE_URL and API keys

# 3. Start dev servers (frontend + backend)
pnpm dev
```

- Frontend: http://localhost:5200
- Backend API: http://localhost:3000/api/health

## Deployment on Railway

### Step 1: Create Railway project
1. Go to [railway.app](https://railway.app) and sign in
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Connect your GitHub account and select the `mosaicprint` repository

### Step 2: Add PostgreSQL database
1. In your Railway project, click **"New Service"** → **"Database"** → **"PostgreSQL"**
2. Railway automatically sets `DATABASE_URL` in your environment

### Step 3: Set environment variables
In Railway → your service → **Variables**, add:
```
PEXELS_API_KEY=your_key
UNSPLASH_ACCESS_KEY=your_key
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
BASE_URL=https://your-app.railway.app
NODE_ENV=production
```

### Step 4: Deploy
Railway automatically builds and deploys on every `git push`.

## Migrate Tiles from TiDB

After setting up Railway PostgreSQL, migrate the existing ~11,000 tiles:

```bash
TIDB_URL="mysql://user:pass@host:4000/db?ssl=true" \
DATABASE_URL="postgresql://..." \
node scripts/migrate-tiles-from-tidb.mjs
```

## Custom Domain

In Railway → your service → **Settings** → **Domains**:
1. Add your custom domain (e.g., `mosaicprint.ch`)
2. Set DNS CNAME record to the Railway-provided hostname
3. Railway handles SSL automatically

## Project Structure

```
mosaicprint/
├── client/              # React frontend (Vite)
│   ├── src/
│   │   ├── pages/       # Landing, Studio, Admin, Pricing, HowItWorks
│   │   ├── components/  # Navbar, Footer, etc.
│   │   └── lib/         # Image cache, utilities
│   └── vite.config.ts
├── server/              # Express backend
│   ├── index.ts         # Main server + REST endpoints
│   ├── router.ts        # tRPC procedures (Admin API)
│   ├── db.ts            # PostgreSQL queries
│   └── mosaicExport.ts  # Server-side mosaic rendering
├── scripts/
│   └── migrate-tiles-from-tidb.mjs
├── railway.toml         # Railway deployment config
└── .env.example
```

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/health` | Health check + tile count |
| `GET /api/trpc/getTilePool?limit=5000&labOnly=true` | Tile pool for mosaic generator |
| `GET /api/tile/:id?size=128` | Individual tile image (redirect) |
| `POST /api/trpc/*` | Admin tRPC procedures |
