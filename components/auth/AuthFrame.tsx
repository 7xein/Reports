/**
 * The centered sign-in layout shared by /login, /signup and /welcome: logo,
 * company line, display heading and a short rule, with the page's content below.
 */
export function AuthFrame({
  heading,
  subtitle,
  children,
}: {
  heading: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-12">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/evs-logo-nobg.png"
            alt="EVS"
            style={{ height: '64px', width: 'auto', margin: '0 auto 24px' }}
          />
          <div className="smallcaps text-xs text-ink-muted mb-4">Electric Vehicle Services</div>
          <h1 className="font-display text-5xl font-light tracking-tight text-ink leading-none">
            {heading}
          </h1>
          <div className="mt-6 mx-auto w-12 h-px bg-rule" />
          {subtitle && <p className="mt-6 text-ink-muted text-sm">{subtitle}</p>}
        </div>

        {children}
      </div>
    </div>
  );
}

/** A labelled input in the sign-in style. */
export function AuthField({
  id,
  label,
  hint,
  ...input
}: { id: string; label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} className="block smallcaps text-[10px] text-ink-muted mb-2">
        {label}
      </label>
      <input
        id={id}
        {...input}
        className="w-full px-4 py-3 bg-white border border-rule focus:border-ink focus:outline-none font-sans text-ink transition-colors"
      />
      {hint && <div className="mt-1.5 text-ink-muted text-xs">{hint}</div>}
    </div>
  );
}

/** Only a same-site path may be a post-sign-in destination; anything else becomes '/'. */
export function safeFrom(from: string | null): string {
  if (!from || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) return '/';
  return from;
}
