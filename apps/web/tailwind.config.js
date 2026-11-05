/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        telegram: {
          primary: '#24A1DE',
          'primary-hover': '#208fc4',
          'primary-dark': '#1e88bb',
          bubble: {
            incoming: '#2b5278',
            outgoing: '#2b5278',
            'incoming-light': '#ffffff',
            'outgoing-light': '#effdde',
          },
          dark: {
            bg: '#0e1621',
            sidebar: '#17212b',
            header: '#17212b',
            card: '#242f3d',
            hover: '#202b36',
            active: '#2b5278',
            border: '#101921',
            text: '#f5f5f5',
            muted: '#7f91a4',
          },
          light: {
            bg: '#f4f4f5',
            sidebar: '#ffffff',
            header: '#ffffff',
            card: '#f9fafb',
            hover: '#f3f4f6',
            active: '#e0f2fe',
            border: '#e5e7eb',
            text: '#111827',
            muted: '#6b7280',
          }
        }
      }
    },
  },
  plugins: [],
}
