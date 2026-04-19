# 06 — Field installation

This is the playbook for each community deployment.

## Before you travel

Prepare each node at your workbench:

1. Flash the firmware (already done per doc 02 — once flashed, it stays flashed).
2. Run a full bench test: plug in battery, confirm serial logs show all four I²C sensors as OK and readings flow for at least 30 minutes.
3. Print a small label for each enclosure with:
   - Its **device ID** (shown on serial: `WN-XXXXXX`).
   - A QR code or short URL to the dashboard.
   - The AP password: `weatherstation`.
4. Pack a spare battery and a screwdriver.

## At the community site

1. Create a user account on the dashboard for the community contact (or use your admin account and transfer later — there's no transfer endpoint yet, so easier to sign up first).
2. Log in → **Add device** → enter the location name → copy the pairing code.
3. Find a spot with strong WiFi signal AND direct sunlight for most of the day.
4. Mount the enclosure at ~1.5–2 m height, out of direct contact with walls or heat sources.
5. Point the solar panel toward the equator at a tilt roughly equal to your latitude.
6. Power on the node.
7. On a phone, connect to `WeatherNode-XXXXXX`, password `weatherstation`.
8. Fill in the captive portal with the community's WiFi + pairing code + location name + tap GPS.
9. Tap **Save & connect**.
10. Open the dashboard on the phone, log in as the community user. Within ~60 seconds the device's tile should go green.

## If something goes wrong

| Symptom | What to check |
|---------|---------------|
| Captive portal doesn't load | Forget the AP and reconnect. Or browse to http://192.168.4.1 manually. |
| "Register HTTP 404 / unknown_pairing_code" | You pasted the code wrong, or it was already used. Generate a fresh one. |
| Sensor tile says "disconnected" | Grove cable is loose. Unplug, reseat, power cycle. |
| Everything posts but dashboard shows "offline" | Check the backend is running (visit `/` URL directly). Also check CORS_ORIGINS. |
| Device re-enters AP mode | Router password changed or out of range. Reconnect to AP and re-enter. |

## How the offline buffer works in practice

If the community WiFi dies for, say, 6 hours:

- Every 60 seconds the node still takes a reading and appends it to `/buffer.jsonl` in flash.
- 6 hours = 360 readings ≈ 60–100 KB. Well within the 150 KB safety limit.
- When WiFi returns, the next POST succeeds → `flushBuffer()` runs → the whole file is streamed up to the API and deleted.
- Buffered readings arrive with their original timestamps intact, so your history charts don't have gaps.

If WiFi is out for so long that the buffer file exceeds 150 KB, the oldest entries are dropped to keep the flash healthy.

## Maintenance visits

- Every 6 months: wipe the solar panel and the vent holes on the enclosure. Check cable glands.
- If you need to re-pair a device (e.g. new WiFi router in the community): hold down the `FLASH` button for 10 seconds while you power cycle, OR just flash a blank LittleFS — and the device will come up in AP mode again. (A dedicated "reset settings" button is a nice future enhancement.)
- To upgrade firmware over-the-air, add ESP8266 OTA support — not in this first version.

You're done. Congratulations!
