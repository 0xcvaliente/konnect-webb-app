'use client'

import { DownloadIcon, FileTextIcon, LoaderCircleIcon, UploadIcon } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { Banner } from './Banner'

/** What the page knows about a CV. `url` is the access-checked download route. */
export type CvInfo = {
  id: number
  name: string
  size?: number | null
  uploadedAt?: string | null
  url?: string | null
}

type UploadError = 'type' | 'size' | 'tooMany' | 'generic'

const MAX_BYTES = 10 * 1024 * 1024

/**
 * Upload a CV through Payload's REST endpoint as the signed-in student. The server checks
 * everything again: the session, the origin, that the file really is a PDF, 10 MB at most, and
 * the limit on unused files. The checks here only give a faster answer.
 */
async function uploadCv(file: File): Promise<{ cv: CvInfo } | { error: UploadError }> {
  const looksPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
  if (!looksPdf) return { error: 'type' }
  if (file.size > MAX_BYTES) return { error: 'size' }

  const form = new FormData()
  form.append('file', file)
  form.append('_payload', '{}')
  try {
    const res = await fetch('/api/cvs', { method: 'POST', body: form, credentials: 'same-origin' })
    if (res.status === 413) return { error: 'size' }
    if (res.status === 429) return { error: 'tooMany' }
    if (res.status === 400) return { error: 'type' }
    if (!res.ok) return { error: 'generic' }
    const { doc } = (await res.json()) as {
      doc: {
        id: number
        originalName?: string
        filesize?: number
        createdAt?: string
        url?: string
      }
    }
    return {
      cv: {
        id: doc.id,
        name: doc.originalName ?? file.name,
        size: doc.filesize,
        uploadedAt: doc.createdAt,
        url: doc.url,
      },
    }
  } catch {
    return { error: 'generic' }
  }
}

/** Delete a CV the student uploaded but no longer wants. Best effort. */
export async function deleteCv(id: number): Promise<void> {
  try {
    await fetch(`/api/cvs/${id}`, { method: 'DELETE', credentials: 'same-origin' })
  } catch {
    // The daily clean-up removes unused CVs.
  }
}

const sizeText = (bytes: number | null | undefined): string | null => {
  if (!bytes) return null
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The CV block (mockup: drop zone, then a file row with Replace and Remove). `onChange` gets the
 * new CV after an upload, or null after Remove; the caller saves it. While `busy`, the buttons
 * are off.
 */
export function CvField({
  cv,
  onChange,
  busy = false,
  error,
  className,
}: {
  cv: CvInfo | null
  onChange: (cv: CvInfo | null) => void | Promise<void>
  busy?: boolean
  /** An error from saving, shown under the field. */
  error?: string
  className?: string
}) {
  const t = useTranslations('Cv')
  const format = useFormatter()
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [problem, setProblem] = useState<UploadError | null>(null)
  const working = busy || uploading
  const message = problem ? t(`errors.${problem}`) : error

  const pick = async (file: File | undefined) => {
    if (!file) return
    setProblem(null)
    setUploading(true)
    const result = await uploadCv(file)
    setUploading(false)
    if (input.current) input.current.value = ''
    if ('error' in result) setProblem(result.error)
    else await onChange(result.cv)
  }

  const fileInput = (
    <input
      ref={input}
      id={`${id}-file`}
      type="file"
      accept="application/pdf,.pdf"
      // Opened by the visible button below, so keep it out of the tab order and the a11y tree.
      tabIndex={-1}
      aria-hidden="true"
      className="sr-only"
      disabled={working}
      onChange={(e) => pick(e.target.files?.[0])}
    />
  )

  const details = cv
    ? [
        sizeText(cv.size),
        cv.uploadedAt ? format.dateTime(new Date(cv.uploadedAt), { dateStyle: 'medium' }) : null,
      ]
    : []

  return (
    <div className={cn('grid gap-3', className)} aria-busy={working || undefined}>
      {cv ? (
        <div className="flex flex-wrap items-center gap-3 rounded-item border-[1.5px] border-line bg-surface px-3.5 py-3">
          <FileTextIcon aria-hidden="true" className="size-[22px] shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold [overflow-wrap:anywhere]">{cv.name}</p>
            {details[0] && details[1] && (
              <p className="text-[0.85rem] text-muted-foreground">
                {t('uploadedOn', { size: details[0], date: details[1] })}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {cv.url && (
              <Button asChild variant="text" size="sm">
                <a href={cv.url} download>
                  <DownloadIcon aria-hidden="true" />
                  {t('download')}
                </a>
              </Button>
            )}
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
          <UploadIcon aria-hidden="true" className="size-[26px] text-primary" />
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

      <p id={`${id}-hint`} className="text-[0.82rem] text-muted-foreground">
        {t('hint')}
      </p>

      <p role="status" className="text-[0.88rem] text-muted-foreground empty:hidden">
        {uploading && (
          <span className="inline-flex items-center gap-2">
            <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
            {t('uploading')}
          </span>
        )}
      </p>

      {message && (
        <Banner id={`${id}-error`} tone="bad" role="alert">
          <p>{message}</p>
        </Banner>
      )}
    </div>
  )
}
