import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { GroupInput } from '../lib/jobs/specialized-suggestions'
import type { ImageGroupOptions } from '../lib/jobs/image-options'
import sharp from 'sharp'

export type EmbeddingGroups = { groups: { templateId: string; variants: { id: string }[] }[]; similarities: number[][]; model: string }

export function legacyEmbeddingRunner(options: { python: string; legacyRepo: string; readImage: (image: string) => Promise<string>; cache: string; script?: string }) {
  return async (scope: GroupInput, stageOptions: ImageGroupOptions): Promise<EmbeddingGroups> => {
    const temporary = await mkdtemp(join(tmpdir(), 'pcv-group-'))
    if (resolve(dirname(temporary)) !== resolve(tmpdir())) throw new Error('Invalid temporary group directory')
    try {
      const plates: Record<string, unknown>[] = []
      for (const [index, { plate }] of scope.entries()) {
        const path = join(temporary, `${index}.img`)
        const image = typeof plate.imageUrl === 'string' && plate.imageUrl ? plate.imageUrl : plate.image
        const bytes = Buffer.from(await options.readImage(image), 'base64')
        if (bytes.length > 8 * 1024 * 1024) throw new Error('Group image is too large')
        const metadata = await sharp(bytes, { limitInputPixels: 16000000 }).metadata()
        if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) throw new Error('Unsupported group image')
        await writeFile(path, bytes)
        plates.push({ id: plate.id, state: plate.state, slug: plate.slug, displayName: plate.displayName, isStandard: plate.isStandard ?? false, isTemplate: plate.templateRole === 'template', templateFamily: plate.templateFamily ?? '', path })
      }
      return await new Promise<EmbeddingGroups>((resolveResult, reject) => {
        const child = execFile(options.python, [options.script ?? resolve('worker/group-runtime.py')], { timeout: 240000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, LOCAL_GROUP_LEGACY_REPO: options.legacyRepo, TORCH_HOME: options.cache, USE_TIMM: '0', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } }, (error, stdout) => {
          if (error) { reject(new Error('Local embedding runtime failed')); return }
          try { resolveResult(JSON.parse(stdout) as EmbeddingGroups) } catch { reject(new Error('Local embedding runtime returned invalid output')) }
        })
        child.stdin?.on('error', () => undefined)
        child.stdin?.end(JSON.stringify({ plates, options: stageOptions }))
      })
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }
}
