/*
 * Community Weather Station — ESP8266 firmware
 *
 * In battery-saver mode (the default) it wakes, reads the following Grove
 * sensors, POSTs them, then deep-sleeps for a few minutes to save power —
 * repeating forever. This is what stretches a ~20-hour battery run into days.
 * (Set SLEEP_MODE_ENABLED to false below for the original always-on, read-
 * every-60-seconds behaviour.) Readings are buffered to flash when WiFi is down:
 *   - AHT20         (temperature + humidity)   I2C addr 0x38
 *   - SGP41         (VOC + NOx)                I2C addr 0x59
 *   - HM3301        (PM2.5 / PM1.0 / PM10)     I2C addr 0x40
 *   - DPS310        (barometric pressure)      I2C addr 0x77 (default) or 0x76
 *   - Water sensor  (analog on A0)
 *
 * First boot: starts a WiFi AP called "WeatherNode-XXXX" with a captive
 * portal at http://192.168.4.1 where the user enters WiFi + pairing code.
 * Those settings are saved to LittleFS and used on every later boot.
 *
 * Libraries to install via Arduino Library Manager:
 *   - Adafruit AHTX0
 *   - Adafruit DPS310
 *   - Sensirion I2C SGP41
 *   - Sensirion Gas Index Algorithm
 *   - Grove - Laser PM2.5 Sensor HM3301   (search "Grove HM330X")
 *   - ArduinoJson  (version 6.x)
 *
 * Board: "Generic ESP8266 Module" or your specific ESP8266 board, with
 * Flash Size set to include a LittleFS filesystem (e.g. "4MB FS:1MB").
 */

#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <DNSServer.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <LittleFS.h>
#include <Wire.h>
#include <ArduinoJson.h>
#include <time.h>

#include <Adafruit_AHTX0.h>
#include <Adafruit_DPS310.h>
#include <SensirionI2CSgp41.h>
#include <NOxGasIndexAlgorithm.h>
#include <VOCGasIndexAlgorithm.h>
#include <Seeed_HM330X.h>

// ===== EDIT ME BEFORE FLASHING =============================================
// The base URL of your deployed backend. During local testing use your
// computer's LAN IP (e.g. http://192.168.1.20:4000). In production use
// the https URL of your Render deployment (see docs/05-deploying-online.md).
#define API_BASE_URL "https://weather-station-api-9zq4.onrender.com"
// ===========================================================================

#define READ_INTERVAL_MS     60000   // 60 seconds
#define REPROBE_EVERY_N      2       // re-run setupSensors() every 2 cycles (helps the I²C extension catch sensors that didn't enumerate on cold boot)
#define BUFFER_FILE          "/buffer.jsonl"
#define CONFIG_FILE          "/config.json"
#define WATER_PIN            A0
#define FACTORY_RESET_PIN    0      // GPIO0 = FLASH button on NodeMCU. Hold at boot to wipe config.
#define AP_PASSWORD          "corefutures16"   // 8+ chars required by ESP8266
#define DNS_PORT             53
#define MAX_BUFFER_BYTES     150000  // ~150 KB of readings before we stop appending
#define AP_FALLBACK_AFTER_MS 10000   // 10 seconds — if WiFi hasn't connected by then, bring up the portal as a fallback so students can reconfigure

// ===== BATTERY SAVER (deep sleep) ==========================================
// When SLEEP_MODE_ENABLED is true, the board wakes, takes ONE reading, sends it
// (or buffers it to flash if WiFi is down), then deep-sleeps for
// SLEEP_DURATION_MIN minutes — repeating forever. This is what turns a ~20-hour
// battery run into several days.
//
// HARDWARE REQUIREMENT: you MUST connect pin D0 (GPIO16) to RST with a jumper
// wire, or the board will go to sleep and never wake up. IMPORTANT: remove that
// wire before uploading new firmware over USB, then reconnect it afterwards
// (the wire interferes with the auto-reset the IDE uses to start an upload).
//
// To change the WiFi/pairing after deployment, hold the FLASH button and tap
// RST, keeping FLASH held ~3 seconds — that factory-resets into the setup
// portal (which stays awake so you can reconfigure).
//
// Set SLEEP_MODE_ENABLED to false to return to the original always-on behaviour
// (handy when debugging on USB power, where battery life doesn't matter).
#define SLEEP_MODE_ENABLED   true
#define SLEEP_DURATION_MIN   5     // minutes asleep between readings
#define SGP_WARMUP_SECS      60    // seconds to warm up the VOC/NOx sensor each wake before reading it (the SGP41 gas-index algorithm needs a full minute of conditioning at 1 Hz to settle on a meaningful value; set to 0 to skip VOC/NOx and save the most battery)
// Water sensor thresholds (ESP8266 ADC range 0..1023).
// Readings around 250 are typical "dry air" noise on the Grove water sensor.
// Increase WATER_RAIN_THRESHOLD if you get false positives in humid air.
#define WATER_RAIN_THRESHOLD 210

// ---- Globals --------------------------------------------------------------
Adafruit_AHTX0       aht;
Adafruit_DPS310      dps;
SensirionI2CSgp41    sgp41;
VOCGasIndexAlgorithm voc_algo;
NOxGasIndexAlgorithm nox_algo;
HM330X               hm3301;

bool have_aht    = false;
bool have_dps    = false;
bool have_sgp41  = false;
bool have_hm3301 = false;

ESP8266WebServer portalServer(80);
DNSServer        dnsServer;
bool             inProvisioningMode = false;

struct Config {
  String wifiSsid;
  String wifiPass;
  String pairingCode;
  String locationName;
  float  latitude  = 0;
  float  longitude = 0;
  String deviceToken;   // returned by server after first successful register
} cfg;

String deviceId;
unsigned long lastReadAt = 0;
unsigned long lastWifiRetryAt = 0;
unsigned long lastSgpTickAt = 0;
unsigned long wifiOfflineSinceMs = 0;  // when we last lost/failed WiFi this boot
bool fallbackAPActive = false;          // true when we've spun up the portal as a fallback
uint32_t cycleCounter = 0;
uint32_t sgpConditioningSecs = 0;   // first 10 ticks use executeConditioning(), then measureRawSignals()
int32_t cachedVocIdx = 0;
int32_t cachedNoxIdx = 0;
bool     sgpReady    = false;       // true once we have real samples flowing
bool clockSynced = false;

// ---- Forward declarations -------------------------------------------------
void   loadConfig();
void   saveConfig();
void   startProvisioningPortal();
void   handlePortalRoot();
void   handlePortalSave();
void   handlePortalStatus();
void   handlePortalScan();
bool   connectToWifi();
void   tickSgp41();
void   setupSensors();
bool   readAll(StaticJsonDocument<1024>& doc);
bool   postReading(const String& body);
void   bufferReading(const String& body);
void   flushBuffer();
bool   registerDeviceIfNeeded();
void   syncClock();
String macSuffix();
void   doOneMeasurementCycle();
void   goToDeepSleep();

// ===== SETUP ===============================================================
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println(F("=== Community Weather Station booting ==="));

  deviceId = "WN-" + macSuffix();
  Serial.printf("Device ID: %s\n", deviceId.c_str());
  Serial.printf("Fallback AP name: WeatherNode-%s   password: %s\n", macSuffix().c_str(), AP_PASSWORD);
  Serial.println(F("(If WiFi isn't reachable for ~10 seconds, this AP will appear automatically.)"));

  if (!LittleFS.begin()) {
    Serial.println(F("LittleFS mount failed, formatting..."));
    LittleFS.format();
    LittleFS.begin();
  }

  Wire.begin();             // ESP8266 default: SDA=GPIO4 (D2), SCL=GPIO5 (D1)
  // 50 kHz instead of the default 100 kHz. The cabled Grove I²C extension adds
  // capacitance, slows down the rising edge, and makes far sensors (PM2.5 +
  // pressure) miss the ACK at 100 kHz. 50 kHz is fully within spec and the
  // 60-second sampling cadence makes the lower bandwidth a non-issue.
  Wire.setClock(50000);
  delay(100);               // let the bus settle before we probe sensors
  setupSensors();

  // ---- Factory reset: tap RST, then press & hold FLASH for ~3s ------------
  // GPIO0 (the FLASH button) is ALSO the chip's boot-mode strapping pin, so
  // it cannot be held during the RST press itself — that would trick the chip
  // into entering its UART bootloader instead of running this firmware. The
  // correct sequence is: tap RST first (nothing else pressed), then within
  // the next few seconds press and hold FLASH for ~3 seconds.
  //
  // To make this easy to do by hand, we open a 4-second detection window
  // here. The user can press FLASH at any point during that window; once
  // pressed, holding it continuously for 3 seconds triggers the wipe. We only
  // open this window on a manual reset / power-on — on silent deep-sleep
  // wakes we skip the whole block so battery life is unaffected.
  pinMode(FACTORY_RESET_PIN, INPUT_PULLUP);
  {
    uint32_t resetReason = ESP.getResetInfoPtr()->reason;
    // 5 == REASON_DEEP_SLEEP_AWAKE (from user_interface.h)
    if (resetReason != 5) {
      Serial.println(F("Press FLASH and hold for 3s within the next 4s to factory-reset..."));
      const unsigned long WINDOW_MS = 4000;
      const unsigned long HOLD_MS   = 3000;
      unsigned long windowStart = millis();
      unsigned long heldSince   = 0;
      while (true) {
        bool isLow = (digitalRead(FACTORY_RESET_PIN) == LOW);
        if (isLow) {
          if (heldSince == 0) {
            heldSince = millis();
            Serial.println(F("FLASH detected — keep holding for 3 seconds..."));
          }
          if (millis() - heldSince > HOLD_MS) {
            Serial.println(F("Factory reset: wiping saved config + WiFi credentials, rebooting into portal."));
            // 1. Wipe LittleFS-stored device config (SSID, password, pairing code, device token).
            LittleFS.remove(CONFIG_FILE);
            LittleFS.remove(BUFFER_FILE);
            // 2. Wipe the ESP8266 SDK's own internal WiFi store — this is in a
            // separate flash region from LittleFS, so removing /config.json is
            // NOT enough on its own. Without this, the next boot's WiFi.begin()
            // silently rejoins the previously saved network.
            WiFi.persistent(true);
            WiFi.disconnect(true /* wifioff */, true /* eraseAP */);
            WiFi.persistent(false);
            ESP.eraseConfig();
            delay(500);
            ESP.restart();
          }
        } else {
          if (heldSince != 0) {
            // User pressed FLASH but let go before the 3 seconds elapsed.
            Serial.println(F("FLASH released too early — skipping reset, continuing normal boot."));
            break;
          }
          if (millis() - windowStart > WINDOW_MS) {
            // Window closed without anyone pressing FLASH — normal boot.
            break;
          }
        }
        delay(50);
      }
    }
  }

  loadConfig();

  if (cfg.wifiSsid.length() == 0 || cfg.pairingCode.length() == 0) {
    Serial.println(F("No saved config — entering provisioning mode."));
    startProvisioningPortal();
    return;   // stay in portal mode, loop() will handle requests
  }

  // Try to join the saved WiFi.
  bool wifiOk = connectToWifi();
  if (wifiOk) {
    syncClock();
    clockSynced = (time(nullptr) > 100000);
    registerDeviceIfNeeded();
  } else {
    Serial.println(F("Could not join saved WiFi this wake."));
  }

  if (SLEEP_MODE_ENABLED) {
    // ---- Battery-saver path: take ONE reading, then deep-sleep. ----
    // If WiFi joined, we send the reading (and flush anything that piled up in
    // the offline buffer while we were away). If it didn't join, we simply
    // buffer this reading to flash and retry on the next wake — we deliberately
    // do NOT sit awake in AP mode here, because that keeps the radio on and
    // burns the battery we're trying to save. To reconfigure WiFi after
    // deployment, hold the FLASH button and tap RST (keep FLASH held ~3s) to
    // factory-reset into the setup portal, which stays awake.
    doOneMeasurementCycle();
    goToDeepSleep();            // never returns — board reboots when D0 pulses RST
  }

  // ---- Original always-on path (only reached when SLEEP_MODE_ENABLED is false) ----
  if (!wifiOk) {
    Serial.println(F("Will keep retrying from loop()."));
  }
  lastReadAt = millis() - READ_INTERVAL_MS;   // force an immediate first reading
}

// ===== LOOP ================================================================
void loop() {
  if (inProvisioningMode) {
    dnsServer.processNextRequest();
    portalServer.handleClient();
    return;
  }

  // Background WiFi retry: if we lost (or never got) a connection, try
  // once every 30 seconds without blocking the rest of the loop.
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiOfflineSinceMs == 0) wifiOfflineSinceMs = millis();
    if (millis() - lastWifiRetryAt > 30000) {
      lastWifiRetryAt = millis();
      Serial.println(F("WiFi not connected — retrying..."));
      WiFi.reconnect();
    }
    // If WiFi has been offline too long, bring up the AP portal as a fallback
    // so students can always reconfigure. WiFi keeps trying in the background.
    if (!fallbackAPActive && millis() - wifiOfflineSinceMs > AP_FALLBACK_AFTER_MS) {
      Serial.println(F("WiFi unreachable for 10 seconds — starting AP fallback so you can reconfigure."));
      WiFi.mode(WIFI_AP_STA);
      String apName = "WeatherNode-" + macSuffix();
      WiFi.softAP(apName.c_str(), AP_PASSWORD);
      Serial.printf("AP up: %s  pass: %s  IP: ", apName.c_str(), AP_PASSWORD);
      Serial.println(WiFi.softAPIP());
      dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());
      if (!inProvisioningMode) {
        portalServer.on("/",       handlePortalRoot);
        portalServer.on("/save",   HTTP_POST, handlePortalSave);
        portalServer.on("/status", handlePortalStatus);
        portalServer.on("/scan",   handlePortalScan);
        portalServer.onNotFound(   handlePortalRoot);
        portalServer.begin();
      }
      fallbackAPActive = true;
    }
    if (fallbackAPActive) {
      dnsServer.processNextRequest();
      portalServer.handleClient();
    }
  } else {
    // WiFi is connected.
    if (fallbackAPActive) {
      Serial.println(F("WiFi reconnected — shutting down AP fallback."));
      WiFi.softAPdisconnect(true);
      dnsServer.stop();
      WiFi.mode(WIFI_STA);
      fallbackAPActive = false;
    }
    wifiOfflineSinceMs = 0;
    if (!clockSynced) {
      // First time we're online this boot — sync NTP and register.
      syncClock();
      clockSynced = (time(nullptr) > 100000);
      registerDeviceIfNeeded();
    }
  }

  // The Sensirion gas-index algorithm is designed for 1 Hz sampling. If we
  // only poll once per 60 s the algorithm never converges and VOC/NOx stay
  // at 0 forever. So we tick SGP41 every second here and cache the index.
  if (millis() - lastSgpTickAt >= 1000) {
    lastSgpTickAt = millis();
    tickSgp41();
  }

  if (millis() - lastReadAt >= READ_INTERVAL_MS) {
    lastReadAt = millis();

    // Every few cycles, re-probe sensors so mid-run unplugs or reconnects are detected.
    if ((cycleCounter++ % REPROBE_EVERY_N) == 0) setupSensors();

    StaticJsonDocument<1024> doc;
    readAll(doc);

    String body;
    serializeJson(doc, body);
    Serial.println(body);

    if (WiFi.status() == WL_CONNECTED && postReading(body)) {
      flushBuffer();
    } else {
      bufferReading(body);
    }
  }
}

// ===== BATTERY-SAVER HELPERS ===============================================
// One complete measurement: (re)init sensors, warm up the gas sensor, read
// everything, then either POST it (and flush the offline buffer) or buffer it
// for the next wake. Used only on the deep-sleep path.
void doOneMeasurementCycle() {
  // In sleep mode the chip cold-boots every wake, so re-probe the sensors and
  // give the I²C bus a moment to settle before reading.
  setupSensors();
  delay(200);

  // The SGP41 VOC/NOx gas-index algorithm needs a short warm-up on every cold
  // start. We tick it once per second for SGP_WARMUP_SECS. NOTE: because the
  // board cold-boots each wake, the algorithm can't build its usual long-term
  // baseline, so VOC/NOx are LESS ACCURATE in sleep mode. Temperature,
  // humidity and pressure are unaffected. (Set SGP_WARMUP_SECS to 0 to skip
  // this warm-up entirely and save the most battery.)
  for (uint16_t i = 0; i < SGP_WARMUP_SECS; ++i) {
    tickSgp41();
    delay(1000);
    yield();
  }

  StaticJsonDocument<1024> doc;
  readAll(doc);

  String body;
  serializeJson(doc, body);
  Serial.println(body);

  if (WiFi.status() == WL_CONNECTED && postReading(body)) {
    flushBuffer();
  } else {
    bufferReading(body);
  }
}

// Put the chip into deep sleep for SLEEP_DURATION_MIN minutes. It wakes via the
// D0 (GPIO16) -> RST jumper, which triggers a full reboot back into setup().
// This function does not return — execution stops here until the next wake.
void goToDeepSleep() {
  uint64_t us = (uint64_t)SLEEP_DURATION_MIN * 60ULL * 1000000ULL;
  Serial.printf("Sleeping for %d minute(s). (Wakes via the D0->RST jumper.)\n", SLEEP_DURATION_MIN);
  Serial.flush();               // make sure the message is sent before we sleep
  ESP.deepSleep(us);            // RF_DEFAULT: radio comes back on after wake so WiFi works
  delay(100);                   // never reached; keeps some toolchains happy
}

// ===== SENSOR INIT =========================================================
// Only tries to init sensors that are currently missing — working sensors are
// left alone so we don't disturb them. Called at boot and on the re-probe
// cycle (to pick up sensors that got plugged back in).
void setupSensors() {
  if (!have_aht) {
    have_aht = aht.begin();
    Serial.printf("AHT20 : %s\n", have_aht ? "OK" : "not found");
  }
  if (!have_dps) {
    // Adafruit_DPS310's begin_I2C() probes 0x77 by default, then 0x76 as a
    // fallback if you pass the alt address explicitly.
    have_dps = dps.begin_I2C(0x77) || dps.begin_I2C(0x76);
    if (have_dps) {
      // Reasonable defaults for a 60-second sampling cadence: 64 Hz / 64
      // samples gives good resolution without burning CPU between reads.
      dps.configurePressure(DPS310_64HZ, DPS310_64SAMPLES);
      dps.configureTemperature(DPS310_64HZ, DPS310_64SAMPLES);
    }
    Serial.printf("DPS310: %s\n", have_dps ? "OK" : "not found");
  }
  if (!have_sgp41) {
    sgp41.begin(Wire);
    uint16_t serialNumber[3];
    uint16_t err = sgp41.getSerialNumber(serialNumber);
    have_sgp41 = (err == 0);
    Serial.printf("SGP41 : %s\n", have_sgp41 ? "OK" : "not found");
  }
  if (!have_hm3301) {
    have_hm3301 = (hm3301.init() == NO_ERROR);
    Serial.printf("HM3301: %s\n", have_hm3301 ? "OK" : "not found");
  }
  pinMode(WATER_PIN, INPUT);
}

// Must be called ~once per second. First 10 ticks run executeConditioning()
// (hot-plate conditioning as Sensirion specifies); after that we switch to
// measureRawSignals() and feed the gas-index algorithm so VOC/NOx produce
// real 0..500 values instead of staying at 0.
void tickSgp41() {
  if (!have_sgp41) return;

  // Pull the latest temperature + humidity for sensor compensation.
  uint16_t rhTicks = 0x8000;   // default 50% RH
  uint16_t tTicks  = 0x6666;   // default 25 C
  if (have_aht) {
    sensors_event_t humEvt, tempEvt;
    if (aht.getEvent(&humEvt, &tempEvt)) {
      rhTicks = (uint16_t)((humEvt.relative_humidity * 65535) / 100);
      tTicks  = (uint16_t)(((tempEvt.temperature + 45) * 65535) / 175);
    }
  }

  if (sgpConditioningSecs < 10) {
    uint16_t rawVoc = 0;
    uint16_t err = sgp41.executeConditioning(rhTicks, tTicks, rawVoc);
    if (err != 0) { Serial.printf("SGP41 conditioning err=%u\n", err); }
    sgpConditioningSecs++;
    if (sgpConditioningSecs == 10) Serial.println(F("SGP41 conditioning complete, switching to measurement."));
    return;
  }

  uint16_t rawVoc = 0, rawNox = 0;
  uint16_t err = sgp41.measureRawSignals(rhTicks, tTicks, rawVoc, rawNox);
  if (err != 0) {
    Serial.printf("SGP41 measure err=%u\n", err);
    return;
  }
  cachedVocIdx = voc_algo.process(rawVoc);
  cachedNoxIdx = nox_algo.process(rawNox);
  sgpReady = true;
}

// ===== READ ALL SENSORS INTO A JSON DOC ====================================
bool readAll(StaticJsonDocument<1024>& doc) {
  doc["device_id"] = deviceId;
  doc["ts"]        = (uint32_t) time(nullptr);
  JsonObject s     = doc.createNestedObject("sensors");

  // ---- AHT20 (temperature + humidity) ----
  {
    JsonObject t = s.createNestedObject("temperature");
    JsonObject h = s.createNestedObject("humidity");
    if (have_aht) {
      sensors_event_t humEvt, tempEvt;
      if (aht.getEvent(&humEvt, &tempEvt)) {
        // Sensor reads in Celsius; convert to Fahrenheit at the source so the
        // number stored in the backend + shown on the dashboard is already °F.
        // (SGP41 compensation below still uses the raw Celsius value — Sensirion
        // requires Celsius for its gas-index algorithm.)
        t["value"]  = tempEvt.temperature * 9.0F / 5.0F + 32.0F;
        t["unit"]   = "F";
        t["status"] = "ok";
        h["value"]  = humEvt.relative_humidity;
        h["unit"]   = "%";
        h["status"] = "ok";
      } else {
        t["status"] = "error"; h["status"] = "error";
      }
    } else {
      t["status"] = "disconnected"; h["status"] = "disconnected";
    }
  }

  // ---- DPS310 (pressure) ----
  {
    JsonObject p = s.createNestedObject("pressure");
    if (have_dps) {
      sensors_event_t pressureEvt;
      // pressureAvailable() guards against the sensor not having a fresh
      // sample ready. With our 60-second cadence and 64Hz config this is
      // essentially always true, but we check anyway to avoid stale data.
      if (dps.pressureAvailable() && dps.getEvents(NULL, &pressureEvt)) {
        float hpa = pressureEvt.pressure;              // library already returns hPa
        if (isnan(hpa) || hpa < 300 || hpa > 1200) {   // sane range
          p["status"] = "error";
          have_dps = false;                            // force re-probe next cycle
        } else {
          p["value"]  = hpa;
          p["unit"]   = "hPa";
          p["status"] = "ok";
        }
      } else {
        p["status"] = "error";
        have_dps = false;
      }
    } else {
      p["status"] = "disconnected";
    }
  }

  // ---- SGP41 (VOC + NOx index) ----
  // The sensor is now sampled every ~1 second from tickSgp41() in loop().
  // Here we just report the cached index the algorithm has converged on.
  {
    JsonObject v = s.createNestedObject("voc");
    JsonObject n = s.createNestedObject("nox");
    if (!have_sgp41) {
      v["status"] = "disconnected"; n["status"] = "disconnected";
    } else if (!sgpReady) {
      // First 10 seconds: sensor conditioning. Report as "warming up".
      v["status"] = "ok"; v["value"] = 0; v["unit"] = "index";
      n["status"] = "ok"; n["value"] = 0; n["unit"] = "index";
    } else {
      v["value"] = cachedVocIdx; v["unit"] = "index"; v["status"] = "ok";
      n["value"] = cachedNoxIdx; n["unit"] = "index"; n["status"] = "ok";
    }
  }

  // ---- HM3301 (PM2.5 etc) ----
  {
    JsonObject pm = s.createNestedObject("pm25");
    // Late re-probe: the HM3301's laser/fan needs ~1s after cold boot before
    // its I²C front-end will reliably ACK, which is longer than the gap
    // between board boot and the original setupSensors() call. By the time
    // we get here (after the 60s SGP41 warm-up) the sensor is definitely
    // ready, so retrying init() now either succeeds and unlocks a real
    // reading, or honestly confirms the cable is unplugged.
    if (!have_hm3301) {
      have_hm3301 = (hm3301.init() == NO_ERROR);
    }
    if (have_hm3301) {
      uint8_t buf[30];
      if (hm3301.read_sensor_value(buf, 29) == NO_ERROR) {
        // Atmospheric PM2.5 is at bytes 10-11 (big-endian)
        uint16_t pm25 = (buf[10] << 8) | buf[11];
        pm["value"]  = pm25;
        pm["unit"]   = "ug/m3";
        pm["status"] = "ok";
      } else {
        pm["status"] = "error";
        have_hm3301 = false;       // force a clean re-probe next cycle
      }
    } else {
      pm["status"] = "disconnected";
    }
  }

  // ---- Water sensor (analog A0) ----
  {
    JsonObject w = s.createNestedObject("water");
    int raw = analogRead(WATER_PIN);        // 0..1023 on ESP8266
    w["value"]  = raw;
    w["unit"]   = "raw";
    w["status"] = "ok";
    w["state"]  = (raw <= WATER_RAIN_THRESHOLD) ? "raining" : "clear";
    // Higher raw reading = wetter. Threshold is WATER_RAIN_THRESHOLD above.
  }

  return true;
}

// ===== NETWORKING ==========================================================
bool connectToWifi() {
  // Clear any stale state from AP mode / previous boot
  WiFi.persistent(false);            // don't wear out flash on every begin()
  WiFi.setAutoReconnect(true);       // auto-recover from brief dropouts
  WiFi.mode(WIFI_AP);
  delay(100);
  WiFi.mode(WIFI_STA);
  WiFi.setSleepMode(WIFI_NONE_SLEEP); // faster response, less hanging
  WiFi.disconnect(true);             // wipe any cached AP
  delay(100);
  WiFi.hostname(deviceId);
  WiFi.begin(cfg.wifiSsid.c_str(), cfg.wifiPass.c_str());
  Serial.printf("Joining WiFi '%s'", cfg.wifiSsid.c_str());
  // Wait up to 10 seconds (20 * 500ms). If it hasn't joined by then, setup()
  // exits and the main loop will bring up the AP fallback within ~10 more
  // seconds so the user can reconfigure. Auto-reconnect keeps trying in the
  // background, so if the network comes back the AP shuts itself down.
  for (int i = 0; i < 20 && WiFi.status() != WL_CONNECTED; ++i) {
    delay(500);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(F("IP: ")); Serial.println(WiFi.localIP());
    return true;
  }
  Serial.printf("WiFi status after timeout: %d\n", WiFi.status());
  return false;
}

void syncClock() {
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  Serial.print(F("Waiting for NTP"));
  time_t now = time(nullptr);
  for (int i = 0; i < 30 && now < 100000; ++i) { delay(500); Serial.print('.'); now = time(nullptr); }
  Serial.println();
}

bool registerDeviceIfNeeded() {
  if (cfg.deviceToken.length() > 0) return true;

  StaticJsonDocument<512> doc;
  doc["device_id"]     = deviceId;
  doc["pairing_code"]  = cfg.pairingCode;
  doc["location_name"] = cfg.locationName;
  doc["latitude"]      = cfg.latitude;
  doc["longitude"]     = cfg.longitude;

  String body;
  serializeJson(doc, body);

  String url = String(API_BASE_URL) + "/api/devices/register";
  HTTPClient http;
  WiFiClient          plainClient;
  BearSSL::WiFiClientSecure tlsClient;
  bool beganOk = false;
  if (url.startsWith("https://")) {
    tlsClient.setInsecure();
    beganOk = http.begin(tlsClient, url);
  } else {
    beganOk = http.begin(plainClient, url);
  }
  if (!beganOk) {
    Serial.println(F("http.begin failed (register)"));
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  Serial.printf("Register HTTP %d\n", code);
  if (code == 200 || code == 201) {
    String resp = http.getString();
    StaticJsonDocument<256> r;
    if (!deserializeJson(r, resp)) {
      cfg.deviceToken = (const char*)(r["token"] | "");
      saveConfig();
      http.end();
      return true;
    }
  }
  http.end();
  return false;
}

bool postReading(const String& body) {
  if (cfg.deviceToken.length() == 0 && !registerDeviceIfNeeded()) return false;

  String url = String(API_BASE_URL) + "/api/readings";
  HTTPClient http;
  WiFiClient          plainClient;
  BearSSL::WiFiClientSecure tlsClient;
  bool beganOk = false;
  if (url.startsWith("https://")) {
    tlsClient.setInsecure();
    beganOk = http.begin(tlsClient, url);
  } else {
    beganOk = http.begin(plainClient, url);
  }
  if (!beganOk) {
    Serial.println(F("http.begin failed (reading)"));
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Id", deviceId);
  http.addHeader("X-Device-Token", cfg.deviceToken);
  int code = http.POST(body);
  http.end();
  Serial.printf("POST /api/readings -> %d\n", code);
  return code >= 200 && code < 300;
}

// ===== OFFLINE BUFFER ======================================================
void bufferReading(const String& body) {
  File f = LittleFS.open(BUFFER_FILE, "a");
  if (!f) { Serial.println(F("Buffer open failed")); return; }
  if (f.size() > MAX_BUFFER_BYTES) {
    Serial.println(F("Buffer full, dropping oldest by truncating."));
    f.close();
    LittleFS.remove(BUFFER_FILE);
    f = LittleFS.open(BUFFER_FILE, "a");
  }
  f.println(body);
  f.close();
  Serial.println(F("Reading buffered to flash."));
}

void flushBuffer() {
  if (!LittleFS.exists(BUFFER_FILE)) return;

  // First pass: count the readings so we can backfill timestamps for any that
  // were buffered while NTP was offline. Those records carry ts == 0 (the
  // ESP8266 returns 0 from time() before configTime() has succeeded), which
  // would otherwise be stored as January 1970 and never show up on the
  // dashboard chart. The buffer is written chronologically (oldest first), so
  // we assume each buffered reading is one SLEEP_DURATION_MIN cycle apart and
  // walk backwards from "now" to assign plausible timestamps.
  int totalReadings = 0;
  {
    File fc = LittleFS.open(BUFFER_FILE, "r");
    if (!fc) return;
    String l;
    while (fc.available()) {
      l = fc.readStringUntil('\n');
      l.trim();
      if (l.length() > 0) totalReadings++;
    }
    fc.close();
  }
  if (totalReadings == 0) { LittleFS.remove(BUFFER_FILE); return; }

  Serial.println(F("Flushing buffered readings..."));

  const uint32_t nowSec      = (uint32_t) time(nullptr);
  const uint32_t intervalSec = (uint32_t) SLEEP_DURATION_MIN * 60UL;
  const bool     clockOk     = (nowSec > 1000000000UL);   // anything past year 2001 = NTP definitely synced

  File f = LittleFS.open(BUFFER_FILE, "r");
  if (!f) return;

  int   flushed = 0;
  int   idx     = 0;
  bool  allOk   = true;
  String line;
  while (f.available()) {
    line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;

    // If this buffered reading's timestamp is bogus (was buffered while NTP
    // was offline), rewrite it based on its chronological position so it
    // lands at a sensible point on the dashboard chart instead of at 1970.
    // Real timestamps (from the rare case where NTP was up but the POST
    // still failed) pass through unchanged.
    StaticJsonDocument<1024> doc;
    DeserializationError err = deserializeJson(doc, line);
    if (!err) {
      uint32_t ts = doc["ts"] | 0UL;
      if (clockOk && ts < 1000000000UL) {
        uint32_t hopsBack = (uint32_t)(totalReadings - idx);   // newest in buffer = 1 cycle ago
        doc["ts"] = nowSec - hopsBack * intervalSec;
        line = "";
        serializeJson(doc, line);
      }
    }

    if (!postReading(line)) { allOk = false; break; }
    flushed++;
    idx++;
    yield();
  }
  f.close();
  if (allOk) {
    LittleFS.remove(BUFFER_FILE);
    Serial.printf("Buffer flushed and cleared. %d readings pushed.\n", flushed);
  } else {
    Serial.printf("Flush interrupted after %d readings; will retry next cycle.\n", flushed);
  }
}

// ===== CONFIG PERSISTENCE ==================================================
void loadConfig() {
  if (!LittleFS.exists(CONFIG_FILE)) return;
  File f = LittleFS.open(CONFIG_FILE, "r");
  if (!f) return;
  StaticJsonDocument<512> d;
  if (deserializeJson(d, f)) { f.close(); return; }
  cfg.wifiSsid     = (const char*)(d["wifiSsid"]     | "");
  cfg.wifiPass     = (const char*)(d["wifiPass"]     | "");
  cfg.pairingCode  = (const char*)(d["pairingCode"]  | "");
  cfg.locationName = (const char*)(d["locationName"] | "");
  cfg.latitude     = d["latitude"]  | 0.0;
  cfg.longitude    = d["longitude"] | 0.0;
  cfg.deviceToken  = (const char*)(d["deviceToken"]  | "");
  f.close();
}

void saveConfig() {
  StaticJsonDocument<512> d;
  d["wifiSsid"]     = cfg.wifiSsid;
  d["wifiPass"]     = cfg.wifiPass;
  d["pairingCode"]  = cfg.pairingCode;
  d["locationName"] = cfg.locationName;
  d["latitude"]     = cfg.latitude;
  d["longitude"]    = cfg.longitude;
  d["deviceToken"]  = cfg.deviceToken;
  File f = LittleFS.open(CONFIG_FILE, "w");
  serializeJson(d, f);
  f.close();
}

// ===== CAPTIVE PORTAL ======================================================
// The HTML page is in portal.h to keep this file shorter.
#include "portal.h"

void startProvisioningPortal() {
  inProvisioningMode = true;
  WiFi.mode(WIFI_AP);
  String apName = "WeatherNode-" + macSuffix();
  WiFi.softAP(apName.c_str(), AP_PASSWORD);
  Serial.printf("AP up: %s  pass: %s\n", apName.c_str(), AP_PASSWORD);
  Serial.print(F("Portal IP: ")); Serial.println(WiFi.softAPIP());

  dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());

  portalServer.on("/",        handlePortalRoot);
  portalServer.on("/save",    HTTP_POST, handlePortalSave);
  portalServer.on("/status",  handlePortalStatus);
  portalServer.on("/scan",    handlePortalScan);
  portalServer.onNotFound(    handlePortalRoot);   // captive portal catch-all
  portalServer.begin();
}

// Returns visible 2.4GHz networks as JSON so the portal page can show a
// pickable list. Crucial for students whose router broadcasts 5GHz networks
// (which the ESP8266 cannot see at all).
void handlePortalScan() {
  // Temporarily switch to AP+STA so we can scan while keeping the portal up.
  WiFi.mode(WIFI_AP_STA);
  int n = WiFi.scanNetworks(false, true);   // sync, include hidden
  String j = "[";
  for (int i = 0; i < n; i++) {
    if (i) j += ",";
    String ssid = WiFi.SSID(i);
    ssid.replace("\"", "\\\"");
    j += "{\"ssid\":\"" + ssid + "\",";
    j += "\"rssi\":" + String(WiFi.RSSI(i)) + ",";
    j += "\"open\":" + String(WiFi.encryptionType(i) == ENC_TYPE_NONE ? "true" : "false") + "}";
  }
  j += "]";
  WiFi.scanDelete();
  WiFi.mode(WIFI_AP);   // back to AP-only so the portal stays responsive
  portalServer.send(200, "application/json", j);
}

void handlePortalRoot() {
  portalServer.send_P(200, "text/html", PORTAL_HTML);
}

void handlePortalStatus() {
  String j = "{\"deviceId\":\"" + deviceId + "\"}";
  portalServer.send(200, "application/json", j);
}

void handlePortalSave() {
  cfg.wifiSsid     = portalServer.arg("ssid");
  cfg.wifiPass     = portalServer.arg("pass");
  cfg.pairingCode  = portalServer.arg("code");
  cfg.locationName = portalServer.arg("loc");
  cfg.latitude     = portalServer.arg("lat").toFloat();
  cfg.longitude    = portalServer.arg("lng").toFloat();
  cfg.deviceToken  = "";            // force re-register with new pairing
  saveConfig();
  portalServer.send(200, "application/json",
    "{\"ok\":true,\"message\":\"Saved. Rebooting...\"}");
  delay(1500);
  ESP.restart();
}

// ===== UTIL ================================================================
String macSuffix() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char buf[7];
  snprintf(buf, sizeof(buf), "%02X%02X%02X", mac[3], mac[4], mac[5]);
  return String(buf);
}