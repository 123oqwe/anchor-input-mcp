# anchor-input-mcp

Cross-platform desktop GUI control as an **MCP server**. Sends keystrokes, types text, clicks at coordinates, takes screenshots. Mac / Win / Linux.

Built as part of the [anchor](https://github.com/123oqwe/anchor-backend) personal-AI ecosystem. Replaces anchor's old macOS-only `macos-vision` bridge with a cross-platform MCP server.

## Tools

| Tool | Description |
|------|------|
| `input_keystroke` | Send key combo (`cmd+c`, `ctrl+t`, `esc`, `return`) |
| `input_type_text` | Type a string of text |
| `input_click` | Click at (x, y) — left or right button |
| `input_screenshot` | Capture screen → returns PNG file path |
| `input_status` | Platform + capability matrix + tools detected |

## Install

```bash
npx -y @anchor/input-mcp
```

## Per-platform

|             | Keystroke | Click  | Type Text | Screenshot |
|-------------|:---------:|:------:|:---------:|:----------:|
| **macOS**   | osascript | osascript / cliclick | osascript | screencapture |
| **Linux**   | xdotool   | xdotool | xdotool  | scrot / gnome-screenshot / maim |
| **Windows** | PowerShell SendKeys | ⚠️ TBD (use Tab nav) | PowerShell SendKeys | PowerShell + .NET Bitmap |

### macOS notes

- All actions use built-in `osascript` + `screencapture` (no install).
- First call may pop System Settings → Privacy → Accessibility. Allow this binary (or whichever process runs `npx`).
- Optional: `brew install cliclick` for faster + more reliable clicks.

### Linux notes

- Install requirements: `sudo apt install xdotool scrot` (Debian/Ubuntu).
- X11 only. Wayland support is best-effort.

### Windows notes

- v0.1: keystroke / type / screenshot work via PowerShell.
- Click-at-coords requires `nut-js` native binding — **planned for v0.2**.
  Workaround: use `input_keystroke` ('tab', 'return', 'space') for nav.
- PR welcome to add nut-js dispatcher under `src/input-win.ts`.

## Roadmap

| version | scope |
|---------|------|
| 0.1 (current) | Mac full · Linux full · Win partial (no click) |
| 0.2 | + Win click via nut-js |
| 0.3 | + screenshot region by element ID (works with anchor-screen-mcp's "find element" output) |

## Use with anchor-backend

```bash
curl -X POST http://localhost:3001/api/mcp/servers -H "Content-Type: application/json" -d '{
  "name": "anchor-input",
  "command": "npx",
  "args": ["-y", "@anchor/input-mcp"]
}'
```

5 tools auto-register as `mcp_anchor_input_*`. Custom Agent + Decision Agent can drive native UIs.

## Use with Claude Desktop

```json
{
  "mcpServers": {
    "anchor-input": {
      "command": "npx",
      "args": ["-y", "@anchor/input-mcp"]
    }
  }
}
```

## Privacy / safety

- No network calls.
- Screenshots saved to `tmpdir()` only — caller responsible for cleanup.
- Caller responsible for sandboxing input — this MCP server **will** click and type whatever you tell it to.
- macOS Accessibility permission is granted/revoked by user via System Settings.

## License

MIT
