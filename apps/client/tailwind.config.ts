import type { Config } from 'tailwindcss';
import defaultTheme from 'tailwindcss/defaultTheme';

// Tailwind 3 on purpose: v4 relies on @property / oklch / color-mix, which older Smart-TV
// browsers (Tizen, webOS) do not support.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // `xs` first so breakpoints stay in ascending order in the generated CSS.
    screens: { xs: '420px', ...defaultTheme.screens },
    extend: {
      colors: {
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
          soft: '#60a5fa',
          strong: '#2563eb',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Noto Sans', 'Noto Sans Georgian', 'sans-serif'],
      },
      keyframes: {
        marquee: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
      },
      animation: {
        marquee: 'marquee 40s linear infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
