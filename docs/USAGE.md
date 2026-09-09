# Porta usage guide

This guide explains how to use Porta through the command-line interface (CLI), the terminal UI (TUI), and the local web UI.

## 1. Install and configure a model

Requirements:

- Node.js 22.19 or newer
- A running model provider

Install dependencies from a checkout:

```bash
npm install
npm run build
npm link
```

This exposes the normal executable interface. Development scripts remain available, but are not required for normal use. A Mema-managed installation should activate Node.js 22.19+ and the installed Porta package, then expose the same `porta` command; Porta does not install Node itself.

### Ollama (default provider)

```bash
ollama serve
ollama pull <model-name>
OLLAMA_MODEL=<model-name> npm run porta
```

`OLLAMA_BASE_URL` defaults to `http://localhost:11434`.

### OpenAI-compatible server

```bash
PORTA_MODEL_PROVIDER=openai-compatible \
PORTA_MODEL_BASE_URL=http://127.0.0.1:8080 \
PORTA_MODEL=<model-name> \
npm run porta
```

### Codex subscription

Log in once, then start any frontend with the Codex provider:

```bash
porta login openai-codex
PORTA_MODEL_PROVIDER=openai-codex PORTA_MODEL=gpt-5.3-codex porta
```

For headless environments use `--device-code` with the login command. Porta does not use an OpenAI API key for this provider.

## 2. Configuration

The simplest setup uses environment variables. For repeatable setups, create a JSON file and set `PORTA_CONFIG`:

```json
{
  "model": {
    "provider": "ollama",
    "baseUrl": "http://localhost:11434",
    "model": "<model-name>"
  },
  "authorization": {
    "mode": "require-approval"
  }
}
```

```bash
PORTA_CONFIG=porta.json npm run porta
```

Porta does not grant workspace access merely because a model is configured. Enable filesystem tools explicitly:

```json
{
  "model": {
    "provider": "ollama",
    "baseUrl": "http://localhost:11434",
    "model": "<model-name>"
  },
  "filesystem": {
    "root": ".",
    "mutation": { "enabled": true }
  },
  "authorization": {
    "mode": "require-approval"
  }
}
```

- `filesystem.root` enables confined read-only filesystem tools.
- `filesystem.mutation.enabled` additionally enables writes and patches.
- `authorization.mode` can be `require-approval` or `allow-all`.
- Command execution is separate and must be explicitly enabled with `execution.enabled` and an allowlist.
- Bounded delegation is opt-in with `delegation.enabled`; it supports `delegation.maxDepth` and `delegation.maxChildren`. A child inherits the parent's effective permissions and may only restrict them. Child task handoff state is stored in a task-owned scratchpad namespace, so a later attempt can use another model without replaying the previous conversation.

Keep the workspace root as narrow as practical. Filesystem paths are confined to that root. Mutation is disabled by default.

## 3. CLI: line-oriented terminal

Start the normal executable with:

```bash
porta
porta --picker
porta --session <session-id>
```

The development equivalent is `npm run porta` (or `node dist/src/main.js` after building).

After startup, Porta prints the configured model and the registered tool IDs. Type one message per line and press Enter. The assistant response and tool events stream below the prompt.

### CLI controls

- Enter: submit the current line
- `/cancel`: cancel the active execution
- `y` or `yes`: approve a requested tool call
- Any other approval response: deny the tool call
- Ctrl+C: exit
- EOF (Ctrl+D): exit gracefully

The CLI is useful for scripts, simple local use, and environments where a full-screen interface is undesirable. It is line-oriented; multiline composition and Shift+Enter editing are features of the TUI and web textarea.

To resume a persisted session:

```bash
PORTA_CONFIG=porta.json PORTA_SESSION=<session-id> npm run porta
# or
PORTA_CONFIG=porta.json npm run porta -- --session <session-id>
```

Persistence must be enabled in the configuration for a session to survive a process restart. Without persistence, sessions are in memory only.

## 4. TUI: interactive terminal interface

Start the TUI with:

```bash
porta tui
```

Use the same `PORTA_CONFIG`, model environment variables, and provider setup as the CLI:

```bash
PORTA_CONFIG=porta.json npm run porta:tui
```

The TUI displays the conversation, streamed assistant output, tool status, approvals, and execution progress.

### TUI controls

- Type text: edit the current message
- Enter: submit the message
- Shift+Enter: insert a newline without submitting
- Backspace: delete the previous character
- Ctrl+C: cancel and exit
- During an approval: Enter or `y` approves; Escape or another key denies
- While the model is running: input is ignored except Ctrl+C

Pasting is supported, including multiline text. Pasted content is placed in the input buffer and is **not** submitted automatically. Press a separate final Enter to submit it. This is especially useful for code, logs, and long prompts.

Resume a persisted session with:

```bash
PORTA_CONFIG=porta.json npm run porta:tui -- --session <session-id>
```

## 5. Web UI

Start the local web server with:

```bash
PORTA_CONFIG=porta.json porta web
```

Open:

```text
http://127.0.0.1:4173
```

Change the port with `PORTA_WEB_PORT`:

```bash
PORTA_WEB_PORT=8080 PORTA_CONFIG=porta.json npm run porta:web
```

The web UI provides:

- A message composer
- Enter to send
- Shift+Enter for a newline
- Streaming assistant output
- Tool and error status
- Approval buttons
- A New session button

The server binds to localhost by default. The browser does not receive model credentials or direct filesystem access; requests are handled by the Porta server. Treat the server as local-only unless you deliberately place it behind suitable authentication and network controls.

The browser stores the current session ID locally and attempts to reuse it. For reliable restart/resume behavior, enable SQLite persistence in the configuration. The web server does not provide credential-management endpoints.

## 6. A first workspace task

With filesystem mutation enabled, start the TUI or web UI and ask:

```text
Create a file named hello.txt containing Hello from Porta. Read the file back and report its contents.
```

With `require-approval`, approve the write and read requests when prompted. Verify the resulting file on disk; do not rely only on the assistant's response.

## 7. Safety and operating notes

- No filesystem, mutation, shell execution, or persistence capability is enabled unless configured.
- Tool authorization is enforced by the gateway, not by the model.
- Keep `allow-all` for trusted local experiments only.
- Host-process execution is best-effort rather than a hard security sandbox; Bubblewrap is required for stronger Linux isolation when selected by policy.
- Large outputs may be stored as artifacts. Ask the model to use bounded artifact reads or searches instead of injecting an entire large file into context.

## 8. Controlled development tasks

Tasks may optionally carry a persisted development state containing the goal, acceptance criteria, workspace, permission intent, focused/full verification commands, deployment target, phase, attention reason, changed files, verification records, commit/image metadata, and last event. Update it through the existing versioned `task/update` capability using `set_development`; the web task list exposes the phase and attention state globally.

The persistent `DevelopmentRunner` advances one phase at a time through an injected normal Porta capability driver. It records a `running` marker before invoking a phase, pauses rather than repeating an interrupted side effect, and resumes only after a version-checked web intervention. Supported interventions are approve, reject, provide input, resume, and cancel. A browser disconnect does not cancel the task.

This is state and intervention infrastructure, not an autonomous deployment workflow yet. Git commit/push, image build/push, and the one-shot `ssh deploy_porta@nas` adapter now exist as explicit capability seams, but are not automatically chained by the runner. The current project has no configured image repository, so live image publication and NAS qualification remain opt-in follow-up work. Do not mark a task completed without passing evidence for every required stage.

## 9. Release configuration

Release orchestration requires an explicit image repository; Porta never guesses one. Configure it with `deployment.imageRepository` and `deployment.registry`, or set `PORTA_IMAGE_REPOSITORY` and optionally `PORTA_IMAGE_REGISTRY` (default `192.168.188.2:9006`). The deployment target defaults to `porta-nas`. The release runner persists commit, immutable image tag, `latest` alias, deployment handoff, and replacement qualification state before invoking the one-shot SSH adapter.

## 10. Diagnostics and development checks

Inspect the actual executable, runtime, configuration, workspace, credentials, persistence, and packaged web assets with:

```bash
porta doctor
porta doctor --verbose
porta doctor --json
```

`doctor --json` is stable machine-readable output for Mema or CI. It never prints credentials. Disabled mutation and command execution are reported as secure warnings, not failures; an invalid required configuration or unsupported Node version returns a non-zero exit code.

From the repository root, run `porta doctor` before the development checks:

```bash
porta doctor
npm test
npm run typecheck
npm run build
npm pack
```

`npm link` points `porta` at the development checkout for self-bootstrap work. A Mema installation is separate: Mema manages the Node runtime, Porta installation, version, and activation, while Porta manages configuration, providers, tools, sessions, and diagnostics.
