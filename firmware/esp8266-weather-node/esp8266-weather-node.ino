/*
 * Community Weather Station — ESP8266 firmware
 *
 * Reads the following Grove sensors every 60 seconds and POSTs them to the
 * backend API, buffering to flash memory when WiFi is down:
 *   - AHT20         (temperature + humidity)   I2C addr 0x38
 *   - SGP41         (VOC + NOx)                I2C addr 0x59
 *   - HM3301        (PM2.5 / PM1.0 / PM10)     I2C addr 0x40
 *   - BMP280        (barometric pressure)      I2C addr 0x76 or 0x77
 *   - Water sensor  (analog on A0)
 *
 * First boot: starts a WiFi AP called "WeatherNode-XXXX" with a captive
 * portal at http://192.168.4.1 where the user enters WiFi + pairing code.
 * Those settings are saved to LittleFS and used on every later boot.
 *
 * Libraries to install via Arduino Library Manager:
 *   - Adafruit AHTX0
 *   - Adafruit BMP280 Library
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
#include <Adafruit_BMP280.h>
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
// Water sensor thresholds (ESP8266 ADC range 0..1023).
// Readings around 250 are typical "dry air" noise on the Grove water sensor.
// Increase WATER_RAIN_THRESHOLD if you get false positives in humid air.
#define WATER_RAIN_THRESHOLD 210

// ---- Globals --------------------------------------------------------------
Adafruit_AHTX0       aht;
Adafruit_BMP280      bmp;
SensirionI2CSgp41    sgp41;
VOCGasIndexAlgorithm voc_algo;
NOxGasIndexAlgorithm nox_algo;
HM330X               hm3301;

bool have_aht    = false;
bool have_bmp    = false;
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

  // ---- Factory reset: hold FLASH button (GPIO0) for 3 seconds at boot ----
  pinMode(FACTORY_RESET_PIN, INPUT_PULLUP);
  if (digitalRead(FACTORY_RESET_PIN) == LOW) {
    Serial.println(F("FLASH button held at boot — checking for 3s hold..."));
    unsigned long start = millis();
    while (digitalRead(FACTORY_RESET_PIN) == LOW) {
      if (millis() - start > 3000) {
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
      delay(50);
    }
  }

  loadConfig();

  if (cfg.wifiSsid.length() == 0 || cfg.pairingCode.length() == 0) {
    Serial.println(F("No saved config — entering provisioning mode."));
    startProvisioningPortal();
    return;   // stay in portal mode, loop() will handle requests
  }

  // Try to join the saved WiFi. If it fails, DON'T drop into AP mode —
  // the main loop will keep retrying in the background. This prevents the
  // device from getting stuck in the captive portal after a brief outage.
  if (!connectToWifi()) {
    Serial.println(F("Could not join saved WiFi yet — will keep retrying from loop()."));
  } else {
    syncClock();
    clockSynced = (time(nullptr) > 100000);
    registerDeviceIfNeeded();
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

// ===== SENSOR INIT =========================================================
// Only tries to init sensors that are currently missing — working sensors are
// left alone so we don't disturb them. Called at boot and on the re-probe
// cycle (to pick up sensors that got plugged back in).
void setupSensors() {
  if (!have_aht) {
    have_aht = aht.begin();
    Serial.printf("AHT20 : %s\n", have_aht ? "OK" : "not found");
  }
  if (!have_bmp) {
    have_bmp = bmp.begin(0x76) || bmp.begin(0x77);
    Serial.printf("BMP280: %s\n", have_bmp ? "OK" : "not found");
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

  // ---- BMP280 (pressure) ----
  {
    JsonObject p = s.createNestedObject("pressure");
    if (have_bmp) {
      float pa = bmp.readPressure();
      if (isnan(pa) || pa < 30000 || pa > 120000) {   // sane range 300..1200 hPa
        p["status"] = "error";
        have_bmp = false;                              // force re-probe next cycle
      } else {
        p["value"]  = pa / 100.0F;                     // hPa
        p["unit"]   = "hPa";
        p["status"] = "ok";
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
  File f = LittleFS.open(BUFFER_FILE, "r");
  if (!f) return;

  Serial.println(F("Flushing buffered readings..."));
  int  flushed = 0;
  bool allOk   = true;
  String line;
  while (f.available()) {
    line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;
    if (!postReading(line)) { allOk = false; break; }
    flushed++;
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