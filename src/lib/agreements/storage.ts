import fs from 'node:fs/promises'
import path from 'node:path'

import { staticDirFor } from '@/lib/uploads/storage'

/**
 * Read a stored private file (a template or an agreement PDF) from the server's disk. The name
 * comes from our own database row, never from a request; anything that is not a plain file name
 * is refused.
 */
export async function readStoredFile(
  slug: 'agreement-templates' | 'agreement-pdfs',
  filename: string | null | undefined,
): Promise<Buffer> {
  if (!filename || filename !== path.basename(filename)) {
    throw new Error('The stored file name is not valid')
  }
  return fs.readFile(path.join(staticDirFor(slug), filename))
}
