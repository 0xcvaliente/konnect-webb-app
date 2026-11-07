import { inflateRawSync } from 'node:zlib'

/**
 * A careful look inside a zip file (a .docx is one) before anything else opens it: count the
 * parts, and unzip each one with a hard cap on the output, so a small upload cannot expand into
 * gigabytes in memory (a "zip bomb"). The sizes a zip declares can lie; the cap here counts what
 * really comes out.
 */

export type ZipCheck =
  | { ok: true; names: string[]; unzippedBytes: number }
  | { ok: false; problem: 'broken_file' | 'too_many_parts' | 'unzipped_too_large' }

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

export function checkZip(
  buffer: Buffer,
  limits: { maxEntries: number; maxUnzippedBytes: number },
): ZipCheck {
  // The end-of-central-directory record sits in the last 22 bytes plus an optional comment.
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return { ok: false, problem: 'broken_file' }

  const entries = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (entries > limits.maxEntries) return { ok: false, problem: 'too_many_parts' }
  if (entries === 0xffff || centralOffset === 0xffffffff) {
    // Zip64: never needed for a Word template.
    return { ok: false, problem: 'broken_file' }
  }

  const names: string[] = []
  let total = 0
  let at = centralOffset
  try {
    for (let n = 0; n < entries; n++) {
      if (buffer.readUInt32LE(at) !== CENTRAL) return { ok: false, problem: 'broken_file' }
      const method = buffer.readUInt16LE(at + 10)
      const compressedSize = buffer.readUInt32LE(at + 20)
      const nameLength = buffer.readUInt16LE(at + 28)
      const extraLength = buffer.readUInt16LE(at + 30)
      const commentLength = buffer.readUInt16LE(at + 32)
      const localOffset = buffer.readUInt32LE(at + 42)
      const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)
      names.push(name)
      at += 46 + nameLength + extraLength + commentLength

      if (buffer.readUInt32LE(localOffset) !== LOCAL) return { ok: false, problem: 'broken_file' }
      const localName = buffer.readUInt16LE(localOffset + 26)
      const localExtra = buffer.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + localName + localExtra
      const data = buffer.subarray(start, start + compressedSize)
      if (data.length !== compressedSize) return { ok: false, problem: 'broken_file' }

      const budget = limits.maxUnzippedBytes - total
      if (method === 0) {
        total += data.length
      } else if (method === 8) {
        try {
          total += inflateRawSync(data, { maxOutputLength: Math.max(1, budget) }).length
        } catch (error) {
          const code = (error as { code?: string }).code
          if (code === 'ERR_BUFFER_TOO_LARGE') return { ok: false, problem: 'unzipped_too_large' }
          return { ok: false, problem: 'broken_file' }
        }
      } else {
        return { ok: false, problem: 'broken_file' }
      }
      if (total > limits.maxUnzippedBytes) return { ok: false, problem: 'unzipped_too_large' }
    }
  } catch {
    // Reads past the end of the buffer: a cut-off or crafted file.
    return { ok: false, problem: 'broken_file' }
  }
  return { ok: true, names, unzippedBytes: total }
}
