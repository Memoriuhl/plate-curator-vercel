/** Choose the supplied unavailable reason or the feature's disabled label for the UI. */
export function localPipelineReason(reason: string) {
  return process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' ? reason : 'Coming soon'
}
