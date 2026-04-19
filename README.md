# Community Weather Station

A solar-powered ESP8266 weather node that reads Seeed Studio Grove sensors every 60 seconds and streams them to a web dashboard. Each user has their own account and sees only their devices; an admin account sees them all. If WiFi drops, the node caches readings in flash memory and flushes them when internet returns.

## What you're building

1. **The Node (hardware in the field)** — ESP8266 + Grove Base shield + AHT20, SGP41 (NOx/VOC), HM3301 (PM2.5), BMP280 (pressure), Water sensor, solar panel, LiPo battery.
2. **The Backend (cloud brain)** — Node.js + Express API, data stored in MongoDB Atlas.
3. **The Frontend (dashboard)** — Next.js web app where users view live readings + history. Admins get a fleet overview.

## Project layout

```
weather-station/
├── README.md                 ← you are here
├── docs/                     ← step-by-step beginner guides
│   ├── 01-hardware-and-wiring.md
│   ├── 02-firmware-setup.md
│   ├── 03-backend-setup.md
│   ├── 04-frontend-setup.md
│   ├── 05-deploying-online.md
│   └── 06-field-installation.md
├── firmware/                 ← Arduino code for the ESP8266
│   └── esp8266-weather-node/
├── backend/                  ← Node.js API + MongoDB
└── frontend/                 ← Next.js dashboard
```

## Read the docs in order

You don't have to know anything upfront. Each doc tells you exactly what to install, what to click, and what to expect.

1. **[01-hardware-and-wiring.md](docs/01-hardware-and-wiring.md)** — parts list and how to plug sensors into the Grove base.
2. **[02-firmware-setup.md](docs/02-firmware-setup.md)** — install Arduino IDE, flash the code to the ESP8266, test on your desk.
3. **[03-backend-setup.md](docs/03-backend-setup.md)** — run the API locally, create a MongoDB Atlas database.
4. **[04-frontend-setup.md](docs/04-frontend-setup.md)** — run the dashboard locally, sign up, pair a device.
5. **[05-deploying-online.md](docs/05-deploying-online.md)** — put backend on Render and frontend on Vercel so real devices in the field can reach them.
6. **[06-field-installation.md](docs/06-field-installation.md)** — solar panel wiring, enclosure, where to mount, troubleshooting.

## Quick end-to-end picture

```
[Sensors] → [ESP8266 reads every 60s] → [HTTPS POST] → [Backend API] → [MongoDB]
                         ↑                                                 ↓
                 offline? buffer in flash                           [Dashboard]
```

## High-level flow of the user experience

1. User goes to dashboard → signs up → sees empty "My Devices" list.
2. User clicks "Add Device" → dashboard generates a 6-character **pairing code** (e.g. `A7X9QM`).
3. User powers on the ESP8266 for the first time. It turns into a WiFi hotspot named `WeatherNode-XXXX`.
4. User connects their phone to that hotspot, a setup page opens automatically.
5. On the setup page, user picks their home WiFi, types the password, pastes the pairing code, types a friendly location name ("Community Center Kumasi"), and taps **Use my GPS** to capture coordinates.
6. User taps Save. ESP reboots, connects to their WiFi, posts itself to the API using the pairing code. Backend binds the device to that user's account.
7. Device now posts readings every 60 seconds. They show up live on the dashboard.

Ready? Open [docs/01-hardware-and-wiring.md](docs/01-hardware-and-wiring.md).
