/**
 * Per-OS input dispatcher. Same shape across platforms; underlying
 * mechanism varies:
 *   macOS  — osascript "tell application System Events" + screencapture
 *   Windows — PowerShell + System.Windows.Forms.SendKeys + .NET Bitmap
 *   Linux  — xdotool + scrot/gnome-screenshot
 *
 * Mac is the most polished today (built-in tools); Win/Linux delegate to
 * commonly-installed system utilities and report clearly when missing.
 */
import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const PLATFORM = process.platform;

// ── App blocklist (Codex-style safety) ─────────────────────────────────────
// Apps where keystroke / click / typing should NEVER fire. Includes:
//   - terminals (could let agent run arbitrary commands)
//   - password managers (don't fish out passwords)
//   - banking / financial apps (don't initiate transfers)
// Override with ANCHOR_INPUT_BLOCKED_APPS=app1,app2,... (replaces defaults).
// Add to defaults via ANCHOR_INPUT_EXTRA_BLOCKED=app3,app4
const DEFAULT_BLOCKED_APPS = new Set([
  "Terminal", "iTerm", "iTerm2", "Warp", "Hyper", "kitty", "Alacritty", "WezTerm",
  "1Password", "1Password 7", "Bitwarden", "LastPass", "Dashlane", "Keeper", "KeePassXC",
  "Banking", "Mint", "Personal Capital",
]);

function blockedApps(): Set<string> {
  if (process.env.ANCHOR_INPUT_BLOCKED_APPS) {
    return new Set(process.env.ANCHOR_INPUT_BLOCKED_APPS.split(",").map(s => s.trim()).filter(Boolean));
  }
  const set = new Set(DEFAULT_BLOCKED_APPS);
  if (process.env.ANCHOR_INPUT_EXTRA_BLOCKED) {
    for (const a of process.env.ANCHOR_INPUT_EXTRA_BLOCKED.split(",").map(s => s.trim()).filter(Boolean)) set.add(a);
  }
  return set;
}

async function getActiveAppName(): Promise<string | null> {
  if (PLATFORM !== "darwin") return null;  // only Mac has reliable cross-app focus check
  const r = safeExec(`osascript -e 'tell application "System Events" to name of first application process whose frontmost is true'`, { timeout: 1500 });
  return r.ok ? r.stdout.trim() : null;
}

function isAppBlocked(appName: string | null): { blocked: boolean; reason?: string } {
  if (!appName) return { blocked: false };
  const list = blockedApps();
  if (list.has(appName)) return { blocked: true, reason: `app '${appName}' is in the blocklist (sensitive: terminal/password/banking)` };
  return { blocked: false };
}

function safeExec(cmd: string, opts: { timeout?: number } = {}): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, { timeout: opts.timeout ?? 5000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (err: any) {
    return { ok: false, stdout: "", stderr: (err?.stderr?.toString() ?? err?.message ?? "").slice(0, 300) };
  }
}

function checkBinary(bin: string): boolean {
  const which = PLATFORM === "win32" ? "where" : "which";
  const r = spawnSync(which, [bin], { encoding: "utf-8" });
  return r.status === 0;
}

// ── Capabilities probe ──────────────────────────────────────────────────────

export interface InputStatus {
  platform: NodeJS.Platform;
  capabilities: { keystroke: boolean; click: boolean; typeText: boolean; screenshot: boolean };
  toolsDetected: Record<string, boolean>;
  blockedApps: string[];
  notes: string[];
}

export function inputStatus(): InputStatus {
  const tools: Record<string, boolean> = {};
  const notes: string[] = [];
  let keystroke = false, click = false, typeText = false, screenshot = false;

  if (PLATFORM === "darwin") {
    tools.osascript = checkBinary("osascript");
    tools.screencapture = checkBinary("screencapture");
    tools.cliclick = checkBinary("cliclick");
    keystroke = tools.osascript;
    typeText = tools.osascript;
    click = tools.osascript || tools.cliclick;
    screenshot = tools.screencapture;
    if (!tools.osascript) notes.push("osascript missing — input via keystroke/click/type unavailable");
    if (tools.osascript) notes.push("Mac may prompt for Accessibility permission on first input call");
    if (!tools.cliclick) notes.push("Optional: `brew install cliclick` for faster + more reliable clicks");
  } else if (PLATFORM === "win32") {
    tools.powershell = checkBinary("powershell") || checkBinary("pwsh");
    keystroke = tools.powershell;
    typeText = tools.powershell;
    screenshot = tools.powershell;
    // Optional nut-js for clicks — probed on first inputClick() call rather
    // than at module load (avoids paying the import cost when never used).
    tools["nut-js"] = false;  // best-effort flag — true value reported per-call
    click = true;             // optimistic; if missing, inputClick errors clearly
    notes.push("Win click uses optional `@nut-tree-fork/nut-js` — install it if not yet (npm i -g)");
    if (!tools.powershell) notes.push("powershell not found — Windows keystroke / type / screenshot unavailable");
  } else if (PLATFORM === "linux") {
    tools.xdotool = checkBinary("xdotool");
    tools.scrot = checkBinary("scrot");
    tools["gnome-screenshot"] = checkBinary("gnome-screenshot");
    tools.maim = checkBinary("maim");
    keystroke = tools.xdotool;
    typeText = tools.xdotool;
    click = tools.xdotool;
    screenshot = tools.scrot || tools["gnome-screenshot"] || tools.maim;
    if (!tools.xdotool) notes.push("xdotool missing — install via `apt install xdotool` or distro equivalent");
    if (!screenshot) notes.push("No screenshot tool found — install `scrot` / `gnome-screenshot` / `maim`");
  } else {
    notes.push(`Unsupported platform: ${PLATFORM}`);
  }

  return { platform: PLATFORM, capabilities: { keystroke, click, typeText, screenshot }, toolsDetected: tools, blockedApps: Array.from(blockedApps()), notes };
}

// ── Keystroke (modifier+key combos like cmd+c, ctrl+t) ─────────────────────

export async function inputKeystroke(combo: string): Promise<{ ok: boolean; error?: string }> {
  // combo format: "cmd+c", "ctrl+shift+t", "esc", "return"
  const blocked = isAppBlocked(await getActiveAppName());
  if (blocked.blocked) return { ok: false, error: `[anchor-input-mcp] BLOCKED: ${blocked.reason}` };
  if (PLATFORM === "darwin") {
    const { keys, mods } = parseMacCombo(combo);
    const using = mods.length ? ` using {${mods.join(", ")}}` : "";
    const script = keys.length === 1
      ? `tell application "System Events" to keystroke "${escapeAS(keys[0])}"${using}`
      : `tell application "System Events" to key code ${macKeyCode(keys[0])}${using}`;
    const r = safeExec(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    return r.ok ? { ok: true } : { ok: false, error: r.stderr };
  }
  if (PLATFORM === "win32") {
    const sendkeys = comboToSendKeys(combo);
    const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendkeys.replace(/'/g, "''")}')`;
    const r = safeExec(`powershell -Command "${script.replace(/"/g, '\\"')}"`);
    return r.ok ? { ok: true } : { ok: false, error: r.stderr };
  }
  if (PLATFORM === "linux") {
    const xdoCombo = combo.replace(/\+/g, "+").replace(/\bcmd\b/g, "super");
    const r = safeExec(`xdotool key ${xdoCombo}`);
    return r.ok ? { ok: true } : { ok: false, error: r.stderr };
  }
  return { ok: false, error: `unsupported platform ${PLATFORM}` };
}

function parseMacCombo(combo: string): { keys: string[]; mods: string[] } {
  const parts = combo.split("+").map(p => p.trim().toLowerCase());
  const modMap: Record<string, string> = {
    cmd: "command down", command: "command down",
    ctrl: "control down", control: "control down",
    alt: "option down", option: "option down",
    shift: "shift down",
  };
  const mods: string[] = [];
  const keys: string[] = [];
  for (const p of parts) {
    if (modMap[p]) mods.push(modMap[p]);
    else keys.push(p);
  }
  return { keys, mods };
}

function macKeyCode(key: string): number {
  // Common keys; agents typically only use these
  const map: Record<string, number> = {
    return: 36, tab: 48, space: 49, esc: 53, escape: 53,
    delete: 51, up: 126, down: 125, left: 123, right: 124,
  };
  return map[key.toLowerCase()] ?? 49; // default space
}

function escapeAS(s: string): string { return s.replace(/"/g, '\\"').replace(/\\/g, "\\\\"); }

function comboToSendKeys(combo: string): string {
  // Windows SendKeys: ^c (ctrl+c), %c (alt+c), +c (shift+c), {ENTER}, etc.
  const parts = combo.split("+").map(p => p.trim().toLowerCase());
  let prefix = "";
  let key = "";
  for (const p of parts) {
    if (p === "ctrl" || p === "control") prefix += "^";
    else if (p === "alt" || p === "option") prefix += "%";
    else if (p === "shift") prefix += "+";
    else if (p === "cmd" || p === "win" || p === "super") prefix += "^";  // treat as ctrl on win
    else if (p === "return" || p === "enter") key = "{ENTER}";
    else if (p === "esc" || p === "escape") key = "{ESC}";
    else if (p === "tab") key = "{TAB}";
    else if (p === "space") key = " ";
    else key = p;
  }
  return prefix + key;
}

// ── Type text (long string) ────────────────────────────────────────────────

export async function inputTypeText(text: string): Promise<{ ok: boolean; error?: string }> {
  if (text.length > 2000) return { ok: false, error: "text too long (max 2000 chars)" };
  const blocked = isAppBlocked(await getActiveAppName());
  if (blocked.blocked) return { ok: false, error: `[anchor-input-mcp] BLOCKED: ${blocked.reason}` };
  if (PLATFORM === "darwin") {
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/'/g, "'\\''");
    const r = safeExec(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`, { timeout: 10000 });
    return r.ok ? { ok: true } : { ok: false, error: r.stderr };
  }
  if (PLATFORM === "win32") {
    // SendKeys treats {} ()[] specially — wrap them
    const escaped = text.replace(/[{}()\[\]+^%~]/g, m => `{${m}}`);
    const r = safeExec(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped.replace(/'/g, "''")}')"`, { timeout: 10000 });
    return r.ok ? { ok: true } : { ok: false, error: r.stderr };
  }
  if (PLATFORM === "linux") {
    const escaped = text.replace(/'/g, "'\\''");
    const r = safeExec(`xdotool type --delay 30 -- '${escaped}'`, { timeout: 10000 });
    return r.ok ? { ok: true } : { ok: false, error: r.stderr };
  }
  return { ok: false, error: `unsupported platform ${PLATFORM}` };
}

// ── Click at coords ─────────────────────────────────────────────────────────

export async function inputClick(x: number, y: number, button: "left" | "right" = "left"): Promise<{ ok: boolean; error?: string }> {
  const blocked = isAppBlocked(await getActiveAppName());
  if (blocked.blocked) return { ok: false, error: `[anchor-input-mcp] BLOCKED: ${blocked.reason}` };
  if (PLATFORM === "darwin") {
    if (checkBinary("cliclick")) {
      const flag = button === "right" ? "rc" : "c";
      const r = safeExec(`cliclick ${flag}:${x},${y}`);
      return r.ok ? { ok: true } : { ok: false, error: r.stderr };
    }
    // Fallback: osascript click — only works inside the focused app window; less reliable
    const r = safeExec(`osascript -e 'tell application "System Events" to click at {${x}, ${y}}'`);
    return r.ok ? { ok: true } : { ok: false, error: r.stderr || "Tip: brew install cliclick for reliable clicks" };
  }
  if (PLATFORM === "linux") {
    const btn = button === "right" ? "3" : "1";
    const r = safeExec(`xdotool mousemove ${x} ${y} click ${btn}`);
    return r.ok ? { ok: true } : { ok: false, error: r.stderr };
  }
  if (PLATFORM === "win32") {
    // Try @nut-tree-fork/nut-js if installed (optional native dep). Falls back
    // to a clear error if user hasn't installed the optional package.
    try {
      // @ts-ignore — optional Win-only dep; not declared in package.json deps
      const nut: any = await import("@nut-tree-fork/nut-js").catch(() => null);
      if (nut?.mouse && nut?.Point && nut?.Button) {
        await nut.mouse.move(nut.straightTo(new nut.Point(x, y)));
        await nut.mouse.click(button === "right" ? nut.Button.RIGHT : nut.Button.LEFT);
        return { ok: true };
      }
    } catch (err: any) {
      return { ok: false, error: `nut-js click failed: ${err?.message ?? err}` };
    }
    return { ok: false, error: "Win click requires `npm i -g @nut-tree-fork/nut-js`. After install, restart anchor-input-mcp." };
  }
  return { ok: false, error: `unsupported platform ${PLATFORM}` };
}

// ── Screenshot ──────────────────────────────────────────────────────────────

export interface ScreenshotResult { ok: boolean; path?: string; error?: string; sizeBytes?: number }

export function inputScreenshot(opts: { region?: { x: number; y: number; w: number; h: number } } = {}): ScreenshotResult {
  const ts = Date.now();
  const tmp = path.join(os.tmpdir(), `anchor-input-${ts}.png`);
  if (PLATFORM === "darwin") {
    const region = opts.region ? `-R${opts.region.x},${opts.region.y},${opts.region.w},${opts.region.h}` : "";
    const r = safeExec(`screencapture -x ${region} "${tmp}"`, { timeout: 5000 });
    if (!r.ok) return { ok: false, error: r.stderr };
    return statResult(tmp);
  }
  if (PLATFORM === "linux") {
    if (checkBinary("scrot")) {
      const r = safeExec(`scrot "${tmp}"`, { timeout: 5000 });
      return r.ok ? statResult(tmp) : { ok: false, error: r.stderr };
    }
    if (checkBinary("gnome-screenshot")) {
      const r = safeExec(`gnome-screenshot -f "${tmp}"`, { timeout: 5000 });
      return r.ok ? statResult(tmp) : { ok: false, error: r.stderr };
    }
    if (checkBinary("maim")) {
      const r = safeExec(`maim "${tmp}"`, { timeout: 5000 });
      return r.ok ? statResult(tmp) : { ok: false, error: r.stderr };
    }
    return { ok: false, error: "No screenshot tool found — install scrot/gnome-screenshot/maim" };
  }
  if (PLATFORM === "win32") {
    const ps = `Add-Type -AssemblyName System.Drawing; $b = [System.Drawing.Bitmap]::new([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width, [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(0,0,0,0,$b.Size); $b.Save('${tmp.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)`;
    const r = safeExec(`powershell -Command "${ps.replace(/"/g, '\\"')}"`, { timeout: 8000 });
    return r.ok ? statResult(tmp) : { ok: false, error: r.stderr };
  }
  return { ok: false, error: `unsupported platform ${PLATFORM}` };
}

function statResult(p: string): ScreenshotResult {
  try {
    const stat = fs.statSync(p);
    return { ok: true, path: p, sizeBytes: stat.size };
  } catch (err: any) {
    return { ok: false, error: `screenshot file missing: ${err.message}` };
  }
}
