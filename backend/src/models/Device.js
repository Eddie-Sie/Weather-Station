const mongoose = require('mongoose');

/*
 * A Device is claimed in two steps:
 *   1. A logged-in user clicks "Add device" and we create a Device doc with
 *      a freshly generated pairingCode but no deviceId yet.
 *   2. The ESP8266 POSTs /api/devices/register with that pairingCode. We set
 *      its deviceId + deviceTokenHash and return a plain deviceToken. From then
 *      on the device authenticates every POST /api/readings using that token.
 */
const DeviceSchema = new mongoose.Schema({
  owner:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  deviceId:        { type: String, unique: true, sparse: true, index: true },
  pairingCode:     { type: String, required: true, unique: true, index: true },
  pairingUsedAt:   { type: Date },
  deviceTokenHash: { type: String },          // bcrypt hash of the raw token
  locationName:    { type: String, default: '' },
  latitude:        { type: Number, default: null },
  longitude:       { type: Number, default: null },
  lastSeenAt:      { type: Date },
  lastStatus:      { type: Object, default: {} },   // sensor status snapshot
  firmwareVersion: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('Device', DeviceSchema);
