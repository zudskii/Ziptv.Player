import { Link } from 'react-router';

import { Brand } from './Brand';

const SOCIAL = [
  { href: 'https://github.com/zuDskyy', label: 'GitHub', icon: '/brand/github.png' },
  { href: 'https://www.linkedin.com/in/zurab-dalakishvili-a7b996220/', label: 'LinkedIn', icon: '/brand/linkedin.png' },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-white/5 bg-ink-950/60">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-3">
          <Brand />
          <p className="text-sm text-slate-500">© {new Date().getFullYear()} ZIPTV. All rights reserved.</p>
        </div>
        <nav aria-label="Footer" className="flex gap-12 text-sm">
          <ul className="space-y-2">
            <li className="font-semibold text-slate-200">Menu</li>
            <li>
              <Link to="/" className="text-slate-400 hover:text-white">
                Home
              </Link>
            </li>
            <li>
              <Link to="/watch" className="text-slate-400 hover:text-white">
                Player
              </Link>
            </li>
          </ul>
          <ul className="space-y-2">
            <li className="font-semibold text-slate-200">Contact</li>
            {SOCIAL.map((item) => (
              <li key={item.href}>
                <a href={item.href} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-slate-400 hover:text-white">
                  <img src={item.icon} alt="" className="h-4 w-4 rounded-sm" />
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
