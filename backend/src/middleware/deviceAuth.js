const bcrypt = require('bcryptjs');
const Device = require('../models/Device');

// The ESP8266 sends X-Device-Id + X-Device-Token on every /api/readings POST.
// We look up the Device by deviceId and bcrypt-compare the token hash.
module.exports = async function requireDevice(req, res, next) {
  try {
    const deviceId = req.headers['x-device-id'];
    const token    = req.headers['x-device-token'];
    if (!deviceId || !token) return res.status(401).json({ error: 'missing_device_credentials' });

    const device = await Device.findOne({ deviceId });
    if (!device || !device.deviceTokenHash) return res.status(401).json({ error: 'unknown_device' });

    const ok = await bcrypt.compare(token, device.deviceTokenHash);
    if (!ok) return res.status(401).json({ error: 'bad_device_token' });

    req.device = device;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'device_auth_failed' });
  }
};
