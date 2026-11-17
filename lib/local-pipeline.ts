export function localPipelineReason(reason: string) {
  return process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' ? reason : 'Coming soon'
}
