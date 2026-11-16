import { StateContent } from '@/components/dashboard/dashboard-data'

export default async function Dashboard({
  params,
}: {
  params: Promise<{ code: string }>
}) {
  const { code } = await params
  return <StateContent code={code} />
}
