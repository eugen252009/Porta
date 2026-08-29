import { createPortaApplication } from "../../dist/src/porta-application.js";
import { loadPortaConfig } from "../../dist/src/porta-config.js";

const config = await loadPortaConfig(undefined);
console.log("provider:", config.model.provider, "model:", config.model.model);
const app = await createPortaApplication(config);
await app.start();
let session;
for await (const e of app.gateway.execute({ type: "CreateSession" })) if (e.type === "SessionCreated") session = e.sessionId;
const events = app.gateway.execute({ type: "SubmitInput", sessionId: session, input: "What is 2+2? Answer with just the number." }, { traceId: "live", signal: new AbortController().signal });
let text = "";
for await (const e of events) {
  if (e.type === "OutputDelta") { text += e.text; process.stdout.write(e.text); }
  else console.log(`\n[event] ${e.type}${e.type === "Error" ? " " + e.error.code + ": " + e.error.message : ""}`);
}
console.log("\nfinal reply:", JSON.stringify(text.trim()));
await app.shutdown();
