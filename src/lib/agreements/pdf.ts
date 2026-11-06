import { createHash } from 'node:crypto'

import { PDFDocument, type PDFFont, rgb, StandardFonts } from 'pdf-lib'

import type { AgreementKind, SignatureParty, SignInMethodUsed } from './fields'

/** The SHA-256 fingerprint of a file, as 64 lower-case hex characters. */
export const sha256 = (data: Buffer | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')

/** A fingerprint in groups of four, easier to compare by eye. */
export const groupedHash = (hash: string): string => hash.match(/.{1,4}/g)?.join(' ') ?? hash

export type SigningLine = {
  party: SignatureParty
  /** For the company line, the company's name. */
  partyName?: string | null
  typedName: string
  signedAt: string
  method: SignInMethodUsed
}

const PARTY: Record<SignatureParty, string> = {
  company: 'Company / Bedrift',
  student: 'Student / Student',
  konnected: 'Konnected',
}

const METHOD: Record<SignInMethodUsed, string> = {
  google: 'Google',
  email_link: 'Email link / E-postlenke',
  password: 'Password / Passord',
  unknown: 'Not recorded / Ikke registrert',
}

/** "2026-11-06 10:42:13 UTC": server time, always UTC, so both parties read the same moment. */
export const utcText = (iso: string): string =>
  `${new Date(iso).toISOString().replace('T', ' ').slice(0, 19)} UTC`

/**
 * Text the built-in Helvetica can draw (Windows-1252: Norwegian letters are fine). Any other
 * character becomes its plain-letter form, or "?" if it has none. The typed name is stored
 * exactly as typed on the signature; only this page simplifies it.
 */
function drawable(font: PDFFont, text: string): string {
  let out = ''
  for (const ch of text.replace(/[\u0000-\u001f\u007f]/g, ' ')) {
    try {
      font.encodeText(ch)
      out += ch
    } catch {
      const plain = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '')
      try {
        font.encodeText(plain)
        out += plain
      } catch {
        out += '?'
      }
    }
  }
  return out
}

/** Split text into lines no wider than `width` points. */
function wrap(font: PDFFont, size: number, text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(next, size) <= width) {
      line = next
      continue
    }
    if (line) lines.push(line)
    // A single word wider than the line (a long name without spaces): cut it.
    let rest = word
    while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
      let cut = rest.length - 1
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--
      lines.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    line = rest
  }
  if (line) lines.push(line)
  return lines
}

/**
 * The signed PDF: every page of the PDF all parties signed, unchanged, then one signing page that
 * lists each signer (party, typed name, UTC time, how they had signed in) and the SHA-256 of the
 * signed content. The page text is in English and Norwegian.
 */
export async function buildSignedPdf(
  unsignedPdf: Buffer,
  meta: {
    reference: string
    kind: AgreementKind
    projectTitle: string
    unsignedSha256: string
    completedAt: string
    signatures: SigningLine[]
  },
): Promise<Buffer> {
  const doc = await PDFDocument.load(unsignedPdf, { updateMetadata: false })
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const mono = await doc.embedFont(StandardFonts.Courier)

  const first = doc.getPage(0)
  const { width: pageWidth, height: pageHeight } = first.getSize()
  const page = doc.addPage([pageWidth, pageHeight])
  const margin = 56
  const width = pageWidth - margin * 2
  const ink = rgb(0.043, 0.165, 0.192)
  const ink2 = rgb(0.294, 0.404, 0.427)
  let y = pageHeight - margin

  const text = (value: string, opts: { size?: number; f?: PDFFont; color?: typeof ink } = {}) => {
    const size = opts.size ?? 10
    const f = opts.f ?? font
    for (const line of wrap(f, size, drawable(f, value), width)) {
      page.drawText(line, { x: margin, y: y - size, size, font: f, color: opts.color ?? ink })
      y -= size * 1.45
    }
  }
  const gap = (points: number) => {
    y -= points
  }

  text('Signing record / Signeringsside', { size: 16, f: bold })
  gap(6)
  text(`Konnected agreement ${meta.reference}`, { size: 11, f: bold })
  text(
    meta.kind === 'company'
      ? 'Company agreement / Avtale med bedrift'
      : 'Student agreement / Avtale med student',
    { color: ink2 },
  )
  text(`Project / Prosjekt: ${meta.projectTitle}`, { color: ink2 })
  gap(10)

  text('Fingerprint of the signed document (SHA-256) / Fingeravtrykk (SHA-256)', { f: bold })
  text(groupedHash(meta.unsignedSha256), { f: mono, size: 9.5 })
  text(
    'Every signer signed the pages before this one, identified by this fingerprint. ' +
      'Alle som signerte, signerte sidene foran denne, identifisert ved dette fingeravtrykket.',
    { size: 9, color: ink2 },
  )
  gap(12)

  for (const sig of meta.signatures) {
    page.drawLine({
      start: { x: margin, y },
      end: { x: margin + width, y },
      thickness: 0.6,
      color: rgb(0.8, 0.91, 0.87),
    })
    gap(10)
    const party =
      sig.party === 'company' && sig.partyName
        ? `${PARTY.company}: ${sig.partyName}`
        : PARTY[sig.party]
    text(party, { f: bold, size: 11 })
    text(`Typed name / Skrevet navn: ${sig.typedName}`)
    text(`Signed / Signert: ${utcText(sig.signedAt)}`)
    text(`Signed in with / Logget inn med: ${METHOD[sig.method]}`)
    text('Ticked / Krysset av: "I have read and agree" / "Jeg har lest og godtar"', {
      color: ink2,
      size: 9,
    })
    gap(8)
  }

  gap(6)
  text(
    `Completed / Fullført: ${utcText(meta.completedAt)}. Signed in the Konnected app with a tick ` +
      'and a typed name by signed-in users. Signert i Konnected-appen med avkrysning og skrevet ' +
      'navn av innloggede brukere.',
    { size: 9, color: ink2 },
  )

  // Fixed metadata, so the file depends only on its content and the completion time.
  const done = new Date(meta.completedAt)
  doc.setTitle(`Konnected agreement ${meta.reference}`)
  doc.setProducer('Konnected')
  doc.setCreator('Konnected')
  doc.setCreationDate(done)
  doc.setModificationDate(done)
  return Buffer.from(await doc.save({ useObjectStreams: false }))
}

/**
 * A simple one-page PDF with lines of text, for development and tests where no converter runs
 * (the seed and the fake Gotenberg in tests). Never used for a real agreement.
 */
export async function textPdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([595, 842])
  let y = 790
  for (const raw of lines) {
    for (const line of wrap(font, 10, drawable(font, raw), 483)) {
      page.drawText(line, { x: 56, y, size: 10, font })
      y -= 15
      if (y < 56) break
    }
  }
  doc.setCreationDate(new Date(0))
  doc.setModificationDate(new Date(0))
  return Buffer.from(await doc.save({ useObjectStreams: false }))
}
