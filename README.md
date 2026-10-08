# rbxSWAP

A desktop launcher for running multiple Roblox accounts side by side on Windows. It handles the boring parts of multi-accounting for you - per-account launches with their own instance, executor integration, RAM/FPS/volume control per instance, and an idle-keeper so background accounts don't get kicked after 20 minutes.

Everything is stored locally. Account cookies are encrypted with a key that stays on your machine.

## Features

- **Accounts** - add accounts via Roblox login, launch any of them into Roblox (or straight into a specific game), see live presence, kill instances individually or in bulk.
- **Groups** - bundle accounts and launch a whole group with one click.
- **Mixer** - force a graphics level, FPS cap, per-instance RAM limit, and OS volume for every running client.
- **Executers** - manages your executors, tracks which Roblox version each one supports (via WEAO) and installs that exact build for you before launching.
- **RDD** - browse and download any Roblox deployment version straight from the CDN, keep several installed side by side, clean out old ones.
- **Swap (Windows admin)** - clean Roblox traces and spoof MAC/machine IDs between account switches.
- **Anti-AFK** - a small native helper taps each Roblox window before the 20-minute idle kick, background windows included, and restores your focus afterwards.
- **Auto-rejoin** - if an account gets kicked or disconnects, it relaunches into the game it was playing.
- **Themes** - presets, accent color, brightness, corner radius, interface scale, reduce-motion.

## Requirements

- **Windows 10 or 11** (x64). The multi-instance, Anti-AFK, Swap and RAM-limit features are Windows-only because they rely on a small C# native helper.
- **Node.js 18+** and **npm**.
- **.NET SDK** - needed to compile `RobloxNative.cs` during the build. If you have `csc` available through another .NET Framework install, that works too; the build script finds whatever is on PATH.
- For the Windows installer specifically, electron-builder pulls in what it needs on first run.

## Building

Clone the repo, install dependencies, then run one command:

```bash
git clone https://github.com/empfi/rbxswap.git
cd rbxswap
npm install
npm run build
```

That does three things:

1. `prebuild` compiles the native helper (`scripts/build-native.js` → `src/RobloxNative.exe`) using the C# compiler found on your system.
2. electron-builder rebuilds native dependencies and packages the app for Windows x64.
3. Two artifacts land in `dist/`:
   - `rbxSWAP.exe` - portable, single file, no installer.
   - `rbxSWAP-Setup-1.0.0.exe` - NSIS installer with desktop and start menu shortcuts.

### Other scripts

| Command | What it does |
| --- | --- |
| `npm start` | Run the app unpackaged from source (normal dev loop). |
| `npm run build:fast` | Build to `dist/win-unpacked/` only - skips the portable/installer targets. Faster iteration. |
| `npm run clean:dist` | Wipe the `dist/` folder. |

### Working on the native helper

`src/RobloxNative.cs` is a single-file C# program (mutex handling, volume control, RAM job objects, anti-AFK). Edit it, then rebuild with:

```bash
node scripts/build-native.js
```

The Electron app looks for the compiled exe next to the sources in dev, and in `resources/` when packaged.

## Notes

- The app encrypts your account data on disk. Losing your encryption key means losing the stored sessions - there is no recovery.
- Executor/Roblox version matching is powered by the WEAO API; it needs internet access on launch.
- This is a personal tool, not affiliated with Roblox. Use it at your own discretion.
