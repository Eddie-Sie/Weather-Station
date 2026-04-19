const mongoose = require('mongoose');

/*
 * A Report is what the user files after an AI chat session. It captures:
 *   - the device it's about
 *   - the Q&A transcript
 *   - an AI-generated summary / recommendation
 *   - who sent it, to whom, and when (if emailed)
 */
const ReportSchema = new mongoose.Schema({
  owner:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true, index: true },
  device:   { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true, index: true },
  title:    { type: String, required: true },
  summary:  { type: String },                       // AI-generated
  messages: [{ role: String, content: String }],    // the chat transcript
  emailedTo: [String],
  emailedAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('Report', ReportSchema);
