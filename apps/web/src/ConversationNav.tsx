interface ConversationNavProps {
  count: number
  index: number
  onPrevious: () => void
  onNext: () => void
}

export function ConversationNav({
  count,
  index,
  onPrevious,
  onNext,
}: ConversationNavProps) {
  if (count < 2) return null
  const prevDisabled = index <= 0
  const nextDisabled = index >= count - 1
  return (
    <div
      className="conversation-nav"
      role="navigation"
      aria-label="conversation navigation"
    >
      <button
        type="button"
        className="icon-button"
        onClick={onPrevious}
        disabled={prevDisabled}
        title="previous user message"
      >
        [^]
      </button>
      <span className="count">
        {index + 1}/{count}
      </span>
      <button
        type="button"
        className="icon-button"
        onClick={onNext}
        disabled={nextDisabled}
        title="next user message"
      >
        [v]
      </button>
    </div>
  )
}
