import './ContentLoading.css'

/** Shared, user-facing loading state for each Rate APP section.
 * Keep messages about the user's task, not network or backend internals. */
export default function ContentLoading({
  text, tone = 'green', compact = false,
}: {
  text: string
  tone?: 'green' | 'violet'
  compact?: boolean
}) {
  return (
    <div className={'content-loading content-loading--' + tone +
      (compact ? ' content-loading--compact' : '')} role="status" aria-live="polite">
      <span className="content-loading__spinner" aria-hidden="true" />
      <span className="content-loading__text">{text}</span>
    </div>
  )
}
