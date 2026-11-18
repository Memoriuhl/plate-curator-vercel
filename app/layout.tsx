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

/** Provide the root HTML, theme initialization and authenticated session context. */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `var t;try{t=localStorage.getItem('plate-curator-theme')}catch{}if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t}else{document.documentElement.removeAttribute('data-theme');document.documentElement.style.removeProperty('color-scheme')}`,
          }}
        />
      </head>
      <body className={overpass.variable + ' ' + mono.variable}>
        <SessionProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </SessionProvider>
      </body>
    </html>
  )
}
