import { useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { api, setToken } from '../lib/api';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const router = useRouter();

  async function submit(e) {
    e.preventDefault();
    setErr('');
    try {
      const { token } = await api('/api/auth/login', { method: 'POST', body: { email, password }, auth: false });
      setToken(token);
      router.push('/dashboard');
    } catch (e) { setErr(e.message); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={submit} className="bg-white rounded-xl shadow p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-blue-900 mb-6">Sign in</h1>
        <label className="block text-sm font-semibold mb-1">Email</label>
        <input className="border rounded w-full p-2 mb-3" value={email} onChange={e => setEmail(e.target.value)} />
        <label className="block text-sm font-semibold mb-1">Password</label>
        <input type="password" className="border rounded w-full p-2 mb-3" value={password} onChange={e => setPassword(e.target.value)} />
        {err && <p className="text-red-600 text-sm mb-3">{err}</p>}
        <button className="w-full bg-blue-900 text-white rounded p-2 font-semibold">Sign in</button>
        <p className="text-sm text-slate-600 mt-4">No account? <Link className="text-blue-900 underline" href="/signup">Sign up</Link></p>
      </form>
    </div>
  );
}
