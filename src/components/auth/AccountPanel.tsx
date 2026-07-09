// LU Cloud account panel (Settings → General). Signed out: inline
// email+password sign-in/sign-up. Signed in: email, tier, credits/token
// meters, manage-subscription (system browser), sign out. Enabling the cloud
// axis everywhere else (Create backend toggle, lu-cloud chat provider) hangs
// off the cloudAuthStore this panel drives via useCloudAuth.

import { useState } from 'react'
import { Loader2, LogOut, ExternalLink, Cloud } from 'lucide-react'
import { useCloudAuth } from '../../hooks/useCloudAuth'
import { useCloudAuthStore } from '../../stores/cloudAuthStore'
import { CLOUD_BASE } from '../../api/cloud/config'
import { openExternal } from '../../api/backend'

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[0.65rem]">
        <span className="text-gray-600 dark:text-gray-400">{label}</span>
        <span className="text-gray-500 dark:text-gray-500 tabular-nums">
          {used.toLocaleString()} / {limit.toLocaleString()}
        </span>
      </div>
      <div className="h-1 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
        <div className="h-full rounded-full bg-gray-700 dark:bg-white/60" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function AccountPanel() {
  const { status, login, signup, logout } = useCloudAuth()
  const user = useCloudAuthStore((s) => s.user)
  const licenseActive = useCloudAuthStore((s) => s.licenseActive)
  const quota = useCloudAuthStore((s) => s.quota)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || !email || !password) return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'signin') await login(email, password)
      else await signup(email, password)
      setPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (status === 'probing') {
    return (
      <div className="flex items-center gap-2 py-1 text-[0.7rem] text-gray-500">
        <Loader2 size={11} className="animate-spin" /> Checking account…
      </div>
    )
  }

  if (status === 'signed-out' || !user) {
    return (
      <form onSubmit={submit} className="space-y-2">
        <p className="text-[0.7rem] text-gray-600 dark:text-gray-400">
          Sign in to render images, video and chat on LU's cloud GPUs. Local features never need an account.
        </p>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          autoComplete="email"
          className="w-full px-2 py-1.5 rounded text-[0.7rem] bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-gray-900 dark:text-gray-100 placeholder-gray-400 outline-none focus:border-gray-400 dark:focus:border-white/30"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          className="w-full px-2 py-1.5 rounded text-[0.7rem] bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-gray-900 dark:text-gray-100 placeholder-gray-400 outline-none focus:border-gray-400 dark:focus:border-white/30"
        />
        {error && <p className="text-[0.65rem] text-red-500 dark:text-red-400">{error}</p>}
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={busy || !email || !password}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[0.7rem] font-medium bg-gray-900 text-white dark:bg-white dark:text-gray-900 disabled:opacity-40 hover:opacity-90 transition-opacity"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Cloud size={11} />}
            {mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
          <button
            type="button"
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null) }}
            className="text-[0.65rem] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            {mode === 'signin' ? 'No account yet? Sign up' : 'Have an account? Sign in'}
          </button>
        </div>
      </form>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[0.7rem] text-gray-900 dark:text-gray-100">{user.email ?? user.id}</div>
          <div className="text-[0.65rem] text-gray-500">
            {licenseActive ? `Plan: ${quota?.tier ?? 'active'}` : 'No active plan'}
          </div>
        </div>
        <button
          onClick={() => void logout()}
          className="flex items-center gap-1 px-2 py-1 rounded text-[0.65rem] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
        >
          <LogOut size={10} /> Sign out
        </button>
      </div>

      {licenseActive && quota ? (
        <div className="space-y-2">
          {/* One shared compute-credit wallet — chat, images, video and voice
              all draw from the same monthly budget. */}
          <Meter
            label="Cloud credits (this month)"
            used={Number(quota.used.credits_used)}
            limit={quota.limits.credits}
          />
        </div>
      ) : (
        <p className="text-[0.7rem] text-gray-600 dark:text-gray-400">
          Pick a plan to unlock cloud rendering and chat.
        </p>
      )}

      <button
        onClick={() => void openExternal(`${CLOUD_BASE}/${licenseActive ? 'account' : 'pricing'}`)}
        className="flex items-center gap-1 text-[0.65rem] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
      >
        <ExternalLink size={10} /> {licenseActive ? 'Manage subscription' : 'View plans'} on lu-labs.ai
      </button>
    </div>
  )
}
