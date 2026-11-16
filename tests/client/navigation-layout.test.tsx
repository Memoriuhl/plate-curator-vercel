import { useEffect } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

const mounted = vi.hoisted(() => ({ strip: 0, review: 0, search: 0, code: 'AK' }))
vi.mock('next/navigation', () => ({ useParams: () => ({ code: mounted.code }) }))
vi.mock('@/components/dashboard/dashboard-data', () => ({
  JurisdictionStrip: function Strip() {
    useEffect(() => { mounted.strip++ }, [])
    return <nav aria-label="Jurisdictions">Jurisdictions</nav>
  },
}))
vi.mock('@/components/dashboard/search', () => ({
  DashboardSearch: function Search() {
    useEffect(() => { mounted.search++ }, [])
    return <input aria-label="Search" />
  },
}))
vi.mock('@/components/dashboard/review-strip', () => ({
  ReviewStrip: function Review() {
    useEffect(() => { mounted.review++ }, [])
    return <div>Review</div>
  },
}))

const { default: StatesLayout } = await import('@/app/(curator)/states/layout')
const { useParams } = await import('next/navigation')

function StatePage() {
  const { code } = useParams()
  return <p>{code}</p>
}

afterEach(cleanup)

test('shared controls stay mounted when the router changes the state parameter', () => {
  const view = render(<StatesLayout><StatePage key={mounted.code} /></StatesLayout>)
  const strip = screen.getByRole('navigation')
  const search = screen.getByRole('textbox')
  mounted.code = 'AL'
  view.rerender(<StatesLayout><StatePage key={mounted.code} /></StatesLayout>)
  expect(screen.getByText('AL')).toBeTruthy()
  expect(screen.getByRole('navigation')).toBe(strip)
  expect(screen.getByRole('textbox')).toBe(search)
  expect(mounted.strip).toBe(1)
  expect(mounted.review).toBe(1)
  expect(mounted.search).toBe(1)
})
