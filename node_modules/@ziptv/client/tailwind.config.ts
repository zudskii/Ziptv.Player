import type { Config } from 'tailwindcss';
import defaultTheme from 'tailwindcss/defaultTheme';

/** Theme colours are CSS variables (see styles/index.css) so dark/light switch without rebuilding classes. */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

// Tailwind 3 on purpose: v4 relies on @property / oklch / color-mix, which older Smart-TV
// browsers (Tizen, webOS) do not support.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // `xs` first so breakpoints stay in ascending order in the generated CSS.
    screens: { xs: '420px', ...defaultTheme.screens },
    extend: {
      colors: {
        canvas: token('canvas'),
        surface: { DEFAULT: token('surface'), 2: token('surface-2') },
        sunken: token('sunken'),
        elevated: token('elevated'),
        fg: { DEFAULT: token('fg'), muted: token('fg-muted'), subtle: token('fg-subtle') },
        line: token('line'),
        // Fixed dark palette for surfaces that are always dark (the video player).
        ink: {
          950: '#070b16',
          900: '#0b1120',
          850: '#0f172a',
          800: '#141d33',
          700: '#1e293b',
          600: '#334155',
        },
        brand: {
          DEFAULT: '#3b82f6',
          soft: token('brand-soft'),
          strong: '#2563eb',
        },
        live: '#ef4444',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Noto Sans', 'Noto Sans Georgian', 'sans-serif'],
      },
      keyframes: {
        marquee: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        marquee: 'marquee 40s linear infinite',
        'fade-in': 'fade-in 160ms ease-out',
      },
    },
  },
  plugins: [],
} satisfies Config;
