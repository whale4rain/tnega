import { MessageCircleDashed, MessageSquareText, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { streamSideChat } from '../../lib/api'
import { errorText, useStableCallback } from '../../lib/hooks'
import type { SideAsk } from '../../lib/workbench'
import { Markdown } from '../Markdown'
import { PromptBox } from '../PromptBox'

interface SideTurn {
  id: number
  role: 'user' | 'assistant'
  content: string
  error?: string
}

/** A session the chat can be about: the one open in the conversation, or the one `/btw` named. */
export interface SideSession {
  id: string
  title: string
}

/**
 * The temporary chat (sidebar's Temporary chat, and `/btw`): quick questions
 * on the side, answered by the model without tools. It can be about a
 * session, which it then reads but never writes to; the agent working there
 * is not interrupted and never sees it. Nothing is saved: closing the tab or
 * reloading the app ends the chat.
 */
export function SideChatView({ workspace, ask, current, visible }: {
  workspace: string
  /** A `/btw` question to ask as soon as it arrives. */
  ask?: SideAsk | undefined
  /** The session open in the conversation, offered as what the chat is about. */
  current?: SideSession | undefined
  visible: boolean
}) {
  const [turns, setTurns] = useState<readonly SideTurn[]>([])
  const [about, setAbout] = useState<SideSession | undefined>(ask?.session)
  /** The answer streaming now. */
  const [pending, setPending] = useState<number>()
  const abort = useRef<AbortController | undefined>(undefined)
  const nextId = useRef(1)
  const asked = useRef(0)
  const scroller = useRef<HTMLDivElement>(null)

  // Stop an answer still streaming when the chat goes away.
  useEffect(() => () => abort.current?.abort(), [])

  useEffect(() => {
    const box = scroller.current
    if (box) box.scrollTop = box.scrollHeight
  }, [turns])

  const answer = async (question: string, session: SideSession | undefined, history: readonly SideTurn[]): Promise<boolean> => {
    const text = question.trim()
    if (!text) return false
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    const userTurn: SideTurn = { id: nextId.current++, role: 'user', content: text }
    const answerId = nextId.current++
    const asked = [...history.filter(turn => !turn.error && turn.content), userTurn]
    setTurns([...history, userTurn, { id: answerId, role: 'assistant', content: '' }])
    setPending(answerId)
    const update = (change: (turn: SideTurn) => SideTurn) =>
      setTurns(list => list.map(turn => (turn.id === answerId ? change(turn) : turn)))
    try {
      await streamSideChat(workspace, {
        messages: asked.map(turn => ({ role: turn.role, content: turn.content })),
        ...(session ? { session: session.id } : {}),
      }, event => {
        if (event.type === 'side/delta') update(turn => ({ ...turn, content: turn.content + event.text }))
        else if (event.type === 'side/error') update(turn => ({ ...turn, error: event.message }))
      }, controller.signal)
    } catch (reason) {
      if (!controller.signal.aborted) update(turn => ({ ...turn, error: errorText(reason) }))
    } finally {
      if (abort.current === controller) {
        abort.current = undefined
        setPending(undefined)
      }
    }
    return true
  }

  // Stable, so the /btw effect below runs for a new ask only; it reads the turns of the moment.
  const send = useStableCallback((question: string, session: SideSession | undefined) => answer(question, session, turns))

  // A /btw question: about the session it was typed in, asked once per nonce.
  useEffect(() => {
    if (!ask || ask.nonce === asked.current) return
    asked.current = ask.nonce
    setAbout(ask.session)
    void send(ask.question, ask.session)
  }, [ask, send])

  const startOver = () => {
    abort.current?.abort()
    setTurns([])
    setPending(undefined)
  }

  // A session is often named after its first reply: show the name it has now.
  const subject = about && current?.id === about.id ? current : about
  const offer = !about && current
  return (
    <div className="wb-view side-chat" aria-label="Temporary chat">
      <div className="wb-toolbar">
        <span className="wb-toolbar-title">Temporary chat</span>
        {(about || offer) && (
          <button
            type="button"
            className="chip side-chat-about"
            aria-pressed={Boolean(about)}
            aria-label={subject ? `About ${subject.title}. Click to stop` : `Ask about ${current?.title ?? 'this session'}`}
            title={about ? 'The chat reads this session. Click to stop.' : 'Let the chat read the open session'}
            onClick={() => setAbout(about ? undefined : current)}
          >
            <MessageSquareText size={12} aria-hidden />
            <span className="side-chat-about-label">{subject ? subject.title : 'Ask about this session'}</span>
          </button>
        )}
        {turns.length > 0 && (
          <button type="button" className="icon-button small" onClick={startOver} aria-label="Start over" title="Start over">
            <RotateCcw size={14} />
          </button>
        )}
      </div>
      <div className="wb-card wb-flow side-chat-body">
        <div className="side-scroll" ref={scroller}>
          {turns.length === 0
            ? (
              <div className="wb-empty">
                <MessageCircleDashed size={20} aria-hidden />
                <p>{subject
                  ? `Ask about “${subject.title}” on the side. The agent is not interrupted and never sees this chat.`
                  : 'Ask anything on the side. Nothing here is saved.'}</p>
              </div>
            )
            : (
              <div className="timeline room" role="log" aria-label="Temporary chat messages" aria-live="polite">
                {turns.map(turn => turn.role === 'user'
                  ? (
                    <div key={turn.id} className="room-run room-run-user">
                      <div className="room-bubble"><div className="room-message"><Markdown text={turn.content} breaks /></div></div>
                    </div>
                  )
                  : (
                    <div key={turn.id} className="room-run room-run-agent">
                      <div className="room-message">
                        {turn.content && <Markdown text={turn.content} />}
                        {!turn.content && !turn.error && turn.id === pending && (
                          <div className="room-typing" role="status"><span className="thinking-dots" aria-hidden><i /><i /><i /></span><span>Thinking…</span></div>
                        )}
                        {!turn.content && !turn.error && turn.id !== pending && <p className="muted small">Stopped.</p>}
                        {turn.error && <div className="notice notice-error" role="alert">{turn.error}</div>}
                      </div>
                    </div>
                  ))}
              </div>
            )}
        </div>
        <div className="side-dock">
          <PromptBox
            inline
            placeholder={subject ? `Ask about ${subject.title}…` : 'Ask anything…'}
            onSubmit={text => send(text, about)}
            onStop={() => abort.current?.abort()}
            running={pending !== undefined}
            autoFocusKey={visible ? `side:${ask?.nonce ?? 0}` : undefined}
          />
          <p className="side-chat-note">Not saved · the agent never sees this chat</p>
        </div>
      </div>
    </div>
  )
}
