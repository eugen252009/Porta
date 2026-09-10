const endpoint = document.querySelector("#endpoint");
const token = document.querySelector("#token");
const defaultTarget = document.querySelector("#defaultTarget");
const status = document.querySelector("#status");
(async () => { const saved = await chrome.storage.local.get({ endpoint: "", token: "", defaultTarget: "" }); endpoint.value = saved.endpoint; token.value = saved.token; defaultTarget.value = saved.defaultTarget; })();
document.querySelector("#save").onclick = async () => { try { const value = new URL(endpoint.value); if (value.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(value.hostname)) throw new Error("HTTPS is required except for localhost qualification."); if (chrome.permissions?.request) { const granted = await chrome.permissions.request({ origins: [`${value.origin}/*`] }); if (!granted) throw new Error("Porta host permission was not granted."); } await chrome.storage.local.set({ endpoint: value.origin, token: token.value, defaultTarget: defaultTarget.value.trim() }); status.textContent = "Saved."; } catch { status.textContent = "Enter a valid Porta HTTPS endpoint."; } };
