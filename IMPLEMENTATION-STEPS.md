# Implementation Steps — Do This In Order

This is the single checklist that gets you from "I have the files" to "nodes are running in communities with AI reports going out by email". Each numbered step links to the full detailed doc if you get stuck. You can tick them off one by one.

## Phase A — Local development (do this all on your laptop)

### A1. Install baseline software
- [ ] Install **Node.js LTS** from <https://nodejs.org>.
- [ ] Install **Git** from <https://git-scm.com/downloads>.
- [ ] Install **Arduino IDE** from <https://www.arduino.cc/en/software>.

### A2. Set up the database (15 min)
- [ ] Sign up at <https://www.mongodb.com/cloud/atlas/register> — free M0 cluster.
- [ ] Create a DB user + password.
- [ ] Network access → Allow from anywhere (`0.0.0.0/0`).
- [ ] Copy the connection string with `weatherstation` as the DB name.
- [ ] Full steps: [docs/03-backend-setup.md §2](docs/03-backend-setup.md).

### A3. Run the backend locally
```bash
cd weather-station/backend
cp .env.example .env       # on Windows: copy .env.example .env
# Edit .env: paste MONGODB_URI and generate JWT_SECRET (see doc 03)
npm install
npm run dev
```
- [ ] You see `MongoDB connected` and `API listening on port 4000`.
- [ ] Visit <http://localhost:4000/> — returns `{"ok":true}`.
- [ ] Full steps: [docs/03-backend-setup.md](docs/03-backend-setup.md).

### A4. Get AI + email credentials (optional for first test, needed for Assistant tab)
- [ ] Create an Anthropic API key at <https://console.anthropic.com/> and add `ANTHROPIC_API_KEY` to `backend/.env`.
- [ ] Create a Gmail App Password (needs 2-step verification first) and add the `SMTP_*` vars to `backend/.env`.
- [ ] Restart the backend.
- [ ] Full steps: [docs/07-ai-and-reports.md](docs/07-ai-and-reports.md).

### A5. Run the frontend locally
Open a **second terminal**, keep the backend one running:
```bash
cd weather-station/frontend
cp .env.example .env.local
npm install
npm run dev
```
- [ ] Visit <http://localhost:3000> — sign-up page appears.
- [ ] Create an account. You land on "My Weather Devices".
- [ ] Full steps: [docs/04-frontend-setup.md](docs/04-frontend-setup.md).

### A6. Assemble one ESP8266 on your desk
- [ ] Plug Grove base shield onto the NodeMCU.
- [ ] Plug AHT20, SGP41, BMP280, HM3301 into any I²C Grove socket.
- [ ] Plug the water sensor into A0.
- [ ] Don't solder or seal anything yet.
- [ ] Full parts list + wiring: [docs/01-hardware-and-wiring.md](docs/01-hardware-and-wiring.md).

### A7. Flash the firmware
In Arduino IDE:
- [ ] Install ESP8266 board support (Preferences → Additional Boards URL).
- [ ] Select your board (NodeMCU 1.0) and the COM port.
- [ ] Set Flash Size to `4MB (FS:1MB OTA:...)`.
- [ ] Install these libraries from Library Manager:
  - Adafruit AHTX0
  - Adafruit BMP280 Library (accept Adafruit Unified Sensor too)
  - Sensirion I2C SGP41
  - Sensirion Gas Index Algorithm
  - Grove - Laser PM2.5 Sensor HM3301
  - ArduinoJson **v6.x** (not v7)
- [ ] Open `firmware/esp8266-weather-node/esp8266-weather-node.ino`.
- [ ] Change `#define API_BASE_URL` to `"http://<your-laptop-LAN-IP>:4000"`.
  - Find laptop IP with `ipconfig` (Windows) or `ifconfig`/`ip a` (macOS/Linux).
- [ ] Click Upload. Open Serial Monitor at 115200. You should see each sensor print `OK` or `not found`.
- [ ] Full steps: [docs/02-firmware-setup.md](docs/02-firmware-setup.md).

### A8. Pair the device
- [ ] On the dashboard, click **Generate pairing code**, note the 6-char code (e.g. `A7X9QM`).
- [ ] On your phone, connect to the `WeatherNode-XXXXXX` hotspot (password: `weatherstation`).
- [ ] On the setup page, enter your home WiFi SSID + password, paste the pairing code, type a location name, tap **Use my phone's GPS**.
- [ ] Tap **Save & connect**. Serial monitor should show `Register HTTP 200` then `POST /api/readings -> 200`.
- [ ] Back in the dashboard, the device goes online. Click it → Live tab shows real values.

### A9. Test the AI + email
- [ ] Click the **Assistant** tab on the device page.
- [ ] Ask "Was today hotter than yesterday?" — get an answer.
- [ ] Click **File a report from this conversation**, give it a title, save.
- [ ] Type an email address, click **Email it**. Check the inbox.

### A10. (Optional) Make yourself admin
- [ ] In MongoDB Atlas → Browse Collections → `weatherstation.users`, change your user's `role` from `user` to `admin`.
- [ ] Reload the dashboard — an "Admin view" link appears. Admin page lists ALL devices from ALL users with a filter box.

At this point the whole system works end-to-end on your laptop.

---

## Phase B — Put it on the internet

### B1. Push to GitHub
```bash
cd weather-station
git init
git add .
git commit -m "Initial weather station project"
# Create an empty repo on github.com, then:
git remote add origin https://github.com/YOU/weather-station.git
git branch -M main
git push -u origin main
```

### B2. Deploy backend to Render
- [ ] Sign up at <https://render.com>.
- [ ] New → Web Service → connect GitHub, pick `weather-station`.
- [ ] Root Directory `backend`, Build `npm install`, Start `npm start`, Free tier.
- [ ] Add every env var from your local `.env` (MongoDB, JWT, CORS, Anthropic, SMTP).
- [ ] Wait for first deploy. Copy the URL, e.g. `https://weather-station-api.onrender.com`.

### B3. Deploy frontend to Vercel
- [ ] Sign up at <https://vercel.com>.
- [ ] New Project → same repo → Root Directory `frontend`.
- [ ] Env var: `NEXT_PUBLIC_API_BASE=https://weather-station-api.onrender.com`.
- [ ] Deploy. Copy the Vercel URL.

### B4. Wire them together
- [ ] Back in Render, set `CORS_ORIGINS` to your Vercel URL (comma-separate multiple if you have them).
- [ ] In the firmware, change `API_BASE_URL` to your Render URL and re-flash every device.

Full steps: [docs/05-deploying-online.md](docs/05-deploying-online.md).

---

## Phase C — Deploy to a community

For each node:

- [ ] Bench test: 30 min of steady readings with all sensors OK.
- [ ] Print a label with the device ID (`WN-XXXXXX`) and the AP password.
- [ ] On site: pick a mounting spot (good WiFi + good sun).
- [ ] The community contact signs up on the dashboard, generates a pairing code.
- [ ] Plug in battery → power cycle → connect phone to hotspot → captive portal → enter WiFi + pairing code + location + GPS.
- [ ] Watch the dashboard for the first reading (≤60 s).
- [ ] Seal the enclosure, mount the solar panel.

Full playbook: [docs/06-field-installation.md](docs/06-field-installation.md).

---

## Common errors and fixes

| Error | Fix |
|---|---|
| `Register HTTP 404 unknown_pairing_code` | Pairing code typo or already used. Generate a new one. |
| Sensor shows "disconnected" | Grove cable loose. Reseat. The firmware re-probes every 5 cycles so it'll reconnect automatically once plugged back. |
| `CORS` error in browser | `CORS_ORIGINS` on the backend doesn't include your frontend URL. |
| Email send fails with Gmail | You used your normal password. You need an **App Password**, which requires 2-step verification. |
| Anthropic 401 | Missing credit on the account, or wrong API key. |
| Device stuck in AP mode | Wrong WiFi password, router out of range, or open-network support needed. Reconnect to AP and re-enter creds. |

---

## What you now have, at a glance

```
ESP8266 node (solar-powered, weatherproof)
   │
   │  every 60 s, POST readings (or buffer to flash if offline)
   ▼
Backend API on Render  ──► MongoDB Atlas
   ▲                         ▲
   │                         │ (read)
   │                         │
Frontend on Vercel ◄─────────┘
   │
   ├─ Live tab  (per-sensor tiles, disconnected-aware)
   ├─ History tab  (charts + CSV export)
   ├─ Assistant tab  (Claude answers questions about YOUR device's data)
   │     └─ File report → Email it out via SMTP
   └─ Admin view (all devices across all users, filter by ID/location/owner)
```

That's the whole thing. When you're ready, start at A1 and work straight through.
