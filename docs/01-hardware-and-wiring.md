# 01 — Hardware & Wiring

## Bill of materials (per node)

| # | Part | Why | Where to buy |
|---|------|-----|--------------|
| 1 | ESP8266 dev board (NodeMCU v3 or Wemos D1 Mini) | Main microcontroller | Seeed Studio / AliExpress / local |
| 2 | Grove Base Shield for NodeMCU (or Grove cables if using D1 Mini) | Gives you Grove sockets | Seeed Studio |
| 3 | Grove AHT20 Temp & Humidity sensor | Temperature, humidity | Seeed Studio |
| 4 | Grove SGP41 VOC and NOx Gas sensor | Air quality (gases) | Seeed Studio |
| 5 | Grove HM3301 Laser PM2.5 sensor | Air quality (particulates) | Seeed Studio |
| 6 | Grove BMP280 Barometer (or similar I²C pressure sensor) | Atmospheric pressure | Seeed Studio |
| 7 | Grove Water Sensor | Detects rain / moisture | Seeed Studio |
| 8 | 6 V / 2 W solar panel | Recharges battery | Any electronics shop |
| 9 | 3.7 V 2000 mAh LiPo battery with JST connector | Power when sun is down | Any electronics shop |
| 10 | TP4056 solar charge board **with protection** | Safely charges the LiPo from the panel | Search "TP4056 solar" |
| 11 | IP65 weatherproof enclosure (small plastic box with rubber gasket) | Keeps electronics dry | Hardware shop |
| 12 | Cable glands & Gore-Tex vents | Cable entry + breathing hole for air sensors | Hardware shop |

## Sensor addresses / pins

All four I²C sensors share the same two wires (SDA, SCL). The Grove base connects them correctly for you, but it helps to know:

| Sensor | Interface | Address / Pin |
|--------|-----------|---------------|
| AHT20  | I²C | 0x38 |
| BMP280 | I²C | 0x76 or 0x77 |
| SGP41  | I²C | 0x59 |
| HM3301 | I²C | 0x40 |
| Water  | Analog | A0 |

On a NodeMCU, Grove I²C sockets route to D1 (SCL / GPIO5) and D2 (SDA / GPIO4).

## Plug everything in

1. Push the Grove Base Shield onto the NodeMCU.
2. Plug the AHT20, SGP41, BMP280, HM3301 into any of the **I²C** Grove sockets.
3. Plug the water sensor into the **A0** (analog) Grove socket.
4. Do not power it on yet. Continue to [02-firmware-setup.md](02-firmware-setup.md).

## Power wiring (you can do this after software is working)

```
Solar panel (+/-) ──► TP4056 IN+/IN−
TP4056 BAT+/BAT− ──► LiPo battery
TP4056 OUT+/OUT− ──► NodeMCU Vin / GND
```

Always connect the battery to the TP4056 BEFORE you connect the solar panel, otherwise some TP4056 boards mis-calibrate the charge current.

## Tips for the enclosure

- Mount air-quality sensors so they face a vent (not sealed inside), otherwise you're just measuring the air trapped in the box.
- Drill the cable gland and vent holes on the bottom so rain can't run in.
- Solar panel on top angled toward the equator.

When all parts are plugged in (but before sealing the enclosure), move on to flashing the firmware.
