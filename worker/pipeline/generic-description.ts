const BOILERPLATE = [
  /\bstandard[- ]issue\b/i,
  /^this (license )?plate is (for|the) [^.]*\bplate\.?$/i,
  /^this (specialty |special |optional )?(license )?plate is (available|offered|issued) (to|in|for) [a-z ]*(residents|motorists|drivers|vehicles)\.?$/i,
]

const PURPOSE =
  /\b(support|supports|supported|fund|funds|funding|fee|fees|proceeds|benefit|benefits|honou?rs?|recogni[sz]e|recogni[sz]es|commemorat\w*|celebrat\w*|sponsor\w*|raise|raises|promot\w*|establish\w*|founded|created|memory|memorial|awareness|dedicated|preserv\w*|protect\w*|holding|served|serving|veterans?|members?|alumni|students|eligible|qualif\w*|recipients?|awarded|received|program|organi[sz]ation|foundation|association|universit\w*|college|school|club)\b/i

const APPEARANCE_LEAD =
  /^(this (license )?plate (features|has|shows|displays|depicts)|featuring|the plate (features|has|shows|displays|depicts))\b/i

/**
 * Identify generic descriptions that lack enough plate-specific information to be
 * useful.
 */
export function isGenericDescription(text: string | null | undefined): boolean {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return true
  if (BOILERPLATE.some((re) => re.test(t))) return true
  if (PURPOSE.test(t)) return false
  return APPEARANCE_LEAD.test(t) || t.split(' ').length < 12
}
