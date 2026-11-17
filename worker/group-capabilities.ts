import { access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import type { GroupRuntime } from '../lib/jobs/image-options'

type Settings = { [key: string]: string | undefined; LOCAL_GROUP_PYTHON?: string; LOCAL_GROUP_LEGACY_REPO?: string; LOCAL_GROUP_CACHE?: string; OLLAMA_URL?: string }
const execute = promisify(execFile)

export async function detectGroupRuntime(settings: Settings): Promise<GroupRuntime> {
  const result: GroupRuntime = { embeddings: false, backgroundMask: false, visionTiebreak: false, reason: 'Needs LOCAL_GROUP_PYTHON, LOCAL_GROUP_LEGACY_REPO and LOCAL_GROUP_CACHE' }
  if (settings.LOCAL_GROUP_PYTHON && settings.LOCAL_GROUP_LEGACY_REPO && settings.LOCAL_GROUP_CACHE) {
    try {
      await Promise.all([access(settings.LOCAL_GROUP_PYTHON), access(join(settings.LOCAL_GROUP_LEGACY_REPO, 'refiner', 'plate_match.py')), access(join(settings.LOCAL_GROUP_CACHE, 'hub', 'checkpoints', 'dinov2_vits14_pretrain.pth'))])
      const probe = await execute(settings.LOCAL_GROUP_PYTHON, ['-c', 'import torch,numpy,json\nfrom PIL import Image\ntry:\n import cv2\n mask=True\nexcept ImportError:\n mask=False\nprint(json.dumps({"embeddings":True,"mask":mask}))'], { timeout: 10000, windowsHide: true, maxBuffer: 4096 })
      const value = JSON.parse(probe.stdout)
      result.embeddings = value.embeddings === true
      result.backgroundMask = value.mask === true
      result.reason = result.embeddings ? undefined : 'Needs the Python PyTorch, NumPy and Pillow dependencies'
      result.maskReason = result.backgroundMask ? undefined : 'Needs the Python OpenCV dependency'
    } catch { result.reason = 'Local grouping runtime, legacy implementation or DINOv2 weights are unavailable' }
  }
  try {
    const response = await fetch(`${(settings.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/+$/, '').replace(/\/v1$/, '')}/api/tags`, { signal: AbortSignal.timeout(1000) })
    const body = await response.json()
    result.visionTiebreak = response.ok && Array.isArray(body.models) && body.models.some((model: { name?: string }) => model.name === 'gemma4:12b')
    result.visionReason = result.visionTiebreak ? undefined : 'Needs the configured local vision model'
  } catch { result.visionReason = 'Needs a reachable local vision service' }
  return result
}
