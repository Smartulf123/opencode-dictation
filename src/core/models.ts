// Speech models: which ones exist, where they live on disk, and how to fetch
// them. Models are downloaded once, on first use, into a cache folder that is
// shared by every OpenCode project on the machine.
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export type ModelName = 'tiny' | 'base' | 'small'

export type ModelFiles = { encoder: string; decoder: string; tokens: string; vad: string }

const HF = 'https://huggingface.co/csukuangfj'
const VAD_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx'

/** Rough download size in MB, shown before the first download. */
export const MODEL_SIZE_MB: Record<ModelName, number> = { tiny: 100, base: 155, small: 360 }

export const MODEL_NAMES: readonly ModelName[] = ['tiny', 'base', 'small']

export function isModelName(value: unknown): value is ModelName {
  return typeof value === 'string' && (MODEL_NAMES as readonly string[]).includes(value)
}

/** The cache folder: $OPENCODE_DICTATION_HOME, else ~/.cache/opencode-dictation. */
export function cacheDir(env: Record<string, string | undefined> = process.env): string {
  return env.OPENCODE_DICTATION_HOME || join(homedir(), '.cache', 'opencode-dictation')
}

export function modelFiles(model: ModelName, root = cacheDir()): ModelFiles {
  const dir = join(root, 'models', `whisper-${model}`)
  return {
    encoder: join(dir, `${model}-encoder.int8.onnx`),
    decoder: join(dir, `${model}-decoder.int8.onnx`),
    tokens: join(dir, `${model}-tokens.txt`),
    vad: join(root, 'models', 'silero_vad.onnx'),
  }
}

/** Where each file comes from. */
export function downloadsFor(model: ModelName, root = cacheDir()): { url: string; path: string }[] {
  const files = modelFiles(model, root)
  const repo = `${HF}/sherpa-onnx-whisper-${model}/resolve/main`
  return [
    { url: `${repo}/${model}-encoder.int8.onnx`, path: files.encoder },
    { url: `${repo}/${model}-decoder.int8.onnx`, path: files.decoder },
    { url: `${repo}/${model}-tokens.txt`, path: files.tokens },
    { url: VAD_URL, path: files.vad },
  ]
}

function isPresent(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0
}

export function isModelReady(model: ModelName, root = cacheDir()): boolean {
  return Object.values(modelFiles(model, root)).every(isPresent)
}

export type Progress = (done: number, total: number) => void

/**
 * Downloads whatever is missing for a model. Each file is written to a
 * `.part` file first and renamed when complete, so a cancelled download never
 * leaves a broken model behind.
 */
export async function ensureModel(
  model: ModelName,
  onProgress: Progress = () => {},
  root = cacheDir(),
  fetchImpl: typeof fetch = fetch,
): Promise<ModelFiles> {
  const missing = downloadsFor(model, root).filter(d => !isPresent(d.path))
  if (missing.length === 0) {
    return modelFiles(model, root)
  }
  const total = MODEL_SIZE_MB[model] * 1024 * 1024
  let done = 0
  for (const { url, path } of missing) {
    mkdirSync(join(path, '..'), { recursive: true })
    const res = await fetchImpl(url)
    if (!res.ok || !res.body) {
      throw new Error(`Could not download ${url} (HTTP ${res.status})`)
    }
    const part = `${path}.part`
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        done += chunk.byteLength
        onProgress(Math.min(done, total), total)
        ctrl.enqueue(chunk)
      },
    })
    try {
      await pipeline(Readable.fromWeb(res.body.pipeThrough(counter) as never), createWriteStream(part))
      renameSync(part, path)
    } catch (error) {
      rmSync(part, { force: true })
      throw error
    }
  }
  onProgress(total, total)
  return modelFiles(model, root)
}
