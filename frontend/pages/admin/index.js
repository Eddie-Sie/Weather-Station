import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { api } from '../../lib/api';

export default function Admin() {
  const [devices, setDevices] = useState([]);
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState('');
  const router = useRouter();

  useEffect(() => {
    (async () => {
      try {
        const who = await api('/api/auth/me');
        if (who.user.role !== 'admin') return router.push('/dashboard');
        const { devices } = await api('/api/devices?all=1');
        setDevices(devices);
      } catch (e) {
        if (e.status === 401) router.push('/');
        else setErr(e.message);
      }
    })();
  }, []);

  const filtered = devices.filter(d => {
    const q = filter.toLowerCase();
    return !q || (d.deviceId || '').toLowerCase().includes(q)
                || (d.locationName || '').toLowerCase().includes(q)
                || (d.owner?.email || '').toLowerCase().includes(q);
  });

  return (
    <div className="min-h-screen p-6 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-blue-900">Admin: All Devices</h1>
        <Link href="/dashboard" className="text-sm text-blue-900 underline">My devices</Link>
      </header>

      <input className="border rounded w-full p-2 mb-4" placeholder="Filter by device ID, location, or owner email"
             value={filter} onChange={e => setFilter(e.target.value)} />

      {err && <p className="text-red-600">{err}</p>}

      <div className="bg-white rounded-xl shadow overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-2 text-left">Device ID</th>
              <th className="p-2 text-left">Location</th>
              <th className="p-2 text-left">Owner</th>
              <th className="p-2 text-left">Last seen</th>
              <th className="p-2 text-left">Sensors</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(d => (
              <tr key={d._id} className="border-t">
                <td className="p-2 font-mono text-xs">{d.deviceId || '(unpaired)'}</td>
                <td className="p-2">{d.locationName || '—'}</td>
                <td className="p-2">{d.owner?.email || '—'}</td>
                <td className="p-2">{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : 'never'}</td>
                <td className="p-2">
                  {Object.entries(d.lastStatus || {}).map(([k,v]) => (
                    <span key={k} className={`inline-block mr-1 px-1.5 py-0.5 rounded text-xs ${
                      v === 'ok' ? 'bg-green-100 text-green-800' :
                      v === 'disconnected' ? 'bg-slate-200 text-slate-600' :
                      'bg-red-100 text-red-800'}`}>{k}</span>
                  ))}
                </td>
                <td className="p-2"><Link href={`/device/${d._id}`} className="text-blue-900 underline">view</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
