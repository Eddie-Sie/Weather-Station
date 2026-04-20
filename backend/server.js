require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');
const rateLimit = require('express-rate-limit');

const connectDb    = require('./src/db');
const authRoutes   = require('./src/routes/auth');
const deviceRoutes = require('./src/routes/devices');
const readingRoutes= require('./src/routes/readings');
const aiRoutes     = require('./src/routes/ai');

const app = express();

// ---- Middleware ----
const origins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);           // curl / ESP8266 etc
    if (origins.length === 0) return cb(null, true);
    return cb(null, origins.includes(origin));
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

// Light rate limit on auth routes to slow down brute-force
app.use('/api/auth', rateLimit({ windowMs: 15*60*1000, max: 400 }));

// ---- Health check ----
app.get('/', (req, res) => res.json({ ok: true, service: 'weather-station-api' }));

// ---- Routes ----
app.use('/api/auth',     authRoutes);
app.use('/api/devices',  deviceRoutes);
app.use('/api/readings', readingRoutes);
app.use('/api/ai',       aiRoutes);

// ---- 404 + error handler ----
app.use((req, res) => res.status(404).json({ error: 'not_found' }));
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'server_error' });
});

// ---- Start ----
const PORT = process.env.PORT || 4000;
connectDb(process.env.MONGODB_URI).then(() => {
  app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
});
