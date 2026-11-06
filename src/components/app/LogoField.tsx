'use client'

import { ImageIcon, LoaderCircleIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { LOGO_MAX_BYTES } from '@/lib/companies/fields'
import { cn } from '@/lib/utils'

import { Banner } from './Banner'
import { CompanyAvatar } from './CompanyAvatar'

/** What the page knows about a logo. `url` is the access-checked file route. */
export type LogoInfo = { id: number; name: string; url?: string | null }

type UploadError = 'type' | 'size' | 'tooMany' | 'generic'

const looksLikeImage = (file: File) =>
  ['image/png', 'image/jpeg'].includes(file.type) || /\.(png|jpe?g)$/i.test(file.name)

/**
 * Upload a logo through Payload's REST endpoint as the signed-in company user. The server checks
 * everything again: the session, the origin, that the file really is a PNG or JPG, 1 MB at
 * most, and the limit on unused files. The checks here only give a faster answer.
 */
async function uploadLogo(file: File): Promise<{ logo: LogoInfo } | { error: UploadError }> {
  if (!looksLikeImage(file)) return { error: 'type' }
  if (file.size > LOGO_MAX_BYTES) return { error: 'size' }

  const form = new FormData()
  form.append('file', file)
  form.append('_payload', '{}')
  try {
    const res = await fetch('/api/company-logos', {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
    })
    if (res.status === 413) return { error: 'size' }
    if (res.status === 429) return { error: 'tooMany' }
    if (res.status === 400) return { error: 'type' }
    if (!res.ok) return { error: 'generic' }
    const { doc } = (await res.json()) as {
      doc: { id: number; originalName?: string; url?: string }
    }
    return { logo: { id: doc.id, name: doc.originalName ?? file.name, url: doc.url } }
  } catch {
    return { error: 'generic' }
  }
}

/** Delete a logo the company uploaded but no longer wants. Best effort. */
export async function deleteLogo(id: number): Promise<void> {
  try {
    await fetch(`/api/company-logos/${id}`, { method: 'DELETE', credentials: 'same-origin' })
  } catch {
    // The daily clean-up removes unused logos.
  }
}

/**
 * The logo block: a drop zone, then the logo with Replace and Remove. `onChange` gets the new
 * logo after an upload, or null after Remove; the caller keeps it until the form is saved.
 */
export function LogoField({
  logo,
  name,
  onChange,
  busy = false,
  error,
  disabled = false,
  className,
}: {
  logo: LogoInfo | null
  /** The company name, for the stand-in letter when there is no logo. */
  name: string
  onChange: (logo: LogoInfo | null) => void | Promise<void>
  busy?: boolean
  /** An error from saving, shown under the field. */
  error?: string
  disabled?: boolean
  className?: string
}) {
  const t = useTranslations('Logo')
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [problem, setProblem] = useState<UploadError | null>(null)
  const working = busy || uploading || disabled
  const message = problem ? t(`errors.${problem}`) : error

  const pick = async (file: File | undefined) => {
    if (!file) return
    setProblem(null)
    setUploading(true)
    const result = await uploadLogo(file)
    setUploading(false)
    if (input.current) input.current.value = ''
    if ('error' in result) setProblem(result.error)
    else await onChange(result.logo)
  }

  const fileInput = (
    <input
      ref={input}
      id={`${id}-file`}
      type="file"
      accept="image/png,image/jpeg,.png,.jpg,.jpeg"
      // Opened by the visible button, so keep it out of the tab order and the a11y tree.
      tabIndex={-1}
      aria-hidden="true"
      className="sr-only"
      disabled={working}
      onChange={(e) => pick(e.target.files?.[0])}
    />
  )

  return (
    <div className={cn('grid gap-3', className)} aria-busy={uploading || busy || undefined}>
      {logo ? (
        <div className="flex flex-wrap items-center gap-3 rounded-item border-[1.5px] border-line bg-surface px-3.5 py-3">
          <CompanyAvatar name={name} logoUrl={logo.url} size="lg" />
          <p className="min-w-0 flex-1 basis-40 font-semibold [overflow-wrap:anywhere]">
            {logo.name}
          </p>
          <div className="flex flex-wrap gap-2">
            {fileInput}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={working}
              onClick={() => input.current?.click()}
            >
              {t('replace')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={working}
              onClick={() => {
                setProblem(null)
                void onChange(null)
              }}
            >
              {t('remove')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid justify-items-center gap-2 rounded-item border-[1.5px] border-dashed border-input bg-surface-2 px-4 py-6 text-center">
          <ImageIcon aria-hidden="true" className="size-[26px] text-primary" />
          <p className="font-semibold">{t('dropTitle')}</p>
          {fileInput}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={working}
            onClick={() => input.current?.click()}
          >
            {t('choose')}
          </Button>
        </div>
      )}

      <p className="text-[0.82rem] text-muted-foreground">{t('hint')}</p>

      <p role="status" className="text-[0.88rem] text-muted-foreground empty:hidden">
        {uploading && (
          <span className="inline-flex items-center gap-2">
            <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
            {t('uploading')}
          </span>
        )}
      </p>

      {message && (
        <Banner tone="bad" role="alert">
          <p>{message}</p>
        </Banner>
      )}
    </div>
  )
}
