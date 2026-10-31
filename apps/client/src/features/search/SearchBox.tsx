import { Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';

import { useDebounced } from '../../lib/use-debounced';

/**
 * Top-bar search: typing opens /search and keeps the URL in sync (debounced), so results are
 * shareable and Back works. "/" focuses it from anywhere.
 */
export function SearchBox() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const onSearch = pathname === '/search';
  const urlQuery = onSearch ? (params.get('q') ?? '') : '';
  const [value, setValue] = useState(urlQuery);
  const debounced = useDebounced(value, 300);
  const input = useRef<HTMLInputElement>(null);
  const typed = useRef(false);

  // URL → box (Back/Forward, links to /search?q=).
  useEffect(() => {
    if (!typed.current) setValue(urlQuery);
  }, [urlQuery]);

  // Box → URL.
  useEffect(() => {
    if (!typed.current) return;
    typed.current = false;
    const q = debounced.trim();
    if (!q && !onSearch) return;
    navigate(`/search${q ? `?q=${encodeURIComponent(q)}` : ''}`, { replace: onSearch });
  }, [debounced, navigate, onSearch]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <form
      role="search"
      className="relative w-full max-w-md"
      onSubmit={(event) => {
        event.preventDefault();
        const q = value.trim();
        if (q) navigate(`/search?q=${encodeURIComponent(q)}`, { replace: onSearch });
      }}
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
      <input
        ref={input}
        type="search"
        value={value}
        onChange={(event) => {
          typed.current = true;
          setValue(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setValue('');
            input.current?.blur();
          }
        }}
        placeholder="Search channels, movies, series…"
        aria-label="Search"
        className="field h-9 pl-9 pr-8 [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            typed.current = true;
            setValue('');
            input.current?.focus();
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-fg-subtle hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </form>
  );
}
