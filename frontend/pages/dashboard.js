import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { api, setToken } from '../lib/api';

export default function Dashboard() {
  const [me, setMe] = useState(null);
  const [devices, setDevices] = useState([]);
  const [locationName, setLocationName] = useState('');
  const [err, setErr] = useState('');
  const [newCode, setNewCode] = useState(null);
  const router = useRouter();

  async function refresh() {
    try {
      const who = await api('/api/auth/me');
      setMe(who.user);
      const { devices } = await api('/api/devices');
      setDevices(devices);
    } catch (e) {
      if (e.status === 401) router.push('/');
      else setErr(e.message);
    }
  }
  useEffect(() => { refresh(); }, []);

  async function addDevice(e) {
    e.preventDefault();
    const { device } = await api('/api/devices', { method: 'POST', body: { locationName } });
    setNewCode(device.pairingCode);
    setLocationName('');
    refresh();
  }

  function logout() { setToken(null); router.push('/'); }

  return (
    <div className="min-h-screen p-6 max-w-5xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-blue-900">My Weather Devices</h1>
        <div className="flex gap-3 items-center">
          {me?.role === 'admin' && <Link href="/admin" className="text-blue-900 underline text-sm">Admin view</Link>}
          <span className="text-sm text-slate-600">{me?.email}</span>
          <button onClick={logout} className="text-sm bg-slate-200 px-3 py-1 rounded">Sign out</button>
        </div>
      </header>

      <section className="bg-white rounded-xl shadow p-5 mb-6">
        <h2 className="font-semibold mb-3">Add a new device</h2>
        <form onSubmit={addDevice} className="flex flex-col sm:flex-row gap-3">
          <input className="border rounded p-2 flex-1" placeholder="Location name (e.g. Community Center Kumasi)"
                 value={locationName} onChange={e => setLocationName(e.target.value)} />
          <button className="bg-blue-900 text-white rounded px-4 py-2 font-semibold">Generate pairing code</button>
        </form>
        {newCode && (
          <div className="mt-4 bg-yellow-50 border border-yellow-300 rounded p-3">
            <p className="text-sm">Type this code into the Weather Node's setup page:</p>
            <p className="text-3xl font-bold tracking-widest text-yellow-900">{newCode}</p>
            <p className="text-xs text-slate-600 mt-1">It's valid until a device successfully pairs with it.</p>
          </div>
        )}
      </section>

      {err && <p className="text-red-600 mb-4">{err}</p>}

      <section className="grid md:grid-cols-2 gap-4">
        {devices.length === 0 && <p className="text-slate-600">No devices yet. Add one above.</p>}
        {devices.map(d => (
          <Link key={d._id} href={`/device/${d._id}`} className="bg-white rounded-xl shadow p-4 hover:shadow-md transition">
            <div className="flex justify-between">
              <h3 className="font-semibold">{d.locationName || '(unnamed location)'}</h3>
              <span className={`text-xs px-2 py-0.5 rounded ${isOnline(d) ? 'bg-green-100 text-green-800' : 'bg-slate-200 text-slate-700'}`}>
                {isOnline(d) ? 'online' : 'offline'}
              </span>
            </div>
            <p className="text-xs text-slate-500">Device ID: {d.deviceId || '(waiting for first connect)'}</p>
            <p className="text-xs text-slate-500">Pairing code: {d.pairingCode}</p>
            {d.lastSeenAt && <p className="text-xs text-slate-500">Last seen: {new Date(d.lastSeenAt).toLocaleString()}</p>}
          </Link>
        ))}
      </section>
    </div>
  );
}

function isOnline(d) {
  if (!d.lastSeenAt) return false;
  return (Date.now() - new Date(d.lastSeenAt).getTime()) < 5 * 60 * 1000;   // seen in last 5 min
}
