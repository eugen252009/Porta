export interface ApplicationEvent { readonly type: string; readonly nodeId: string; readonly sessionId?: string; readonly taskId?: string; readonly version?: number; readonly at: string }
export class ApplicationEventHub {
  private readonly listeners = new Set<(event: ApplicationEvent) => void>();
  publish(event: Omit<ApplicationEvent, "at">): void { const complete = { ...event, at: new Date().toISOString() }; for (const listener of this.listeners) listener(complete); }
  subscribe(listener: (event: ApplicationEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
