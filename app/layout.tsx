import type { Metadata } from 'next'
import { SessionProvider } from '../lib/client/session'
import './globals.css'

export const metadata: Metadata = {
  title: 'Plate Curator',
  description: 'Plate Curator review dashboard',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  )
}
