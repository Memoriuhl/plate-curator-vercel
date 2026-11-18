import Image from 'next/image'
import Link from 'next/link'

/** Show the curator brand and give users a consistent way back to the workspace home. */
export function Brand() {
  return (
    <Link href="/" className="brand">
      <Image
        src="/state-spotter-icon.png"
        alt=""
        width={36}
        height={36}
        priority
      />
      <span className="brand-copy">
        <span>State Spotter</span>
        <strong>Plate Curator</strong>
      </span>
    </Link>
  )
}
