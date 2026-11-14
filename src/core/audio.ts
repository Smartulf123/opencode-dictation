// Where the sound comes from: the microphone, or a WAV file (for tests and
// for trying the plugin without speaking). Both hand out 16 kHz mono frames
// of 512 samples as floats in -1..1, the format the speech engine expects.
import { readFileSync } from 'node:fs'

export const SAMPLE_RATE = 16000
export const FRAME = 512

export interface AudioSource {
  /** Starts delivering frames; resolves once the device is open. */
  start(onFrame: (frame: Float32Array) => void): Promise<void>
  /** Stops and releases the device. Frames already delivered stay delivered. */
  stop(): Promise<void>
}

export function toFloat(frame: Int16Array): Float32Array {
  const out = new Float32Array(frame.length)
  for (let i = 0; i < frame.length; i++) {
    out[i] = frame[i]! / 32768
  }
  return out
}

export function peakOf(frame: Float32Array): number {
  let peak = 0
  for (const s of frame) {
    peak = Math.max(peak, Math.abs(s))
  }
  return peak
}

type Recorder = {
  start(): void
  stop(): void
  release(): void
  read(): Promise<Int16Array>
  getSelectedDevice(): string
}
type RecorderModule = {
  PvRecorder: (new (frameLength: number, deviceIndex: number) => Recorder) & {
    getAvailableDevices(): string[]
  }
}

async function loadRecorder(): Promise<RecorderModule> {
  return (await import('@picovoice/pvrecorder-node')) as unknown as RecorderModule
}

/** The names of the microphones the system offers, in device-index order. */
export async function listMicrophones(): Promise<string[]> {
  return (await loadRecorder()).PvRecorder.getAvailableDevices()
}

/** The microphone. `device` is a name (or part of one); empty means the system default. */
export class MicrophoneSource implements AudioSource {
  private recorder?: Recorder
  private running = false
  private stopped = false
  private loop?: Promise<void>
  constructor(private readonly device = '') {}

  /** The device that was opened, once started. */
  deviceName = ''

  async start(onFrame: (frame: Float32Array) => void): Promise<void> {
    const { PvRecorder } = await loadRecorder()
    let index = -1
    if (this.device) {
      const wanted = this.device.toLowerCase()
      index = PvRecorder.getAvailableDevices().findIndex(name => name.toLowerCase().includes(wanted))
    }
    if (this.stopped) {
      return
    }
    const recorder = new PvRecorder(FRAME, index)
    recorder.start()
    this.recorder = recorder
    this.deviceName = recorder.getSelectedDevice()
    this.running = true
    this.loop = (async () => {
      while (this.running) {
        const frame = await recorder.read()
        if (this.running) {
          onFrame(toFloat(frame))
        }
      }
    })().catch(() => {})
  }

  async stop(): Promise<void> {
    this.running = false
    this.stopped = true
    const recorder = this.recorder
    this.recorder = undefined
    if (!recorder) {
      return
    }
    recorder.stop()
    await this.loop
    recorder.release()
  }
}

/** Reads a 16-bit PCM WAV file into floats, mixing to mono. Must already be 16 kHz. */
export function readWav(path: string): Float32Array {
  const buf = readFileSync(path)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path} is not a WAV file`)
  }
  let offset = 12
  let channels = 1
  let rate = 0
  let bits = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2)
      rate = buf.readUInt32LE(body + 4)
      bits = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      if (bits !== 16 || rate !== SAMPLE_RATE) {
        throw new Error(`${path} must be 16-bit 16 kHz PCM (got ${bits}-bit ${rate} Hz)`)
      }
      const count = Math.floor(Math.min(size, buf.length - body) / 2 / channels)
      const out = new Float32Array(count)
      for (let i = 0; i < count; i++) {
        let sum = 0
        for (let c = 0; c < channels; c++) {
          sum += buf.readInt16LE(body + (i * channels + c) * 2)
        }
        out[i] = sum / channels / 32768
      }
      return out
    }
    offset = body + size + (size % 2)
  }
  throw new Error(`${path} has no audio data`)
}

/**
 * Plays a WAV file as if it were spoken into the microphone. With
 * `realtime`, frames arrive at the pace of speech; otherwise all at once.
 * After the file it keeps sending silence until stopped, like a quiet room.
 */
export class WavFileSource implements AudioSource {
  private timer?: ReturnType<typeof setInterval>
  constructor(
    private readonly samples: Float32Array,
    private readonly realtime = true,
  ) {}

  static fromFile(path: string, realtime = true): WavFileSource {
    return new WavFileSource(readWav(path), realtime)
  }

  async start(onFrame: (frame: Float32Array) => void): Promise<void> {
    let pos = 0
    const next = () => {
      const frame = new Float32Array(FRAME)
      if (pos < this.samples.length) {
        frame.set(this.samples.subarray(pos, pos + FRAME))
      }
      pos += FRAME
      onFrame(frame)
    }
    if (!this.realtime) {
      while (pos < this.samples.length + SAMPLE_RATE) {
        next()
      }
      return
    }
    this.timer = setInterval(next, (FRAME / SAMPLE_RATE) * 1000)
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    this.timer = undefined
  }
}
