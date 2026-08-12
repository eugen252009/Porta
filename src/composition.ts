import { HarnessKernel } from "./kernel.js";
import { MemoryStore, MockModelProvider, NullTelemetry, RecordingRenderer, ScriptInput } from "./adapters.js";
import { ModelProvider } from "./contracts.js";
export function compose(model: ModelProvider = new MockModelProvider()) { return { kernel: new HarnessKernel(new MemoryStore(), model), input: new ScriptInput([]), renderer: new RecordingRenderer(), telemetry: new NullTelemetry() }; }
