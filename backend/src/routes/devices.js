const router   = require('express').Router();
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const Device   = require('../models/Device');
const Reading  = require('../models/Reading');
const { requireUser, requireAdmin } = require('../middleware/auth');

function randomCode(n = 6) {
  // Pairing codes: human-typeable, no ambiguous chars
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// ---- USER SIDE ----------------------------------------------------------------

// List my devices (or with ?all=1 and admin role, list all devices)
router.get('/', requireUser, async (req, res, next) => {
  try {
    const filter = (req.query.all === '1' && req.user.role === 'admin') ? {} : { owner: req.user._id };
    const devices = await Device.find(filter).populate('owner', 'email name').sort({ createdAt: -1 });
    res.json({ devices });
  } catch (e) { next(e); }
});

// Generate a new pairing code — the user pastes this into the captive portal
router.post('/', requireUser, async (req, res, next) => {
  try {
    const { locationName } = req.body;
    let code, exists;
    do { code = randomCode(6); exists = await Device.findOne({ pairingCode: code }); } while (exists);
    const device = await Device.create({
      owner: req.user._id,
      pairingCode: code,
      locationName: locationName || '',
    });
    res.json({ device });
  } catch (e) { next(e); }
});

// Update location name / coords after the fact
router.patch('/:id', requireUser, async (req, res, next) => {
  try {
    const filter = req.user.role === 'admin' ? { _id: req.params.id } : { _id: req.params.id, owner: req.user._id };
    const device = await Device.findOneAndUpdate(
      filter,
      { $set: {
        ...(req.body.locationName !== undefined ? { locationName: req.body.locationName } : {}),
        ...(req.body.latitude     !== undefined ? { latitude:     req.body.latitude }     : {}),
        ...(req.body.longitude    !== undefined ? { longitude:    req.body.longitude }    : {}),
      } },
      { new: true }
    );
    if (!device) return res.status(404).json({ error: 'not_found' });
    res.json({ device });
  } catch (e) { next(e); }
});

// Latest reading for a device
router.get('/:id/latest', requireUser, async (req, res, next) => {
  try {
    const filter = req.user.role === 'admin' ? { _id: req.params.id } : { _id: req.params.id, owner: req.user._id };
    const device = await Device.findOne(filter);
    if (!device) return res.status(404).json({ error: 'not_found' });
    const latest = await Reading.findOne({ device: device._id }).sort({ ts: -1 });
    res.json({ device, latest });
  } catch (e) { next(e); }
});

// Paginated history — default: last 500 readings newest first
router.get('/:id/history', requireUser, async (req, res, next) => {
  try {
    const filter = req.user.role === 'admin' ? { _id: req.params.id } : { _id: req.params.id, owner: req.user._id };
    const device = await Device.findOne(filter);
    if (!device) return res.status(404).json({ error: 'not_found' });

    const q = { device: device._id };
    if (req.query.from) q.ts = { ...(q.ts || {}), $gte: new Date(req.query.from) };
    if (req.query.to)   q.ts = { ...(q.ts || {}), $lte: new Date(req.query.to)   };

    const limit = Math.min(parseInt(req.query.limit) || 500, 5000);
    const readings = await Reading.find(q).sort({ ts: -1 }).limit(limit);
    res.json({ readings });
  } catch (e) { next(e); }
});

// Delete a device (and optionally its readings)
router.delete('/:id', requireUser, async (req, res, next) => {
  try {
    const filter = req.user.role === 'admin' ? { _id: req.params.id } : { _id: req.params.id, owner: req.user._id };
    const device = await Device.findOneAndDelete(filter);
    if (!device) return res.status(404).json({ error: 'not_found' });
    await Reading.deleteMany({ device: device._id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- DEVICE SIDE (unauthenticated, uses pairing code) -------------------------

// Called by the ESP8266 right after it connects to WiFi for the first time.
router.post('/register', async (req, res, next) => {
  try {
    const { device_id, pairing_code, location_name, latitude, longitude } = req.body;
    if (!device_id || !pairing_code) return res.status(400).json({ error: 'missing_fields' });

    const device = await Device.findOne({ pairingCode: pairing_code.toUpperCase() });
    if (!device) return res.status(404).json({ error: 'unknown_pairing_code' });

    // If this pairing code was already used by another device, refuse.
    if (device.deviceId && device.deviceId !== device_id) {
      return res.status(409).json({ error: 'pairing_code_already_used' });
    }

    // Issue a fresh token (always, so re-registration rotates it)
    const rawToken = crypto.randomBytes(24).toString('hex');
    device.deviceId        = device_id;
    device.deviceTokenHash = await bcrypt.hash(rawToken, 10);
    device.pairingUsedAt   = device.pairingUsedAt || new Date();
    if (location_name) device.locationName = location_name;
    if (latitude)      device.latitude     = latitude;
    if (longitude)     device.longitude    = longitude;
    device.lastSeenAt = new Date();
    await device.save();

    res.json({ ok: true, token: rawToken });
  } catch (e) { next(e); }
});

module.exports = router;
