const router  = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const Device  = require('../models/Device');
const Reading = require('../models/Reading');
const Report  = require('../models/Report');
const { requireUser } = require('../middleware/auth');

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// Summarises recent readings into a compact context block we can feed Claude.
async function buildContext(device) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);   // last 7 days
  const recent = await Reading.find({ device: device._id, ts: { $gte: since } })
                              .sort({ ts: -1 }).limit(2000);
  if (recent.length === 0) return 'No readings recorded yet for this device.';

  // Compute simple stats per sensor
  const keys = ['temperature','humidity','pressure','voc','nox','pm25','water'];
  const stats = {};
  for (const k of keys) {
    const vals = recent.map(r => r.sensors?.[k])
                       .filter(s => s && s.status === 'ok' && typeof s.value === 'number')
                       .map(s => s.value);
    if (vals.length === 0) { stats[k] = 'no data'; continue; }
    const min = Math.min(...vals), max = Math.max(...vals);
    const avg = vals.reduce((a,b)=>a+b,0) / vals.length;
    stats[k] = { min: +min.toFixed(2), max: +max.toFixed(2), avg: +avg.toFixed(2), samples: vals.length };
  }

  const latest = recent[0];
  return [
    `Device: ${device.deviceId} at ${device.locationName || 'unknown location'}`,
    `Readings window: last 7 days, ${recent.length} samples.`,
    `Latest reading at ${latest.ts.toISOString()}:`,
    JSON.stringify(latest.sensors, null, 2),
    `7-day stats per sensor:`,
    JSON.stringify(stats, null, 2),
  ].join('\n');
}

// POST /api/ai/query  { deviceId, messages: [{role, content}], question }
router.post('/query', requireUser, async (req, res, next) => {
  try {
    const { deviceId, messages = [], question } = req.body;
    if (!question) return res.status(400).json({ error: 'question_required' });

    const filter = req.user.role === 'admin' ? { _id: deviceId } : { _id: deviceId, owner: req.user._id };
    const device = await Device.findOne(filter);
    if (!device) return res.status(404).json({ error: 'not_found' });

    const context = await buildContext(device);

    const system = `You are an environmental data assistant attached to a specific weather-station device.
Help the user understand their readings, spot trends, and draft reports.
Be concise, cite specific numbers from the context, and say "I don't have enough data" if a question can't be answered from it.

DEVICE CONTEXT:
${context}`;

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages: [...messages, { role: 'user', content: question }],
    });
    const answer = response.content?.[0]?.text || '';
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
