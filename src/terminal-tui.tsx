import { useState, useCallback, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { KernelEvent, ApplicationGateway } from "./contracts.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type UserMessage = { kind: "user"; text: string; id: number };
type AssistantMessage = { kind: "assistant"; text: string; id: number };
type ToolMessage = { kind: "tool"; toolId: string; status: "pending" | "running" | "ok" | "error"; error?: string; id: string };
type SystemMessage = { kind: "system"; text: string; id: number };
type ApprovalMessage = { kind: "approval"; toolId: string; input: unknown; pending: boolean; id: string };
type Message = UserMessage | AssistantMessage | ToolMessage | SystemMessage | ApprovalMessage;

// ─── Constants ───────────────────────────────────────────────────────────────

const C = {
  accent: "cyan",
  muted: "gray",
  success: "green",
  info: "blue",
  warning: "yellow",
  danger: "red",
  text: "white",
};

const ICON = {
  user:      "◎",
  assistant: "◈",
  tool:      "◌",
  done:      "✓",
  running:   "↻",
  error:     "✗",
  approval:  "?",
  prompt:    "▸",
};

const TOOL_COLORS: Record<string, string> = {
  filesystem: C.accent,
  execution: C.success,
  git: C.info,
  artifact: C.warning,
  scratchpad: C.text,
  task: C.accent,
  default: C.muted,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toolColor(toolId: string): string {
  const slash = toolId.indexOf("/");
  const prefix = slash >= 0 ? toolId.slice(0, slash) : toolId;
  const color = TOOL_COLORS[prefix as keyof typeof TOOL_COLORS];
  return (color ?? TOOL_COLORS.default) as string;
}

function shortToolId(toolId: string): string {
  const slash = toolId.lastIndexOf("/");
  return slash >= 0 ? toolId.slice(slash + 1) : toolId;
}

function truncate(input: unknown, max = 80): string {
  try {
    const str = JSON.stringify(input, null, 2);
    return str.length <= max ? str : str.slice(0, max) + "…";
  } catch {
    return String(input).slice(0, max);
  }
}

// ─── Components ──────────────────────────────────────────────────────────────

function Header({ model }: { model: string }) {
  return (
    <Box borderStyle="single" borderColor={C.muted} paddingX={1} marginBottom={1}>
      <Box>
        <Text color={C.accent} bold>Porta</Text>
        <Text color={C.muted}> {"·"} {model}</Text>
      </Box>
    </Box>
  );
}

function UserMessageRow({ message }: { message: UserMessage }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={C.accent} bold>{ICON.user} You</Text>
      <Box paddingLeft={2}><Text color={C.text}>{message.text}</Text></Box>
    </Box>
  );
}

function AssistantMessageRow({ message }: { message: AssistantMessage }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={C.success} bold>{ICON.assistant} Porta</Text>
      {message.text ? message.text.split("\n").map((line, i) => (
         <Box key={i} paddingLeft={2}><Text color={C.text} dimColor>{line}</Text></Box>
      )) : null}
    </Box>
  );
}

function ToolMessageRow({ message }: { message: ToolMessage }) {
  const color = toolColor(message.toolId);
  let icon = ICON.tool;
  let statusColor = C.muted;
  if (message.status === "running") { icon = ICON.running; statusColor = C.warning; }
  else if (message.status === "ok") { icon = ICON.done; statusColor = C.success; }
  else if (message.status === "error") { icon = ICON.error; statusColor = C.danger; }

  return (
    <Box paddingLeft={2} marginBottom={0.5}>
      <Text color={statusColor}>{icon} </Text>
      <Text color={color}>{shortToolId(message.toolId)}</Text>
      {message.error && (
        <>
          <Text color={C.muted}> {"·"} </Text>
          <Text color={C.danger}>{message.error}</Text>
        </>
      )}
    </Box>
  );
}

function ApprovalMessageRow({ message }: { message: ApprovalMessage }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.warning} paddingX={1} marginBottom={1}>
      <Text color={C.warning} bold>{ICON.approval} Approval required · {shortToolId(message.toolId)}</Text>
      <Box paddingLeft={2}><Text color={C.text}>{truncate(message.input)}</Text></Box>
      {message.pending && (
        <Box paddingLeft={2}><Text color={C.warning} dimColor>Enter/y approve · any other key deny</Text></Box>
      )}
    </Box>
  );
}

function SystemMessageRow({ message }: { message: SystemMessage }) {
  return (
    <Box marginBottom={1}>
      <Text color={C.muted} dimColor>{message.text}</Text>
    </Box>
  );
}

function MessageRow({ message }: { message: Message }) {
  if (message.kind === "user") return <UserMessageRow message={message} />;
  if (message.kind === "assistant") return <AssistantMessageRow message={message} />;
  if (message.kind === "tool") return <ToolMessageRow message={message} />;
  if (message.kind === "approval") return <ApprovalMessageRow message={message} />;
  return <SystemMessageRow message={message} />;
}

function StatusBar({ steps, maxSteps }: { steps: number; maxSteps: number }) {
  const stepColor = steps >= maxSteps ? C.danger : steps > 0 ? C.success : C.muted;
  return (
    <Box marginBottom={1}>
      <Text color={stepColor} dimColor={steps === 0}>{steps}/{maxSteps} steps</Text>
    </Box>
  );
}

function InputLine({ value, running }: { value: string; running: boolean }) {
  return (
    <Box>
      <Text color={running ? C.warning : C.accent} bold>{running ? ICON.running : ICON.prompt} </Text>
      <Text color={C.text}>{value}</Text>
      {!running && <Text color={C.muted} dimColor>▏</Text>}
    </Box>
  );
}

// ─── Deferred tool queue ─────────────────────────────────────────────────────

interface DeferredTool {
  toolId: string;
  toolCallId: string;
  status: "running" | "ok" | "error";
  error?: string;
}

// ─── Main TUI ────────────────────────────────────────────────────────────────

interface PortaTUIProps {
  gateway: ApplicationGateway;
  sessionId: string;
  model: string;
  maxSteps?: number;
}

export function PortaTUI({ gateway, sessionId, model, maxSteps = 16 }: PortaTUIProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([
    { kind: "system", text: "Type your message and press Enter to start. Ctrl+C to exit.", id: 0 },
  ]);
  const [input, setInput] = useState("");
  const [pendingApproval, setPendingApproval] = useState<ApprovalMessage | null>(null);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState(0);

  // Deferred tool calls — accumulated during streaming, rendered after assistant completes
  const deferredToolsRef = useRef<DeferredTool[]>([]);

  const resetDeferredTools = useCallback(() => {
    deferredToolsRef.current = [];
  }, []);

  const flushTools = useCallback((tools: DeferredTool[]) => {
    const newTools: ToolMessage[] = tools.map(t => ({
      kind: "tool",
      toolId: t.toolId,
      status: t.status,
      error: t.error,
      id: t.toolCallId,
    }));
    deferredToolsRef.current = [];
    setMessages(prev => [...prev, ...newTools]);
  }, []);

  // ─── Event processing ────────────────────────────────────────────────────

  const processEvent = useCallback(async (event: KernelEvent) => {
    switch (event.type) {
      case "ExecutionStarted":
        setSteps(s => s + 1);
        break;

      case "OutputStarted":
        // Start assistant message (empty text — will fill during streaming)
        setMessages(prev => [...prev, { kind: "assistant", text: "", id: Date.now() }]);
        break;

      case "OutputDelta":
        // Accumulate text in the latest assistant message
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.kind === "assistant") {
            return [...prev.slice(0, -1), { ...last, text: last.text + event.text }];
          }
          return [...prev, { kind: "assistant", text: event.text, id: Date.now() }];
        });
        break;

      case "OutputCompleted":
        // Nothing to do — streaming is done, text is complete
        break;

      case "Warning":
        setMessages(prev => [...prev, { kind: "system", text: `Warning: ${event.message}`, id: Date.now() }]);
        break;

      case "ToolRequested":
        // Buffer tool — don't render yet
        deferredToolsRef.current.push({
          toolId: event.toolId,
          toolCallId: event.toolCallId,
          status: "running",
        });
        break;

      case "ToolStarted":
        // Already in deferred queue as running
        break;

      case "ToolCompleted":
        // Update tool status in deferred queue
        const idx = deferredToolsRef.current.findIndex(t => t.toolCallId === event.toolCallId);
        if (idx >= 0) {
          const tool = deferredToolsRef.current[idx];
          if (tool) {
            tool.status = event.result.error ? "error" : "ok";
            tool.error = event.result.error?.message;
          }
        }
        break;

      case "ApprovalRequested":
        setPendingApproval({
          kind: "approval",
          toolId: event.toolId,
          input: event.input,
          pending: true,
          id: event.approvalId,
        });
        break;

      case "ApprovalResolved":
        setPendingApproval(null);
        break;

      case "ExecutionCompleted":
      case "ExecutionCancelled":
        setRunning(false);
        // Flush any remaining deferred tools
        if (deferredToolsRef.current.length > 0) {
           flushTools(deferredToolsRef.current);
        }
        setMessages(prev => [
          ...prev,
          { kind: "system", text: event.type === "ExecutionCompleted" ? "Done." : "Cancelled.", id: Date.now() },
        ]);
        break;

      case "Error":
        setRunning(false);
        if (deferredToolsRef.current.length > 0) {
           flushTools(deferredToolsRef.current);
        }
        setMessages(prev => [
          ...prev,
          { kind: "system", text: `Error: ${event.error.message}`, id: Date.now() },
        ]);
        break;
    }
  }, [flushTools]);

  // ─── Run execution ───────────────────────────────────────────────────────

  const submit = useCallback(async (text: string) => {
    resetDeferredTools();
    setRunning(true);
    // Add user message immediately
    setMessages(prev => [...prev, { kind: "user", text, id: Date.now() }]);
    setInput("");

    try {
      for await (const event of gateway.execute({ type: "SubmitInput", sessionId, input: text }, {})) {
        await processEvent(event);
      }
    } finally {
      setRunning(false);
      // Flush deferred tools at the end
      if (deferredToolsRef.current.length > 0) {
         flushTools(deferredToolsRef.current);
      }
    }
  }, [gateway, sessionId, processEvent, resetDeferredTools, flushTools]);

  // ─── Keyboard ────────────────────────────────────────────────────────────

  useInput((inputChar, key) => {
    // Approval handling
    if (pendingApproval) {
      if (key.ctrl && inputChar === "c") {
        void gateway.execute({ type: "CancelExecution", sessionId }, {});
        exit();
        return true;
      }
      if (key.return || inputChar === "y" || inputChar === "Y") {
        void gateway.execute({ type: "ResolveApproval", approvalId: pendingApproval.id, decision: "approve" }, {});
        setPendingApproval(null);
        return true;
      }
      if (key.escape || inputChar) {
        void gateway.execute({ type: "ResolveApproval", approvalId: pendingApproval.id, decision: "deny" }, {});
        setPendingApproval(null);
        return true;
      }
      return true; // consume all input during approval
    }

    // Exit
    if (key.ctrl && inputChar === "c") {
      void gateway.execute({ type: "CancelExecution", sessionId }, {});
      void gateway.execute({ type: "CloseSession", sessionId }, {});
      exit();
      return true;
    }

    // Block all input while execution is running (except Ctrl+C)
    if (running) return true;

    // Submit on Enter
    if (key.return && input.trim()) {
      void submit(input.trim());
      return true;
    }

    // Buffer input
    if (!key.shift && !key.ctrl && inputChar) {
      setInput(prev => prev + inputChar);
      return true;
    }

    // Backspace
    if (key.backspace && input) {
      setInput(prev => prev.slice(0, -1));
      return true;
    }

    return false;
  });

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" height="100%" width="100%">
      <Header model={model} />
      <StatusBar steps={steps} maxSteps={maxSteps} />
      <Box flexDirection="column" flexGrow={1}>
        {messages.map((msg, i) => (
          <MessageRow key={`${msg.kind}-${msg.id}-${i}`} message={msg} />
        ))}
      </Box>
      <Box borderStyle="single" borderColor={C.muted} marginTop={1} />
      <Box>
        <InputLine value={input} running={running} />
      </Box>
    </Box>
  );
}
