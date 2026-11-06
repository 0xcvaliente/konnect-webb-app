import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import { fileTypeFromBuffer, fileTypeFromFile } from 'file-type'
import {
  APIError,
  type CollectionBeforeChangeHook,
  type CollectionBeforeOperationHook,
  type UploadConfig,
} from 'payload'

import { staticDirFor } from './storage'

/**
 * The file types Konnected accepts anywhere. Each is recognised from the file's first bytes
 * (`file-type`), never from its name or the browser's MIME type alone. Legacy Office formats
 * (.doc, .xls, .ppt) are left out: their bytes look the same for all three and they can carry
 * macros. Macro-enabled Office files (.docm, .xlsm, .pptm) are detected as their own types and
 * so are refused too.
 */
export const FILE_TYPES = {
  pdf: { mime: 'application/pdf', extensions: ['pdf'] },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['docx'],
  },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['xlsx'],
  },
  pptx: {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extensions: ['pptx'],
  },
  png: { mime: 'image/png', extensions: ['png'] },
  jpg: { mime: 'image/jpeg', extensions: ['jpg', 'jpeg'] },
  zip: { mime: 'application/zip', extensions: ['zip'] },
} as const

export type FileKind = keyof typeof FILE_TYPES

export type UploadRule = {
  /** The kinds this collection accepts. */
  kinds: readonly FileKind[]
  /** Largest file in bytes. Checked on the server for every way in (REST, GraphQL, Local API). */
  maxBytes: number
}

export const MB = 1024 * 1024

/** The largest file any collection accepts. Payload's multipart parser stops above this. */
export const MAX_UPLOAD_BYTES = 50 * MB

const CONTEXT_KEY = 'uploadOriginalName'

type IncomingFile = {
  data: Buffer
  mimetype: string
  name: string
  size: number
  tempFilePath?: string
}

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * The name the person gave the file, for display only. The path, control characters and
 * anything that could break a header are stripped. The stored file gets a random name instead.
 */
export const displayName = (name: string): string =>
  name
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f"<>]/g, '')
    .trim()
    .slice(0, 150) || 'file'

async function actualSize(file: IncomingFile): Promise<number> {
  if (file.data?.length) return file.data.length
  if (file.tempFilePath) return (await fs.stat(file.tempFilePath)).size
  return 0
}

async function detect(file: IncomingFile) {
  try {
    if (file.data?.length) return await fileTypeFromBuffer(file.data)
    if (file.tempFilePath) return await fileTypeFromFile(file.tempFilePath)
  } catch {
    // Unreadable or truncated: treated as an unknown type below.
  }
  return undefined
}

/**
 * Check an uploaded file before Payload stores it: size, real type from its first bytes, and a
 * name that matches the content. A PNG called `cv.pdf` or a text file called `report.docx` is
 * refused. The file is then renamed to a random name with the right extension, so the stored
 * name, the URL and any server log line carry no personal data and cannot be guessed.
 */
export const checkUpload =
  (rule: UploadRule): CollectionBeforeOperationHook =>
  async ({ args, operation, req }) => {
    if (operation !== 'create' && operation !== 'update') return args
    const file = req.file as IncomingFile | undefined
    if (!file) return args

    const size = await actualSize(file)
    if (size === 0) throw new APIError('The file is empty.', 400)
    if (size > rule.maxBytes) {
      throw new APIError(`The file is too large. The limit is ${rule.maxBytes / MB} MB.`, 413)
    }

    const detected = await detect(file)
    const kind = rule.kinds.find((k) => FILE_TYPES[k].mime === detected?.mime)
    if (!kind) throw new APIError('This type of file is not allowed here.', 400)

    const extensions: readonly string[] = FILE_TYPES[kind].extensions
    if (!extensions.includes(extensionOf(file.name))) {
      throw new APIError('The file name does not match what the file contains.', 400)
    }

    req.context[CONTEXT_KEY] = displayName(file.name)
    req.file = {
      ...file,
      name: `${randomUUID()}.${FILE_TYPES[kind].extensions[0]}`,
      mimetype: FILE_TYPES[kind].mime,
      size,
    }
    return args
  }

/**
 * Keep `originalName` server-controlled: the name from the upload checked above, else the
 * stored value. A client cannot write it directly.
 */
export const setOriginalName: CollectionBeforeChangeHook = ({ data, originalDoc, req }) => {
  const fromUpload = req.context[CONTEXT_KEY]
  data.originalName =
    typeof fromUpload === 'string' ? fromUpload : (originalDoc?.originalName ?? null)
  return data
}

/**
 * Headers for every file response. Always a download, never shown inline: the browser must not
 * guess the type, run anything, or keep a copy in a shared cache.
 */
export const privateFileHeaders = ({ headers }: { headers: Headers }): Headers => {
  headers.set('Content-Disposition', 'attachment')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Cache-Control', 'private, no-store')
  headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox")
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  return headers
}

/**
 * The upload settings every private file collection shares: stored on the local disk under
 * MEDIA_DIR, accepted types listed for Payload's own check too, no resizing, cropping or
 * previews, no fetching from a URL, and download-only responses.
 */
export const privateUpload = (slug: string, rule: UploadRule): UploadConfig => ({
  staticDir: staticDirFor(slug),
  mimeTypes: rule.kinds.map((k) => FILE_TYPES[k].mime),
  // No imageSizes: nothing is resized. (An empty list breaks the GraphQL schema.)
  crop: false,
  focalPoint: false,
  displayPreview: false,
  bulkUpload: false,
  pasteURL: false,
  modifyResponseHeaders: privateFileHeaders,
})
