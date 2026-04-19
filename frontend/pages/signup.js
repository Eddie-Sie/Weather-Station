import { useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { api, setToken } from '../lib/api';

export default function Signup() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const router = useRouter();

  async function submit(e) {
    e.preventDefault();
    setErr('');
    try {
      const { token } = await api('/api/auth/signup', { method: 'POST', body: { email, password, name }, auth: false });
      setToken(token);
      router.push('/dashboard');
    } catch (e) { setErr(e.message); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={submit} className="bg-white rounded-xl shadow p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-blue-900 mb-6">Create your account</h1>
        <label className="block text-sm font-semibold mb-1">Name</label>
        <input className="border rounded w-full p-2 mb-3" value={name} onChange={e => setName(e.target.value)} />
        <label className="block text-sm font-semibold mb-1">Email</label>
        <input className="border rounded w-full p-2 mb-3" value={email} onChange={e => setEmail(e.target.value)} />
        <label className="block text-sm font-semibold mb-1">Password (min 8 chars)</label>
        <input type="password" className="border rounded w-full p-2 mb-3" value={password} onChange={e => setPassword(e.target.value)} />
        {err && <p className="text-red-600 text-sm mb-3">{err}</p>}
        <button className="w-full bg-blue-900 text-white rounded p-2 font-semibold">Sign up</button>
        <p className="text-sm text-slate-600 mt-4">Already have an account? <Link className="text-blue-900 underline" href="/">Sign in</Link></p>
      </form>
    </div>
  );
}
