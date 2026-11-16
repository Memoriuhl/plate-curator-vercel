import type { Metadata } from 'next'
import { Overpass, Geist_Mono } from 'next/font/google'
import { SessionProvider } from '../lib/client/session'
import './globals.css'
import { TooltipProvider } from '../components/ui/tooltip'

const overpass = Overpass({
  subsets: ['latin'],
  variable: '--font-overpass',
  style: ['normal', 'italic'],
  display: 'swap',
})
const mono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Plate Curator',
  description: 'Plate Curator review dashboard',
  icons: { icon: '/state-spotter-icon.png' },
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={overpass.variable + ' ' + mono.variable}>
        <SessionProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </SessionProvider>
      </body>
    </html>
  )
}
