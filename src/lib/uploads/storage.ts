import path from 'node:path'

/**
 * Where uploaded files live: a directory on the server's own disk (owner decision 6 Nov 2026:
 * files on the server, backed up off the server). `MEDIA_DIR` sets it, `./media` by default. Each
 * upload collection gets its own subdirectory.
 *
 * The directory must never be served directly (no static route, no Caddy file_server, never
 * under `public/`): every file goes out through Payload's file route, which checks the
 * collection's read access first.
 *
 * `turbopackIgnore`: these paths are only known at run time. Without the comment the build's file
 * tracer treats them as files the server needs and copies the whole project, uploads included,
 * into the standalone output (`next build` with `output: 'standalone'`).
 */
export function mediaRoot(): string {
  const root = path.resolve(/* turbopackIgnore: true */ process.env.MEDIA_DIR || './media')
  const publicDir = path.resolve(/* turbopackIgnore: true */ 'public')
  if (root === publicDir || root.startsWith(publicDir + path.sep)) {
    throw new Error('MEDIA_DIR must be outside public/: files there would be served to anyone')
  }
  return root
}

export const staticDirFor = (slug: string): string => path.join(mediaRoot(), slug)
