/** @jsxImportSource @opentui/solid */
// OpenCode Dictation: a microphone in the prompt bar. Click it (or press the
// shortcut, or type /dictate) and speak; each phrase is typed into the prompt
// as you pause. Click again to stop, Enter to stop and send, Esc to cancel.
// Speech is turned into text on this computer with Whisper; nothing is sent
// anywhere.
import { Show } from 'solid-js'
import { Plugin } from '@opencode/plugin/tui'
import { MicrophoneSource, WavFileSource, listMicrophones, type AudioSource } from './core/audio'
import { createEngine, type Engine } from './core/engine'
import { MODEL_NAMES, MODEL_SIZE_MB, ensureModel, isModelName, isModelReady, type ModelName } from './core/models'
import { DictationSession, type SessionState } from './core/session'
import { InlineDraft, type Editor } from './core/inline'
import { levelBar } from './core/text'

const RED = '#E5484D'

type Live = {
  state: SessionState
  peak: number
  speaking: boolean
  /** Shown beside the icon while starting, e.g. the download progress. */
  note: string
  /** The words of the phrase being spoken, before the pause makes them final. */
  draft: string
  /** Finished phrases are still being turned into text. */
  busy: boolean
}

type Settings = { model: string; device: string; uses: number }

/** The stop-and-send hint shows during the first few dictations, then the footer stays short. */
const HINT_USES = 3



function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default Plugin.define({
  id: 'opencode-dictation',
  setup(context) {
    const options = context.options ?? {}
    const key: string = typeof options.key === 'string' ? options.key : 'alt+v'
    const language: string = typeof options.language === 'string' ? options.language : ''
    const sendOnEnter = options.sendOnEnter !== false
    // A WAV file to "speak" instead of the microphone: for tests and demos.
    const testWav: string = options.testWav || process.env.OPENCODE_DICTATION_WAV || ''

    const [settings, setSettings] = context.storage.store<Settings>('settings', {
      initial: { model: isModelName(options.model) ? options.model : 'base', device: '', uses: 0 },
    })
    const [live, setLive] = context.storage.memory<Live>('live', {
      initial: { state: 'idle', peak: 0, speaking: false, note: '', draft: '', busy: false },
    })
    setLive(d => {
      d.state = 'idle'
      d.note = ''
      d.draft = ''
      d.busy = false
    })

    const toast = (message: string, variant: 'info' | 'success' | 'warning' | 'error' = 'info') =>
      context.ui.toast.show({ title: 'Dictation', message, variant })

    const model = (): ModelName => (isModelName(settings.model) ? settings.model : 'base')

    // One engine per model, loaded on first use and kept for the next time.
    const engines = new Map<string, Promise<Engine>>()
    const engineFor = (name: ModelName): Promise<Engine> => {
      const id = `${name}:${language}`
      let engine = engines.get(id)
      if (!engine) {
        engine = (async () => {
          if (!isModelReady(name)) {
            toast(`Downloading the ${name} speech model (about ${MODEL_SIZE_MB[name]} MB), once.`)
          }
          const files = await ensureModel(name, (done, total) => {
            const pct = Math.floor((done / total) * 100)
            setLive(d => {
              d.note = `downloading model ${pct}%`
            })
          })
          setLive(d => {
            d.note = 'loading model'
          })
          return createEngine(files, { language })
        })()
        engines.set(id, engine)
        engine.catch(() => engines.delete(id))
      }
      return engine
    }

    // The prompt that was focused when dictation started. Phrases go there,
    // at its cursor, so typing and speaking mix.
    let target: Editor | undefined
    let inline: InlineDraft | undefined
    let held = ''
    const focusedEditor = () => context.renderer.currentFocusedEditor as unknown as Editor | null

    const write = (phrase: string) => {
      const editor = target && !target.isDestroyed ? target : null
      if (editor && focusedEditor() === editor) {
        if (held) {
          phrase = `${held} ${phrase}`
          held = ''
        }
        inline ??= new InlineDraft(editor, context.theme.text.muted)
        inline.commit(phrase)
        return
      }
      if (!editor && focusedEditor() === null) {
        // No edit buffer to talk to: paste it the way a terminal would.
        context.renderer.keyInput.processPaste(new TextEncoder().encode(`${phrase} `))
        return
      }
      // The prompt lost focus (a dialog is open); keep the words until it is back.
      held = held ? `${held} ${phrase}` : phrase
    }

    const session = new DictationSession({
      onPhrase: write,
      onState: state =>
        setLive(d => {
          d.state = state
          if (state !== 'starting') {
            d.note = ''
          }
          if (state === 'idle') {
            d.peak = 0
            d.speaking = false
            d.draft = ''
            d.busy = false
          }
        }),
      onDraft: draft => {
        // The draft goes into the prompt itself, greyed, at the cursor.
        const editor = target && !target.isDestroyed ? target : null
        if (!editor || focusedEditor() !== editor) {
          return
        }
        inline ??= new InlineDraft(editor, context.theme.text.muted)
        if (draft) {
          inline.show(draft)
        } else {
          inline.clear()
        }
        setLive(d => {
          d.draft = draft
        })
      },
      onBusy: busy =>
        setLive(d => {
          d.busy = busy
        }),
      onLevel: (peak, speaking) =>
        setLive(d => {
          // Smooth the meter so it reads as a level, not flicker.
          d.peak = Math.max(peak * 3, d.peak * 0.8)
          d.speaking = speaking
        }),
      onError: error => toast(`Could not transcribe: ${errorText(error)}`, 'error'),
    })

    const source = (): AudioSource =>
      testWav ? WavFileSource.fromFile(testWav) : new MicrophoneSource(settings.device)

    const start = async () => {
      target = focusedEditor() ?? undefined
      inline = undefined
      held = ''
      showHint = settings.uses < HINT_USES
      try {
        await session.start(source(), engineFor(model()))
        if (session.state === 'listening') {
          void setSettings(d => {
            d.uses = (d.uses ?? 0) + 1
          })
        }
      } catch (error) {
        toast(`Could not start dictation: ${errorText(error)}`, 'error')
      }
    }

    const stop = async () => {
      await session.stop()
      if (held) {
        toast(`The prompt was not focused, so this was not typed: "${held}"`, 'warning')
        held = ''
      }
    }

    let showHint = true

    const toggle = () => {
      if (session.state === 'idle') {
        void start()
      } else if (session.state === 'listening' || session.state === 'starting') {
        void stop()
      }
    }

    const finishAndSend = async () => {
      await stop()
      if (sendOnEnter) {
        context.keymap.dispatch('prompt.submit')
      }
    }

    const isActive = () => live.state !== 'idle'

    context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: 'dictation.toggle',
          title: 'Dictation: start or stop',
          description: 'Speak into the prompt; each phrase is typed when you pause',
          group: 'Dictation',
          palette: true,
          slash: { name: 'dictate' },
          bind: key,
          run: toggle,
        },
        {
          id: 'dictation.model',
          title: 'Dictation: choose the speech model',
          group: 'Dictation',
          palette: true,
          slash: { name: 'dictate-model' },
          run: async () => {
            const picked = await context.ui.dialog.select<ModelName>({
              title: 'Speech model',
              current: model(),
              options: MODEL_NAMES.map(name => ({
                title: name,
                value: name,
                description: {
                  tiny: 'fastest, least accurate',
                  base: 'a good balance (default)',
                  small: 'most accurate, slower on a CPU',
                }[name],
                footer: isModelReady(name) ? 'downloaded' : `${MODEL_SIZE_MB[name]} MB download`,
              })),
            })
            if (picked) {
              await setSettings(d => {
                d.model = picked
              })
              toast(`Speech model: ${picked}`, 'success')
            }
          },
        },
        {
          id: 'dictation.microphone',
          title: 'Dictation: choose the microphone',
          group: 'Dictation',
          palette: true,
          slash: { name: 'dictate-mic' },
          run: async () => {
            let mics: string[]
            try {
              mics = await listMicrophones()
            } catch (error) {
              toast(`Could not list microphones: ${errorText(error)}`, 'error')
              return
            }
            const picked = await context.ui.dialog.select<string>({
              title: 'Microphone',
              current: settings.device,
              options: [
                { title: 'System default', value: '' },
                ...mics.map(name => ({ title: name, value: name })),
              ],
            })
            if (picked !== undefined) {
              await setSettings(d => {
                d.device = picked
              })
              toast(`Microphone: ${picked || 'system default'}`, 'success')
            }
          },
        },
      ],
    }))

    // While dictating, Enter finishes the last words before sending, and Esc
    // throws the recording away. Everything else types as usual.
    context.keymap.layer(() => ({
      mode: 'global',
      priority: 100,
      enabled: isActive,
      commands: [
        {
          title: 'Dictation: stop and send',
          group: 'Dictation',
          bind: 'return',
          run: () => {
            void finishAndSend()
          },
        },
        {
          title: 'Dictation: cancel',
          group: 'Dictation',
          bind: 'escape',
          run: () => {
            void session.cancel()
          },
        },
      ],
    }))

    const status = () => {
      if (live.state === 'starting') {
        return live.note || 'starting'
      }
      return live.state === 'finishing' ? 'finishing' : 'listening'
    }

    context.ui.slot({
      append: 'prompt.footer.status',
      render: () => (
        <box flexDirection="row" flexShrink={0} onMouseUp={toggle}>
          <Show
            when={isActive()}
            fallback={
              <text fg={context.theme.text.muted}>
                🎙 <span style={{ fg: context.theme.text.faint }}>{key}</span>
              </text>
            }
          >
            <text fg={RED}>
              {live.state === 'starting' ? '◌ ' : '● '}
              <span style={{ fg: context.theme.text.base }}>{status()}</span>
              {/* Bars only while you speak, so a quiet room shows nothing. */}
              {live.state === 'listening' && live.speaking ? ` ${levelBar(live.peak, 3)}` : ''}
              <span style={{ fg: context.theme.text.faint }}>{live.busy ? ' …' : ''}</span>
              <span style={{ fg: context.theme.text.faint }}>
                {live.state === 'listening' && showHint
                  ? sendOnEnter
                    ? '  enter send, esc cancel'
                    : '  esc cancel'
                  : ''}
              </span>
            </text>
          </Show>
        </box>
      ),
    })

    return async () => {
      await session.cancel()
    }
  },
})
