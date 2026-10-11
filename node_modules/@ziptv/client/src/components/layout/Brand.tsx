import { Link } from 'react-router';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
      <img src="/brand/logo.jpg" alt="" width={32} height={32} className="h-8 w-8 rounded-full ring-1 ring-line/10" />
      {!compact && <span className="text-lg font-bold tracking-tight text-fg">ZIPTV</span>}
    </Link>
  );
}
