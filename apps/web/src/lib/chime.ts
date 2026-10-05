/**
 * The desktop notice sound: two soft sine notes with a quiet octave shimmer,
 * synthesised here instead of the system "ding" (`shell.beep`), which is loud
 * and different on every machine. Rising for a reply or a question, falling
 * for a failure; always quiet.
 */
export type ChimeKind = 'completed' | 'failed' | 'waiting'

const NOTES: Record<ChimeKind, readonly number[]> = {
  completed: [783.99, 1046.5], // G5 → C6
  waiting: [880, 1174.66], // A5 → D6
  failed: [659.25, 523.25], // E5 → C5
}

const VOLUME = 0.05
const STEP = 0.13
const DECAY = 0.9

let shared: AudioContext | undefined

function audio(): AudioContext | undefined {
  if (!shared && typeof AudioContext === 'function') shared = new AudioContext()
  return shared
}

export function playChime(kind: ChimeKind, context: AudioContext | undefined = audio()): void {
  if (!context) return
  try {
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
    const start = context.currentTime + 0.02
    NOTES[kind].forEach((frequency, index) => {
      const at = start + index * STEP
      for (const [multiple, level] of [[1, VOLUME], [2, VOLUME * 0.18]] as const) {
        const tone = context.createOscillator()
        tone.type = 'sine'
        tone.frequency.value = frequency * multiple
        const envelope = context.createGain()
        envelope.gain.setValueAtTime(0, at)
        envelope.gain.linearRampToValueAtTime(level, at + 0.012)
        envelope.gain.exponentialRampToValueAtTime(0.0001, at + DECAY / multiple)
        tone.connect(envelope)
        envelope.connect(context.destination)
        tone.start(at)
        tone.stop(at + DECAY)
      }
    })
  } catch {
    // A notice sound is a nicety; never let it break the notice.
  }
}
