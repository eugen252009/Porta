import type { ReactNode } from "react";
import { ApplicationGateway, HarnessFailure, KernelEvent } from "./contracts.js";
import { PortaConfig } from "./porta-config.js";
import { PortaTUI } from "./terminal-tui.js";

export interface TuiApplication {
  gateway: ApplicationGateway;
}

export interface InkInstance {
  waitUntilExit(): Promise<unknown>;
}

export type InkRender = (element: ReactNode) => InkInstance;

export async function createTuiSession(gateway: ApplicationGateway, requestedSessionId?: string): Promise<string> {
  const events: KernelEvent[] = [];
  for await (const event of gateway.execute({ type: "CreateSession", ...(requestedSessionId ? { sessionId: requestedSessionId } : {}) }, {})) {
    events.push(event);
  }
  const session = events.find((event): event is Extract<KernelEvent, { type: "SessionCreated" }> => event.type === "SessionCreated");
  if (session) return session.sessionId;
  const error = events.find((event): event is Extract<KernelEvent, { type: "Error" }> => event.type === "Error");
  if (error) throw new HarnessFailure(error.error);
  throw new Error("Could not create session.");
}

export async function runTui(
  application: TuiApplication,
  config: PortaConfig,
  render: InkRender,
  requestedSessionId?: string,
): Promise<string> {
  const sessionId = await createTuiSession(application.gateway, requestedSessionId);
  const instance = render(
    <PortaTUI
      gateway={application.gateway}
      sessionId={sessionId}
      model={config.model.model}
      maxSteps={config.agent.maxSteps ?? 16}
    />,
  );
  await instance.waitUntilExit();
  return sessionId;
}
