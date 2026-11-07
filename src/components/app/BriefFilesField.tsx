'use client'

import { DownloadIcon, FileTextIcon, LoaderCircleIcon, UploadIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ATTACHMENT_EXTENSIONS, ATTACHMENT_MAX_BYTES, MAX_ATTACHMENTS } from '@/lib/projects/fields'
import { cn } from '@/lib/utils'

import { Banner } from './Banner'

/** What the page knows about a brief file. `url` is the access-checked download route. */
export type BriefFileInfo = { id: number; name: string; size?: number | null; url?: string | null }

type UploadError = 'type' | 'size' | 'tooMany' | 'full' | 'generic'

const ACCEPT = [
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.png',
  '.jpg',
  '.jpeg',
  'application/pdf',
  'image/png',
  'image/jpeg',
].join(',')

const extensionOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''

export const sizeText = (bytes: number | null | undefined): string | null => {
  if (!bytes) return null
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Upload one brief file through Payload's REST endpoint as the signed-in company user. The server
 * checks everything again: the session, the origin, the company's status, the real file type from
 * its bytes, 20 MB at most, and the limit on unused files. The checks here only answer faster.
 */
async function uploadBrief(file: File): Promise<{ file: BriefFileInfo } | { error: UploadError }> {
  if (!(ATTACHMENT_EXTENSIONS as readonly string[]).includes(extensionOf(file.name)))
    return { error: 'type' }
  if (file.size > ATTACHMENT_MAX_BYTES) return { error: 'size' }

  const form = new FormData()
  form.append('file', file)
  form.append('_payload', '{}')
  try {
    const res = await fetch('/api/brief-files', {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
    })
    if (res.status === 413) return { error: 'size' }
    if (res.status === 429) return { error: 'tooMany' }
    if (res.status === 400) return { error: 'type' }
    if (!res.ok) return { error: 'generic' }
    const { doc } = (await res.json()) as {
      doc: { id: number; originalName?: string; filesize?: number; url?: string }
    }
    return {
      file: { id: doc.id, name: doc.originalName ?? file.name, size: doc.filesize, url: doc.url },
    }
  } catch {
    return { error: 'generic' }
  }
}

/** Delete a brief file that was uploaded but never saved on the project. Best effort. */
export async function deleteBrief(id: number): Promise<void> {
  try {
    await fetch(`/api/brief-files/${id}`, { method: 'DELETE', credentials: 'same-origin' })
  } catch {
    // The daily clean-up removes unused files.
  }
}

/**
 * The attachments block of the project form (mockup "Submit a project", Attachments): a drop
 * zone, then one row per file with Download and Remove. `onChange` gets the new list; the form
 * saves it with the draft. Up to 10 files.
 */
export function BriefFilesField({
  files,
  onChange,
  disabled = false,
  error,
  className,
}: {
  files: BriefFileInfo[]
  onChange: (files: BriefFileInfo[], removed?: BriefFileInfo) => void
  disabled?: boolean
  /** An error from saving, shown under the field. */
  error?: string
  className?: string
}) {
  const t = useTranslations('Attachments')
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(0)
  const [problem, setProblem] = useState<UploadError | null>(null)
  const working = disabled || uploading > 0
  const full = files.length >= MAX_ATTACHMENTS
  const message = problem ? t(`errors.${problem}`, { max: MAX_ATTACHMENTS }) : error

  const pick = async (list: FileList | null) => {
    if (!list?.length) return
    setProblem(null)
    const room = MAX_ATTACHMENTS - files.length
    const chosen = Array.from(list).slice(0, Math.max(0, room))
    if (list.length > room) setProblem('full')
    let next = files
    for (const file of chosen) {
      setUploading((n) => n + 1)
      const result = await uploadBrief(file)
      setUploading((n) => n - 1)
      if ('error' in result) {
        setProblem(result.error)
        break
      }
      next = [...next, result.file]
      onChange(next)
    }
    if (input.current) input.current.value = ''
  }

  return (
    <div className={cn('grid gap-3', className)} aria-busy={uploading > 0 || undefined}>
      {files.length > 0 && (
        <ul className="grid gap-2" aria-label={t('listLabel')}>
          {files.map((file) => (
            <li
              key={file.id}
              className="flex flex-wrap items-center gap-3 rounded-item border-[1.5px] border-line bg-surface px-3.5 py-3"
            >
              <FileTextIcon aria-hidden="true" className="size-[22px] shrink-0 text-primary" />
              <div className="min-w-0 flex-1 basis-40">
                <p className="font-semibold [overflow-wrap:anywhere]">{file.name}</p>
                {sizeText(file.size) && (
                  <p className="text-[0.85rem] text-muted-foreground">{sizeText(file.size)}</p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {file.url && (
                  <Button asChild variant="secondary" size="sm">
                    <a href={file.url} download={file.name}>
                      <DownloadIcon aria-hidden="true" className="size-4" />
                      {t('download')}
                      <span className="sr-only">: {file.name}</span>
                    </a>
                  </Button>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={working}
                  onClick={() => {
                    setProblem(null)
                    onChange(
                      files.filter((f) => f.id !== file.id),
                      file,
                    )
                  }}
                >
                  {t('remove')}
                  <span className="sr-only">: {file.name}</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!full && (
        <div className="grid justify-items-center gap-2 rounded-item border-[1.5px] border-dashed border-input bg-surface-2 px-4 py-6 text-center">
          <UploadIcon aria-hidden="true" className="size-[26px] text-primary" />
          <p className="font-semibold">{t('dropTitle')}</p>
          <input
            ref={input}
            id={`${id}-file`}
            type="file"
            multiple
            accept={ACCEPT}
            // Opened by the visible button, so keep it out of the tab order and the a11y tree.
            tabIndex={-1}
            aria-hidden="true"
            className="sr-only"
            disabled={working}
            onChange={(e) => pick(e.target.files)}
          />
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

      <p className="text-[0.82rem] text-muted-foreground">
        {t('hint', { max: MAX_ATTACHMENTS, count: files.length })}
      </p>
      <p className="text-[0.82rem] text-muted-foreground">{t('whoSees')}</p>

      <p role="status" className="text-[0.88rem] text-muted-foreground empty:hidden">
        {uploading > 0 && (
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
