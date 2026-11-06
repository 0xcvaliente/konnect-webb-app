'use client'

import { useTranslations } from 'next-intl'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

/** Toasts: a pill in --ink with --bg text, at the bottom of the screen. Follows the system theme. */
function Toaster(props: ToasterProps) {
  const t = useTranslations('Shell')
  return (
    <Sonner
      containerAriaLabel={t('notifications')}
      theme="system"
      position="bottom-center"
      offset={{ bottom: 88 }}
      mobileOffset={{ bottom: 88 }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex w-full items-center gap-2.5 rounded-full bg-foreground px-5 py-3 text-body font-semibold text-background shadow-[0_8px_24px_-8px_color-mix(in_srgb,var(--ink)_50%,transparent)] sm:w-auto',
          description: 'font-normal opacity-85',
          actionButton:
            'ml-auto min-h-9 cursor-pointer rounded-full bg-background px-3 text-sm font-semibold text-foreground',
          icon: 'shrink-0',
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
