import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

import { fileTypeFromBuffer, fileTypeFromFile } from 'file-type'
import {
  APIError,
  type CollectionBeforeChangeHook,
  type CollectionBeforeOperationHook,
  type CollectionSlug,
  type PayloadRequest,
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
 * guess the type, run anything, or keep a copy in a shared cache. `serveFile` below replaces the
 * plain `attachment` with one that carries the uploaded file name.
 */
export const privateFileHeaders = ({ headers }: { headers: Headers }): Headers => {
  headers.set('Content-Disposition', 'attachment')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Cache-Control', 'private, no-store')
  headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox")
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  return headers
}

const MAX_NAME_LENGTH = 150

/**
 * The name a file downloads with: the name the person uploaded, made safe. Path parts, control
 * characters, quotes, angle brackets and the Unicode direction marks that can disguise an
 * extension are removed. The name always ends in an extension of the stored file's real type
 * (`stored` is the random stored name, such as `<uuid>.pdf`), so cutting a long name or a name
 * without one never changes what the file opens as.
 */
export function downloadName(original: string | null | undefined, stored: string): string {
  const storedExtension = extensionOf(stored)
  const allowed: readonly string[] = Object.values(FILE_TYPES).find((t) =>
    (t.extensions as readonly string[]).includes(storedExtension),
  )?.extensions ?? [storedExtension]

  // A file without a recorded name downloads under its stored name.
  let name = (original || stored)
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f-\u009f"'`<>\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .normalize('NFC')
    .replace(/^[\s.]+|[\s.]+$/g, '')

  if (!allowed.includes(extensionOf(name))) name = `${name}.${storedExtension}`
  // Keep the extension as written when shortening, and never cut a character in half.
  const dot = name.lastIndexOf('.')
  const extension = name.slice(dot)
  const chars = Array.from(name.slice(0, dot))
  const base =
    chars.length > MAX_NAME_LENGTH
      ? chars.slice(0, MAX_NAME_LENGTH).join('').trimEnd()
      : chars.join('')
  return `${base || 'file'}${extension}`
}

/** RFC 5987 `attr-char` encoding: percent-encode everything but letters, digits and !#$&+-.^_`|~ */
const encodeRfc5987 = (value: string): string =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )

/**
 * `Content-Disposition: attachment` with the file name: a plain ASCII `filename` for every
 * browser, and the exact name as RFC 5987 `filename*` when it has other characters (Ø, å, é).
 */
export function attachmentHeader(name: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/[\\%;"]/g, '_')
  const header = `attachment; filename="${ascii}"`
  return ascii === name ? header : `${header}; filename*=UTF-8''${encodeRfc5987(name)}`
}

type StoredFile = {
  filename?: string | null
  originalName?: string | null
  mimeType?: string | null
}

const KNOWN_MIME_TYPES = new Set<string>(Object.values(FILE_TYPES).map((t) => t.mime))

type UploadHandler = NonNullable<UploadConfig['handlers']>[number]

/**
 * Payload upload handler that sends a private file with the name it was uploaded with.
 *
 * Payload's file route (`/api/<slug>/file/<name>`, see payload/dist/uploads/endpoints/getFile.js)
 * applies the collection's read access first and only then calls this handler, with the
 * document it found under that access (`doc`). When the access result is plain `true` (admins)
 * Payload passes no document, so it is looked up here with access control on as the same user.
 *
 * Payload also calls upload handlers for "client uploads" (a multipart request whose `file`
 * field names a file already in storage), with `doc: null` and no access check at all. This
 * handler answers nothing there, so nobody can copy another person's file into an upload of
 * their own; Payload then refuses the request.
 *
 * Range requests are not supported: the whole file is sent with 200, which HTTP allows.
 */
export const serveFile =
  (slug: CollectionSlug): UploadHandler =>
  (req, args) =>
    // Payload's type lists Promise<Response> and Promise<void> but not their union; its file
    // route (getFile.js) accepts either.
    sendFile(slug, req, args) as Promise<void>

async function sendFile(
  slug: CollectionSlug,
  req: PayloadRequest,
  { doc, params }: { doc?: unknown; params: { filename: string } },
): Promise<Response | undefined> {
  if (req.method !== 'GET' || doc === null) return
  const { filename } = params

  let file = doc as StoredFile | undefined
  if (!file) {
    file = (
      await req.payload.find({
        collection: slug,
        where: { filename: { equals: filename } },
        depth: 0,
        limit: 1,
        overrideAccess: false,
        user: req.user,
        req,
      })
    ).docs[0] as StoredFile | undefined
  }
  if (!file || file.filename !== filename) return

  const directory = path.resolve(staticDirFor(slug))
  const filePath = path.resolve(directory, filename)
  // Same guard as Payload's own file route. Anything odd falls back to Payload's answer.
  if (!filePath.startsWith(directory + path.sep)) return
  let size: number
  try {
    size = (await fs.stat(filePath)).size
  } catch {
    return
  }

  const headers = privateFileHeaders({ headers: new Headers() })
  headers.set('Content-Disposition', attachmentHeader(downloadName(file.originalName, filename)))
  headers.set(
    'Content-Type',
    file.mimeType && KNOWN_MIME_TYPES.has(file.mimeType)
      ? file.mimeType
      : 'application/octet-stream',
  )
  headers.set('Content-Length', String(size))
  const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>
  return new Response(body, { headers, status: 200 })
}

/**
 * The upload settings every private file collection shares: stored on the local disk under
 * MEDIA_DIR, accepted types listed for Payload's own check too, no resizing, cropping or
 * previews, no fetching from a URL, and download-only responses with the uploaded file name.
 */
export const privateUpload = (slug: CollectionSlug, rule: UploadRule): UploadConfig => ({
  staticDir: staticDirFor(slug),
  mimeTypes: rule.kinds.map((k) => FILE_TYPES[k].mime),
  // No imageSizes: nothing is resized. (An empty list breaks the GraphQL schema.)
  crop: false,
  focalPoint: false,
  displayPreview: false,
  bulkUpload: false,
  pasteURL: false,
  handlers: [serveFile(slug)],
  modifyResponseHeaders: privateFileHeaders,
})
