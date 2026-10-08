import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceArea } from 'recharts';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../../lib/api';

const SENSOR_LABELS = {
  temperature: 'Temperature',
  humidity:    'Humidity',
  pressure:    'Pressure',
  voc:         'VOC Index',
  nox:         'NOx Index',
  pm25:        'PM2.5',
  water:       'Water',
};

// Fixed y-axis ranges chosen for *visualisation*, not for sensor validation.
// The firmware's sanity-check ranges are intentionally wider (e.g. 300–1200 hPa
// to reject clearly broken readings); here we tighten each axis to the typical
// real-world range so day-to-day variation is actually visible on the chart.
const Y_RANGES = {
  temperature: [0, 130],    // °F, broad ambient range
  humidity:    [0, 100],    // %RH, natural full range
  pressure:    [300, 1200], // hPa, matches the firmware's full sanity-check range
  voc:         [0, 500],    // Sensirion gas index (full scale)
  nox:         [0, 5],      // NOx index zoomed to typical clean-air range
  pm25:        [0, 100],    // ug/m3
  water:       [0, 1023],   // raw ADC
};

// ── Colour-zone definitions ───────────────────────────────────────────────────
// Each sensor gets an array of { y1, y2, color, opacity } bands rendered as
// ReferenceArea behind the line. Sensors with dynamic line colouring (voc, nox,
// pm25, water) instead get a ZONES_LINE entry: an array of { max, color } thresholds
// applied per-segment so the line itself changes colour.

const ZONES_BG = {
  temperature: [
    { y1: 0,   y2: 50,  color: '#3b82f6', opacity: 0.08 },  // cold – blue
    { y1: 50,  y2: 85,  color: '#22c55e', opacity: 0.10 },  // comfortable – green
    { y1: 85,  y2: 100, color: '#f59e0b', opacity: 0.12 },  // hot – amber
    { y1: 100, y2: 130, color: '#ef4444', opacity: 0.14 },  // dangerous – red
  ],
  humidity: [
    { y1: 0,  y2: 30,  color: '#3b82f6', opacity: 0.08 },   // too dry – blue
    { y1: 30, y2: 60,  color: '#22c55e', opacity: 0.10 },   // ideal – green
    { y1: 60, y2: 80,  color: '#f59e0b', opacity: 0.12 },   // uncomfortable – amber
    { y1: 80, y2: 100, color: '#ef4444', opacity: 0.14 },   // oppressive – red
  ],
  pressure: [
    { y1: 300,  y2: 980,  color: '#ef4444', opacity: 0.10 }, // storm – red
    { y1: 980,  y2: 1000, color: '#f59e0b', opacity: 0.10 }, // watch low – amber
    { y1: 1000, y2: 1020, color: '#22c55e', opacity: 0.10 }, // normal – green
    { y1: 1020, y2: 1040, color: '#f59e0b', opacity: 0.10 }, // watch high – amber
    { y1: 1040, y2: 1200, color: '#ef4444', opacity: 0.10 }, // extreme – red
  ],
};

// For voc, nox, pm25, water: return a line stroke colour based on the value.
function zoneColor(key, value) {
  if (value == null) return '#94a3b8';
  if (key === 'voc' || key === 'nox') {
    if (value <= 100) return '#22c55e';
    if (value <= 200) return '#f59e0b';
    if (value <= 300) return '#f97316';
    return '#ef4444';
  }
  if (key === 'pm25') {
    if (value <= 12)  return '#22c55e';
    if (value <= 35)  return '#f59e0b';
    if (value <= 55)  return '#f97316';
    return '#ef4444';
  }
  if (key === 'water') {
    return value >= 400 ? '#3b82f6' : '#22c55e';
  }
  return '#0b3d91';
}

// Zone legend items shown below each chart that has background bands.
const ZONE_LEGENDS = {
  temperature: [
    { label: 'Cold (<50°F)',        color: '#3b82f6' },
    { label: 'Comfortable (50–85)', color: '#22c55e' },
    { label: 'Hot (85–100)',        color: '#f59e0b' },
    { label: 'Dangerous (>100)',    color: '#ef4444' },
  ],
  humidity: [
    { label: 'Too dry (<30%)',      color: '#3b82f6' },
    { label: 'Ideal (30–60)',       color: '#22c55e' },
    { label: 'Uncomfortable (60–80)', color: '#f59e0b' },
    { label: 'Oppressive (>80)',    color: '#ef4444' },
  ],
  pressure: [
    { label: 'Normal (1000–1020)', color: '#22c55e' },
    { label: 'Watch',              color: '#f59e0b' },
    { label: 'Extreme / Storm',    color: '#ef4444' },
  ],
  voc:  [
    { label: 'Good (≤100)',    color: '#22c55e' },
    { label: 'Moderate (≤200)', color: '#f59e0b' },
    { label: 'Poor (≤300)',    color: '#f97316' },
    { label: 'Unhealthy',      color: '#ef4444' },
  ],
  nox:  [
    { label: 'Good (≤100)',    color: '#22c55e' },
    { label: 'Moderate (≤200)', color: '#f59e0b' },
    { label: 'Poor (≤300)',    color: '#f97316' },
    { label: 'Unhealthy',      color: '#ef4444' },
  ],
  pm25: [
    { label: 'Good (≤12 µg/m³)',   color: '#22c55e' },
    { label: 'Moderate (≤35)',     color: '#f59e0b' },
    { label: 'Sensitive (≤55)',    color: '#f97316' },
    { label: 'Unhealthy (>55)',    color: '#ef4444' },
  ],
  water: [
    { label: 'Clear',   color: '#22c55e' },
    { label: 'Raining', color: '#3b82f6' },
  ],
};

// Keys shown as tiles on the Live tab. `airquality` is the synthetic combined
// rating (Good/Moderate/Poor/Unhealthy/Severe) derived from voc + nox; `voc`
// and `nox` show the raw Sensirion index values alongside it so students can
// see both the headline rating and the underlying numbers. PM2.5 is the
// HM3301 particulate reading in µg/m³.
const LIVE_TILE_KEYS = ['temperature', 'humidity', 'pressure', 'airquality', 'voc', 'nox', 'pm25', 'water'];
const LIVE_TILE_LABELS = { ...SENSOR_LABELS, airquality: 'Air Quality' };

// Generate explicit X-axis tick timestamps at every midnight (00:00) and
// every noon (12:00) inside the visible data range. The tickFormatter below
// renders midnight ticks as the date (e.g. "May 11") and noon ticks as "12h",
// giving the History charts the date / 12h / next-date / 12h cadence.
function ticksEvery12h(min, max) {
  if (!min || !max || max - min < 60 * 60 * 1000) return undefined; // <1h: let Recharts auto-pick
  const HALF_DAY = 12 * 60 * 60 * 1000;
  const start = new Date(min);
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() < 12 ? 0 : 12);
  let t = start.getTime();
  const ticks = [];
  while (t <= max) {
    if (t >= min) ticks.push(t);
    t += HALF_DAY;
  }
  return ticks.length > 0 ? ticks : undefined;
}

function format12hTick(t) {
  const d = new Date(t);
  const h = d.getHours();
  // Exact midnight: show the date (e.g. "May 12").
  if (h === 0) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  // Exact noon: show "12h" as the user requested.
  if (h === 12) return '12h';
  // Any other tick (Recharts auto-picks these when our generated tick array
  // is empty — i.e. the data range doesn't cross a midnight or noon yet).
  // Show the time of day as e.g. "14h" so labels carry real meaning instead
  // of all reading the same.
  return `${h}h`;
}

// Pretty-print sensor units. Firmware sends plain "F" / "C" / "%" — we map
// the thermal ones to include the degree symbol so the tile reads naturally.
function displayUnit(u) {
  if (u === 'F') return '°F';
  if (u === 'C') return '°C';
  return u || '';
}

function airQualityFromSensors(sensors) {
  const voc = sensors?.voc;
  const nox = sensors?.nox;
  // Both sensors disconnected → tile is disconnected
  if ((!voc || voc.status === 'disconnected') && (!nox || nox.status === 'disconnected')) {
    return { status: 'disconnected' };
  }
  if (voc?.status === 'error' && nox?.status === 'error') {
    return { status: 'error' };
  }
  const vocIdx = typeof voc?.value === 'number' ? voc.value : 0;
  const noxIdx = typeof nox?.value === 'number' ? nox.value : 0;
  // SGP41 gas-index algorithm returns 0 during the 1–3 minute warmup.
  if (vocIdx === 0 && noxIdx === 0) {
    return { status: 'ok', label: 'Warming up', tone: 'bg-slate-100 text-slate-600', idx: null };
  }
  // Combined AQ = worst of the two (higher index = worse air).
  const idx = Math.max(vocIdx, noxIdx);
  if (idx <= 100) return { status: 'ok', label: 'Good',       tone: 'bg-green-100 text-green-800',   idx };
  if (idx <= 200) return { status: 'ok', label: 'Moderate',   tone: 'bg-yellow-100 text-yellow-800', idx };
  if (idx <= 300) return { status: 'ok', label: 'Poor',       tone: 'bg-orange-100 text-orange-800', idx };
  if (idx <= 400) return { status: 'ok', label: 'Unhealthy',  tone: 'bg-red-100 text-red-800',       idx };
  return            { status: 'ok', label: 'Severe',     tone: 'bg-rose-200 text-rose-900',     idx };
}

export default function DevicePage() {
  const router = useRouter();
  const { id } = router.query;

  const [tab, setTab] = useState('live');
  const [device, setDevice] = useState(null);
  const [latest, setLatest] = useState(null);
  const [history, setHistory] = useState([]);
  const [err, setErr] = useState('');

  async function load() {
    try {
      const { device, latest } = await api(`/api/devices/${id}/latest`);
      setDevice(device); setLatest(latest);
      if (tab === 'history') {
        const { readings } = await api(`/api/devices/${id}/history?limit=500`);
        setHistory(readings);
      }
    } catch (e) { setErr(e.message); }
  }

  useEffect(() => {
    if (!id) return;
    load();
    const i = setInterval(load, 15000);    // refresh every 15s
    return () => clearInterval(i);
  }, [id, tab]);

  function exportCsv() {
    // Resolve the viewer's local timezone (IANA name, e.g. "Africa/Accra" or
    // "America/New_York"). The CSV is written in that timezone so the times
    // match the user's wall clock — the DB still stores UTC, which is correct.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

    // Format a JS Date as "YYYY-MM-DD HH:MM:SS" in the local timezone. This
    // is the format Excel and Google Sheets auto-recognise as a datetime.
    const fmtLocal = (d) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
             `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const rows = [['timestamp_local', 'timezone', ...Object.keys(SENSOR_LABELS)]];
    for (const r of history) {
      rows.push([
        fmtLocal(new Date(r.ts)),
        tz,
        ...Object.keys(SENSOR_LABELS).map(k => r.sensors?.[k]?.value ?? ''),
      ]);
    }
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Add today's local date to the filename so successive exports don't overwrite.
    const today = fmtLocal(new Date()).slice(0, 10);
    a.download = `${device?.deviceId || 'device'}-readings-${today}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (err)      return <div className="p-6">Error: {err} <Link href="/dashboard" className="underline">back</Link></div>;
  if (!device)  return <div className="p-6">Loading...</div>;

  const sensors = latest?.sensors || {};

  return (
    <div className="min-h-screen p-6 max-w-5xl mx-auto">
      <header className="mb-6">
        <Link href="/dashboard" className="text-sm text-blue-900 underline">&larr; Back to devices</Link>
        <h1 className="text-2xl font-bold text-blue-900 mt-1">{device.locationName || device.deviceId}</h1>
        <p className="text-sm text-slate-600">Device ID: {device.deviceId || '(not yet connected)'}</p>
        {device.latitude && device.longitude && <p className="text-sm text-slate-600">GPS: {device.latitude}, {device.longitude}</p>}
        {latest?.ts && <p className="text-sm text-slate-600">Last reading: {new Date(latest.ts).toLocaleString()}</p>}
      </header>

      <div className="flex gap-2 mb-4">
        <button onClick={() => setTab('live')}      className={`px-4 py-2 rounded ${tab==='live'      ? 'bg-blue-900 text-white' : 'bg-slate-200'}`}>Live</button>
        <button onClick={() => setTab('history')}   className={`px-4 py-2 rounded ${tab==='history'   ? 'bg-blue-900 text-white' : 'bg-slate-200'}`}>History</button>
        <button onClick={() => setTab('assistant')} className={`px-4 py-2 rounded ${tab==='assistant' ? 'bg-blue-900 text-white' : 'bg-slate-200'}`}>Assistant</button>
        <button onClick={() => setTab('settings')}  className={`px-4 py-2 rounded ${tab==='settings'  ? 'bg-blue-900 text-white' : 'bg-slate-200'}`}>Settings</button>
      </div>

      {tab === 'assistant' && <AssistantPanel deviceId={id} deviceLabel={device.locationName || device.deviceId} />}
      {tab === 'settings'  && <SettingsPanel  deviceId={id} device={device} onSaved={load} />}

      {tab === 'live' && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {LIVE_TILE_KEYS.map(k => {
            const isWater = k === 'water';
            const isAq    = k === 'airquality';
            const s = isAq ? airQualityFromSensors(sensors) : (sensors[k] || { status: 'disconnected' });
            const bg = s.status === 'ok'
              ? (isWater && s.state === 'raining' ? 'bg-blue-50' : 'bg-white')
              : s.status === 'error' ? 'bg-red-50' : 'bg-slate-100 opacity-70';
            return (
              <div key={k} className={`rounded-xl shadow p-4 ${bg}`}>
                <p className="text-xs uppercase text-slate-500">{LIVE_TILE_LABELS[k]}</p>
                {s.status === 'ok' ? (
                  isAq ? (
                    <div className="mt-1">
                      <span className={`inline-block rounded px-2 py-1 text-lg font-bold ${s.tone}`}>{s.label}</span>
                      {s.idx != null && <p className="text-xs text-slate-400 mt-2">Index: {s.idx}  (higher = worse)</p>}
                    </div>
                  ) : isWater ? (
                    <div className="mt-1">
                      <p className="text-2xl font-bold">
                        {(s.state || (typeof s.value === 'number' && s.value >= 400 ? 'raining' : 'clear')) === 'raining'
                          ? '🌧️ Raining'
                          : '☀️ Clear'}
                      </p>
                      <p className="text-xs text-slate-400 mt-1">raw: {s.value}</p>
                    </div>
                  ) : (
                    <p className="text-2xl font-bold">{formatValue(k, s.value)} <span className="text-sm font-normal text-slate-500">{displayUnit(s.unit)}</span></p>
                  )
                ) : (
                  <p className="text-sm font-semibold text-slate-500 mt-1">{s.status}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'history' && (
        <div>
          <div className="flex justify-end mb-3">
            <button onClick={exportCsv} className="bg-blue-900 text-white rounded px-4 py-2 text-sm">Export CSV</button>
          </div>
          {Object.keys(SENSOR_LABELS).map(k => {
            const data = history
              .map(r => ({
                ts: new Date(r.ts).getTime(),
                value: typeof r.sensors?.[k]?.value === 'number' ? r.sensors[k].value : null,
              }))
              .sort((a, b) => a.ts - b.ts);

            const bgZones  = ZONES_BG[k] || [];
            const legends  = ZONE_LEGENDS[k] || [];
            // For sensors without bg zones, derive line colour from the latest value.
            const useDynLine = !ZONES_BG[k];
            const latestVal  = data.filter(d => d.value != null).slice(-1)[0]?.value ?? null;
            const lineColor  = useDynLine ? zoneColor(k, latestVal) : '#0b3d91';

            return (
              <div key={k} className="bg-white rounded-xl shadow p-4 mb-4">
                <h3 className="font-semibold mb-1">{SENSOR_LABELS[k]}</h3>

                {/* Zone legend */}
                {legends.length > 0 && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2">
                    {legends.map(l => (
                      <span key={l.label} className="flex items-center gap-1 text-xs text-slate-500">
                        <span style={{ display:'inline-block', width:10, height:10, borderRadius:2, background:l.color }} />
                        {l.label}
                      </span>
                    ))}
                  </div>
                )}

                <div style={{ width: '100%', height: 180 }}>
                  <ResponsiveContainer>
                    <LineChart data={data}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />

                      {/* Background colour bands */}
                      {bgZones.map((z, i) => (
                        <ReferenceArea key={i} y1={z.y1} y2={z.y2}
                          fill={z.color} fillOpacity={z.opacity} ifOverflow="hidden" />
                      ))}

                      <XAxis
                        dataKey="ts"
                        type="number"
                        domain={['dataMin', 'dataMax']}
                        scale="time"
                        ticks={ticksEvery12h(data[0]?.ts, data[data.length - 1]?.ts)}
                        tickFormatter={format12hTick}
                        tick={{ fontSize: 11, fill: '#64748b' }}
                      />
                      <YAxis
                        domain={Y_RANGES[k] || ['auto', 'auto']}
                        allowDataOverflow
                        tick={{ fontSize: 11, fill: '#64748b' }}
                        width={42}
                      />
                      <Tooltip
                        labelFormatter={t => new Date(t).toLocaleString()}
                        contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
                      />
                      <Line
                        type="monotone"
                        dataKey="value"
                        dot={false}
                        stroke={lineColor}
                        strokeWidth={2}
                        isAnimationActive={false}
                        connectNulls={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            );
          })}
          <details className="bg-white rounded-xl shadow p-4">
            <summary className="cursor-pointer font-semibold">Raw readings table ({history.length})</summary>
            <div className="overflow-auto max-h-96 mt-2">
              <table className="w-full text-xs">
                <thead className="bg-slate-100"><tr>
                  <th className="p-1 text-left">Time</th>
                  {Object.keys(SENSOR_LABELS).map(k => <th key={k} className="p-1 text-left">{SENSOR_LABELS[k]}</th>)}
                </tr></thead>
                <tbody>
                  {history.map(r => (
                    <tr key={r._id} className="border-t">
                      <td className="p-1">{new Date(r.ts).toLocaleString()}</td>
                      {Object.keys(SENSOR_LABELS).map(k => (
                        <td key={k} className="p-1">{r.sensors?.[k]?.status === 'ok' ? formatValue(k, r.sensors[k].value) : '—'}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

// -------- Settings tab --------
function SettingsPanel({ deviceId, device, onSaved }) {
  const [locationName, setLocationName] = useState(device.locationName || '');
  const [lat, setLat]                   = useState(device.latitude  != null ? String(device.latitude)  : '');
  const [lon, setLon]                   = useState(device.longitude != null ? String(device.longitude) : '');
  const [geoStatus, setGeoStatus]       = useState('');
  const [saving,    setSaving]          = useState(false);
  const [saved,     setSaved]           = useState(false);
  const [err,       setErr]             = useState('');

  async function useMyLocation() {
    if (!navigator.geolocation) {
      setGeoStatus('error:Geolocation is not supported by this browser.');
      return;
    }

    // Check permission state before trying — avoids silent failures when
    // the user previously clicked "Block" and the browser won't ask again.
    if (navigator.permissions) {
      try {
        const perm = await navigator.permissions.query({ name: 'geolocation' });
        if (perm.state === 'denied') {
          setGeoStatus('error:Location access is blocked. To fix it: click the 🔒 lock icon in your browser\'s address bar → Site settings → Location → Allow, then refresh the page and try again.');
          return;
        }
      } catch (_) { /* permissions API not supported — carry on */ }
    }

    setGeoStatus('loading:Getting your location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(6));
        setLon(pos.coords.longitude.toFixed(6));
        setGeoStatus('success:Location filled in — click Save to store it.');
      },
      (error) => {
        const msgs = {
          1: 'error:Location access was denied. Click the 🔒 lock icon in your browser\'s address bar → Site settings → Location → Allow, then refresh and try again.',
          2: 'error:Your device couldn\'t determine its position. Make sure location services are enabled in your phone/computer settings.',
          3: 'error:Timed out waiting for location. Move to an area with better GPS signal and try again.',
        };
        setGeoStatus(msgs[error.code] || 'error:Could not get location: ' + error.message);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true); setErr(''); setSaved(false);
    try {
      await api(`/api/devices/${deviceId}`, {
        method: 'PATCH',
        body: {
          locationName,
          latitude:  lat  !== '' ? parseFloat(lat)  : null,
          longitude: lon  !== '' ? parseFloat(lon)  : null,
        },
      });
      setSaved(true);
      onSaved();   // re-fetch device so header GPS line updates
    } catch (e) { setErr(e.message); }
    setSaving(false);
  }

  return (
    <div className="bg-white rounded-xl shadow p-5 max-w-lg">
      <h2 className="font-semibold text-lg mb-4">Device settings</h2>
      <form onSubmit={save} className="space-y-4">

        <div>
          <label className="block text-sm font-medium mb-1">Location name</label>
          <input className="border rounded p-2 w-full"
                 value={locationName} onChange={e => setLocationName(e.target.value)}
                 placeholder="e.g. Community Center Kumasi" />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">GPS coordinates</label>
          <p className="text-xs text-slate-500 mb-2">
            Used by the AI assistant to fetch local weather forecasts. You can type them manually or click
            "Use my location" to fill them automatically.
          </p>
          <div className="flex gap-2 mb-2">
            <input className="border rounded p-2 flex-1" placeholder="Latitude  (e.g. 6.6885)"
                   value={lat} onChange={e => setLat(e.target.value)} />
            <input className="border rounded p-2 flex-1" placeholder="Longitude (e.g. -1.6244)"
                   value={lon} onChange={e => setLon(e.target.value)} />
          </div>
          <button type="button" onClick={useMyLocation}
                  className="text-sm bg-slate-100 hover:bg-slate-200 border rounded px-3 py-1.5">
            📍 Use my location
          </button>
          {geoStatus && (() => {
            const [type, ...rest] = geoStatus.split(':');
            const msg = rest.join(':');
            const styles = {
              error:   'text-red-600 bg-red-50 border border-red-200',
              success: 'text-green-700 bg-green-50 border border-green-200',
              loading: 'text-slate-500',
            };
            return (
              <p className={`text-xs mt-2 rounded px-2 py-1 ${styles[type] || 'text-slate-600'}`}>
                {type === 'error' ? '⚠️ ' : type === 'success' ? '✓ ' : ''}{msg}
              </p>
            );
          })()}
        </div>

        <div className="flex items-center gap-3">
          <button disabled={saving}
                  className="bg-blue-900 text-white rounded px-5 py-2 font-semibold disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved && <span className="text-green-700 text-sm">Saved ✓</span>}
          {err   && <span className="text-red-600  text-sm">{err}</span>}
        </div>
      </form>
    </div>
  );
}

function formatValue(key, v) {
  if (v == null) return '—';
  if (typeof v !== 'number') return v;
  if (key === 'temperature' || key === 'pressure') return v.toFixed(1);
  return Math.round(v);
}

// -------- Assistant tab --------
function AssistantPanel({ deviceId, deviceLabel }) {
  const [messages, setMessages] = useState([]);   // [{role:'user'|'assistant', content}]
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Report / email state
  const [reportTitle, setReportTitle] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [savedReport, setSavedReport] = useState(null);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('');

  async function send(e) {
    e?.preventDefault();
    if (!input.trim()) return;
    const question = input.trim();
    setInput('');
    setErr('');
    setBusy(true);
    const nextMsgs = [...messages, { role: 'user', content: question }];
    setMessages(nextMsgs);
    try {
      const { answer } = await api('/api/ai/query', {
        method: 'POST',
        body: { deviceId, messages, question },
      });
      setMessages([...nextMsgs, { role: 'assistant', content: answer }]);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  async function fileReport() {
    setErr(''); setStatus('Saving report...');
    try {
      const { report } = await api('/api/ai/reports', {
        method: 'POST',
        body: { deviceId, title: reportTitle || `Report for ${deviceLabel}`, messages },
      });
      setSavedReport(report);
      setStatus('Report saved. Enter an email address to send it.');
    } catch (e) { setErr(e.message); setStatus(''); }
  }

  async function sendEmail() {
    if (!savedReport) return;
    setErr(''); setStatus('Sending email...');
    try {
      await api(`/api/ai/reports/${savedReport._id}/email`, { method: 'POST', body: { to: email } });
      setStatus(`Sent to ${email}.`);
    } catch (e) { setErr(e.message); setStatus(''); }
  }

  return (
    <div className="bg-white rounded-xl shadow p-4">
      <p className="text-sm text-slate-600 mb-3">
        Ask anything about <strong>{deviceLabel}</strong>'s readings. The assistant sees the last 30 days of data for this device, and can look up live weather anywhere in the world.
      </p>

      <div className="border rounded p-3 h-80 overflow-auto bg-slate-50 mb-3">
        {messages.length === 0 && (
          <p className="text-sm text-slate-400">
            Try: "Was today hotter than yesterday?" &middot; "Is the air quality safe right now?" &middot; "Any sensor acting up this week?"
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`mb-3 ${m.role === 'user' ? 'text-right' : ''}`}>
            {m.role === 'user' ? (
              <div className="inline-block rounded-lg px-3 py-2 max-w-[85%] whitespace-pre-wrap text-sm bg-blue-900 text-white">
                {m.content}
              </div>
            ) : (
              <div className="inline-block rounded-lg px-3 py-2 max-w-[85%] text-sm bg-white border text-left ai-message">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
              </div>
            )}
          </div>
        ))}
        {busy && <p className="text-sm text-slate-500">Thinking...</p>}
      </div>

      <form onSubmit={send} className="flex gap-2">
        <input className="border rounded p-2 flex-1" placeholder="Ask a question..."
               value={input} onChange={e => setInput(e.target.value)} disabled={busy} />
        <button className="bg-blue-900 text-white rounded px-4">Send</button>
      </form>

      {err && <p className="text-red-600 text-sm mt-2">{err}</p>}

      <div className="mt-5 border-t pt-4">
        {!showReport ? (
          <button disabled={messages.length === 0}
                  onClick={() => setShowReport(true)}
                  className="bg-emerald-700 text-white rounded px-4 py-2 text-sm disabled:opacity-40">
            File a report from this conversation
          </button>
        ) : (
          <div className="space-y-2">
            <label className="block text-sm font-semibold">Report title</label>
            <input className="border rounded p-2 w-full"
                   placeholder={`Report for ${deviceLabel}`}
                   value={reportTitle} onChange={e => setReportTitle(e.target.value)} />

            {!savedReport ? (
              <button onClick={fileReport} className="bg-emerald-700 text-white rounded px-4 py-2 text-sm">Save report</button>
            ) : (
              <div className="flex gap-2">
                <input className="border rounded p-2 flex-1" type="email" placeholder="send-to@example.com"
                       value={email} onChange={e => setEmail(e.target.value)} />
                <button onClick={sendEmail} className="bg-blue-900 text-white rounded px-4 py-2 text-sm">Email it</button>
              </div>
            )}
            {status && <p className="text-sm text-slate-600">{status}</p>}
          </div>
        )}
      </div>
    </div>
  );
}