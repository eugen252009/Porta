import { HarnessKernel } from "./kernel.js";
import { MemoryStore, MockModelProvider, NullTelemetry, RecordingRenderer, ScriptInput } from "./adapters.js";
export function compose() { return { kernel: new HarnessKernel(new MemoryStore(), new MockModelProvider()), input: new ScriptInput([]), renderer: new RecordingRenderer(), telemetry: new NullTelemetry() }; }
