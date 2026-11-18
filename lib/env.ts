/**
 * Require a configured environment value before creating a service dependency that needs
 * it.
 */
export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable ${name}`)
  return value
}