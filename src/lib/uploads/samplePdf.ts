/**
 * A small, valid one-page PDF (with a cross-reference table and an end-of-file marker), built in
 * memory. Used by the dev seed and the tests so they upload a real PDF without keeping binary
 * files in the repo. Not used by the app itself.
 */
export function samplePdf(text = 'Sample PDF'): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
  ]
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xrefAt = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}
