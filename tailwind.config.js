/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['var(--font-display)', 'serif'],
        sans: ['var(--font-sans)', 'sans-serif'],
        mono: ['var(--font-mono)', 'monospace'],
      },
      colors: {
        ink: {
          DEFAULT: '#1a1a1a',
          soft:    '#333333',
          muted:   '#888888',
        },
        surface:  '#f7f8f6',
        border:   '#eeeeee',
        'evs-green': {
          DEFAULT: '#78C41A',
          dark:    '#5a9015',
          light:   '#9fd94d',
        },
        'evs-dark': {
          DEFAULT: '#0d1f08',
          mid:     '#1a3a0d',
        },
        'evs-gray': {
          DEFAULT: '#808285',
          light:   '#a8aaad',
          dark:    '#555759',
        },
        danger: {
          DEFAULT: '#e53e3e',
          dark:    '#c53030',
        },
        // Legacy tokens kept for any old references
        paper:   { DEFAULT: '#fafaf7', warm: '#f5f3ed' },
        rule:    '#d8d4ca',
        accent:  '#78C41A',
        sage:    '#5a9015',
        rust:    '#a0451f',
        amber:   '#b8821f',
      },
    },
  },
  plugins: [],
};
