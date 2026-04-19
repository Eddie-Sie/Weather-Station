const router  = require('express').Router();
const Reading = require('../models/Reading');
const requireDevice = require('../middleware/deviceAuth');

// POST a single reading OR an array of readings (for buffer flush).
// Body shape (from firmware):
//   { device_id, ts (epoch seconds), sensors: { ... } }
router.post('/', requireDevice, async (req, res, next) => {
  try {
    const payloads = Array.isArray(req.body) ? req.body : [req.body];
    const docs = payloads.map(p => ({
      device:   req.device._id,
      deviceId: req.device.deviceId,
      ts:       p.ts ? new Date(p.ts * 1000) : new Date(),
      sensors:  p.sensors || {},
      buffered: payloads.length > 1,
    }));
    await Reading.insertMany(docs, { ordered: false });

    // Update lastSeen + per-sensor status on the device
    const last = docs[docs.length - 1];
    const statusSnap = {};
    for (const [k, v] of Object.entries(last.sensors || {})) statusSnap[k] = v.status || 'ok';
    req.device.lastSeenAt = new Date();
    req.device.lastStatus = statusSnap;
    await req.device.save();

    res.json({ ok: true, accepted: docs.length });
  } catch (e) { next(e); }
});

module.exports = router;
