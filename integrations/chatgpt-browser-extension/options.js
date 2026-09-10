const endpoint = document.querySelector("#endpoint");
const token = document.querySelector("#token");
const defaultTarget = document.querySelector("#defaultTarget");
const status = document.querySelector("#status");
(async () => { const saved = await chrome.storage.local.get({ endpoint: "", token: "", defaultTarget: "" }); endpoint.value = saved.endpoint; token.value = saved.token; defaultTarget.value = saved.defaultTarget; })();
document.querySelector("#save").onclick = async () => { try { const value = new URL(endpoint.value); if (chrome.permissions?.request) await chrome.permissions.request({ origins: [`${value.origin}/*`] }); await chrome.storage.local.set({ endpoint: value.origin, token: token.value, defaultTarget: defaultTarget.value.trim() }); status.textContent = "Saved."; } catch { status.textContent = "Enter a valid Porta HTTPS endpoint."; } };
