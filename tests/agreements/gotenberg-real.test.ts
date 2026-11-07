import fs from 'node:fs/promises'
import path from 'node:path'

import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'

import { checkTemplate, fillTemplate } from '@/lib/agreements/docx'
import { convertDocxToPdf } from '@/lib/agreements/gotenberg'
import { buildSignedPdf, sha256 } from '@/lib/agreements/pdf'

/**
 * One real conversion through a running Gotenberg, to confirm the stand-in used everywhere else
 * behaves like the real thing. Skipped unless GOTENBERG_TEST_URL is set, for example:
 *
 *   docker run -d --rm -p 127.0.0.1:3400:3000 gotenberg/gotenberg:8.38.1
 *   GOTENBERG_TEST_URL=http://127.0.0.1:3400 pnpm test tests/agreements/gotenberg-real.test.ts
 *
 * It fills the example company template from docs/agreements with Norwegian letters, converts it,
 * and adds the signing page.
 */
const url = process.env.GOTENBERG_TEST_URL

describe.skipIf(!url)('real Gotenberg conversion', () => {
  it('turns the filled example template into a PDF, and the signing page goes on the end', async () => {
    const template = await fs.readFile(
      path.resolve('docs/agreements/example-company-agreement.docx'),
    )
    const check = await checkTemplate(template, 'company')
    expect(check.ok).toBe(true)
    if (!check.ok) return
    const values = Object.fromEntries(check.fields.map((f) => [f, `Verdi for ${f} æøå ÆØÅ`]))
    const docx = fillTemplate(template, values)

    const previous = process.env.GOTENBERG_URL
    process.env.GOTENBERG_URL = url
    try {
      const pdf = await convertDocxToPdf(docx)
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
      const doc = await PDFDocument.load(pdf)
      expect(doc.getPageCount()).toBeGreaterThanOrEqual(1)

      const signed = await buildSignedPdf(pdf, {
        reference: 'AGR-TEST0001',
        kind: 'company',
        projectTitle: 'Prosjekt med æøå',
        unsignedSha256: sha256(pdf),
        completedAt: new Date().toISOString(),
        signatures: [
          {
            party: 'company',
            partyName: 'Fjordfrukt AS',
            typedName: 'Åse Ødegård',
            signedAt: new Date().toISOString(),
            method: 'google',
          },
          {
            party: 'konnected',
            typedName: 'Konnected Team',
            signedAt: new Date().toISOString(),
            method: 'google',
          },
        ],
      })
      expect((await PDFDocument.load(signed)).getPageCount()).toBe(doc.getPageCount() + 1)
      if (process.env.GOTENBERG_TEST_OUT) {
        await fs.writeFile(process.env.GOTENBERG_TEST_OUT, signed)
      }
    } finally {
      process.env.GOTENBERG_URL = previous
    }
  })
})
