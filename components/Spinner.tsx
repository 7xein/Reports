/** 14px indeterminate spinner in the current text colour. */
export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`animate-spin h-3.5 w-3.5 shrink-0${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
