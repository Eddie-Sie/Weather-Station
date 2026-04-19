const mongoose = require('mongoose');

const SensorSchema = new mongoose.Schema({
  value:  { type: mongoose.Schema.Types.Mixed },
  unit:   { type: String },
  status: { type: String, enum: ['ok', 'error', 'disconnected'], default: 'ok' },
}, { _id: false });

const ReadingSchema = new mongoose.Schema({
  device:   { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true, index: true },
  deviceId: { type: String, required: true, index: true },     // denormalised for fast lookup
  ts:       { type: Date,   required: true, index: true },
  sensors:  {
    temperature: SensorSchema,
    humidity:    SensorSchema,
    pressure:    SensorSchema,
    voc:         SensorSchema,
    nox:         SensorSchema,
    pm25:        SensorSchema,
    water:       SensorSchema,
  },
  buffered: { type: Boolean, default: false },
}, { timestamps: true });

// Compound index to speed up "history for a device, newest first"
ReadingSchema.index({ device: 1, ts: -1 });

module.exports = mongoose.model('Reading', ReadingSchema);
