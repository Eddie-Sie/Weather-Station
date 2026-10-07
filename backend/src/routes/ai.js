const router  = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const https   = require('https');
const Device  = require('../models/Device');
const Reading = require('../models/Reading');
const Report  = require('../models/Report');
const { requireUser } = require('../middleware/auth');

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// ─── helpers ───────────────────────────────────────────────────────────────

// Simple HTTPS GET that returns parsed JSON. No extra dependencies needed.
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ClimateSignal/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

// Fetch current + 7-day forecast from Open-Meteo for a lat/lon pair.
// Returns a compact string Claude can read.
async function fetchOpenMeteo(lat, lon, locationLabel) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,wind_speed_10m,weather_code` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=7`;

  const d = await httpsGet(url);
  const c = d.current;
  const daily = d.daily;

  // WMO weather code → plain English
  const wmoDesc = (code) => {
    if (code === 0) return 'clear sky';
    if (code <= 3) return 'partly cloudy';
    if (code <= 49) return 'foggy';
    if (code <= 59) return 'drizzle';
    if (code <= 69) return 'rain';
    if (code <= 79) return 'snow';
    if (code <= 84) return 'rain showers';
    if (code <= 94) return 'thunderstorm';
    return 'severe thunderstorm';
  };

  const lines = [
    `=== Global weather for ${locationLabel} (lat ${lat}, lon ${lon}) ===`,
    `Source: Open-Meteo (real-time). Data as of ${c.time} local time.`,
    `Current: ${c.temperature_2m}°F, feels like ${c.apparent_temperature}°F, ` +
      `humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} mph, ` +
      `conditions: ${wmoDesc(c.weather_code)}, precipitation ${c.precipitation} mm`,
    ``,
    `7-day forecast:`,
  ];
  for (let i = 0; i < (daily.time || []).length; i++) {
    lines.push(
      `  ${daily.time[i]}: high ${daily.temperature_2m_max[i]}°F, ` +
      `low ${daily.temperature_2m_min[i]}°F, ` +
      `precip ${daily.precipitation_sum[i]} mm, ` +
      `${wmoDesc(daily.weather_code[i])}`
    );
  }
  return lines.join('\n');
}

// Geocode a city name → {lat, lon, name} using Open-Meteo's free geocoding API.
async function geocodeCity(cityName) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=en&format=json`;
  const d = await httpsGet(url);
  if (!d.results || d.results.length === 0) return null;
  const r = d.results[0];
  return { lat: r.latitude, lon: r.longitude, name: `${r.name}, ${r.country}` };
}

// Build the station's own historical context: last 30 days, bucketed by day.
// This replaces the old 7-day aggregate so Claude can answer per-day questions
// like "was Monday hotter than Tuesday?" or "what was the temp 10 days ago?"
async function buildStationContext(device) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);   // last 30 days
  const recent = await Reading.find({ device: device._id, ts: { $gte: since } })
                              .sort({ ts: 1 })   // oldest first so daily buckets are in order
                              .limit(10000);

  if (recent.length === 0) return null;   // null = no station data at all

  const SENSOR_KEYS = ['temperature','humidity','pressure','voc','nox','pm25','water'];

  // ── bucket readings into calendar days (UTC) ─────────────────────────────
  const buckets = {};   // "YYYY-MM-DD" → { key: [values] }
  for (const r of recent) {
    const day = r.ts.toISOString().slice(0, 10);   // e.g. "2026-10-01"
    if (!buckets[day]) buckets[day] = {};
    for (const k of SENSOR_KEYS) {
      const s = r.sensors?.[k];
      if (s && s.status === 'ok' && typeof s.value === 'number') {
        if (!buckets[day][k]) buckets[day][k] = [];
        buckets[day][k].push(s.value);
      }
    }
  }

  // ── compute per-day averages ──────────────────────────────────────────────
  const avg = (arr) => arr.length ? +(arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(2) : null;
  const dailyRows = Object.entries(buckets)
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([day, data]) => {
      const row = { date: day };
      for (const k of SENSOR_KEYS) row[k] = data[k] ? avg(data[k]) : null;
      return row;
    });

  // ── latest reading ────────────────────────────────────────────────────────
  const latest = recent[recent.length - 1];

  return [
    `=== Station data: ${device.deviceId} at ${device.locationName || 'unknown location'} ===`,
    device.latitude && device.longitude
      ? `GPS: lat ${device.latitude}, lon ${device.longitude}`
      : `GPS: not set`,
    `Total readings in last 30 days: ${recent.length}`,
    `Latest reading: ${latest.ts.toISOString()}`,
    JSON.stringify(latest.sensors, null, 2),
    ``,
    `Daily averages (last 30 days, null = no data that day):`,
    JSON.stringify(dailyRows, null, 2),
  ].join('\n');
}

// ─── Tool definitions for Claude ───────────────────────────────────────────
// Claude can call these when the user asks about global weather or a specific
// location. We handle the actual HTTP calls here on the server side.
const WEATHER_TOOLS = [
  {
    name: 'get_weather_by_coords',
    description: 'Get current weather and 7-day forecast for a specific latitude/longitude from Open-Meteo. Use this when the user asks about the weather at the station\'s own location, or when you already have coordinates.',
    input_schema: {
      type: 'object',
      properties: {
        lat:   { type: 'number', description: 'Latitude' },
        lon:   { type: 'number', description: 'Longitude' },
        label: { type: 'string', description: 'Human-readable location name to include in the response' },
      },
      required: ['lat', 'lon', 'label'],
    },
  },
  {
    name: 'get_weather_by_city',
    description: 'Look up a city by name, then fetch its current weather and 7-day forecast. Use this when the user asks about weather in a named city or region anywhere in the world.',
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City or place name, e.g. "Accra", "Washington DC", "London"' },
      },
      required: ['city'],
    },
  },
];

// Execute a tool call Claude requested and return the result string.
async function runTool(toolName, toolInput) {
  try {
    if (toolName === 'get_weather_by_coords') {
      return await fetchOpenMeteo(toolInput.lat, toolInput.lon, toolInput.label);
    }
    if (toolName === 'get_weather_by_city') {
      const geo = await geocodeCity(toolInput.city);
      if (!geo) return `Could not find location: "${toolInput.city}". Try a more specific name.`;
      return await fetchOpenMeteo(geo.lat, geo.lon, geo.name);
    }
    return 'Unknown tool.';
  } catch (e) {
    return `Weather lookup failed: ${e.message}`;
  }
}

// POST /api/ai/query  { deviceId, messages: [{role, content}], question }
router.post('/query', requireUser, async (req, res, next) => {
  try {
    const { deviceId, messages = [], question } = req.body;
    if (!question) return res.status(400).json({ error: 'question_required' });

    const filter = req.user.role === 'admin' ? { _id: deviceId } : { _id: deviceId, owner: req.user._id };
    const device = await Device.findOne(filter);
    if (!device) return res.status(404).json({ error: 'not_found' });

    // Build station context (30-day daily buckets). May be null if no data yet.
    const stationContext = await buildStationContext(device);

    // If the station has GPS coords, tell Claude upfront so it can use the
    // coord-based tool without needing to geocode the same location.
    const coordHint = (device.latitude && device.longitude)
      ? `Station GPS: lat=${device.latitude}, lon=${device.longitude} (use get_weather_by_coords for local weather lookups).`
      : `Station GPS: not set (use get_weather_by_city if the user asks about weather in a named location).`;

    const system = `You are an environmental data assistant for a ClimateSignal weather station.
You help users understand their own station's readings AND can look up global weather data for any location.

RULES:
- When the user asks about their station's readings (temperature, humidity, pressure, air quality, etc.), answer from the STATION DATA below. Cite specific dates and numbers.
- When the user asks about weather anywhere in the world, or at the station's location right now (current/forecast), use the weather tools.
- If the station has recorded data for that location, compare station readings to the global weather when helpful.
- Do NOT say "I don't have enough data" when station data is present — use it. Only say so if the specific date range or sensor is genuinely absent from the data.
- Be concise. Cite numbers. Use natural language, not raw JSON.

${coordHint}

${stationContext
  ? `STATION DATA:\n${stationContext}`
  : `STATION DATA: No readings recorded yet for this device.`}`;

    // ── Agentic loop: Claude may call tools before giving a final answer ──────
    // This works like this:
    // 1. We send Claude the user's question + tools it can call.
    // 2. If Claude calls a tool (weather lookup), we run it and send the result back.
    // 3. We repeat until Claude gives a plain text answer (stop_reason = 'end_turn').
    const conversationMessages = [...messages, { role: 'user', content: question }];
    let answer = '';
    let loopMessages = [...conversationMessages];

    for (let attempt = 0; attempt < 5; attempt++) {   // safety limit: max 5 tool calls
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system,
        tools: WEATHER_TOOLS,
        messages: loopMessages,
      });

      if (response.stop_reason === 'end_turn') {
        // Claude is done — extract the text answer.
        answer = response.content.find(b => b.type === 'text')?.text || '';
        break;
      }

      if (response.stop_reason === 'tool_use') {
        // Claude wants to call one or more tools. Run each one and collect results.
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
        const toolResults = [];

        for (const block of toolUseBlocks) {
          const result = await runTool(block.name, block.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }

        // Append Claude's tool-call turn + our tool results to the loop.
        loopMessages = [
          ...loopMessages,
          { role: 'assistant', content: response.content },
          { role: 'user',      content: toolResults },
        ];
        continue;
      }

      // Any other stop reason (max_tokens etc.) — break with whatever text exists.
      answer = response.content.find(b => b.type === 'text')?.text || '';
      break;
    }

    res.json({ answer });
  } catch (e) { next(e); }
});

// POST /api/ai/reports  { deviceId, title, messages }
// Creates a Report document and asks Claude to write a 1-paragraph summary.
router.post('/reports', requireUser, async (req, res, next) => {
  try {
    const { deviceId, title, messages } = req.body;
    if (!deviceId || !title || !Array.isArray(messages)) return res.status(400).json({ error: 'bad_request' });

    const filter = req.user.role === 'admin' ? { _id: deviceId } : { _id: deviceId, owner: req.user._id };
    const device = await Device.findOne(filter);
    if (!device) return res.status(404).json({ error: 'not_found' });

    const transcript = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
    let summary = '';
    try {
      const resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 400,
        system: 'Summarise the following weather-station chat into one short executive-summary paragraph a non-technical reader can understand. No preamble, just the summary.',
        messages: [{ role: 'user', content: transcript }],
      });
      summary = resp.content?.[0]?.text || '';
    } catch (_) { /* non-fatal */ }

    const report = await Report.create({
      owner: req.user._id, device: device._id, title, summary, messages,
    });
    res.json({ report });
  } catch (e) { next(e); }
});

// POST /api/ai/reports/:id/email   { to: "someone@example.com" }
router.post('/reports/:id/email', requireUser, async (req, res, next) => {
  try {
    const { to } = req.body;
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'bad_email' });

    const filter = req.user.role === 'admin' ? { _id: req.params.id } : { _id: req.params.id, owner: req.user._id };
    const report = await Report.findOne(filter).populate('device');
    if (!report) return res.status(404).json({ error: 'not_found' });

    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '465'),
      secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const transcriptHtml = report.messages
      .map(m => `<p><strong>${m.role === 'user' ? 'You' : 'Assistant'}:</strong><br>${escapeHtml(m.content).replace(/\n/g,'<br>')}</p>`)
      .join('\n');

    const html = `
      <h2>${escapeHtml(report.title)}</h2>
      <p><strong>Device:</strong> ${escapeHtml(report.device.locationName || report.device.deviceId)}<br>
         <strong>Filed:</strong> ${new Date(report.createdAt).toLocaleString()}</p>
      ${report.summary ? `<h3>Summary</h3><p>${escapeHtml(report.summary)}</p>` : ''}
      <h3>Conversation</h3>${transcriptHtml}
      <hr><p style="color:#777;font-size:12px">Sent from the Community Weather Station dashboard.</p>`;

    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: `Weather report: ${report.title}`,
      html,
    });

    report.emailedTo = [...(report.emailedTo || []), to];
    report.emailedAt = new Date();
    await report.save();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/ai/reports?deviceId=...   list previous reports for a device
router.get('/reports', requireUser, async (req, res, next) => {
  try {
    const { deviceId } = req.query;
    const filter = { owner: req.user._id };
    if (deviceId) filter.device = deviceId;
    if (req.user.role === 'admin') delete filter.owner;
    const reports = await Report.find(filter).sort({ createdAt: -1 }).limit(100);
    res.json({ reports });
  } catch (e) { next(e); }
});

function escapeHtml(s='') {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

module.exports = router;
