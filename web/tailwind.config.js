/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#05050a',
        panel: 'rgba(255,255,255,0.045)',
        violet: { 400: '#a78bfa', 500: '#8b5cf6', 600: '#7c3aed' },
        electric: { 300: '#7aa7ff', 400: '#4d86ff', 500: '#2f6bff' },
      },
      fontFamily: {
        display: ['"Sora Variable"', 'Sora', 'system-ui', 'sans-serif'],
        sans: ['"Inter Variable"', 'Inter', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        floaty: { '0%,100%': { transform: 'translate3d(0,0,0) scale(1)' }, '50%': { transform: 'translate3d(30px,-24px,0) scale(1.08)' } },
        rise: { from: { opacity: 0, transform: 'translateY(12px)' }, to: { opacity: 1, transform: 'none' } },
        pulseRing: { '0%': { boxShadow: '0 0 0 0 rgba(139,92,246,.55)' }, '100%': { boxShadow: '0 0 0 18px rgba(139,92,246,0)' } },
      },
      animation: { floaty: 'floaty 14s ease-in-out infinite', rise: 'rise .5s cubic-bezier(.2,.8,.2,1) both', pulseRing: 'pulseRing 1.6s ease-out infinite' },
    },
  },
  plugins: [],
};
