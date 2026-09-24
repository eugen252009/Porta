# NAS Git/SSH qualification

This is a live, disposable smoke-test record for Porta's generic session workspace and Git credential path. It is separate from the normal offline test suite. No NAS-specific Git code, hostname override, production DNS change, or production deployment was used.

## Architecture and runtime

Session creation passes the supplied remote directly as an argv value to `git clone -- ...` in the server-generated staging workspace. The existing server-side `GitCredentialStore` writes SSH private-key/known-hosts files with mode `0600`; the session workspace registry stores only credential IDs. For a clone or remote Git operation, Porta creates short-lived credential material and sets `GIT_SSH_COMMAND` to an isolated OpenSSH config. It disables agent/default identities, uses the supplied trusted `known_hosts`, and sets `StrictHostKeyChecking yes`. The configured SSH key, known-hosts file, and temporary config are cleaned up after the operation. Session filesystem, command, and Git providers are bound to the assigned workspace.

A qualification-only image was built from the current working tree and run with Docker's normal bridge networking, as the image's `porta` UID 10001. The actual Porta API server and clone flow ran inside that container. The older locally cached image did not contain the current workspace module, so it was not used for the application/API test. No Docker socket, host networking, or DNS override was used.

`nas` resolved inside the container via the Docker-provided resolver (`192.168.188.2`); `getent hosts nas` returned the NAS link-local IPv6 record. OpenSSH resolved and connected to `192.168.188.2:22` from that same container. Host-side `ssh nas` also succeeded, but host connectivity alone was not counted as qualification.

## NAS fixture and credential

A clearly named, disposable bare repository was created under the non-root NAS account's home:

```text
/volume1/homes/Eugen/porta-qualification-<temporary-id>.git
```

It contained one seed commit on `main`. A fresh, unencrypted Ed25519 key was generated solely for this smoke test and temporarily added to that NAS account's `authorized_keys`; the Porta credential used that private key and a `known_hosts` entry derived from the already trusted NAS host key. The credential also used the generic, permitted SSH config directive `Host nas / User eugen`, enabling the exact `nas:/...` spelling without provider-specific parsing. Strict verification was left enabled. The key, its NAS authorization entry, test repository, temporary container, and local test files were removed after qualification. No existing repositories were modified.

The user's existing interactive NAS login depends on an agent-loaded, passphrase-protected key. Porta intentionally does not inherit an SSH agent, and encrypted SSH keys are not currently supported by the credential store. A dedicated unencrypted Porta key is therefore the recommended arrangement; do not copy or transform an existing user key merely to work around this limitation.

## Results

- Direct `git clone nas:/...`: passed using the selected Porta credential and its host-scoped SSH `User` setting.
- Direct `git clone ssh://eugen@nas/...`: passed using the same generic credential mechanism.
- Separate `ssh -T nas true` from the Porta container: passed; logs confirmed the trusted NAS ED25519 key matched and authentication used the supplied identity.
- Normal authenticated Porta session-creation API: passed. Clone completed before the session reached its active/ready workspace state. A failed setup does not leave an active session workspace.
- Session tools: filesystem read/write/patch, `execution/run` (`git status`), and Git status/diff/log all observed the cloned workspace and a harmless uncommitted change. `git fetch` succeeded with the session-assigned credential. Fetch cleans temporary credential material.
- `git push` was not invoked. Its policy decision was checked and returned `require-approval`; commit and push remain explicit operations.
- Keep/reopen: passed. The same workspace ID/path, `.git` data, branch/history, uncommitted changes, and `nas:/...` origin survived. Deletion afterward was explicitly selected in the disposable test.
- Credential leakage: none observed in the create-session API response or operation output. Credential metadata APIs do not return secret material; files were mode `0600`.

The normal test suite does not contact the NAS. Automated coverage was added for scp-style remotes (including a username), SSH URL remotes, strict known-hosts configuration, an empty base directory with session-scoped Git tools, and API clone/lifecycle behavior using local fixtures.

## Qualification matrix

| Check | Result |
| --- | --- |
| NAS hostname resolves inside Porta runtime | PASS |
| SSH authentication using Porta credential | PASS |
| SSH host verification enabled | PASS |
| Direct `git clone nas:/...` | PASS |
| Direct `git clone ssh://user@nas/...` | PASS |
| Porta session clone from `nas:/...` | PASS |
| Filesystem tools use cloned workspace | PASS |
| Command tools use cloned workspace | PASS |
| Git tools use cloned workspace | PASS |
| Credential leakage | NONE |
| Automatic commit | NO |
| Automatic push | NO |
| Saved-project reopen | PASS |
| Full regression suite | PASS (78 files passed, 2 skipped; 447 tests passed, 13 skipped) |

## Limitations

The NAS path depends on `nas` resolving/reaching SSH in the Porta runtime network. The tested setup used Docker's default bridge in this environment; other Compose, remote-worker, or future network configurations must be checked at their actual execution location. SSH agent forwarding and passphrase-protected keys remain unsupported. Push permission/receive-pack was deliberately not tested; only that Porta's push operation stays approval-gated was checked. No clone-size/disk quotas or outbound-source policy are implemented, by design for this trusted single-user installation.
