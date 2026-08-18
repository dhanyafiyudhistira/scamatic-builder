import { useEffect, useState } from 'react'
import { login, signup } from './api.js'
import { ThemeToneToggle } from './ThemeTone.jsx'

const DEFAULT_GOOGLE_AUTH_URL = '/api/auth/google/start?next=%2F'

export const GOOGLE_AUTH_URL = resolveGoogleAuthUrl(import.meta.env.VITE_GOOGLE_AUTH_URL)

function resolveGoogleAuthUrl(configuredUrl) {
  const candidate = String(configuredUrl || DEFAULT_GOOGLE_AUTH_URL).trim()
  if (candidate.startsWith('/') && !candidate.startsWith('//')) return candidate
  try {
    const url = new URL(candidate)
    if (url.protocol === 'https:' || (import.meta.env.DEV && url.protocol === 'http:')) return url.href
  } catch { /* Use the safe default below. */ }
  return DEFAULT_GOOGLE_AUTH_URL
}

export function AuthScreen({ onAuthenticated, runtime = false, allowSignup = true }) {
  const [mode, setMode] = useState('login')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState(readOAuthError)
  const [busy, setBusy] = useState(false)
  const signingUp = mode === 'signup'

  useEffect(() => {
    if (typeof window === 'undefined' || !new URLSearchParams(window.location.search).has('auth_error')) return
    const url = new URL(window.location.href)
    url.searchParams.delete('auth_error')
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

  const submit = async event => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (signingUp) {
        await signup({ displayName, email, password, confirmPassword })
      } else {
        await login(email, password)
      }
      await onAuthenticated()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  const switchMode = nextMode => {
    setMode(nextMode)
    setPassword('')
    setConfirmPassword('')
    setError('')
  }

  return (
    <div className={runtime ? 'sb-runtime-login' : 'sb-login-page'}>
      <form className="sb-login-card" onSubmit={submit}>
        <div className="sb-login-card-head"><div className="sb-login-mark">SC</div><ThemeToneToggle /></div>
        <p className="eyebrow">{runtime ? 'PRIVATE SCADA RUNTIME' : 'SCADA SCHEMATIC PLATFORM'}</p>
        <h1>{signingUp ? 'Create your account' : runtime ? 'Runtime access' : 'Welcome to Scamatic Builder'}</h1>
        <p>{signingUp ? 'Use your own email to create a private SCADA workspace.' : runtime ? 'Sign in with an account assigned to this project.' : 'Sign in securely with your own account.'}</p>

        {signingUp && <label>Display name <input type="text" value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="name" maxLength="100" placeholder="Your name" /></label>}
        <label>Email <input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" maxLength="120" placeholder="you@company.com" required autoFocus /></label>
        <label>Password <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={signingUp ? 'new-password' : 'current-password'} minLength={signingUp ? 10 : undefined} maxLength="256" required /></label>
        {signingUp && <label>Confirm password <input type="password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength="10" maxLength="256" required /></label>}
        {signingUp && <small className="sb-auth-hint">Use at least 10 characters for your password.</small>}
        {error && <div className="sb-form-error" role="alert">{error}</div>}
        <button type="submit" className="primary sb-auth-submit" disabled={busy}>{busy ? signingUp ? 'Creating account…' : 'Signing in…' : signingUp ? 'Create account' : 'Sign in'}</button>

        <div className="sb-auth-divider"><span>or</span></div>
        <a className="sb-google-auth" href={GOOGLE_AUTH_URL}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285f4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.41Z" />
            <path fill="#34a853" d="M12 22c2.7 0 4.98-.9 6.63-2.36l-3.24-2.54c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z" />
            <path fill="#fbbc05" d="M6.39 13.93A6.02 6.02 0 0 1 6.08 12c0-.67.11-1.32.31-1.93V7.45H3.04A10 10 0 0 0 2 12c0 1.63.39 3.17 1.04 4.55l3.35-2.62Z" />
            <path fill="#ea4335" d="M12 5.94c1.47 0 2.79.5 3.82 1.5l2.88-2.87A9.65 9.65 0 0 0 12 2a10 10 0 0 0-8.96 5.45l3.35 2.62C7.18 7.7 9.39 5.94 12 5.94Z" />
          </svg>
          <span>Lanjutkan dengan Google</span>
        </a>

        {allowSignup && <p className="sb-auth-switch">{signingUp ? 'Already have an account?' : 'New to Scamatic?'} <button type="button" onClick={() => switchMode(signingUp ? 'login' : 'signup')}>{signingUp ? 'Sign in' : 'Create an account'}</button></p>}
      </form>
    </div>
  )
}

function readOAuthError() {
  if (typeof window === 'undefined') return ''
  const code = new URLSearchParams(window.location.search).get('auth_error')
  const messages = {
    google_not_configured: 'Google sign-in is not configured yet.',
    google_cancelled: 'Google sign-in was cancelled.',
    google_state_invalid: 'Google sign-in expired or could not be verified. Please try again.',
    google_response_invalid: 'Google returned an invalid sign-in response.',
    google_exchange_failed: 'Google sign-in could not be completed. Please try again.',
    google_identity_invalid: 'The Google account identity could not be verified.',
    account_disabled: 'This account is disabled.',
    account_access_disabled: 'This account no longer has workspace access.',
    database_unavailable: 'The database is temporarily unavailable. Please try again.',
    google_login_failed: 'Google sign-in failed. Please try again.',
  }
  return code ? messages[code] || messages.google_login_failed : ''
}
