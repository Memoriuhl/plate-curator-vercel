import Image from 'next/image'
import Link from 'next/link'

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
