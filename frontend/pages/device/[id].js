import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceArea,
} from 'recharts';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../../lib/api';

// ─────────────────────────────────────────────────────────────
// Sensor metadata
// ─────────────────────────────────────────────────────────────
const SENSOR_LABELS = {
  temperature: 'Temperature',
  humidity:    'Humidity',
  pressure:    'Pressure',
  voc:         'VOC Index',
  nox:         'NOx Index',
  pm25:        'PM2.5',
  water:       'Water',
};

const Y_RANGES = {
  temperature: [0, 130],
  humidity:    [0, 100],
  pressure:    [300, 1200],
  voc:         [0, 500],
  nox:         [0, 5],
  pm25:        [0, 100],
  water:       [0, 1023],
};

const ZONES_BG = {
  temperature: [
    { y1: 0,   y2: 50,  color: '#3b82f6', opacity: 0.08 },
    { y1: 50,  y2: 85,  color: '#22c55e', opacity: 0.10 },
    { y1: 85,  y2: 100, color: '#f59e0b', opacity: 0.12 },
    { y1: 100, y2: 130, color: '#ef4444', opacity: 0.14 },
  ],
  humidity: [
    { y1: 0,  y2: 30,  color: '#3b82f6', opacity: 0.08 },
    { y1: 30, y2: 60,  color: '#22c55e', opacity: 0.10 },
    { y1: 60, y2: 80,  color: '#f59e0b', opacity: 0.12 },
    { y1: 80, y2: 100, color: '#ef4444', opacity: 0.14 },
  ],
  pressure: [
    { y1: 300,  y2: 980,  color: '#ef4444', opacity: 0.10 },
    { y1: 980,  y2: 1000, color: '#f59e0b', opacity: 0.10 },
    { y1: 1000, y2: 1020, color: '#22c55e', opacity: 0.10 },
    { y1: 1020, y2: 1040, color: '#f59e0b', opacity: 0.10 },
    { y1: 1040, y2: 1200, color: '#ef4444', opacity: 0.10 },
  ],
};

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
  if (key === 'water') return value >= 400 ? '#3b82f6' : '#22c55e';
  return '#0b3d91';
}

const ZONE_LEGENDS = {
  temperature: [
    { label: 'Cold (<50°F)',         color: '#3b82f6' },
    { label: 'Comfortable (50–85)',  color: '#22c55e' },
    { label: 'Hot (85–100)',         color: '#f59e0b' },
    { label: 'Dangerous (>100)',     color: '#ef4444' },
  ],
  humidity: [
    { label: 'Too dry (<30%)',       color: '#3b82f6' },
    { label: 'Ideal (30–60)',        color: '#22c55e' },
    { label: 'Uncomfortable (60–80)', color: '#f59e0b' },
    { label: 'Oppressive (>80)',     color: '#ef4444' },
  ],
  pressure: [
    { label: 'Normal (1000–1020)',   color: '#22c55e' },
    { label: 'Watch',                color: '#f59e0b' },
    { label: 'Extreme / Storm',      color: '#ef4444' },
  ],
  voc:  [
    { label: 'Good (≤100)',     color: '#22c55e' },
    { label: 'Moderate (≤200)', color: '#f59e0b' },
    { label: 'Poor (≤300)',     color: '#f97316' },
    { label: 'Unhealthy',       color: '#ef4444' },
  ],
  nox: [
    { label: 'Good (≤100)',     color: '#22c55e' },
    { label: 'Moderate (≤200)', color: '#f59e0b' },
    { label: 'Poor (≤300)',     color: '#f97316' },
    { label: 'Unhealthy',       color: '#ef4444' },
  ],
  pm25: [
    { label: 'Good (≤12 µg/m³)', color: '#22c55e' },
    { label: 'Moderate (≤35)',   color: '#f59e0b' },
    { label: 'Sensitive (≤55)',  color: '#f97316' },
    { label: 'Unhealthy (>55)', color: '#ef4444' },
  ],
  water: [
    { label: 'Clear',   color: '#22c55e' },
    { label: 'Raining', color: '#3b82f6' },
  ],
};

const LIVE_TILE_KEYS   = ['temperature', 'humidity', 'pressure', 'airquality', 'voc', 'nox', 'pm25', 'water'];
const LIVE_TILE_LABELS = { ...SENSOR_LABELS, airquality: 'Air Quality' };

// ─────────────────────────────────────────────────────────────
// Sky gradient — reacts to air-quality index + hour of day
// ─────────────────────────────────────────────────────────────
function skyGradient(aqLabel, hour) {
  const isNight  = hour < 6 || hour >= 20;
  const isSunset = hour >= 17 && hour < 20;
  const isSunrise= hour >= 6  && hour < 9;

  if (aqLabel === 'Poor' || aqLabel === 'Unhealthy' || aqLabel === 'Severe') {
    return 'linear-gradient(160deg, #78716c 0%, #a8a29e 40%, #d6d3d1 100%)'; // smoky grey
  }
  if (aqLabel === 'Moderate') {
    if (isNight)  return 'linear-gradient(160deg, #1e1b4b 0%, #312e81 60%, #4338ca 100%)';
    return          'linear-gradient(160deg, #fed7aa 0%, #fbbf24 50%, #f97316 100%)'; // hazy amber
  }
  // Good / Warming-up / disconnected → time-of-day sky
  if (isNight)   return 'linear-gradient(160deg, #0f172a 0%, #1e1b4b 60%, #312e81 100%)';
  if (isSunrise) return 'linear-gradient(160deg, #fef3c7 0%, #fb923c 40%, #38bdf8 100%)';
  if (isSunset)  return 'linear-gradient(160deg, #f97316 0%, #db2777 40%, #7c3aed 100%)';
  return           'linear-gradient(160deg, #38bdf8 0%, #0ea5e9 55%, #0369a1 100%)'; // clear day
}

// ─────────────────────────────────────────────────────────────
// Friendly language helpers
// ─────────────────────────────────────────────────────────────
function friendlyTemp(val, unit) {
  if (val == null) return null;
  const f = unit === 'C' ? val * 9 / 5 + 32 : val;
  if (f < 32)  return { icon: '🥶', text: 'Freezing cold!',    color: '#bfdbfe' };
  if (f < 50)  return { icon: '🧥', text: 'Bundle up, it\'s chilly', color: '#93c5fd' };
  if (f < 68)  return { icon: '😊', text: 'Nice and comfy',    color: '#86efac' };
  if (f < 85)  return { icon: '☀️', text: 'Warm and sunny',    color: '#fde68a' };
  if (f < 100) return { icon: '🥵', text: 'Pretty hot today',  color: '#fca5a5' };
  return               { icon: '🔥', text: 'Dangerously hot!', color: '#f87171' };
}

function friendlyHumidity(val) {
  if (val == null) return null;
  if (val < 20)  return { icon: '🏜️', text: 'Super dry air',         color: '#fef9c3' };
  if (val < 30)  return { icon: '💧', text: 'A bit dry',             color: '#bae6fd' };
  if (val < 60)  return { icon: '✅', text: 'Just right!',           color: '#bbf7d0' };
  if (val < 80)  return { icon: '😓', text: 'Feels a bit muggy',     color: '#fde68a' };
  return               { icon: '☁️', text: 'Very humid & sticky',   color: '#fca5a5' };
}

function friendlyPressure(val) {
  if (val == null) return null;
  if (val < 980)  return { icon: '⛈️', text: 'Storm might be coming!', color: '#fca5a5' };
  if (val < 1000) return { icon: '🌧️', text: 'Cloudy & rainy vibes',   color: '#93c5fd' };
  if (val < 1020) return { icon: '🌤️', text: 'Normal pressure',        color: '#bbf7d0' };
  if (val < 1040) return { icon: '☀️', text: 'Clear and stable',       color: '#fde68a' };
  return                 { icon: '🌬️', text: 'High pressure winds',    color: '#fca5a5' };
}

function friendlyAQ(label) {
  if (!label) return null;
  const map = {
    'Good':       { icon: '🌱', text: 'Fresh, clean air!',      color: '#bbf7d0' },
    'Warming up': { icon: '⏳', text: 'Sensor waking up…',       color: '#e2e8f0' },
    'Moderate':   { icon: '😐', text: 'Air is okay-ish',         color: '#fde68a' },
    'Poor':       { icon: '😷', text: 'Air not great today',     color: '#fed7aa' },
    'Unhealthy':  { icon: '⚠️', text: 'Stay indoors if you can', color: '#fca5a5' },
    'Severe':     { icon: '🚨', text: 'Very unhealthy air!',     color: '#f87171' },
  };
  return map[label] || { icon: '❓', text: label, color: '#e2e8f0' };
}

function friendlyVoc(val) {
  if (val == null) return null;
  if (val <= 100) return { icon: '🌿', text: 'Air smells fresh',         color: '#bbf7d0' };
  if (val <= 200) return { icon: '🏠', text: 'Some indoor gases',        color: '#fde68a' };
  if (val <= 300) return { icon: '😶‍🌫️', text: 'Stale air — open a window', color: '#fed7aa' };
  return                 { icon: '🚫', text: 'Lots of bad gases!',       color: '#fca5a5' };
}

function friendlyNox(val) {
  if (val == null) return null;
  if (val <= 100) return { icon: '✅', text: 'Nitrogen levels fine',     color: '#bbf7d0' };
  if (val <= 200) return { icon: '🚗', text: 'Some exhaust in the air',  color: '#fde68a' };
  if (val <= 300) return { icon: '😮', text: 'Quite a bit of NOx',       color: '#fed7aa' };
  return                 { icon: '☠️', text: 'Unhealthy NOx levels!',    color: '#fca5a5' };
}

function friendlyPm25(val) {
  if (val == null) return null;
  if (val <= 12)  return { icon: '✨', text: 'Super clean air!',         color: '#bbf7d0' };
  if (val <= 35)  return { icon: '🌫️', text: 'Some dust in the air',    color: '#fde68a' };
  if (val <= 55)  return { icon: '😷', text: 'Dusty — be careful',      color: '#fed7aa' };
  return                 { icon: '🚨', text: 'Lots of particles — stay safe', color: '#fca5a5' };
}

function friendlyWater(val) {
  if (val == null) return null;
  const raining = val >= 400;
  return raining
    ? { icon: '🌧️', text: 'It\'s raining!',     color: '#93c5fd' }
    : { icon: '☀️', text: 'No rain detected',   color: '#bbf7d0' };
}

// ─────────────────────────────────────────────────────────────
// Air-quality helper (unchanged logic)
// ─────────────────────────────────────────────────────────────
function airQualityFromSensors(sensors) {
  const voc = sensors?.voc;
  const nox = sensors?.nox;
  if ((!voc || voc.status === 'disconnected') && (!nox || nox.status === 'disconnected')) {
    return { status: 'disconnected' };
  }
  if (voc?.status === 'error' && nox?.status === 'error') return { status: 'error' };
  const vocIdx = typeof voc?.value === 'number' ? voc.value : 0;
  const noxIdx = typeof nox?.value === 'number' ? nox.value : 0;
  if (vocIdx === 0 && noxIdx === 0)
    return { status: 'ok', label: 'Warming up', tone: 'bg-slate-100 text-slate-600', idx: null };
  const idx = Math.max(vocIdx, noxIdx);
  if (idx <= 100) return { status: 'ok', label: 'Good',      tone: 'bg-green-100 text-green-800',   idx };
  if (idx <= 200) return { status: 'ok', label: 'Moderate',  tone: 'bg-yellow-100 text-yellow-800', idx };
  if (idx <= 300) return { status: 'ok', label: 'Poor',      tone: 'bg-orange-100 text-orange-800', idx };
  if (idx <= 400) return { status: 'ok', label: 'Unhealthy', tone: 'bg-red-100 text-red-800',       idx };
  return                 { status: 'ok', label: 'Severe',    tone: 'bg-rose-200 text-rose-900',     idx };
}

// ─────────────────────────────────────────────────────────────
// Chart tick helpers (unchanged)
// ─────────────────────────────────────────────────────────────
function ticksEvery12h(min, max) {
  if (!min || !max || max - min < 60 * 60 * 1000) return undefined;
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
  if (h === 0)  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (h === 12) return '12h';
  return `${h}h`;
}

function displayUnit(u) {
  if (u === 'F') return '°F';
  if (u === 'C') return '°C';
  return u || '';
}

function formatValue(key, v) {
  if (v == null) return '—';
  if (typeof v !== 'number') return v;
  if (key === 'temperature' || key === 'pressure') return v.toFixed(1);
  return Math.round(v);
}

// ─────────────────────────────────────────────────────────────
// Lumi the Firefly SVG mascot
// ─────────────────────────────────────────────────────────────
function LumiFirefly({ aqLabel = 'Good', size = 160 }) {
  // glow color by AQ
  const glowMap = {
    'Good':       '#4ade80',
    'Warming up': '#94a3b8',
    'Moderate':   '#facc15',
    'Poor':       '#fb923c',
    'Unhealthy':  '#f87171',
    'Severe':     '#ef4444',
  };
  const glowColor = glowMap[aqLabel] || '#4ade80';
  const isUnhealthy = aqLabel === 'Unhealthy' || aqLabel === 'Severe' || aqLabel === 'Poor';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ filter: `drop-shadow(0 0 18px ${glowColor})`, overflow: 'visible' }}
    >
      {/* Outer glow ring — pulses via CSS animation */}
      <circle
        cx="100" cy="110" r="38"
        fill={glowColor}
        opacity="0.18"
        style={{
          transformOrigin: '100px 110px',
          animation: 'lumipulse 2.4s ease-in-out infinite',
        }}
      />

      {/* Body — teardrop / abdomen */}
      <ellipse cx="100" cy="118" rx="22" ry="28" fill="#1a1a2e" />
      {/* Glowing abdomen lantern */}
      <ellipse cx="100" cy="130" rx="14" ry="12" fill={glowColor} opacity="0.95" />
      <ellipse cx="100" cy="128" rx="8"  ry="7"  fill="#ffffff" opacity="0.45" />

      {/* Thorax */}
      <ellipse cx="100" cy="96" rx="18" ry="16" fill="#16213e" />

      {/* Head */}
      <circle cx="100" cy="76" r="16" fill="#16213e" />

      {/* Eyes */}
      <circle cx="93"  cy="74" r="5"  fill={isUnhealthy ? '#ef4444' : '#ffffff'} />
      <circle cx="107" cy="74" r="5"  fill={isUnhealthy ? '#ef4444' : '#ffffff'} />
      <circle cx="93"  cy="74" r="2.5" fill="#0f172a" />
      <circle cx="107" cy="74" r="2.5" fill="#0f172a" />
      {/* Eye shine */}
      <circle cx="94"  cy="72.5" r="1.2" fill="#ffffff" opacity="0.8" />
      <circle cx="108" cy="72.5" r="1.2" fill="#ffffff" opacity="0.8" />

      {/* Antennae */}
      <path d="M94 62 Q88 50 82 44" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" />
      <circle cx="82" cy="44" r="3.5" fill={glowColor} opacity="0.9" />
      <path d="M106 62 Q112 50 118 44" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" />
      <circle cx="118" cy="44" r="3.5" fill={glowColor} opacity="0.9" />

      {/* Wings (left pair) */}
      <ellipse cx="74"  cy="94" rx="22" ry="12"
        fill={glowColor} opacity="0.22"
        transform="rotate(-30 74 94)" />
      <ellipse cx="74"  cy="108" rx="18" ry="10"
        fill={glowColor} opacity="0.16"
        transform="rotate(-20 74 108)" />

      {/* Wings (right pair) */}
      <ellipse cx="126" cy="94" rx="22" ry="12"
        fill={glowColor} opacity="0.22"
        transform="rotate(30 126 94)" />
      <ellipse cx="126" cy="108" rx="18" ry="10"
        fill={glowColor} opacity="0.16"
        transform="rotate(20 126 108)" />

      {/* Wing veins */}
      <path d="M78 90 Q70 86 64 92"  stroke={glowColor} strokeWidth="1" opacity="0.5" />
      <path d="M78 100 Q70 100 65 108" stroke={glowColor} strokeWidth="1" opacity="0.4" />
      <path d="M122 90 Q130 86 136 92"  stroke={glowColor} strokeWidth="1" opacity="0.5" />
      <path d="M122 100 Q130 100 135 108" stroke={glowColor} strokeWidth="1" opacity="0.4" />

      {/* Tiny sparkle dots floating around */}
      <circle cx="58"  cy="72"  r="2.5" fill={glowColor} opacity="0.7"
        style={{ animation: 'lumispark 3s ease-in-out infinite' }} />
      <circle cx="142" cy="80"  r="2"   fill={glowColor} opacity="0.6"
        style={{ animation: 'lumispark 3s ease-in-out 1s infinite' }} />
      <circle cx="60"  cy="130" r="1.8" fill={glowColor} opacity="0.5"
        style={{ animation: 'lumispark 3s ease-in-out 1.8s infinite' }} />

      <style>{`
        @keyframes lumipulse {
          0%, 100% { transform: scale(1);   opacity: 0.18; }
          50%       { transform: scale(1.4); opacity: 0.08; }
        }
        @keyframes lumispark {
          0%, 100% { opacity: 0.7; transform: translateY(0); }
          50%       { opacity: 0.1; transform: translateY(-8px); }
        }
      `}</style>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────
// Sensor tile — glassmorphism, friendly text, expandable numbers
// ─────────────────────────────────────────────────────────────
function SensorTile({ sensorKey, sensorData, aqData }) {
  const [expanded, setExpanded] = useState(false);

  const isAq    = sensorKey === 'airquality';
  const isWater = sensorKey === 'water';
  const s = isAq ? aqData : (sensorData || { status: 'disconnected' });

  // Build friendly display
  let friendly = null;
  let rawLabel  = null;
  let rawValue  = null;

  if (s.status === 'ok') {
    if (isAq) {
      friendly = friendlyAQ(s.label);
      rawLabel  = `Index: ${s.idx != null ? s.idx : '—'} (higher = worse)`;
    } else if (isWater) {
      const val = typeof s.value === 'number' ? s.value : null;
      const raining = s.state === 'raining' || (val != null && val >= 400);
      friendly  = friendlyWater(raining ? 500 : 100);
      rawLabel  = `Raw ADC: ${val != null ? val : '—'}`;
    } else {
      const val = typeof s.value === 'number' ? s.value : null;
      const unit = displayUnit(s.unit);
      rawValue  = val != null ? `${formatValue(sensorKey, val)} ${unit}` : '—';

      if (sensorKey === 'temperature') friendly = friendlyTemp(val, s.unit);
      if (sensorKey === 'humidity')    friendly = friendlyHumidity(val);
      if (sensorKey === 'pressure')    friendly = friendlyPressure(val);
      if (sensorKey === 'voc')         friendly = friendlyVoc(val);
      if (sensorKey === 'nox')         friendly = friendlyNox(val);
      if (sensorKey === 'pm25')        friendly = friendlyPm25(val);
    }
  }

  const tileStyle = {
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    background: s.status === 'ok'
      ? (friendly?.color
          ? `linear-gradient(135deg, ${friendly.color}55 0%, ${friendly.color}22 100%)`
          : 'rgba(255,255,255,0.35)')
      : s.status === 'error'
        ? 'rgba(254,202,202,0.4)'
        : 'rgba(226,232,240,0.35)',
    border: '1px solid rgba(255,255,255,0.5)',
    borderRadius: '20px',
    boxShadow: '0 4px 24px rgba(0,0,0,0.10)',
    padding: '1.1rem 1.2rem',
    transition: 'transform 0.15s ease, box-shadow 0.15s ease',
    cursor: 'default',
  };

  return (
    <div style={tileStyle}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 32px rgba(0,0,0,0.15)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = '';                e.currentTarget.style.boxShadow = '0 4px 24px rgba(0,0,0,0.10)'; }}
    >
      <p style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(15,23,42,0.5)', marginBottom: '0.4rem' }}>
        {LIVE_TILE_LABELS[sensorKey]}
      </p>

      {s.status === 'ok' && friendly ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem' }}>
            <span style={{ fontSize: '1.6rem' }}>{friendly.icon}</span>
            <span style={{ fontSize: '1rem', fontWeight: 700, color: '#0f172a', lineHeight: 1.2 }}>
              {friendly.text}
            </span>
          </div>

          {/* "See the numbers" toggle */}
          <button
            onClick={() => setExpanded(p => !p)}
            style={{
              fontSize: '0.7rem',
              fontWeight: 600,
              color: 'rgba(15,23,42,0.5)',
              background: 'rgba(15,23,42,0.07)',
              border: 'none',
              borderRadius: '999px',
              padding: '0.15rem 0.65rem',
              cursor: 'pointer',
              marginTop: '0.5rem',
              transition: 'background 0.15s',
            }}
          >
            {expanded ? '▲ Hide numbers' : '🔢 See the numbers'}
          </button>

          {expanded && (
            <div style={{
              marginTop: '0.55rem',
              padding: '0.5rem 0.6rem',
              background: 'rgba(15,23,42,0.07)',
              borderRadius: '10px',
              fontSize: '0.78rem',
              color: '#1e293b',
              fontFamily: 'monospace',
            }}>
              {rawValue && <div><strong>Value:</strong> {rawValue}</div>}
              {rawLabel && <div>{rawLabel}</div>}
            </div>
          )}
        </>
      ) : s.status === 'ok' ? (
        // Fallback for sensors with no friendly mapping (shouldn't happen)
        <p style={{ fontSize: '1.4rem', fontWeight: 700 }}>
          {formatValue(sensorKey, s.value)}{' '}
          <span style={{ fontSize: '0.85rem', fontWeight: 400, color: 'rgba(15,23,42,0.5)' }}>
            {displayUnit(s.unit)}
          </span>
        </p>
      ) : (
        <p style={{ fontSize: '0.85rem', fontWeight: 600, color: 'rgba(15,23,42,0.45)', marginTop: '0.3rem' }}>
          {s.status === 'disconnected' ? '📡 Not connected' : '⚠️ Sensor error'}
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────
export default function DevicePage() {
  const router = useRouter();
  const { id } = router.query;

  const [tab,     setTab]     = useState('live');
  const [device,  setDevice]  = useState(null);
  const [latest,  setLatest]  = useState(null);
  const [history, setHistory] = useState([]);
  const [err,     setErr]     = useState('');

  async function load() {
    try {
      const { device, latest } = await api(`/api/devices/${id}/latest`);
      setDevice(device);
      setLatest(latest);
      if (tab === 'history') {
        const { readings } = await api(`/api/devices/${id}/history?limit=500`);
        setHistory(readings);
      }
    } catch (e) { setErr(e.message); }
  }

  useEffect(() => {
    if (!id) return;
    load();
    const i = setInterval(load, 15000);
    return () => clearInterval(i);
  }, [id, tab]);

  function exportCsv() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const fmtLocal = (d) => {
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const rows = [['timestamp_local', 'timezone', ...Object.keys(SENSOR_LABELS)]];
    for (const r of history) {
      rows.push([
        fmtLocal(new Date(r.ts)), tz,
        ...Object.keys(SENSOR_LABELS).map(k => r.sensors?.[k]?.value ?? ''),
      ]);
    }
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `${device?.deviceId || 'device'}-readings-${fmtLocal(new Date()).slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (err)     return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f1f5f9' }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: '2rem', maxWidth: 400 }}>
        <p style={{ color: '#ef4444', marginBottom: '1rem' }}>⚠️ {err}</p>
        <Link href="/dashboard" style={{ color: '#0369a1', textDecoration: 'underline' }}>← Back to devices</Link>
      </div>
    </div>
  );

  if (!device) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <LumiFirefly aqLabel="Warming up" size={120} />
        <p style={{ marginTop: '1rem', color: '#64748b', fontWeight: 600 }}>Loading…</p>
      </div>
    </div>
  );

  const sensors = latest?.sensors || {};
  const aq      = airQualityFromSensors(sensors);
  const hour    = new Date().getHours();
  const bg      = skyGradient(aq.status === 'ok' ? aq.label : '', hour);

  // Tab pill styles
  const tabStyle = (t) => ({
    padding: '0.45rem 1.1rem',
    borderRadius: '999px',
    border: 'none',
    fontWeight: 600,
    fontSize: '0.82rem',
    cursor: 'pointer',
    transition: 'all 0.15s',
    ...(tab === t
      ? { background: 'rgba(255,255,255,0.9)', color: '#0f172a', boxShadow: '0 2px 8px rgba(0,0,0,0.12)' }
      : { background: 'rgba(255,255,255,0.25)', color: 'rgba(255,255,255,0.9)' }),
  });

  return (
    <div style={{ minHeight: '100vh', background: bg, transition: 'background 1.5s ease' }}>
      {/* ── Top nav bar ── */}
      <div style={{
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        background: 'rgba(0,0,0,0.18)',
        borderBottom: '1px solid rgba(255,255,255,0.15)',
        padding: '0.75rem 1.5rem',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '0.5rem',
      }}>
        <Link href="/dashboard" style={{ color: 'rgba(255,255,255,0.85)', textDecoration: 'none', fontSize: '0.85rem', fontWeight: 600 }}>
          ← Back
        </Link>
        <div>
          <h1 style={{ color: '#fff', fontWeight: 800, fontSize: '1.15rem', margin: 0 }}>
            {device.locationName || device.deviceId}
          </h1>
          {latest?.ts && (
            <p style={{ color: 'rgba(255,255,255,0.65)', fontSize: '0.72rem', margin: 0 }}>
              Last reading: {new Date(latest.ts).toLocaleString()}
            </p>
          )}
        </div>
        {/* Tab pills */}
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          {['live', 'history', 'assistant', 'settings'].map(t => (
            <button key={t} style={tabStyle(t)} onClick={() => setTab(t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* ── Page body ── */}
      <div style={{ maxWidth: '1050px', margin: '0 auto', padding: '1.5rem 1.25rem 3rem' }}>

        {/* ── LIVE tab ── */}
        {tab === 'live' && (
          <>
            {/* Lumi + hero summary */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '1.5rem',
              marginBottom: '2rem',
              flexWrap: 'wrap',
            }}>
              <LumiFirefly aqLabel={aq.status === 'ok' ? aq.label : 'Good'} size={150} />
              <div>
                <p style={{ color: 'rgba(255,255,255,0.75)', fontSize: '0.85rem', margin: '0 0 0.3rem' }}>
                  Hi! I'm Lumi 🌟 Here's what the air is like right now:
                </p>
                {aq.status === 'ok' ? (
                  <div style={{
                    background: 'rgba(255,255,255,0.22)',
                    backdropFilter: 'blur(12px)',
                    WebkitBackdropFilter: 'blur(12px)',
                    border: '1px solid rgba(255,255,255,0.4)',
                    borderRadius: '14px',
                    padding: '0.6rem 1rem',
                    display: 'inline-block',
                  }}>
                    <span style={{ color: '#fff', fontWeight: 800, fontSize: '1.1rem' }}>
                      {friendlyAQ(aq.label)?.icon} {aq.label} air quality
                    </span>
                    <p style={{ color: 'rgba(255,255,255,0.8)', margin: '0.2rem 0 0', fontSize: '0.82rem' }}>
                      {friendlyAQ(aq.label)?.text}
                    </p>
                  </div>
                ) : (
                  <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.9rem' }}>
                    Sensors are warming up or not connected yet.
                  </p>
                )}
              </div>
            </div>

            {/* Sensor tiles grid */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: '1rem',
            }}>
              {LIVE_TILE_KEYS.map(k => (
                <SensorTile
                  key={k}
                  sensorKey={k}
                  sensorData={sensors[k]}
                  aqData={k === 'airquality' ? aq : null}
                />
              ))}
            </div>
          </>
        )}

        {/* ── HISTORY tab ── */}
        {tab === 'history' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
              <button
                onClick={exportCsv}
                style={{
                  background: 'rgba(255,255,255,0.25)',
                  backdropFilter: 'blur(8px)',
                  border: '1px solid rgba(255,255,255,0.4)',
                  color: '#fff',
                  borderRadius: '10px',
                  padding: '0.45rem 1rem',
                  fontWeight: 600,
                  fontSize: '0.82rem',
                  cursor: 'pointer',
                }}
              >
                Export CSV
              </button>
            </div>

            {Object.keys(SENSOR_LABELS).map(k => {
              const data = history
                .map(r => ({
                  ts: new Date(r.ts).getTime(),
                  value: typeof r.sensors?.[k]?.value === 'number' ? r.sensors[k].value : null,
                }))
                .sort((a, b) => a.ts - b.ts);

              const bgZones    = ZONES_BG[k] || [];
              const legends    = ZONE_LEGENDS[k] || [];
              const useDynLine = !ZONES_BG[k];
              const latestVal  = data.filter(d => d.value != null).slice(-1)[0]?.value ?? null;
              const lineColor  = useDynLine ? zoneColor(k, latestVal) : '#0b3d91';

              return (
                <div key={k} style={{
                  background: 'rgba(255,255,255,0.78)',
                  backdropFilter: 'blur(14px)',
                  WebkitBackdropFilter: 'blur(14px)',
                  border: '1px solid rgba(255,255,255,0.6)',
                  borderRadius: '18px',
                  padding: '1rem 1.1rem',
                  marginBottom: '1rem',
                }}>
                  <h3 style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: '0.5rem', color: '#0f172a' }}>
                    {SENSOR_LABELS[k]}
                  </h3>

                  {legends.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem', marginBottom: '0.5rem' }}>
                      {legends.map(l => (
                        <span key={l.label} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.72rem', color: '#475569' }}>
                          <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: l.color }} />
                          {l.label}
                        </span>
                      ))}
                    </div>
                  )}

                  <div style={{ width: '100%', height: 180 }}>
                    <ResponsiveContainer>
                      <LineChart data={data}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        {bgZones.map((z, i) => (
                          <ReferenceArea key={i} y1={z.y1} y2={z.y2}
                            fill={z.color} fillOpacity={z.opacity} ifOverflow="hidden" />
                        ))}
                        <XAxis
                          dataKey="ts" type="number"
                          domain={['dataMin', 'dataMax']} scale="time"
                          ticks={ticksEvery12h(data[0]?.ts, data[data.length-1]?.ts)}
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
                          type="monotone" dataKey="value"
                          dot={false} stroke={lineColor} strokeWidth={2}
                          isAnimationActive={false} connectNulls={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              );
            })}

            <details style={{
              background: 'rgba(255,255,255,0.78)',
              backdropFilter: 'blur(14px)',
              WebkitBackdropFilter: 'blur(14px)',
              border: '1px solid rgba(255,255,255,0.6)',
              borderRadius: '18px',
              padding: '1rem 1.1rem',
            }}>
              <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: '0.9rem', color: '#0f172a' }}>
                Raw readings table ({history.length})
              </summary>
              <div style={{ overflowX: 'auto', maxHeight: '24rem', marginTop: '0.75rem' }}>
                <table style={{ width: '100%', fontSize: '0.72rem', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f1f5f9' }}>
                      <th style={{ padding: '0.3rem 0.5rem', textAlign: 'left' }}>Time</th>
                      {Object.keys(SENSOR_LABELS).map(k => (
                        <th key={k} style={{ padding: '0.3rem 0.5rem', textAlign: 'left' }}>{SENSOR_LABELS[k]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.map(r => (
                      <tr key={r._id} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '0.3rem 0.5rem' }}>{new Date(r.ts).toLocaleString()}</td>
                        {Object.keys(SENSOR_LABELS).map(k => (
                          <td key={k} style={{ padding: '0.3rem 0.5rem' }}>
                            {r.sensors?.[k]?.status === 'ok' ? formatValue(k, r.sensors[k].value) : '—'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        )}

        {/* ── ASSISTANT tab ── */}
        {tab === 'assistant' && (
          <div style={{
            background: 'rgba(255,255,255,0.82)',
            backdropFilter: 'blur(14px)',
            WebkitBackdropFilter: 'blur(14px)',
            border: '1px solid rgba(255,255,255,0.6)',
            borderRadius: '20px',
            overflow: 'hidden',
          }}>
            <AssistantPanel deviceId={id} deviceLabel={device.locationName || device.deviceId} />
          </div>
        )}

        {/* ── SETTINGS tab ── */}
        {tab === 'settings' && (
          <div style={{
            background: 'rgba(255,255,255,0.82)',
            backdropFilter: 'blur(14px)',
            WebkitBackdropFilter: 'blur(14px)',
            border: '1px solid rgba(255,255,255,0.6)',
            borderRadius: '20px',
            overflow: 'hidden',
          }}>
            <SettingsPanel deviceId={id} device={device} onSaved={load} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Settings panel (unchanged logic, refreshed shell)
// ─────────────────────────────────────────────────────────────
function SettingsPanel({ deviceId, device, onSaved }) {
  const [locationName, setLocationName] = useState(device.locationName || '');
  const [lat,          setLat]          = useState(device.latitude  != null ? String(device.latitude)  : '');
  const [lon,          setLon]          = useState(device.longitude != null ? String(device.longitude) : '');
  const [geoStatus,    setGeoStatus]    = useState('');
  const [saving,       setSaving]       = useState(false);
  const [saved,        setSaved]        = useState(false);
  const [err,          setErr]          = useState('');

  async function useMyLocation() {
    if (!navigator.geolocation) { setGeoStatus('error:Geolocation is not supported by this browser.'); return; }
    if (navigator.permissions) {
      try {
        const perm = await navigator.permissions.query({ name: 'geolocation' });
        if (perm.state === 'denied') {
          setGeoStatus("error:Location access is blocked. Click the 🔒 lock icon in your browser's address bar → Site settings → Location → Allow, then refresh and try again.");
          return;
        }
      } catch (_) {}
    }
    setGeoStatus('loading:Getting your location…');
    navigator.geolocation.getCurrentPosition(
      pos => { setLat(pos.coords.latitude.toFixed(6)); setLon(pos.coords.longitude.toFixed(6)); setGeoStatus('success:Location filled in — click Save to store it.'); },
      error => {
        const msgs = {
          1: "error:Location access was denied. Click the 🔒 lock icon → Site settings → Location → Allow, then refresh.",
          2: "error:Your device couldn't determine its position. Make sure location services are enabled.",
          3: 'error:Timed out waiting for location. Try moving to an area with better signal.',
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
        body: { locationName, latitude: lat !== '' ? parseFloat(lat) : null, longitude: lon !== '' ? parseFloat(lon) : null },
      });
      setSaved(true);
      onSaved();
    } catch (e) { setErr(e.message); }
    setSaving(false);
  }

  const inputStyle = { border: '1px solid #e2e8f0', borderRadius: '10px', padding: '0.55rem 0.75rem', width: '100%', fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box' };
  const labelStyle = { display: 'block', fontSize: '0.82rem', fontWeight: 600, marginBottom: '0.35rem', color: '#374151' };

  return (
    <div style={{ padding: '1.5rem' }}>
      <h2 style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: '1.25rem', color: '#0f172a' }}>Device settings</h2>
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem', maxWidth: '460px' }}>

        <div>
          <label style={labelStyle}>Location name</label>
          <input style={inputStyle} value={locationName}
            onChange={e => setLocationName(e.target.value)} placeholder="e.g. Community Center Kumasi" />
        </div>

        <div>
          <label style={labelStyle}>GPS coordinates</label>
          <p style={{ fontSize: '0.78rem', color: '#64748b', marginBottom: '0.5rem' }}>
            Used by the AI assistant to fetch local weather forecasts.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <input style={{ ...inputStyle, width: '50%' }} placeholder="Latitude  (e.g. 6.6885)"  value={lat} onChange={e => setLat(e.target.value)} />
            <input style={{ ...inputStyle, width: '50%' }} placeholder="Longitude (e.g. -1.6244)" value={lon} onChange={e => setLon(e.target.value)} />
          </div>
          <button type="button" onClick={useMyLocation} style={{ fontSize: '0.82rem', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '0.4rem 0.9rem', cursor: 'pointer' }}>
            📍 Use my location
          </button>
          {geoStatus && (() => {
            const [type, ...rest] = geoStatus.split(':');
            const msg = rest.join(':');
            const col = { error: '#dc2626', success: '#16a34a', loading: '#64748b' }[type] || '#64748b';
            const bg  = { error: '#fef2f2', success: '#f0fdf4', loading: 'transparent' }[type] || 'transparent';
            return <p style={{ fontSize: '0.76rem', marginTop: '0.4rem', color: col, background: bg, borderRadius: '6px', padding: bg !== 'transparent' ? '0.3rem 0.6rem' : 0 }}>{msg}</p>;
          })()}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button disabled={saving} style={{
            background: '#1e3a5f', color: '#fff', border: 'none', borderRadius: '10px',
            padding: '0.55rem 1.4rem', fontWeight: 700, fontSize: '0.88rem', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1,
          }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved && <span style={{ color: '#16a34a', fontSize: '0.85rem', fontWeight: 600 }}>Saved ✓</span>}
          {err   && <span style={{ color: '#dc2626', fontSize: '0.85rem' }}>{err}</span>}
        </div>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Assistant panel (unchanged logic, refreshed shell)
// ─────────────────────────────────────────────────────────────
function AssistantPanel({ deviceId, deviceLabel }) {
  const [messages,     setMessages]    = useState([]);
  const [input,        setInput]       = useState('');
  const [busy,         setBusy]        = useState(false);
  const [err,          setErr]         = useState('');
  const [reportTitle,  setReportTitle] = useState('');
  const [showReport,   setShowReport]  = useState(false);
  const [savedReport,  setSavedReport] = useState(null);
  const [email,        setEmail]       = useState('');
  const [status,       setStatus]      = useState('');

  async function send(e) {
    e?.preventDefault();
    if (!input.trim()) return;
    const question = input.trim();
    setInput(''); setErr(''); setBusy(true);
    const nextMsgs = [...messages, { role: 'user', content: question }];
    setMessages(nextMsgs);
    try {
      const { answer } = await api('/api/ai/query', { method: 'POST', body: { deviceId, messages, question } });
      setMessages([...nextMsgs, { role: 'assistant', content: answer }]);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  async function fileReport() {
    setErr(''); setStatus('Saving report...');
    try {
      const { report } = await api('/api/ai/reports', { method: 'POST', body: { deviceId, title: reportTitle || `Report for ${deviceLabel}`, messages } });
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

  const inputStyle = { border: '1px solid #e2e8f0', borderRadius: '10px', padding: '0.55rem 0.75rem', flex: 1, fontSize: '0.9rem', outline: 'none' };

  return (
    <div style={{ padding: '1.5rem' }}>
      <p style={{ fontSize: '0.85rem', color: '#475569', marginBottom: '1rem' }}>
        Ask anything about <strong>{deviceLabel}</strong>'s readings. The assistant sees the last 30 days of data, and can look up live weather anywhere.
      </p>

      <div style={{ border: '1px solid #e2e8f0', borderRadius: '12px', padding: '0.75rem', height: '20rem', overflowY: 'auto', background: '#f8fafc', marginBottom: '0.75rem' }}>
        {messages.length === 0 && (
          <p style={{ fontSize: '0.82rem', color: '#94a3b8' }}>
            Try: "Was today hotter than yesterday?" · "Is the air quality safe right now?" · "Any sensor acting up this week?"
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: '0.75rem', textAlign: m.role === 'user' ? 'right' : 'left' }}>
            {m.role === 'user' ? (
              <div style={{ display: 'inline-block', background: '#1e3a5f', color: '#fff', borderRadius: '12px', padding: '0.45rem 0.75rem', maxWidth: '85%', fontSize: '0.85rem', whiteSpace: 'pre-wrap', textAlign: 'left' }}>
                {m.content}
              </div>
            ) : (
              <div className="ai-message" style={{ display: 'inline-block', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '0.45rem 0.75rem', maxWidth: '85%', fontSize: '0.85rem', textAlign: 'left' }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
              </div>
            )}
          </div>
        ))}
        {busy && <p style={{ fontSize: '0.82rem', color: '#94a3b8' }}>Thinking...</p>}
      </div>

      <form onSubmit={send} style={{ display: 'flex', gap: '0.5rem' }}>
        <input style={inputStyle} placeholder="Ask a question…" value={input} onChange={e => setInput(e.target.value)} disabled={busy} />
        <button style={{ background: '#1e3a5f', color: '#fff', border: 'none', borderRadius: '10px', padding: '0 1.1rem', fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>Send</button>
      </form>

      {err && <p style={{ color: '#dc2626', fontSize: '0.82rem', marginTop: '0.5rem' }}>{err}</p>}

      <div style={{ marginTop: '1.25rem', borderTop: '1px solid #f1f5f9', paddingTop: '1rem' }}>
        {!showReport ? (
          <button disabled={messages.length === 0} onClick={() => setShowReport(true)}
            style={{ background: '#065f46', color: '#fff', border: 'none', borderRadius: '10px', padding: '0.5rem 1rem', fontWeight: 600, fontSize: '0.82rem', cursor: messages.length === 0 ? 'default' : 'pointer', opacity: messages.length === 0 ? 0.4 : 1 }}>
            File a report from this conversation
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <label style={{ fontSize: '0.82rem', fontWeight: 600 }}>Report title</label>
            <input style={inputStyle} placeholder={`Report for ${deviceLabel}`} value={reportTitle} onChange={e => setReportTitle(e.target.value)} />
            {!savedReport ? (
              <button onClick={fileReport} style={{ background: '#065f46', color: '#fff', border: 'none', borderRadius: '10px', padding: '0.5rem 1rem', fontWeight: 600, cursor: 'pointer', alignSelf: 'flex-start' }}>Save report</button>
            ) : (
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input style={inputStyle} type="email" placeholder="send-to@example.com" value={email} onChange={e => setEmail(e.target.value)} />
                <button onClick={sendEmail} style={{ background: '#1e3a5f', color: '#fff', border: 'none', borderRadius: '10px', padding: '0 1rem', fontWeight: 600, cursor: 'pointer' }}>Email it</button>
              </div>
            )}
            {status && <p style={{ fontSize: '0.82rem', color: '#475569' }}>{status}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
