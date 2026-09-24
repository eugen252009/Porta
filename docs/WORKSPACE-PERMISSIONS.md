# Workspace file permissions

Use `authorization.mode: "workspace"` to allow routine filesystem work without approving each file operation while retaining human approval for sensitive files and other capabilities.

```json
{
  "authorization": {
    "mode": "workspace",
    "sensitivePaths": ["private/settings.json", "deployment/credentials"]
  },
  "filesystem": {
    "root": "/workspace",
    "mutation": { "enabled": true }
  }
}
```

These are fields to merge into a complete configuration. A configured filesystem root is required. Mutation must still be enabled explicitly. The existing default mode remains `require-approval`; `allow-all` remains available but does not provide this protection.

## Decisions

| Operation | Workspace mode |
| --- | --- |
| Read or summarize an ordinary text file | Automatic |
| Create, replace, or patch an ordinary file | Automatic, subject to existing mutation/version checks |
| Stat or list ordinary workspace paths | Automatic |
| Search ordinary workspace content | Automatic, filtered before reading |
| Read, summarize, stat, or modify a sensitive path | Human approval for that operation |
| Absolute paths, traversal outside the configured root | Denied |
| Symlinks in any path component, hard-linked files, special files | Denied, even after approval |
| Command execution, Git, MCP and all other tools | Human approval |

The scope is the application's configured `filesystem.root`, not a separate per-job subfolder. Filesystem tool paths remain relative to that root. This does not add folder creation or deletion tools.

Workspace mode takes precedence over `jobs.unattendedTools`: adding `execution/run` or `filesystem/read_file` to a job allowlist cannot bypass workspace mode's decisions. Recovered approval applies once to the exact approved tool call, not to subsequent tools.

## Sensitive defaults

Matching is case-insensitive and applies at every directory level:

- `.env` and any name beginning with `.env`, including `.env.example`
- `.ssh`, `.aws`, `.azure`, `.gcloud`, `.kube`, `.docker`, `.gnupg`, `.config`, `.auth`
- `.git`, `.porta`, `.cocoindex_code`, `secrets`, `.secrets`
- `.netrc`, `.npmrc`, `.pypirc`, `credentials`, `auth.json`, `oauth.json`, `tokens.json`, `webauthn.json`, `kubeconfig`
- Names beginning with `secret` or `credential`, optionally plural, followed by a separator or end of name
- Common SSH key names such as `id_rsa` and `id_ed25519`
- `.key`, `.pem`, `.p12`, `.pfx`, `.keystore`, `.db`, `.sqlite`, `.sqlite3` and their SQLite WAL/SHM sidecars

`authorization.sensitivePaths` adds exact workspace-relative paths or directory prefixes; it cannot remove defaults. Do not use glob patterns. Absolute paths, backslashes, empty components, or `..` are rejected. Defaults are deliberately conservative: example env files and public PEM certificates still require approval.

Directory listings omit protected entries and aliases. Global search skips sensitive paths and directories before reading content and uses the internal linear engine, not native grep/ripgrep or an index that might already contain secrets. This trades indexed-search performance for a clear policy boundary. To inspect a protected file, request its exact path and approve the operation; global search never includes it merely because another read was approved.

## Limits of the guarantee

This is a name/path-based tool policy, not a secret detector or an operating-system sandbox. A password placed in an otherwise ordinary source file is not automatically recognized. Add project-specific sensitive paths where necessary.

Approved commands or Git operations can read sensitive files and make broad changes with the runtime user's authority. A single command approval is therefore more powerful than approval to read one named file. Host-process execution remains best-effort; a confined cwd is not filesystem isolation. Do not grant command approval to untrusted code assuming it cannot inspect secrets.

The filesystem provider rechecks path confinement and rejects aliases before operations, including after an approval wait. Existing mutation operations remain atomic/hash-checked. This policy does not establish isolation against hostile concurrent processes running with the same filesystem privileges; stronger OS sandboxing is required for that threat model.

The live node is not automatically reconfigured or restarted by introducing this mode. Activate it by changing the configured authorization mode and performing a controlled restart when no work is running. Existing jobs are not replayed automatically.
