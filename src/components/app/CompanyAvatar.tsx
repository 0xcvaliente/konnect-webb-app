import { cn } from '@/lib/utils'

/**
 * A company's logo in a round frame (konnected-design-system: avatars and company logos are
 * round), or the first letter of its name on the tint when there is no logo. Decorative: the
 * name is always written next to it, so the image has an empty alt text.
 */
export function CompanyAvatar({
  name,
  logoUrl,
  size = 'md',
  className,
}: {
  name: string
  logoUrl?: string | null
  size?: 'md' | 'lg'
  className?: string
}) {
  const box = size === 'lg' ? 'size-14 text-[1.15rem]' : 'size-10 text-[0.9rem]'
  if (logoUrl) {
    return (
      // A private, access-checked file route: next/image would fetch it without the session.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt=""
        className={cn(
          'shrink-0 rounded-full border-[1.5px] border-line bg-white object-contain p-1',
          box,
          className,
        )}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-tint font-bold text-tint-foreground',
        box,
        className,
      )}
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}
