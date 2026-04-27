import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import './globals.css'
import { Toaster } from '@/components/ui/toaster'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
})

export const metadata: Metadata = {
  title: 'AgentForge - AI-Powered Microservices Builder',
  description: 'Build microservices with AI agents using visual DAG workflows',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}>
        <div className="min-h-screen bg-background">
          <nav className="border-b border-zinc-800 bg-zinc-950">
            <div className="container mx-auto flex items-center gap-6 px-4 h-14">
              <a href="/" className="font-bold text-lg tracking-tight">AgentForge</a>
              <a href="/coordinator" className="text-sm text-zinc-400 hover:text-white transition-colors">Coordinator</a>
              <a href="/oracles" className="text-sm text-zinc-400 hover:text-white transition-colors">Oracles</a>
              <a href="/developers" className="text-sm text-zinc-400 hover:text-white transition-colors">Developers</a>
              <a href="/spawners" className="text-sm text-zinc-400 hover:text-white transition-colors">Spawners</a>
              <a href="/projects" className="text-sm text-zinc-400 hover:text-white transition-colors">Projects</a>
            </div>
          </nav>
          {children}
        </div>
        <Toaster />
      </body>
    </html>
  )
}
