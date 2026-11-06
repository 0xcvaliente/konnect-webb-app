import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// Teach tailwind-merge our own theme names (globals.css), so that "text-body" is read as a font
// size and does not knock out a text colour, and "rounded-card" as a radius.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['body', 'tag'],
      radius: ['card', 'item', 'menu'],
    },
  },
})

/** Join class names and let later Tailwind classes win over earlier ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
