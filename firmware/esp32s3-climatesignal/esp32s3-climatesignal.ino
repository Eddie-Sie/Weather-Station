/*
 * ClimateSignal — ESP32-S3 Custom PCB Firmware
 * Hardware: Custom "Amyy" ClimateSignal PCB  (schematic rev 1.0, 2026-06-25)
 *
 * ── PIN MAP (from schematic — do not change without re-checking schematic) ──
 *   SDA  = GPIO20   (all Grove DA connectors)
 *   SCL  = GPIO21   (all Grove CL connectors)
 *   A0   = GPIO1    (A0 connector on PCB — ADC1_CH0, confirmed in ESP32-S3 TRM)
 *   BOOT = GPIO0    (SW2 BOOT button on schematic)
 *   EN   = SW1      (hardware-only; resets/enables the chip — no GPIO)
 *
 *   Micro-SD (SPI via DS1139-06-08SS4BSR):
 *     CMD = GPIO35   CLK = GPIO36   D0 = GPIO37
 *     D1  = GPIO38   D2  = GPIO33   D3 = GPIO34
 *
 * ── SENSORS (I²C, all on SDA/SCL) ──────────────────────────────────────────
 *   AHT20   temperature + humidity    0x38
 *   DPS310  barometric pressure       0x77 (or 0x76)
 *   SGP41   VOC + NOx                 0x59
 *   HM3301  PM2.5                     0x40
 *   DS3231M hardware RTC              0x68
 *   Water   analog on GPIO1 (A0 connector)
 *
 * ── KEY DIFFERENCES FROM ESP8266 VERSION ─────────────────────────────────
 *   • ESP8266WiFi / BearSSL       → WiFi.h / WiFiClientSecure.h
 *   • ESP8266WebServer            → WebServer.h
 *   • ESP8266HTTPClient           → HTTPClient.h (built into ESP32 Arduino core)
 *   • Wire.begin()                → Wire.begin(PIN_SDA, PIN_SCL)   (must be explicit)
 *   • analogRead()                → 12-bit (0–4095) instead of 10-bit (0–1023)
 *   • Deep sleep D0→RST jumper    → NOT needed; ESP32-S3 wakes from internal RTC
 *   • ESP.deepSleep()             → esp_sleep_enable_timer_wakeup() + esp_deep_sleep_start()
 *   • reset reason                → esp_reset_reason() instead of ESP.getResetInfoPtr()
 *   • Hardware RTC (DS3231M)      → timestamps available even without NTP
 *   • Micro-SD card slot          → readings can be archived locally to SD
 *   • awake-window sleep strategy → unchanged from refined ESP8266 firmware
 *
 * ── LIBRARIES (install via Arduino Library Manager) ─────────────────────
 *   Adafruit AHTX0
 *   Adafruit DPS310
 *   Sensirion I2C SGP41
 *   Sensirion Gas Index Algorithm
 *   Grove - Laser PM2.5 Sensor HM3301   (search "Grove HM330X")
 *   RTClib                              (Adafruit RTClib — for DS3231M)
 *   SD  (built-in to ESP32 Arduino core)
 *   ArduinoJson  6.x
 *
 * ── ARDUINO IDE BOARD SETTINGS ──────────────────────────────────────────
 *   Board:              ESP32S3 Dev Module
 *   USB CDC On Boot:    Enabled   (Serial works over USB-C without a separate chip)
 *   Flash Size:         8MB
 *   Partition Scheme:   8M with spiffs  (leaves ~1.5 MB LittleFS + OTA room)
 *   Upload Speed:       921600
 *
 * ── SLEEP MODE NOTES ────────────────────────────────────────────────────
 *   SLEEP_MODE_ENABLED true  → 10-reading awake window then deep-sleep.
 *   SLEEP_MODE_ENABLED false → always-on, reads every 60 s (good for USB debug).
 *   No external jumper wire required for wake — the RTC timer is internal.
 */

#include <stdint.h>
typedef uint8_t  u8;
typedef uint32_t u32;

// ── ESP32 Arduino core headers ───────────────────────────────────────────────
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <LittleFS.h>
#include <Wire.h>
#include <ArduinoJson.h>
#include <time.h>
#include <SD.h>
#include <SPI.h>

// ── Sensor / RTC libraries ───────────────────────────────────────────────────
#include <Adafruit_AHTX0.h>
#include <Adafruit_DPS310.h>
#include <SensirionI2CSgp41.h>
#include <NOxGasIndexAlgorithm.h>
#include <VOCGasIndexAlgorithm.h>
#include <Seeed_HM330X.h>
#include <RTClib.h>     // Adafruit RTClib — covers DS3231

// ===== EDIT BEFORE FLASHING =================================================
#define API_BASE_URL "https://weather-station-api-9zq4.onrender.com"
// ============================================================================

// ── Pin definitions (schematic-confirmed) ────────────────────────────────────
#define PIN_SDA             20   // Grove DA — all five connectors share this bus
#define PIN_SCL             21   // Grove CL
#define PIN_WATER           1    // A0 connector → GPIO1 = ADC1_CH0 on ESP32-S3
#define FACTORY_RESET_PIN   0    // SW2 BOOT button (GPIO0)

// ── Micro-SD SPI (DS1139-06-08SS4BSR footprint from schematic) ───────────────
#define SD_CMD   35   // MOSI
#define SD_CLK   36   // SCK
#define SD_D0    37   // MISO
#define SD_CS    34   // D3 = CS (active low)
// D1=GPIO38 D2=GPIO33 are unused in single-bit SPI mode

// ── Configuration ────────────────────────────────────────────────────────────
#define READ_INTERVAL_MS     60000   // ms between readings (always-on mode)
#define REPROBE_EVERY_N      2       // re-probe missing sensors every N cycles
#define BUFFER_FILE          "/buffer.jsonl"
#define CONFIG_FILE          "/config.json"
#define AP_PASSWORD          "corefutures16"
#define DNS_PORT             53
#define MAX_BUFFER_BYTES     150000
#define AP_FALLBACK_AFTER_MS 10000

// ── Water sensor (ESP32-S3 ADC is 12-bit: 0–4095) ───────────────────────────
// Equivalent to the ESP8266's 210/1023 threshold scaled to 12-bit:  210*4 ≈ 840
// Adjust upward if you see false "raining" in high humidity.
#define WATER_RAIN_THRESHOLD 840

// ── Battery saver / deep sleep ───────────────────────────────────────────────
// NO external D0→RST jumper required on ESP32-S3.
// Deep sleep wakes automatically via the internal RTC timer.
#define SLEEP_MODE_ENABLED   false   // change to true for battery/solar operation
#define SLEEP_DURATION_MIN   5       // minutes asleep between awake windows
#define AWAKE_READINGS       10      // readings per awake window (1 per minute)
#define READING_GAP_SECS     60      // seconds between readings while awake
#define SGP_WARMUP_SECS      60      // first minute of awake window = SGP41 warm-up

// ── Sensor objects ───────────────────────────────────────────────────────────
Adafruit_AHTX0       aht;
Adafruit_DPS310      dps;
SensirionI2CSgp41    sgp41;
VOCGasIndexAlgorithm voc_algo;
NOxGasIndexAlgorithm nox_algo;
HM330X               hm3301;
RTC_DS3231           rtc;

bool have_aht    = false;
bool have_dps    = false;
bool have_sgp41  = false;
bool have_hm3301 = false;
bool have_rtc    = false;
bool have_sd     = false;

// ── Server objects ───────────────────────────────────────────────────────────
WebServer portalServer(80);
DNSServer dnsServer;
bool      inProvisioningMode = false;

// ── Config struct ─────────────────────────────────────────────────────────────
struct Config {
    String wifiSsid;
    String wifiPass;
    String pairingCode;
    String locationName;
    float  latitude  = 0;
    float  longitude = 0;
    String deviceToken;
} cfg;

// ── Global state ─────────────────────────────────────────────────────────────
String        deviceId;
unsigned long lastReadAt          = 0;
unsigned long lastWifiRetryAt     = 0;
unsigned long lastSgpTickAt       = 0;
unsigned long wifiOfflineSinceMs  = 0;
unsigned long lastPortalBannerAt  = 0;
bool          fallbackAPActive    = false;
uint32_t      cycleCounter        = 0;
uint32_t      sgpConditioningSecs = 0;
int32_t       cachedVocIdx        = 0;
int32_t       cachedNoxIdx        = 0;
bool          sgpReady            = false;
bool          clockSynced         = false;   // NTP succeeded at least once

// ── Forward declarations ──────────────────────────────────────────────────────
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
void   archiveToSD(const String& body);
void   flushBuffer();
bool   registerDeviceIfNeeded();
void   syncClock();
uint32_t getTimestamp();
String macSuffix();
void   doOneMeasurementCycle();
void   goToDeepSleep();

// =============================================================================
// SETUP
// =============================================================================
void setup() {
    // USB-CDC serial — works over USB-C without a separate UART chip.
    // "USB CDC On Boot: Enabled" must be set in Arduino IDE board settings.
    Serial.begin(115200);
    delay(500);   // give USB-CDC time to enumerate on host
    Serial.println();
    Serial.println(F("=== ClimateSignal ESP32-S3 Custom PCB booting ==="));

    deviceId = "WN-" + macSuffix();
    Serial.printf("Device ID : %s\n", deviceId.c_str());
    Serial.printf("Fallback AP: WeatherNode-%s  pw: %s\n",
                  macSuffix().c_str(), AP_PASSWORD);

    // ── LittleFS ─────────────────────────────────────────────────────────────
    // formatOnFail=true: auto-formats on first boot or if flash is corrupted
    if (!LittleFS.begin(true)) {
        Serial.println(F("LittleFS: mount failed even after format — check partition scheme"));
    } else {
        Serial.println(F("LittleFS: mounted OK"));
    }

    // ── I²C ──────────────────────────────────────────────────────────────────
    // Must pass SDA and SCL explicitly on ESP32 — no hardcoded defaults.
    Wire.begin(PIN_SDA, PIN_SCL);
    // 50 kHz: Grove cables add capacitance; 50 kHz is safe for long cable runs
    // and is within spec for all five I²C sensors and the DS3231M RTC.
    Wire.setClock(50000);
    delay(100);   // let bus settle before probing
    setupSensors();

    // ── Micro-SD ─────────────────────────────────────────────────────────────
    // Custom SPI pins — must call SPI.begin() before SD.begin() on ESP32.
    SPI.begin(SD_CLK, SD_D0, SD_CMD, SD_CS);
    if (SD.begin(SD_CS)) {
        have_sd = true;
        Serial.println(F("SD card: mounted OK"));
    } else {
        Serial.println(F("SD card: not found or mount failed (readings buffered to LittleFS only)"));
    }

    // ── Factory reset detection ───────────────────────────────────────────────
    // Hold the BOOT button (GPIO0) for 3 seconds within 4 s of power-on.
    // On ESP32-S3 we check esp_reset_reason() — DEEPSLEEP wake skips the window
    // so battery/solar mode doesn't burn through the boot delay every cycle.
    pinMode(FACTORY_RESET_PIN, INPUT_PULLUP);
    {
        esp_reset_reason_t reason = esp_reset_reason();
        if (reason != ESP_RST_DEEPSLEEP) {
            Serial.println(F("Hold BOOT 3s within 4s to factory-reset..."));
            const unsigned long WINDOW_MS = 4000;
            const unsigned long HOLD_MS   = 3000;
            unsigned long windowStart = millis();
            unsigned long heldSince   = 0;
            while (true) {
                bool isLow = (digitalRead(FACTORY_RESET_PIN) == LOW);
                if (isLow) {
                    if (heldSince == 0) {
                        heldSince = millis();
                        Serial.println(F("BOOT held — keep holding 3 s..."));
                    }
                    if (millis() - heldSince > HOLD_MS) {
                        Serial.println(F("Factory reset — wiping config..."));
                        LittleFS.remove(CONFIG_FILE);
                        LittleFS.remove(BUFFER_FILE);
                        WiFi.disconnect(true, true);   // wipe stored WiFi creds
                        delay(500);
                        ESP.restart();
                    }
                } else {
                    if (heldSince != 0) {
                        Serial.println(F("BOOT released too early — skipping reset."));
                        break;
                    }
                    if (millis() - windowStart > WINDOW_MS) break;
                }
                delay(50);
            }
        }
    }

    // ── Load saved config ─────────────────────────────────────────────────────
    loadConfig();

    if (cfg.wifiSsid.length() == 0 || cfg.pairingCode.length() == 0) {
        Serial.println(F("No saved config — entering provisioning mode."));
        startProvisioningPortal();
        return;
    }

    bool wifiOk = connectToWifi();
    if (wifiOk) {
        syncClock();
        clockSynced = (time(nullptr) > 100000);
        // Sync hardware RTC if NTP succeeded and RTC is available.
        // This keeps timestamps accurate even after WiFi-less boots.
        if (clockSynced && have_rtc) {
            rtc.adjust(DateTime((uint32_t)time(nullptr)));
            Serial.println(F("DS3231M: synced from NTP."));
        }
        registerDeviceIfNeeded();
    } else {
        Serial.println(F("Could not join saved WiFi this boot."));
    }

    if (SLEEP_MODE_ENABLED) {
        doOneMeasurementCycle();
        goToDeepSleep();   // does not return
    }

    lastReadAt = millis() - READ_INTERVAL_MS;   // fire first reading immediately
}

// =============================================================================
// LOOP  (always-on mode only — SLEEP_MODE_ENABLED must be false)
// =============================================================================
void loop() {
    if (inProvisioningMode) {
        dnsServer.processNextRequest();
        portalServer.handleClient();
        // Repeat the connection banner every 15 s so it's easy to spot
        if (millis() - lastPortalBannerAt > 15000) {
            lastPortalBannerAt = millis();
            printPortalBanner("WeatherNode-" + macSuffix(), WiFi.softAPIP());
        }
        return;
    }

    // ── WiFi watchdog ─────────────────────────────────────────────────────────
    if (WiFi.status() != WL_CONNECTED) {
        if (wifiOfflineSinceMs == 0) wifiOfflineSinceMs = millis();

        if (millis() - lastWifiRetryAt > 30000) {
            lastWifiRetryAt = millis();
            Serial.println(F("WiFi not connected — retrying..."));
            WiFi.reconnect();
        }

        if (!fallbackAPActive &&
            millis() - wifiOfflineSinceMs > AP_FALLBACK_AFTER_MS) {
            Serial.println(F("WiFi unreachable 10 s — starting fallback AP."));
            WiFi.mode(WIFI_AP_STA);
            String apName = "WeatherNode-" + macSuffix();
            WiFi.softAP(apName.c_str(), AP_PASSWORD);
            delay(500);
            printPortalBanner(apName, WiFi.softAPIP());
            lastPortalBannerAt = millis();
            dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());
            portalServer.on("/",       handlePortalRoot);
            portalServer.on("/save",   HTTP_POST, handlePortalSave);
            portalServer.on("/status", handlePortalStatus);
            portalServer.on("/scan",   handlePortalScan);
            portalServer.onNotFound(   handlePortalRoot);
            portalServer.begin();
            fallbackAPActive = true;
        }

        if (fallbackAPActive) {
            dnsServer.processNextRequest();
            portalServer.handleClient();
        }
    } else {
        // WiFi connected
        if (fallbackAPActive) {
            Serial.println(F("WiFi reconnected — shutting down fallback AP."));
            WiFi.softAPdisconnect(true);
            dnsServer.stop();
            WiFi.mode(WIFI_STA);
            fallbackAPActive = false;
        }
        wifiOfflineSinceMs = 0;

        if (!clockSynced) {
            syncClock();
            clockSynced = (time(nullptr) > 100000);
            if (clockSynced && have_rtc) {
                rtc.adjust(DateTime((uint32_t)time(nullptr)));
                Serial.println(F("DS3231M: synced from NTP."));
            }
            registerDeviceIfNeeded();
        }
    }

    // ── SGP41 must be ticked at ~1 Hz for the gas-index algorithm ────────────
    if (millis() - lastSgpTickAt >= 1000) {
        lastSgpTickAt = millis();
        tickSgp41();
    }

    // ── Main reading cycle ────────────────────────────────────────────────────
    if (millis() - lastReadAt >= READ_INTERVAL_MS) {
        lastReadAt = millis();

        if ((cycleCounter++ % REPROBE_EVERY_N) == 0) setupSensors();

        StaticJsonDocument<1024> doc;
        readAll(doc);

        String body;
        serializeJson(doc, body);
        Serial.println(body);

        // Always archive to SD (if available) regardless of WiFi state.
        archiveToSD(body);

        if (WiFi.status() == WL_CONNECTED && postReading(body)) {
            flushBuffer();
        } else {
            bufferReading(body);
        }
    }
}

// =============================================================================
// BATTERY-SAVER HELPERS
// =============================================================================
void doOneMeasurementCycle() {
    setupSensors();
    delay(200);

    const unsigned long windowStart  = millis();
    unsigned long       lastWifiKick = 0;
    unsigned long       lastClockTry = 0;

    for (uint8_t r = 0; r < AWAKE_READINGS; ++r) {
        const unsigned long dueAt =
            (unsigned long)(r + 1) * (unsigned long)READING_GAP_SECS * 1000UL;

        while (millis() - windowStart < dueAt) {
            tickSgp41();

            if (WiFi.status() != WL_CONNECTED) {
                if (millis() - lastWifiKick > 30000UL) {
                    lastWifiKick = millis();
                    Serial.println(F("WiFi down mid-window — retrying..."));
                    WiFi.begin(cfg.wifiSsid.c_str(), cfg.wifiPass.c_str());
                }
            } else if (!clockSynced && millis() - lastClockTry > 30000UL) {
                lastClockTry = millis();
                syncClock();
                clockSynced = (time(nullptr) > 100000);
                if (clockSynced && have_rtc) {
                    rtc.adjust(DateTime((uint32_t)time(nullptr)));
                    Serial.println(F("DS3231M: synced mid-window."));
                }
                registerDeviceIfNeeded();
            }
            delay(1000);
            yield();
        }

        if ((r % REPROBE_EVERY_N) == 0) setupSensors();

        StaticJsonDocument<1024> doc;
        readAll(doc);

        String body;
        serializeJson(doc, body);
        Serial.println(body);

        archiveToSD(body);

        if (WiFi.status() == WL_CONNECTED && clockSynced && postReading(body)) {
            flushBuffer();
        } else {
            bufferReading(body);
        }
    }
}

void goToDeepSleep() {
    // ESP32-S3 deep sleep — wakes via internal RTC timer, no external jumper.
    uint64_t us = (uint64_t)SLEEP_DURATION_MIN * 60ULL * 1000000ULL;
    Serial.printf("Sleeping %d min — wakes via RTC timer.\n", SLEEP_DURATION_MIN);
    Serial.flush();
    esp_sleep_enable_timer_wakeup(us);
    esp_deep_sleep_start();   // does not return
}

// =============================================================================
// SENSOR INIT
// =============================================================================
void setupSensors() {
    // Each probe flushes Serial first so a crash mid-init is easy to spot:
    // the last "Probing..." line without a result is where it died.

    if (!have_aht) {
        Serial.print(F("Probing AHT20  ... ")); Serial.flush();
        have_aht = aht.begin();
        Serial.println(have_aht ? F("OK") : F("not found"));
    }

    if (!have_dps) {
        Serial.print(F("Probing DPS310 ... ")); Serial.flush();
        have_dps = dps.begin_I2C(0x77) || dps.begin_I2C(0x76);
        if (have_dps) {
            dps.configurePressure(DPS310_64HZ, DPS310_64SAMPLES);
            dps.configureTemperature(DPS310_64HZ, DPS310_64SAMPLES);
        }
        Serial.println(have_dps ? F("OK") : F("not found"));
    }

    if (!have_sgp41) {
        Serial.print(F("Probing SGP41  ... ")); Serial.flush();
        sgp41.begin(Wire);
        uint16_t sn[3];
        have_sgp41 = (sgp41.getSerialNumber(sn) == 0);
        Serial.println(have_sgp41 ? F("OK") : F("not found"));
    }

    if (!have_hm3301) {
        // The Seeed HM3301 library may call Wire.begin() internally with default
        // pins on some versions. Re-assert our pin config immediately after init
        // to prevent a bus conflict on ESP32-S3.
        Serial.print(F("Probing HM3301 ... ")); Serial.flush();
        int hm_err = hm3301.init();
        Wire.begin(PIN_SDA, PIN_SCL);   // re-assert in case library clobbered it
        Wire.setClock(50000);
        have_hm3301 = (hm_err == NO_ERROR);
        Serial.println(have_hm3301 ? F("OK") : F("not found"));
    }

    if (!have_rtc) {
        Serial.print(F("Probing DS3231M... ")); Serial.flush();
        have_rtc = rtc.begin(&Wire);
        if (have_rtc) {
            if (rtc.lostPower()) {
                Serial.println(F("OK (lost power — will sync from NTP)"));
            } else {
                Serial.println(F("OK (battery-backed time valid)"));
            }
        } else {
            Serial.println(F("not found"));
        }
    }

    // Water sensor — analog read, no init needed beyond setting ADC mode.
    // GPIO1 = ADC1_CH0 on ESP32-S3 — fully supported by analogRead().
    pinMode(PIN_WATER, INPUT);
    analogSetAttenuation(ADC_11db);   // full 0–3.3V range for 12-bit read
    Serial.println(F("Water  : ready (analog GPIO1)"));
}

// =============================================================================
// SGP41 TICK  (call every ~1 second)
// =============================================================================
void tickSgp41() {
    if (!have_sgp41) return;

    // Compensation values from AHT20; defaults to 25°C / 50% RH if unavailable.
    uint16_t rhTicks = 0x8000;
    uint16_t tTicks  = 0x6666;
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
        if (err != 0) Serial.printf("SGP41 conditioning err=%u\n", err);
        sgpConditioningSecs++;
        if (sgpConditioningSecs == 10)
            Serial.println(F("SGP41: conditioning complete."));
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

// =============================================================================
// TIMESTAMP HELPER
// Returns the best available Unix timestamp:
//   1. NTP-synced system clock (most accurate)
//   2. DS3231M hardware RTC (accurate after at least one NTP sync)
//   3. 0 (buffered, will be backfilled on flush)
// =============================================================================
uint32_t getTimestamp() {
    time_t t = time(nullptr);
    if (t > 1000000000UL) return (uint32_t)t;   // NTP good

    if (have_rtc) {
        DateTime now = rtc.now();
        uint32_t ts = now.unixtime();
        if (ts > 1000000000UL) return ts;         // RTC battery-backed time good
    }

    return 0;   // neither source ready — will be backfilled at flush
}

// =============================================================================
// READ ALL SENSORS
// =============================================================================
bool readAll(StaticJsonDocument<1024>& doc) {
    doc["device_id"] = deviceId;
    doc["ts"]        = getTimestamp();
    JsonObject s     = doc.createNestedObject("sensors");

    // ── AHT20 (temperature + humidity) ───────────────────────────────────────
    {
        JsonObject t = s.createNestedObject("temperature");
        JsonObject h = s.createNestedObject("humidity");
        if (have_aht) {
            sensors_event_t humEvt, tempEvt;
            if (aht.getEvent(&humEvt, &tempEvt)) {
                // Send Fahrenheit — dashboard expects °F
                t["value"]  = tempEvt.temperature * 9.0F / 5.0F + 32.0F;
                t["unit"]   = "F";
                t["status"] = "ok";
                h["value"]  = humEvt.relative_humidity;
                h["unit"]   = "%";
                h["status"] = "ok";
            } else {
                t["status"] = "error";
                h["status"] = "error";
            }
        } else {
            t["status"] = "disconnected";
            h["status"] = "disconnected";
        }
    }

    // ── DPS310 (barometric pressure) ──────────────────────────────────────────
    {
        JsonObject p = s.createNestedObject("pressure");
        if (have_dps) {
            sensors_event_t pressureEvt;
            if (dps.pressureAvailable() && dps.getEvents(NULL, &pressureEvt)) {
                float hpa = pressureEvt.pressure;
                if (isnan(hpa) || hpa < 300 || hpa > 1200) {
                    p["status"] = "error";
                    have_dps = false;
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

    // ── SGP41 (VOC + NOx) ─────────────────────────────────────────────────────
    {
        JsonObject v = s.createNestedObject("voc");
        JsonObject n = s.createNestedObject("nox");
        if (!have_sgp41) {
            v["status"] = "disconnected";
            n["status"] = "disconnected";
        } else if (!sgpReady) {
            v["status"] = "ok"; v["value"] = 0; v["unit"] = "index";
            n["status"] = "ok"; n["value"] = 0; n["unit"] = "index";
        } else {
            v["value"] = cachedVocIdx; v["unit"] = "index"; v["status"] = "ok";
            n["value"] = cachedNoxIdx; n["unit"] = "index"; n["status"] = "ok";
        }
    }

    // ── HM3301 (PM2.5) ────────────────────────────────────────────────────────
    {
        JsonObject pm = s.createNestedObject("pm25");
        if (!have_hm3301) {
            have_hm3301 = (hm3301.init() == NO_ERROR);   // late re-probe
        }
        if (have_hm3301) {
            uint8_t buf[30];
            if (hm3301.read_sensor_value(buf, 29) == NO_ERROR) {
                uint16_t pm25 = (buf[10] << 8) | buf[11];   // atmospheric PM2.5
                pm["value"]  = pm25;
                pm["unit"]   = "ug/m3";
                pm["status"] = "ok";
            } else {
                pm["status"] = "error";
                have_hm3301 = false;
            }
        } else {
            pm["status"] = "disconnected";
        }
    }

    // ── Water sensor (analog, GPIO1) ──────────────────────────────────────────
    // ESP32-S3 ADC is 12-bit (0–4095). Higher = wetter.
    {
        JsonObject w = s.createNestedObject("water");
        int raw = analogRead(PIN_WATER);
        w["value"]  = raw;
        w["unit"]   = "raw";
        w["status"] = "ok";
        w["state"]  = (raw <= WATER_RAIN_THRESHOLD) ? "raining" : "clear";
    }

    return true;
}

// =============================================================================
// NETWORKING
// =============================================================================
bool connectToWifi() {
    WiFi.persistent(false);
    WiFi.setAutoReconnect(true);
    WiFi.mode(WIFI_STA);
    WiFi.disconnect(true);
    delay(100);
    WiFi.setHostname(deviceId.c_str());
    WiFi.begin(cfg.wifiSsid.c_str(), cfg.wifiPass.c_str());
    Serial.printf("Joining WiFi '%s'", cfg.wifiSsid.c_str());
    for (int i = 0; i < 20 && WiFi.status() != WL_CONNECTED; ++i) {
        delay(500);
        Serial.print('.');
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
        Serial.print(F("IP: "));
        Serial.println(WiFi.localIP());
        return true;
    }
    Serial.printf("WiFi failed (status=%d)\n", WiFi.status());
    return false;
}

void syncClock() {
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");
    Serial.print(F("Waiting for NTP"));
    time_t now = time(nullptr);
    for (int i = 0; i < 30 && now < 100000; ++i) {
        delay(500);
        Serial.print('.');
        now = time(nullptr);
    }
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
    WiFiClientSecure tlsClient;
    WiFiClient       plainClient;
    bool beganOk = false;
    if (url.startsWith("https://")) {
        tlsClient.setInsecure();
        beganOk = http.begin(tlsClient, url);
    } else {
        beganOk = http.begin(plainClient, url);
    }
    if (!beganOk) { Serial.println(F("http.begin failed (register)")); return false; }
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
    WiFiClientSecure tlsClient;
    WiFiClient       plainClient;
    bool beganOk = false;
    if (url.startsWith("https://")) {
        tlsClient.setInsecure();
        beganOk = http.begin(tlsClient, url);
    } else {
        beganOk = http.begin(plainClient, url);
    }
    if (!beganOk) { Serial.println(F("http.begin failed (reading)")); return false; }
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Device-Id",    deviceId);
    http.addHeader("X-Device-Token", cfg.deviceToken);
    int code = http.POST(body);
    http.end();
    Serial.printf("POST /api/readings -> %d\n", code);
    return code >= 200 && code < 300;
}

// =============================================================================
// SD CARD ARCHIVE
// One JSONL file per calendar day: /log/YYYY-MM-DD.jsonl
// Silently skips if no SD card present.
// =============================================================================
void archiveToSD(const String& body) {
    if (!have_sd) return;

    // Build a date-stamped filename from RTC or system time.
    String filename;
    if (have_rtc) {
        DateTime now = rtc.now();
        char buf[32];
        snprintf(buf, sizeof(buf), "/log/%04d-%02d-%02d.jsonl",
                 now.year(), now.month(), now.day());
        filename = String(buf);
    } else {
        time_t t = time(nullptr);
        if (t > 1000000000UL) {
            struct tm* tm_info = gmtime(&t);
            char buf[32];
            snprintf(buf, sizeof(buf), "/log/%04d-%02d-%02d.jsonl",
                     tm_info->tm_year + 1900,
                     tm_info->tm_mon + 1,
                     tm_info->tm_mday);
            filename = String(buf);
        } else {
            filename = "/log/unknown.jsonl";   // no time source yet
        }
    }

    // Create /log directory if needed.
    if (!SD.exists("/log")) SD.mkdir("/log");

    File f = SD.open(filename, FILE_APPEND);
    if (!f) {
        Serial.println(F("SD archive: failed to open file"));
        return;
    }
    f.println(body);
    f.close();
}

// =============================================================================
// OFFLINE BUFFER (LittleFS)
// =============================================================================
void bufferReading(const String& body) {
    File f = LittleFS.open(BUFFER_FILE, "a");
    if (!f) { Serial.println(F("Buffer open failed")); return; }
    if (f.size() > MAX_BUFFER_BYTES) {
        Serial.println(F("Buffer full — dropping oldest."));
        f.close();
        LittleFS.remove(BUFFER_FILE);
        f = LittleFS.open(BUFFER_FILE, "a");
    }
    f.println(body);
    f.close();
    Serial.println(F("Reading buffered to LittleFS."));
}

void flushBuffer() {
    if (!LittleFS.exists(BUFFER_FILE)) return;

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

    const uint32_t nowSec        = getTimestamp();
    const uint32_t readingGapSec = (uint32_t)READING_GAP_SECS;
    const uint32_t sleepGapSec   = (uint32_t)SLEEP_DURATION_MIN * 60UL
                                 + (uint32_t)READING_GAP_SECS;
    const bool     clockOk       = (nowSec > 1000000000UL);

    File f = LittleFS.open(BUFFER_FILE, "r");
    if (!f) return;

    int   flushed = 0, idx = 0;
    bool  allOk   = true;
    String line;

    while (f.available()) {
        line = f.readStringUntil('\n');
        line.trim();
        if (line.length() == 0) continue;

        StaticJsonDocument<1024> doc;
        DeserializationError err = deserializeJson(doc, line);
        if (!err) {
            uint32_t ts = doc["ts"] | 0UL;
            if (clockOk && ts < 1000000000UL) {
                uint32_t hopsBack   = (uint32_t)(totalReadings - idx);
                uint32_t sleepsBack = (hopsBack - 1) / (uint32_t)AWAKE_READINGS;
                doc["ts"] = nowSec
                           - hopsBack * readingGapSec
                           - sleepsBack * (sleepGapSec - readingGapSec);
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
        Serial.printf("Buffer flushed: %d readings sent.\n", flushed);
    } else {
        Serial.printf("Flush interrupted after %d readings — retry next cycle.\n", flushed);
    }
}

// =============================================================================
// CONFIG PERSISTENCE
// =============================================================================
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
    Serial.println(F("Config loaded."));
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
    if (!f) { Serial.println(F("Failed to save config!")); return; }
    serializeJson(d, f);
    f.close();
    Serial.println(F("Config saved."));
}

// =============================================================================
// CAPTIVE PORTAL
// =============================================================================
const char PORTAL_HTML[] PROGMEM = R"rawhtml(
<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClimateSignal Setup</title>
<style>
  body{font-family:Arial,sans-serif;max-width:420px;margin:40px auto;padding:20px;background:#f0f4f8}
  h2{color:#1a73e8;margin-bottom:4px}
  p.sub{color:#555;font-size:13px;margin-top:0 0 20px}
  label{display:block;font-size:13px;color:#333;margin-bottom:2px;margin-top:12px}
  input,select{width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;
    box-sizing:border-box;font-size:15px;background:#fff}
  button{width:100%;padding:13px;background:#1a73e8;color:#fff;border:none;
    border-radius:8px;font-size:16px;cursor:pointer;margin-top:20px}
  button:active{background:#1558b0}
  .note{font-size:12px;color:#888;margin-top:18px;text-align:center}
  #networks{display:none}
</style></head><body>
<h2>🌤 ClimateSignal Setup</h2>
<p class="sub">Connect to your WiFi network and enter the pairing code from your dashboard.</p>
<form method="POST" action="/save">
  <label>WiFi Network
    <input type="text" name="ssid" id="ssid" placeholder="Network name" required autocomplete="off">
  </label>
  <label>WiFi Password
    <input type="password" name="pass" placeholder="Leave blank for open networks">
  </label>
  <label>Pairing Code
    <input type="text" name="code" placeholder="6-character code (e.g. AB3K7M)" required
           maxlength="6" style="text-transform:uppercase;letter-spacing:3px">
  </label>
  <label>Location Name <span style="color:#888">(optional)</span>
    <input type="text" name="loc" placeholder="e.g. School Rooftop">
  </label>
  <label>Latitude <span style="color:#888">(optional)</span>
    <input type="number" name="lat" step="0.0001" placeholder="e.g. 38.9072">
  </label>
  <label>Longitude <span style="color:#888">(optional)</span>
    <input type="number" name="lng" step="0.0001" placeholder="e.g. -77.0369">
  </label>
  <button type="submit">Save &amp; Connect</button>
</form>
<p class="note">Connected to WeatherNode AP &bull; open 192.168.4.1 in your browser</p>
<script>
  // Auto-fill SSID by scanning nearby networks
  fetch('/scan').then(r=>r.json()).then(nets=>{
    if(!nets.length) return;
    const sel = document.createElement('select');
    sel.onchange = e => document.getElementById('ssid').value = e.target.value;
    const blank = document.createElement('option');
    blank.text='— select a network —'; sel.add(blank);
    nets.sort((a,b)=>b.rssi-a.rssi).forEach(n=>{
      const o=document.createElement('option');
      o.value=n.ssid; o.text=n.ssid+(n.open?' (open)':'');
      sel.add(o);
    });
    const lbl=document.createElement('label');
    lbl.style.marginTop='12px';
    lbl.innerHTML='<span style="font-size:13px;color:#333">Nearby Networks</span>';
    lbl.appendChild(sel);
    document.querySelector('form').insertBefore(lbl,document.querySelector('[name=ssid]').parentNode);
  }).catch(()=>{});
</script>
</body></html>
)rawhtml";

void printPortalBanner(const String& apName, const IPAddress& ip) {
    Serial.println();
    Serial.println(F("┌─────────────────────────────────────────┐"));
    Serial.println(F("│         SETUP PORTAL IS ACTIVE          │"));
    Serial.println(F("├─────────────────────────────────────────┤"));
    Serial.print(  F("│  WiFi name : "));
    Serial.print(apName);
    for (int i = apName.length(); i < 27; i++) Serial.print(' ');
    Serial.println(F(" │"));
    Serial.print(  F("│  Password  : corefutures16             │\n"));
    Serial.print(  F("│  Then open : http://"));
    Serial.print(ip);
    Serial.println(F("            │"));
    Serial.println(F("└─────────────────────────────────────────┘"));
    Serial.println();
}

void startProvisioningPortal() {
    inProvisioningMode = true;
    WiFi.mode(WIFI_AP);
    String apName = "WeatherNode-" + macSuffix();
    WiFi.softAP(apName.c_str(), AP_PASSWORD);
    delay(500);   // softAP needs a moment before softAPIP() is valid
    IPAddress ip = WiFi.softAPIP();
    printPortalBanner(apName, ip);
    dnsServer.start(DNS_PORT, "*", ip);
    portalServer.on("/",       handlePortalRoot);
    portalServer.on("/save",   HTTP_POST, handlePortalSave);
    portalServer.on("/status", handlePortalStatus);
    portalServer.on("/scan",   handlePortalScan);
    portalServer.onNotFound(   handlePortalRoot);
    portalServer.begin();
}

void handlePortalRoot() {
    portalServer.send_P(200, "text/html", PORTAL_HTML);
}

void handlePortalStatus() {
    String j = "{\"deviceId\":\"" + deviceId + "\"}";
    portalServer.send(200, "application/json", j);
}

void handlePortalScan() {
    WiFi.mode(WIFI_AP_STA);
    int n = WiFi.scanNetworks(false, true);
    String j = "[";
    for (int i = 0; i < n; i++) {
        if (i) j += ",";
        String ssid = WiFi.SSID(i);
        ssid.replace("\"", "\\\"");
        j += "{\"ssid\":\"" + ssid + "\",";
        j += "\"rssi\":"  + String(WiFi.RSSI(i)) + ",";
        j += "\"open\":"  + String(WiFi.encryptionType(i) == WIFI_AUTH_OPEN
                                   ? "true" : "false") + "}";
    }
    j += "]";
    WiFi.scanDelete();
    WiFi.mode(WIFI_AP);
    portalServer.send(200, "application/json", j);
}

void handlePortalSave() {
    cfg.wifiSsid     = portalServer.arg("ssid");
    cfg.wifiPass     = portalServer.arg("pass");
    cfg.pairingCode  = portalServer.arg("code");
    cfg.pairingCode.toUpperCase();
    cfg.locationName = portalServer.arg("loc");
    cfg.latitude     = portalServer.arg("lat").toFloat();
    cfg.longitude    = portalServer.arg("lng").toFloat();
    cfg.deviceToken  = "";   // force re-register with new pairing code
    saveConfig();
    portalServer.send(200, "application/json",
        "{\"ok\":true,\"message\":\"Saved. Rebooting...\"}");
    delay(1500);
    ESP.restart();
}

// =============================================================================
// UTIL
// =============================================================================
String macSuffix() {
    // Read from the hardware eFuse base MAC — always the same regardless of
    // whether WiFi is in STA, AP, or AP+STA mode (WiFi.macAddress() shifts
    // the last byte in AP mode, causing the ID and AP name to differ).
    uint8_t mac[6];
    esp_efuse_mac_get_default(mac);
    char buf[7];
    snprintf(buf, sizeof(buf), "%02X%02X%02X", mac[3], mac[4], mac[5]);
    return String(buf);
}
