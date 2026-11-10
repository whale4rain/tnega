import { useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { deviceName } from '../lib/account'
import { errorText } from '../lib/hooks'

/**
 * The page a tnega server shows before anyone is signed in: a login and a
 * password, or, when the address carries an invite, the form that creates
 * the account the invite is for.
 */
export function SignIn({ invite, onSignedIn }: { invite?: string | undefined; onSignedIn: () => void }) {
  const [login, setLogin] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (invite && password !== again) {
      setError('The two passwords are different.')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      if (invite) await api.acceptInvite({ code: invite, login, password, device: deviceName(), ...(name.trim() ? { name: name.trim() } : {}) })
      else await api.signIn(login, password, deviceName())
      onSignedIn()
    } catch (reason) {
      setError(errorText(reason))
      setBusy(false)
    }
  }

  return (
    <div className="splash">
      <span className="brand-mark large" aria-hidden />
      <h1>{invite ? 'Join this tnega server' : 'Sign in to tnega'}</h1>
      <p className="muted">{invite ? 'Choose the login and password you will sign in with.' : 'This server is shared. Sign in with the login you were given.'}</p>
      <form className="signin-form" onSubmit={event => void submit(event)} aria-label={invite ? 'Create your account' : 'Sign in'}>
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <label className="field">
          <span className="field-label">Login</span>
          <input value={login} onChange={event => setLogin(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus />
        </label>
        {invite && <label className="field">
          <span className="field-label">Name</span>
          <input value={name} onChange={event => setName(event.target.value)} autoComplete="name" placeholder="Shown to others; optional" />
        </label>}
        <label className="field">
          <span className="field-label">Password</span>
          <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={invite ? 'new-password' : 'current-password'} minLength={invite ? 10 : undefined} required />
        </label>
        {invite && <label className="field">
          <span className="field-label">Password again</span>
          <input type="password" value={again} onChange={event => setAgain(event.target.value)} autoComplete="new-password" required />
        </label>}
        {invite && <p className="muted small">At least 10 characters.</p>}
        <button type="submit" className="button primary" disabled={busy}>{busy ? 'One moment…' : invite ? 'Create account' : 'Sign in'}</button>
      </form>
    </div>
  )
}
