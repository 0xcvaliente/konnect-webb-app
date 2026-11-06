// Tailwind 4 runs as a PostCSS plugin. It only reaches files that import src/app/(frontend)/globals.css,
// so the Payload admin keeps its own styles.
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}

export default config
