# Send to Porta (Chromium MV3)

This is a small unpacked Chromium Manifest V3 extension for sending a selected ChatGPT assistant artifact to Porta.

## Local setup

1. Start a local Porta Web/API endpoint.
2. Create a scoped integration credential with `nodes.read`, `models.read`, and `prompt.submit`.
3. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked** for this directory.
4. Open the extension options and configure the Porta HTTPS endpoint and credential.
5. Configure `PORTA_EXTENSION_ORIGINS` on Porta with the extension origin when required by the browser deployment.

The extension requests host permission for the configured endpoint. HTTPS is required except for localhost qualification.

## Security model

The ChatGPT content script only reads rendered assistant artifacts, injects the explicit user control, and sends narrow typed messages to the extension service worker. The service worker owns endpoint configuration, credential storage, validation, and authenticated HTTP requests. The integration token is never returned to the content script or inserted into the page DOM.

The extension does not access SSH, node private keys, filesystems, runtimes, Git, or Docker. It does not submit automatically.

## Known limitation

ChatGPT DOM structure is not a stable public API. Artifact selectors and Markdown reconstruction may need maintenance as the ChatGPT Web UI changes. Real-browser qualification is required before production use.
