/**
 * DOCX to PDF through Gotenberg (owner decision 6 Nov 2026: Gotenberg turns agreement templates
 * into PDFs). Gotenberg runs as its own container on the internal network, never exposed; its
 * address comes from GOTENBERG_URL. LibreOffice inside it does the conversion.
 *
 * Nothing about the document is logged: on failure only the HTTP status or the error name.
 */

/** How long one conversion may take before we give up (the job retries later). */
const TIMEOUT_MS = 60_000
/** A converted agreement is a few hundred KB. Anything far larger is not what we sent. */
const MAX_PDF_BYTES = 30 * 1024 * 1024

/** The converter is down, slow or answered with an error. Worth retrying. */
export class ConverterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConverterError'
  }
}

export function gotenbergUrl(): string {
  const url = process.env.GOTENBERG_URL?.trim()
  if (!url) throw new ConverterError('GOTENBERG_URL is not set')
  return url.replace(/\/+$/, '')
}

export async function convertDocxToPdf(docx: Buffer, name = 'agreement.docx'): Promise<Buffer> {
  const form = new FormData()
  form.append(
    'files',
    new Blob([new Uint8Array(docx)], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
    name,
  )
  let res: Response
  try {
    res = await fetch(`${gotenbergUrl()}/forms/libreoffice/convert`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Gotenberg names the output after this; it is not stored anywhere.
      headers: { 'Gotenberg-Output-Filename': 'agreement' },
    })
  } catch (error) {
    throw new ConverterError(`The converter could not be reached (${(error as Error).name})`)
  }
  if (!res.ok) throw new ConverterError(`The converter answered ${res.status}`)
  const pdf = Buffer.from(await res.arrayBuffer())
  if (pdf.length > MAX_PDF_BYTES || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new ConverterError('The converter did not return a PDF')
  }
  return pdf
}
