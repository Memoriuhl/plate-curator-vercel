import { createHook, sleep } from "workflow";

export type SpikeNote = { note: string };

export async function waitForSpikeNote(token: string, timeoutMinutes: number) {
  "use workflow";

  const hook = createHook<SpikeNote>({ token });
  const result = await Promise.race([
    hook,
    sleep(timeoutMinutes * 60_000).then(() => "timeout" as const),
  ]);

  if (result === "timeout") return { outcome: "timed_out" as const };
  return recordNote(result);
}

async function recordNote({ note }: SpikeNote) {
  "use step";

  const deployment = process.env.VERCEL_DEPLOYMENT_ID ?? "local";
  console.log(`Spike resumed on ${deployment}: ${note}`);
  return { outcome: "resumed" as const, note, deployment };
}
