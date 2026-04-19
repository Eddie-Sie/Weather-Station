#pragma once

// Captive-portal HTML served from the ESP8266 when the device has no saved
// WiFi. Kept as a PROGMEM string so it doesn't eat RAM.
static const char PORTAL_HTML[] PROGMEM = R"HTML(
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weather Node Setup</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 440px; margin: 0 auto; padding: 18px; background:#f7f8fa; color:#111; }
  h1 { color:#0b3d91; font-size:20px; }
  label { display:block; margin-top:12px; font-weight:600; font-size:14px; }
  input { width:100%; padding:10px; border:1px solid #cbd0d6; border-radius:6px; font-size:15px; margin-top:4px; box-sizing:border-box; }
  button { width:100%; margin-top:18px; padding:12px; background:#0b3d91; color:white; border:0; border-radius:6px; font-size:16px; font-weight:600; }
  button.secondary { background:#555; margin-top:8px; }
  .muted { color:#555; font-size:13px; }
  .ok { color:#176b30; }
  .err { color:#a01044; }
  .row { display:flex; gap:8px; }
  .row > * { flex:1; }
</style>
</head>
<body>
<h1>Weather Node Setup</h1>
<p class="muted">Fill out this form to connect this device to your WiFi and bind it to your dashboard account.</p>

<form id="f">
  <label>WiFi network name (SSID)</label>
  <input name="ssid" required placeholder="e.g. CommunityCenter-WiFi">

  <label>WiFi password</label>
  <input name="pass" type="password" placeholder="leave empty for open networks">

  <label>Pairing code (from your dashboard)</label>
  <input name="code" required maxlength="12" placeholder="e.g. A7X9QM" style="text-transform:uppercase">

  <label>Location name</label>
  <input name="loc" required placeholder="e.g. Community Center Kumasi">

  <label>GPS coordinates (optional but recommended)</label>
  <div class="row">
    <input name="lat" id="lat" placeholder="latitude"  step="any">
    <input name="lng" id="lng" placeholder="longitude" step="any">
  </div>
  <button type="button" class="secondary" onclick="getGps()">Use my phone's GPS</button>
  <p id="gpsMsg" class="muted"></p>

  <button type="submit">Save &amp; connect</button>
</form>

<p id="msg"></p>

<script>
function getGps() {
  const m = document.getElementById('gpsMsg');
  if (!navigator.geolocation) { m.textContent = 'Geolocation not supported on this phone.'; return; }
  m.textContent = 'Getting location...';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      document.getElementById('lat').value = pos.coords.latitude.toFixed(6);
      document.getElementById('lng').value = pos.coords.longitude.toFixed(6);
      m.textContent = 'Location captured.';
      m.className = 'ok';
    },
    (err) => { m.textContent = 'Could not get GPS: ' + err.message; m.className = 'err'; },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = new FormData(e.target);
  const body = new URLSearchParams(data).toString();
  const msg = document.getElementById('msg');
  msg.textContent = 'Saving...';
  try {
    const r = await fetch('/save', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
    const j = await r.json();
    msg.textContent = j.message || 'Saved.';
    msg.className = 'ok';
  } catch (err) {
    msg.textContent = 'Error: ' + err;
    msg.className = 'err';
  }
});
</script>
</body>
</html>
)HTML";
