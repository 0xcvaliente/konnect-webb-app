/**
 * Runs once when the Next.js server starts. Starts Payload with its job scheduler, so the nightly
 * clean-up of unused files (src/jobs) runs without waiting for someone to open the admin panel.
 * Payload skips the scheduler during `next build`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const [{ getPayload }, { default: config }] = await Promise.all([
    import('payload'),
    import('@payload-config'),
  ])
  try {
    await getPayload({ config, cron: true })
  } catch (error) {
    // The app still serves requests; the scheduler starts with the next admin request instead.
    // Only the error code: a database error message can carry connection details.
    console.error('Could not start the job scheduler', (error as { code?: string }).code ?? '')
  }
}
