#!/usr/bin/env node
/**
 * anchor-input-mcp — cross-platform desktop GUI control as MCP server.
 *
 * Speaks MCP 2025-06-18 over stdio. Per-OS underlying:
 *   macOS  — osascript + screencapture (built-in, no install)
 *   Linux  — xdotool + scrot/gnome-screenshot/maim (apt install ...)
 *   Win    — PowerShell SendKeys + .NET Bitmap (built-in; click-at-coords TBD)
 *
 * Tools:
 *   input_keystroke  — send key combo (cmd+c, ctrl+t, esc, return, etc)
 *   input_type_text  — type a string of text
 *   input_click      — click at (x, y)
 *   input_screenshot — capture full screen or region → returns file path
 *   input_status     — platform + capability matrix + tools detected
 *
 * IMPORTANT: macOS requires Accessibility permission for keystroke/click.
 * First call may pop a system prompt. Permanent until user revokes.
 */
import { inputKeystroke, inputTypeText, inputClick, inputScreenshot, inputStatus } from "./input.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "anchor-input-mcp", version: "0.1.0" };

interface JsonRpcRequest { jsonrpc: "2.0"; id?: number | string; method: string; params?: any }
interface JsonRpcResponse { jsonrpc: "2.0"; id: number | string; result?: any; error?: { code: number; message: string } }

const TOOLS = [
  {
    name: "input_keystroke",
    description: "Send a keyboard combination. Format: 'cmd+c', 'ctrl+shift+t', 'esc', 'return'. Modifiers: cmd/ctrl/alt/shift.",
    inputSchema: {
      type: "object",
      properties: { combo: { type: "string", description: "e.g. 'cmd+c' or 'esc'" } },
      required: ["combo"],
    },
  },
  {
    name: "input_type_text",
    description: "Type a string of text into the focused field (max 2000 chars).",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "input_click",
    description: "Click at screen coordinates (x, y). Coordinates from top-left.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right"], description: "default left" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "input_screenshot",
    description: "Take a screenshot. Returns a temp file path (PNG). Optional region {x, y, w, h}.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "object",
          properties: {
            x: { type: "number" }, y: { type: "number" },
            w: { type: "number" }, h: { type: "number" },
          },
        },
      },
    },
  },
  {
    name: "input_status",
    description: "Platform + capability matrix (which actions are available) + tools detected (osascript / cliclick / xdotool / scrot / etc).",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callTool(name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case "input_keystroke": {
      if (!args.combo) throw new Error("combo required");
      const r = inputKeystroke(String(args.combo));
      return JSON.stringify(r, null, 2);
    }
    case "input_type_text": {
      if (typeof args.text !== "string") throw new Error("text required");
      const r = inputTypeText(args.text);
      return JSON.stringify(r, null, 2);
    }
    case "input_click": {
      const x = Number(args.x), y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x, y required (numbers)");
      const button = args.button === "right" ? "right" : "left";
      const r = await inputClick(x, y, button);
      return JSON.stringify(r, null, 2);
    }
    case "input_screenshot": {
      const r = inputScreenshot({ region: args.region });
      return JSON.stringify(r, null, 2);
    }
    case "input_status":
      return JSON.stringify(inputStatus(), null, 2);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? 0;
  if (req.method === "initialize") {
    return { jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
  }
  if (req.method === "notifications/initialized") return null;
  if (req.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (req.method === "tools/call") {
    const { name, arguments: args } = req.params ?? {};
    try {
      const text = await callTool(name, args ?? {});
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
    } catch (err: any) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }], isError: true } };
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } };
}

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", async chunk => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const req: JsonRpcRequest = JSON.parse(line);
      const res = await handleRequest(req);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    } catch (err: any) {
      process.stderr.write(`[parse-error] ${err?.message ?? err}\n`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

process.stderr.write(`[anchor-input-mcp] ready on stdio (platform=${process.platform})\n`);
