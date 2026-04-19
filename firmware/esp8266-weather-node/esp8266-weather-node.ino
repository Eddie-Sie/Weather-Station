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
#define API_BASE_URL "http://10.191.51.160:4000"
// ===========================================================================

#define READ_INTERVAL_MS     60000   // 60 seconds
#define REPROBE_EVERY_N      5       // re-run setupSensors() every 5 cycles
#define BUFFER_FILE          "/buffer.jsonl"
#define CONFIG_FILE          "/config.json"
#define WATER_PIN            A0
#define AP_PASSWORD          "weatherstation"   // 8+ chars required by ESP8266
#define DNS_PORT             53
#define MAX_BUFFER_BYTES     150000  // ~150 KB of readings before we stop appending

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
uint32_t cycleCounter = 0;

// ---- Forward declarations -------------------------------------------------
void   loadConfig();
void   saveConfig();
void   startProvisioningPortal();
void   handlePortalRoot();
void   handlePortalSave();
void   handlePortalStatus();
bool   connectToWifi();
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

  if (!LittleFS.begin()) {
    Serial.println(F("LittleFS mount failed, formatting..."));
    LittleFS.format();
    LittleFS.begin();
  }

  Wire.begin();           // ESP8266 default: SDA=GPIO4 (D2), SCL=GPIO5 (D1)
  setupSensors();

  loadConfig();

  if (cfg.wifiSsid.length() == 0 || cfg.pairingCode.length() == 0) {
    Serial.println(F("No saved config — entering provisioning mode."));
    startProvisioningPortal();
    return;   // stay in portal mode, loop() will handle requests
  }

  if (!connectToWifi()) {
    Serial.println(F("Could not join saved WiFi — entering provisioning mode."));
    startProvisioningPortal();
    return;
  }

  syncClock();
  registerDeviceIfNeeded();
  lastReadAt = millis() - READ_INTERVAL_MS;   // force an immediate first reading
}

// ===== LOOP ================================================================
void loop() {
  if (inProvisioningMode) {
    dnsServer.processNextRequest();
    portalServer.handleClient();
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(F("WiFi dropped, attempting reconnect..."));
    WiFi.reconnect();
    delay(3000);
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
void setupSensors() {
  have_aht = aht.begin();
  Serial.printf("AHT20 : %s\n", have_aht ? "OK" : "not found");

  have_bmp = bmp.begin(0x76) || bmp.begin(0x77);
  Serial.printf("BMP280: %s\n", have_bmp ? "OK" : "not found");

  sgp41.begin(Wire);
  uint16_t serialNumber[3];
  uint8_t  serialLen = 3;
  uint16_t err = sgp41.getSerialNumber(serialNumber, serialLen);
  have_sgp41 = (err == 0);
  Serial.printf("SGP41 : %s\n", have_sgp41 ? "OK" : "not found");

  have_hm3301 = (hm3301.init() == NO_ERROR);
  Serial.printf("HM3301: %s\n", have_hm3301 ? "OK" : "not found");

  pinMode(WATER_PIN, INPUT);
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
        t["value"]  = tempEvt.temperature;
        t["unit"]   = "C";
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
  {
    JsonObject v = s.createNestedObject("voc");
    JsonObject n = s.createNestedObject("nox");
    if (have_sgp41) {
      // SGP41 wants compensation values; use AHT data if we have it, else defaults
      uint16_t rhTicks = 0x8000;   // 50% RH default
      uint16_t tTicks  = 0x6666;   // 25 C default
      if (have_aht) {
        sensors_event_t humEvt, tempEvt;
        if (aht.getEvent(&humEvt, &tempEvt)) {
          rhTicks = (uint16_t)((humEvt.relative_humidity * 65535) / 100);
          tTicks  = (uint16_t)(((tempEvt.temperature + 45) * 65535) / 175);
        }
      }
      uint16_t rawVoc = 0, rawNox = 0;
      uint16_t err = sgp41.measureRawSignals(rhTicks, tTicks, rawVoc, rawNox);
      if (err == 0) {
        int32_t vocIdx = voc_algo.process(rawVoc);
        int32_t noxIdx = nox_algo.process(rawNox);
        v["value"] = vocIdx; v["unit"] = "index"; v["status"] = "ok";
        n["value"] = noxIdx; n["unit"] = "index"; n["status"] = "ok";
      } else {
        v["status"] = "error"; n["status"] = "error";
      }
    } else {
      v["status"] = "disconnected"; n["status"] = "disconnected";
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
    // Higher raw reading = wetter. You can convert to % in the frontend.
  }

  return true;
}

// ===== NETWORKING ==========================================================
bool connectToWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.hostname(deviceId);
  WiFi.begin(cfg.wifiSsid.c_str(), cfg.wifiPass.c_str());
  Serial.printf("Joining WiFi '%s'", cfg.wifiSsid.c_str());
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; ++i) {
    delay(500);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(F("IP: ")); Serial.println(WiFi.localIP());
    return true;
  }
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

  std::unique_ptr<BearSSL::WiFiClientSecure> client(new BearSSL::WiFiClientSecure);
  client->setInsecure();
  HTTPClient http;
  http.begin(*client, String(API_BASE_URL) + "/api/devices/register");
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  Serial.printf("Register HTTP %d\n", code);
  if (code == 200 || code == 201) {
    String resp = http.getString();
    StaticJsonDocument<256> r;
    if (!deserializeJson(r, resp)) {
      cfg.deviceToken = (const char*) r["token"];
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

  std::unique_ptr<BearSSL::WiFiClientSecure> client(new BearSSL::WiFiClientSecure);
  client->setInsecure();
  HTTPClient http;
  http.begin(*client, String(API_BASE_URL) + "/api/readings");
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
  bool allOk = true;
  String line;
  while (f.available()) {
    line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;
    if (!postReading(line)) { allOk = false; break; }
    yield();
  }
  f.close();
  if (allOk) {
    LittleFS.remove(BUFFER_FILE);
    Serial.println(F("Buffer flushed and cleared."));
  } else {
    Serial.println(F("Flush interrupted; will retry next cycle."));
  }
}

// ===== CONFIG PERSISTENCE ==================================================
void loadConfig() {
  if (!LittleFS.exists(CONFIG_FILE)) return;
  File f = LittleFS.open(CONFIG_FILE, "r");
  if (!f) return;
  StaticJsonDocument<512> d;
  if (deserializeJson(d, f)) { f.close(); return; }
  cfg.wifiSsid     = (const char*) d["wifiSsid"]     | "";
  cfg.wifiPass     = (const char*) d["wifiPass"]     | "";
  cfg.pairingCode  = (const char*) d["pairingCode"]  | "";
  cfg.locationName = (const char*) d["locationName"] | "";
  cfg.latitude     = d["latitude"]  | 0.0;
  cfg.longitude    = d["longitude"] | 0.0;
  cfg.deviceToken  = (const char*) d["deviceToken"]  | "";
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
  portalServer.onNotFound(    handlePortalRoot);   // captive portal catch-all
  portalServer.begin();
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
