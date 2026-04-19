# 03 — Backend setup

The backend is a small Node.js + Express server that receives readings from the ESP8266 and stores them in MongoDB.

## 1. Install Node.js

Go to <https://nodejs.org> and install the **LTS** version (currently 20.x). Verify in a terminal:
```
node -v
npm -v
```
You should see a version number printed by each command.

## 2. Create a MongoDB Atlas cluster

1. Go to <https://www.mongodb.com/cloud/atlas/register> and sign up.
2. Click **Build a Database**. You'll see several tier options:
   - **M0 Free** — 512 MB, fine for testing a single node.
   - **Flex** (formerly "M2/M5 shared") — 2 GB / 5 GB / 10 GB. **Pick the 5 GB option if your PI has asked for it.** Requires a credit card but is pay-as-you-go (only charged for storage + ops you actually use).
   - **M10+ Dedicated** — only needed for very large fleets.
3. Region: pick the one nearest your users (e.g. `eu-west-1` for Europe, `af-south-1` for southern Africa).
4. Cluster name: `Cluster0` is fine.
5. **Database access**: create a database user (username + password). Write them down.
6. **Network access**: click **Add IP Address → Allow access from anywhere** (`0.0.0.0/0`). This is required so your Render backend can connect. For stricter production use, later add only your Render server's egress IPs.
7. Once the cluster is ready, click **Connect → Drivers** and copy the connection string. It looks like:
   ```
   mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
   Replace `USER` and `PASSWORD` with the ones you created, and add `/weatherstation` before the `?`:
   ```
   mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/weatherstation?retryWrites=true&w=majority
   ```

### What 5 GB buys you

Each reading document is ~1 KB. At one reading per minute, that's ~1.4 MB per device per day → roughly **9 years of data for one device, or ~3 years for 10 devices, or ~1 year for 30 devices.** Pricing terms, exact tier names, and free-tier limits can change, so double-check the current Atlas pricing page before you commit.

### Optional: set a retention policy so you never run out

If you'd rather cap how far back you keep data (e.g. 2 years per device), add a TTL index to the `readings` collection. Open the Atlas UI → Browse Collections → `weatherstation.readings` → Indexes → Create Index:
```
{ "ts": 1 }     options: { expireAfterSeconds: 63072000 }   // 2 years
```
Mongo will then automatically delete documents older than that.

## 3. Configure the backend

1. Open a terminal and `cd` into `weather-station/backend`.
2. Copy the env template:
   - macOS / Linux: `cp .env.example .env`
   - Windows PowerShell: `copy .env.example .env`
3. Open `.env` in any editor and set:
   - `MONGODB_URI=` paste the connection string from step 2.
   - `JWT_SECRET=` generate a random string with:
     ```
     node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
     ```
   - `CORS_ORIGINS=http://localhost:3000` (we'll add the Vercel URL later).

## 4. Install + run

```
npm install
npm run dev
```

You should see:
```
MongoDB connected
API listening on port 4000
```

Test it with:
```
curl http://localhost:4000/
```
Should print `{"ok":true,"service":"weather-station-api"}`.

## 5. Create an admin user (optional)

For the admin dashboard you need a user with `role: "admin"`.

1. Sign up normally through the dashboard (doc 04) first.
2. Then in MongoDB Atlas: **Browse Collections → weatherstation → users**, find your user and change the `role` field from `user` to `admin`. Save.

Backend done. Continue to [04-frontend-setup.md](04-frontend-setup.md).
