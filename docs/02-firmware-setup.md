# 02 — Firmware setup

This doc walks you through flashing the ESP8266. Assume zero prior knowledge.

## 1. Install Arduino IDE

1. Go to <https://www.arduino.cc/en/software> and download the Arduino IDE for your OS.
2. Install it and open it.

## 2. Add ESP8266 board support

1. In the Arduino IDE menu: **File → Preferences**.
2. Find the field "Additional Boards Manager URLs". Paste this into it:
   ```
   https://arduino.esp8266.com/stable/package_esp8266com_index.json
   ```
3. Click OK.
4. Go to **Tools → Board → Boards Manager…**.
5. Search for "esp8266" and click **Install** on the "esp8266 by ESP8266 Community" entry.

## 3. Select the right board

1. **Tools → Board → esp8266** → choose your board. If you have a NodeMCU, pick **"NodeMCU 1.0 (ESP-12E Module)"**. If you have a Wemos D1 Mini, pick **"LOLIN(WEMOS) D1 R2 & mini"**.
2. **Tools → Flash Size → 4MB (FS:1MB OTA:~1019KB)**  ← important so LittleFS has room to store the buffered readings.
3. **Tools → Upload Speed → 115200** (or leave default).
4. Plug the board in with a USB cable.
5. **Tools → Port → <your COM/tty port>**.

## 4. Install the required libraries

**Sketch → Include Library → Manage Libraries…**, and install each of these by searching for the name:

- `Adafruit AHTX0`
- `Adafruit BMP280 Library` (this will also ask to install "Adafruit Unified Sensor" — say yes)
- `Sensirion I2C SGP41`
- `Sensirion Gas Index Algorithm`
- `Grove - Laser PM2.5 Sensor HM3301` (search for "Grove HM330X")
- `ArduinoJson` — **choose version 6.x**, NOT version 7. (Our code uses v6 API.)

## 5. Open the firmware

1. In Arduino IDE: **File → Open…** and open `firmware/esp8266-weather-node/esp8266-weather-node.ino` from this project.
2. The `portal.h` file opens automatically as a second tab.

## 6. Point the firmware at your backend

Near the top of `esp8266-weather-node.ino` there is a line like:
```c
#define API_BASE_URL "https://your-backend.onrender.com"
```

- **For first-time testing**, you will run the backend on your laptop and the device will post to your laptop's local IP. Change it to something like `http://192.168.1.20:4000` (use your laptop's LAN IP, which you can find with `ipconfig` on Windows or `ifconfig`/`ip a` on macOS/Linux).
- **Once you deploy to Render** (see doc 05), change it back to the public https URL.

## 7. Upload

1. Click the round **Upload** button (top-left, ▶ arrow).
2. Watch the bottom of the IDE: it compiles (takes ~1 min), then uploads.
3. Open **Tools → Serial Monitor** and set baud to `115200`.
4. Press the RESET button on the board. You should see:
   ```
   === Community Weather Station booting ===
   Device ID: WN-A1B2C3
   AHT20 : OK
   BMP280: OK
   SGP41 : OK
   HM3301: OK
   No saved config — entering provisioning mode.
   AP up: WeatherNode-A1B2C3  pass: weatherstation
   ```

## 8. First-time setup over WiFi (the captive portal)

1. On your **phone**, open WiFi settings and connect to `WeatherNode-XXXXXX`. Password: `weatherstation`.
2. Most phones automatically pop open the setup page. If not, open a browser and go to <http://192.168.4.1>.
3. Fill in:
   - Your home/community WiFi name + password (so the device can reach the internet).
   - The **pairing code** you will get from the dashboard in doc 04.
   - A location name (e.g. "My workbench" while testing).
   - Tap **Use my phone's GPS** to capture coordinates.
4. Tap **Save & connect**. The board reboots, joins your WiFi, and the serial monitor shows:
   ```
   Joining WiFi 'MyHomeWiFi'.....
   IP: 192.168.1.42
   Register HTTP 200
   POST /api/readings -> 201
   ```

That's it — the device is running! But you still need the backend + dashboard up for step 8 to succeed. Go to [03-backend-setup.md](03-backend-setup.md).
