# 05 — Deploying to the internet

Running everything on your laptop is fine for testing, but real nodes in communities need a public URL. We'll put the backend on **Render** (free tier) and the frontend on **Vercel** (free tier). Both connect to your existing MongoDB Atlas cluster.

## 1. Put the code on GitHub

If you haven't already:

1. Create a free GitHub account: <https://github.com/join>.
2. Install Git: <https://git-scm.com/downloads>.
3. In a terminal, inside the `weather-station/` folder:
   ```
   git init
   git add .
   git commit -m "Initial weather station project"
   ```
4. On GitHub, click **New repository**, name it `weather-station`, leave it empty (no README), **Create**.
5. Follow the "push an existing repository" commands GitHub shows. They look like:
   ```
   git remote add origin https://github.com/YOURNAME/weather-station.git
   git branch -M main
   git push -u origin main
   ```

## 2. Deploy the backend on Render

1. Sign up: <https://render.com/>.
2. Click **New → Web Service**.
3. Connect your GitHub and pick the `weather-station` repo.
4. Settings:
   - **Name:** `weather-station-api`
   - **Root Directory:** `backend`
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Click **Advanced → Add Environment Variable** and add the same keys as your local `.env`:
   - `MONGODB_URI` — the Atlas connection string
   - `JWT_SECRET` — the long random string you generated
   - `CORS_ORIGINS` — leave empty for now, we'll set it after Vercel deploys
6. Click **Create Web Service**. Wait ~3 min for the first build. When it's live you'll see a URL like `https://weather-station-api.onrender.com`.
7. Test: `https://weather-station-api.onrender.com/` in a browser should print `{"ok":true,...}`.

Note: Render's free tier sleeps the service after 15 minutes of inactivity. The first request after sleep takes ~30 s. That's OK for a 60-second posting interval, but if you want it always-on upgrade to the $7/mo Starter plan.

## 3. Deploy the frontend on Vercel

1. Sign up: <https://vercel.com/signup>.
2. Click **Add New → Project**, import the same GitHub repo.
3. Settings:
   - **Root Directory:** `frontend`
   - **Framework Preset:** Next.js (auto-detected)
4. In **Environment Variables** add:
   - `NEXT_PUBLIC_API_BASE` = `https://weather-station-api.onrender.com` (from step 2)
5. Click **Deploy**. In ~2 min you'll get a URL like `https://weather-station-xxxx.vercel.app`.

## 4. Tell the backend about the frontend

Back in Render:

1. Open your `weather-station-api` service → **Environment**.
2. Edit `CORS_ORIGINS` to `https://weather-station-xxxx.vercel.app` (replace with your real URL). You can add multiple origins separated by commas.
3. Save — the service restarts automatically.

## 5. Update the firmware

Edit `firmware/esp8266-weather-node/esp8266-weather-node.ino`:
```c
#define API_BASE_URL "https://weather-station-api.onrender.com"
```
Re-upload to any devices that were pointed at your laptop IP.

Every device you flash from now on will talk to the cloud.

## 6. Sanity check

- Open your Vercel URL, sign in, generate a pairing code.
- Power a node, enter WiFi + pairing code + location.
- Within ~60 seconds the node should appear with live data on the dashboard.

Now you can ship nodes to communities without worrying about your laptop being online. Continue to [06-field-installation.md](06-field-installation.md) for how to physically install them.
