import { LogIn, LogOut } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { errorText } from '../lib/hooks'
import type { ChatGptLoginState, ConfigSnapshot } from '../lib/types'

/**
 * Use a ChatGPT plan instead of an API key: opens OpenAI's sign-in page,
 * waits for the account to come back, then adds a "ChatGPT" model route.
 */
export function ChatGptSignIn({ onChanged }: { onChanged: (config: ConfigSnapshot) => void }) {
  const [state, setState] = useState<ChatGptLoginState>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    void api.chatgptLogin().then(next => { if (alive.current) setState(next) }, () => undefined)
    return () => { alive.current = false }
  }, [])

  // While a sign-in is open in the browser, watch for it to finish.
  useEffect(() => {
    if (state?.status !== 'pending') return
    const timer = setInterval(() => {
      void api.chatgptLogin().then(async next => {
        if (!alive.current) return
        setState(next)
        if (next.status === 'signed-in') onChanged(await api.config())
      }, () => undefined)
    }, 1500)
    return () => clearInterval(timer)
  }, [state?.status, onChanged])

  const signIn = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const { url } = await api.startChatgptLogin()
      setState({ status: 'pending', url })
      window.open(url, '_blank', 'noopener')
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }
  const signOut = async () => {
    setBusy(true)
    try {
      setState(await api.signOutChatgpt())
      onChanged(await api.config())
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="chatgpt-sign-in">
      {state?.status === 'signed-in'
        ? <>
          <span className="muted small">Signed in to ChatGPT{state.email ? ` as ${state.email}` : ''}; the ChatGPT model uses your plan.</span>
          <button type="button" className="button ghost small" disabled={busy} onClick={() => void signOut()}><LogOut size={13} /> Sign out</button>
        </>
        : state?.status === 'pending'
          ? <span className="muted small">Finish signing in in your browser… <a href={state.url} target="_blank" rel="noreferrer noopener">Open the sign-in page again</a></span>
          : <>
            <button type="button" className="button secondary small" disabled={busy} onClick={() => void signIn()}><LogIn size={13} /> Sign in with ChatGPT</button>
            <span className="muted small">Use your ChatGPT plan instead of an API key.</span>
          </>}
      {(error || state?.status === 'error') && <div role="alert" className="notice notice-error"><span>{error ?? (state?.status === 'error' ? state.message : '')}</span></div>}
    </div>
  )
}
