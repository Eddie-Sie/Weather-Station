import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api } from '../../lib/api';

const SENSOR_LABELS = {
  temperature: 'Temperature',
  humidity:    'Humidity',
  pressure:    'Pressure',
  voc:         'VOC Index',
  nox:         'NOx Index',
  pm25:        'PM2.5',
  water:       'Water',
};

export default function DevicePage() {
  const router = useRouter();
  const { id } = router.query;

  const [tab, setTab] = useState('live');
  const [device, setDevice] = useState(null);
  const [latest, setLatest] = useState(null);
  const [history, setHistory] = useState([]);
  const [err, setErr] = useState('');

  async function load() {
    try {
      const { device, latest } = await api(`/api/devices/${id}/latest`);
      setDevice(device); setLatest(latest);
      if (tab === 'history') {
        const { readings } = await api(`/api/devices/${id}/history?limit=500`);
        setHistory(readings);
      }
    } catch (e) { setErr(e.message); }
  }

  useEffect(() => {
    if (!id) return;
    load();
    const i = setInterval(load, 15000);    // refresh every 15s
    return () => clearInterval(i);
  }, [id, tab]);

  function exportCsv() {
    const rows = [['timestamp', ...Object.keys(SENSOR_LABELS)]];
    for (const r of history) {
      rows.push([
        new Date(r.ts).toISOString(),
        ...Object.keys(SENSOR_LABELS).map(k => r.sensors?.[k]?.value ?? ''),
      ]);
    }
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${device?.deviceId || 'device'}-readings.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  if (err)      return <div className="p-6">Error: {err} <Link href="/dashboard" className="underline">back</Link></div>;
  if (!device)  return <div className="p-6">Loading...</div>;

  const sensors = latest?.sensors || {};

  return (
    <div className="min-h-screen p-6 max-w-5xl mx-auto">
      <header className="mb-6">
        <Link href="/dashboard" className="text-sm text-blue-900 underline">&larr; Back to devices</Link>
        <h1 className="text-2xl font-bold text-blue-900 mt-1">{device.locationName || device.deviceId}</h1>
        <p className="text-sm text-slate-600">Device ID: {device.deviceId || '(not yet connected)'}</p>
        {device.latitude && device.longitude && <p className="text-sm text-slate-600">GPS: {device.latitude}, {device.longitude}</p>}
        {latest?.ts && <p className="text-sm text-slate-600">Last reading: {new Date(latest.ts).toLocaleString()}</p>}
      </header>

      <div className="flex gap-2 mb-4">
        <button onClick={() => setTab('live')}      className={`px-4 py-2 rounded ${tab==='live'      ? 'bg-blue-900 text-white' : 'bg-slate-200'}`}>Live</button>
        <button onClick={() => setTab('history')}   className={`px-4 py-2 rounded ${tab==='history'   ? 'bg-blue-900 text-white' : 'bg-slate-200'}`}>History</button>
        <button onClick={() => setTab('assistant')} className={`px-4 py-2 rounded ${tab==='assistant' ? 'bg-blue-900 text-white' : 'bg-slate-200'}`}>Assistant</button>
      </div>

      {tab === 'assistant' && <AssistantPanel deviceId={id} deviceLabel={device.locationName || device.deviceId} />}

      {tab === 'live' && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {Object.keys(SENSOR_LABELS).map(k => {
            const s = sensors[k] || { status: 'disconnected' };
            const isWater = k === 'water';
            const bg = s.status === 'ok'
              ? (isWater && s.state === 'raining' ? 'bg-blue-50' : 'bg-white')
              : s.status === 'error' ? 'bg-red-50' : 'bg-slate-100 opacity-70';
            return (
              <div key={k} className={`rounded-xl shadow p-4 ${bg}`}>
                <p className="text-xs uppercase text-slate-500">{SENSOR_LABELS[k]}</p>
                {s.status === 'ok' ? (
                  isWater ? (
                    <div className="mt-1">
                      <p className="text-2xl font-bold">
                        {(s.state || (typeof s.value === 'number' && s.value <= 180 ? 'raining' : 'clear')) === 'raining'
                          ? '🌧️ Raining'
                          : '☀️ Clear'}
                      </p>
                      <p className="text-xs text-slate-400 mt-1">raw: {s.value}</p>
                    </div>
                  ) : (
                    <p className="text-2xl font-bold">{formatValue(k, s.value)} <span className="text-sm font-normal text-slate-500">{s.unit}</span></p>
                  )
                ) : (
                  <p className="text-sm font-semibold text-slate-500 mt-1">{s.status}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'history' && (
        <div>
          <div className="flex justify-end mb-3">
            <button onClick={exportCsv} className="bg-blue-900 text-white rounded px-4 py-2 text-sm">Export CSV</button>
          </div>
          {Object.keys(SENSOR_LABELS).map(k => {
            const data = history.map(r => ({
              ts: new Date(r.ts).getTime(),
              value: typeof r.sensors?.[k]?.value === 'number' ? r.sensors[k].value : null,
            })).reverse();
            return (
              <div key={k} className="bg-white rounded-xl shadow p-4 mb-4">
                <h3 className="font-semibold mb-2">{SENSOR_LABELS[k]}</h3>
                <div style={{ width: '100%', height: 180 }}>
                  <ResponsiveContainer>
                    <LineChart data={data}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="ts" tickFormatter={t => new Date(t).toLocaleTimeString()} />
                      <YAxis domain={['auto', 'auto']} />
                      <Tooltip labelFormatter={t => new Date(t).toLocaleString()} />
                      <Line type="monotone" dataKey="value" dot={false} stroke="#0b3d91" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            );
          })}
          <details className="bg-white rounded-xl shadow p-4">
            <summary className="cursor-pointer font-semibold">Raw readings table ({history.length})</summary>
            <div className="overflow-auto max-h-96 mt-2">
              <table className="w-full text-xs">
                <thead className="bg-slate-100"><tr>
                  <th className="p-1 text-left">Time</th>
                  {Object.keys(SENSOR_LABELS).map(k => <th key={k} className="p-1 text-left">{SENSOR_LABELS[k]}</th>)}
                </tr></thead>
                <tbody>
                  {history.map(r => (
                    <tr key={r._id} className="border-t">
                      <td className="p-1">{new Date(r.ts).toLocaleString()}</td>
                      {Object.keys(SENSOR_LABELS).map(k => (
                        <td key={k} className="p-1">{r.sensors?.[k]?.status === 'ok' ? formatValue(k, r.sensors[k].value) : '—'}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

function formatValue(key, v) {
  if (v == null) return '—';
  if (typeof v !== 'number') return v;
  if (key === 'temperature' || key === 'pressure') return v.toFixed(1);
  return Math.round(v);
}

// -------- Assistant tab --------
function AssistantPanel({ deviceId, deviceLabel }) {
  const [messages, setMessages] = useState([]);   // [{role:'user'|'assistant', content}]
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Report / email state
  const [reportTitle, setReportTitle] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [savedReport, setSavedReport] = useState(null);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('');

  async function send(e) {
    e?.preventDefault();
    if (!input.trim()) return;
    const question = input.trim();
    setInput('');
    setErr('');
    setBusy(true);
    const nextMsgs = [...messages, { role: 'user', content: question }];
    setMessages(nextMsgs);
    try {
      const { answer } = await api('/api/ai/query', {
        method: 'POST',
        body: { deviceId, messages, question },
      });
      setMessages([...nextMsgs, { role: 'assistant', content: answer }]);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  async function fileReport() {
    setErr(''); setStatus('Saving report...');
    try {
      const { report } = await api('/api/ai/reports', {
        method: 'POST',
        body: { deviceId, title: reportTitle || `Report for ${deviceLabel}`, messages },
      });
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

  return (
    <div className="bg-white rounded-xl shadow p-4">
      <p className="text-sm text-slate-600 mb-3">
        Ask anything about <strong>{deviceLabel}</strong>'s readings. The assistant sees the last 7 days of data for this device.
      </p>

      <div className="border rounded p-3 h-80 overflow-auto bg-slate-50 mb-3">
        {messages.length === 0 && (
          <p className="text-sm text-slate-400">
            Try: "Was today hotter than yesterday?" &middot; "Is the air quality safe right now?" &middot; "Any sensor acting up this week?"
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`mb-3 ${m.role === 'user' ? 'text-right' : ''}`}>
            <div className={`inline-block rounded-lg px-3 py-2 max-w-[85%] whitespace-pre-wrap text-sm ${
              m.role === 'user' ? 'bg-blue-900 text-white' : 'bg-white border'}`}>
              {m.content}
            </div>
          </div>
        ))}
        {busy && <p className="text-sm text-slate-500">Thinking...</p>}
      </div>

      <form onSubmit={send} className="flex gap-2">
        <input className="border rounded p-2 flex-1" placeholder="Ask a question..."
               value={input} onChange={e => setInput(e.target.value)} disabled={busy} />
        <button className="bg-blue-900 text-white rounded px-4">Send</button>
      </form>

      {err && <p className="text-red-600 text-sm mt-2">{err}</p>}

      <div className="mt-5 border-t pt-4">
        {!showReport ? (
          <button disabled={messages.length === 0}
                  onClick={() => setShowReport(true)}
                  className="bg-emerald-700 text-white rounded px-4 py-2 text-sm disabled:opacity-40">
            File a report from this conversation
          </button>
        ) : (
          <div className="space-y-2">
            <label className="block text-sm font-semibold">Report title</label>
            <input className="border rounded p-2 w-full"
                   placeholder={`Report for ${deviceLabel}`}
                   value={reportTitle} onChange={e => setReportTitle(e.target.value)} />

            {!savedReport ? (
              <button onClick={fileReport} className="bg-emerald-700 text-white rounded px-4 py-2 text-sm">Save report</button>
            ) : (
              <div className="flex gap-2">
                <input className="border rounded p-2 flex-1" type="email" placeholder="send-to@example.com"
                       value={email} onChange={e => setEmail(e.target.value)} />
                <button onClick={sendEmail} className="bg-blue-900 text-white rounded px-4 py-2 text-sm">Email it</button>
              </div>
            )}
            {status && <p className="text-sm text-slate-600">{status}</p>}
          </div>
        )}
      </div>
    </div>
  );
}