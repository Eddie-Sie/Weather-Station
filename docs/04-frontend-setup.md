# 04 — Frontend setup

The dashboard is a small Next.js app.

## 1. Install + configure

In a **new terminal** (leave the backend one running):
```
cd weather-station/frontend
cp .env.example .env.local      # or "copy" on Windows
```

Open `.env.local` and leave the default:
```
NEXT_PUBLIC_API_BASE=http://localhost:4000
```

## 2. Install + run

```
npm install
npm run dev
```

Open <http://localhost:3000>. You should see a sign-in page.

## 3. Create an account

1. Click **Sign up**, create an account with any email (it doesn't have to be real for local testing; there's no email verification).
2. You land on the "My Weather Devices" dashboard with an empty list.

## 4. Add a device (generate a pairing code)

1. Type a location name (e.g. "My desk").
2. Click **Generate pairing code**.
3. A big yellow box appears showing a 6-char code like `A7X9QM`. Copy it.

## 5. Pair the ESP8266

Now go back to the device setup from doc 02:

1. Connect your phone to `WeatherNode-XXXXXX` hotspot.
2. On the captive portal, enter your WiFi credentials, **paste the pairing code**, enter a location name, capture GPS if you want.
3. Tap **Save & connect**.

In the Arduino Serial Monitor you should see:
```
Register HTTP 200
POST /api/readings -> 200
```

Refresh the dashboard — the device now has a `deviceId`, shows "online", and clicking it opens the Live tab with real readings.

## 6. Make yourself an admin (optional)

Follow step 5 of [03-backend-setup.md](03-backend-setup.md). Reload the dashboard. An "Admin view" link appears at the top-right. Clicking it opens `/admin` which lists every device across every user, with a filter box.

Frontend done for local. Continue to [05-deploying-online.md](05-deploying-online.md) to put everything on the public internet so field-deployed devices can reach it.
