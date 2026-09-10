# Real browser dogfood qualification

This checklist is intentionally manual. The repository environment currently has Firefox ESR but no Chromium/Chrome automation, and this extension targets Chromium Manifest V3.

## Local isolated setup

Use a temporary data directory and the repository's normal Web server. Do not use the NAS target for this qualification.

Create the temporary scoped credential before starting Porta so the server loads it at startup:

```bash
export PORTA_DATA_DIR=/tmp/porta-browser-dogfood
node --input-type=module -e 'import { IntegrationCredentialStore } from "./dist/src/integration-auth.js"; const created = new IntegrationCredentialStore(`${process.env.PORTA_DATA_DIR}/integrations`).create("local-browser-dogfood", ["nodes.read", "models.read", "prompt.submit"]); process.stdout.write(created.token + "\\n");'
```

Save the one-time token privately for the extension options page. Then start Porta:

```bash
export PORTA_WEB_PORT=4178
export PORTA_EXTENSION_ORIGINS=chrome-extension://<extension-id>
npm run porta:web
```

The canonical local qualification endpoint is:

```text
http://localhost:4178
```

The current `porta.json` NAS endpoint is `http://192.168.188.2:4173`; it is not suitable for the hardened extension because non-local HTTP is rejected. Use an HTTPS deployment for a real remote endpoint.

The token is displayed once for entry in the extension options page. Revoke it after testing through the normal credential-management API or by removing the temporary data directory.

## Load the unpacked extension

1. Use Chromium or Chrome.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Choose **Load unpacked**.
5. Select:

```text
/home/eugen/projekte/Porta/integrations/chatgpt-browser-extension
```

6. Note the generated extension ID.
7. Restart Porta with `PORTA_EXTENSION_ORIGINS` set to `chrome-extension://<extension-id>`.
8. Open the extension options.
9. Set `http://localhost:4178` and the temporary token.
10. Grant the requested localhost host permission.
11. Save and reload ChatGPT.

## Qualification prompt

Use exactly:

```markdown
# Porta Browser Integration Qualification

Inspect the Node.js version available on this Porta node and report:

1. the exact `node --version` result;
2. the node/target on which the command executed;
3. whether any files were modified.

Do not modify files.
Do not commit.
Do not push.
Do not deploy.
```

## Checks

Verify:

- one `Send to Porta ▾` control appears for the assistant artifact;
- user messages and unrelated page content are not decorated;
- rerendering does not duplicate controls;
- node selection shows Local and no duplicate entries;
- submission creates one Local session;
- the Porta Web UI shows the session without reload;
- the prompt result reports the exact Node.js version;
- the browser page cannot find the token in DOM, `window`, localStorage, or sessionStorage;
- the extension service-worker console contains no token or Authorization header logging;
- revoking the token causes the next nodes request to fail;
- no unavailable target causes Local fallback.

For remote qualification, use an HTTPS Porta endpoint and a directly trusted node only after the local qualification succeeds.
