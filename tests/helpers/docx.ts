import PizZip from 'pizzip'

/**
 * Small Word files for the agreement tests, built in memory: a real .docx package that Word,
 * LibreOffice and docxtemplater open. `split` puts every paragraph's text in two runs, the way
 * Word often splits a field, to prove the filler still finds it.
 */

const MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
const MACRO_MAIN = 'application/vnd.ms-word.document.macroEnabled.main+xml'

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const run = (text: string, bold = false) =>
  `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${escape(text)}</w:t></w:r>`

export function buildDocx(
  paragraphs: string[],
  { macro = false, split = false }: { macro?: boolean; split?: boolean } = {},
): Buffer {
  const zip = new PizZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${macro ? MACRO_MAIN : MAIN}"/></Types>`,
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  )
  const body = paragraphs
    .map((text, i) => {
      const bold = i === 0
      if (!split || text.length < 4) return `<w:p>${run(text, bold)}</w:p>`
      const middle = Math.floor(text.length / 2)
      return `<w:p>${run(text.slice(0, middle), bold)}${run(text.slice(middle), bold)}</w:p>`
    })
    .join('')
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  )
  if (macro) zip.file('word/vbaProject.bin', Buffer.from('not really vba'))
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer
}

/** The plain text of a .docx, one line per paragraph. */
export function docxText(docx: Buffer): string[] {
  const xml = new PizZip(docx).file('word/document.xml')?.asText() ?? ''
  return xml
    .split(/<\/w:p>/)
    .map((p) =>
      p
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .trim(),
    )
    .filter(Boolean)
}

/** A company agreement template using a few fields, the price among them. */
export const companyTemplateDocx = (options?: { split?: boolean }) =>
  buildDocx(
    [
      'Company agreement (TEST)',
      'Reference {{agreement.reference}}, made {{agreement.date}}.',
      'Between Konnected and {{company.name}}, organisation number {{company.orgNumber}}.',
      'Project: {{project.title}}.',
      'Price {{price.exclVat}} plus VAT {{price.vat}}, total {{price.total}}.',
    ],
    options,
  )

/** A student agreement template using the student's name. */
export const studentTemplateDocx = (options?: { split?: boolean }) =>
  buildDocx(
    [
      'Student agreement (TEST)',
      'Reference {{agreement.reference}}, made {{agreement.date}}.',
      'Between Konnected and {{student.fullName}}.',
      'Project: {{project.title}} for {{company.name}}.',
    ],
    options,
  )
