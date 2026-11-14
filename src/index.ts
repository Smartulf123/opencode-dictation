// The server part does nothing. OpenCode loads a plugin added with
// `opencode plugin add` through its server part, which brings the prompt-bar
// microphone (./tui) along with it.
import { Plugin } from '@opencode/plugin'

export default Plugin.define({
  id: 'opencode-dictation.server',
  setup() {},
})
