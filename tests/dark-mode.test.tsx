import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { afterEach, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { applyTheme } from '../components/app/theme-toggle'
import { Avatar, AvatarFallback } from '../components/ui/avatar'

afterEach(() => vi.unstubAllGlobals())

function testDocument() {
  const dataset: Record<string, string> = {}
  const style = { colorScheme: '', removeProperty() { this.colorScheme = '' } }
  return { documentElement: { dataset, style, removeAttribute() { delete dataset.theme }, getAttribute() { return dataset.theme ?? null } } }
}

test('theme choices apply, persist, clear and tolerate blocked storage', () => {
  const document = testDocument()
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) }
  vi.stubGlobal('document', document)
  vi.stubGlobal('localStorage', storage)
  for (const theme of ['light', 'dark', 'system'] as const) {
    applyTheme(theme)
    expect(document.documentElement.dataset.theme).toBe(theme === 'system' ? undefined : theme)
    expect(document.documentElement.style.colorScheme).toBe(theme === 'system' ? '' : theme)
    expect(localStorage.getItem('plate-curator-theme')).toBe(theme)
  }
  vi.stubGlobal('localStorage', { setItem() { throw new Error('blocked') } })
  expect(() => applyTheme('dark')).not.toThrow()
  expect(document.documentElement.dataset.theme).toBe('dark')
})

test('the head script restores only valid stored themes and tolerates blocked storage', () => {
  const layout = readFileSync('app/layout.tsx', 'utf8')
  const script = layout.match(/__html: `([^`]+)`/)![1]
  expect(layout.indexOf('<head>')).toBeLessThan(layout.indexOf('<body'))
  for (const theme of ['light', 'dark', 'system', 'invalid', null]) {
    const document = testDocument()
    runInContext(script, createContext({ document, localStorage: { getItem: () => theme } }))
    expect(document.documentElement.dataset.theme).toBe(theme === 'light' || theme === 'dark' ? theme : undefined)
  }
  expect(() => runInContext(script, createContext({ localStorage: { getItem() { throw new Error('blocked') } } }))).not.toThrow()
})

function luminance(hex: string) {
  const channels = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)]
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05)
}

test('both dark token blocks match and meet text, icon and highlight contrast targets', () => {
  const css = readFileSync('design-system/tokens.css', 'utf8')
  const blocks = [...css.matchAll(/--ground: #121715;([\s\S]*?)--shadow-pop:[^;]+;/g)].map(match => Object.fromEntries([...match[0].matchAll(/--([\w-]+): (#[\da-fA-F]{6})/g)].map(token => [token[1], token[2]])))
  expect(blocks).toHaveLength(2)
  expect(blocks[0]).toEqual(blocks[1])
  const tokens = blocks[0]
  for (const status of ['success', 'danger', 'warning']) {
    expect(contrast(tokens[status], tokens.card)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(tokens[status], tokens.ground)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(tokens[status + '-tint'], tokens.card)).toBeGreaterThanOrEqual(1.6)
    expect(contrast(tokens.ink, tokens[status + '-tint'])).toBeGreaterThanOrEqual(7)
  }
})

test('avatar fallback centres text at default and small sizes', () => {
  for (const size of ['default', 'sm'] as const) {
    const html = renderToStaticMarkup(<Avatar size={size}><AvatarFallback>J</AvatarFallback></Avatar>)
    expect(html).toContain('items-center justify-center')
    expect(html).toContain('leading-none')
    expect(html).toContain('pt-px')
    expect(html).toContain('group-data-[size=sm]/avatar:pt-0')
    expect(html).toContain('group-data-[size=sm]/avatar:text-xs')
  }
})
