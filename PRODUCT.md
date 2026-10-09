# rbxSWAP — Product & Feature Documentation

> A Windows desktop launcher for running **many Roblox accounts side by side**, each in its own
> isolated instance, with per-instance performance control, version management, executor
> integration and between-session machine-identity tooling.

This document describes the product as it exists in the source tree (`src/`), how it is built, how
each screen works, and how the moving parts fit together.

---

## Table of contents

1. [What rbxSWAP is](#1-what-rbxswap-is)
2. [Who it's for, and the honest caveats](#2-who-its-for-and-the-honest-caveats)
3. [Tech stack & architecture](#3-tech-stack--architecture)
4. [Build & run](#4-build--run)
5. [Repository layout](#5-repository-layout)
6. [First run: the encryption key](#6-first-run-the-encryption-key)
7. [The window: navigation & global UI](#7-the-window-navigation--global-ui)
8. [Accounts](#8-accounts)
9. [Adding & maintaining accounts](#9-adding--maintaining-accounts)
10. [Account menus & modals](#10-account-menus--modals)
11. [BloxGen account generator](#11-bloxgen-account-generator)
12. [Groups](#12-groups)
13. [Games (charts browser)](#13-games-charts-browser)
14. [Game picker & launch targets](#14-game-picker--launch-targets)
15. [Mixer (graphics, FPS, RAM, volume)](#15-mixer-graphics-fps-ram-volume)
16. [Executer (executor management)](#16-executer-executor-management)
17. [RDD (Roblox Deployment Downloader)](#17-rdd-roblox-deployment-downloader)
18. [Swap (identity spoofing & trace cleaning)](#18-swap-identity-spoofing--trace-cleaning)
19. [Multi-instance, Anti-AFK & protocol handler](#19-multi-instance-anti-afk--protocol-handler)
20. [Auto-rejoin, presence & cookie health](#20-auto-rejoin-presence--cookie-health)
21. [Settings](#21-settings)
22. [Themes & appearance](#22-themes--appearance)
23. [Onboarding tutorial](#23-onboarding-tutorial)
24. [Tray, notifications & logging](#24-tray-notifications--logging)
25. [Security & encryption model](#25-security--encryption-model)
26. [Data & file locations](#26-data--file-locations)
27. [The native helper (RobloxNative.cs)](#27-the-native-helper-robloxnativecs)
28. [Platform support & limitations](#28-platform-support--limitations)
29. [Launch pipeline, step by step](#29-launch-pipeline-step-by-step)
30. [Troubleshooting](#30-troubleshooting)
31. [Glossary](#31-glossary)

---

## 1. What rbxSWAP is

rbxSWAP is an Electron desktop application that turns the tedious parts of multi-accounting on
Roblox into one-click operations. It stores your accounts locally, launches any account (or a
whole group of them) into Roblox, keeps track of which Roblox **client version** each executor
needs, downloads and retains that exact build, and optionally tweaks the machine's network and
hardware identifiers between account switches.

The product's own one-line pitch (from `README.md`):

> A desktop launcher for running multiple Roblox accounts side by side on Windows. It handles the
> boring parts of multi-accounting for you — per-account launches with their own instance, executor
> integration, RAM/FPS/volume control per instance, and an idle-keeper so background accounts don't
> get kicked after 20 minutes.

### The nine headline capabilities

| Feature | One-line summary |
| --- | --- |
| **Accounts** | Sign in with Roblox or paste a cookie; launch, monitor presence, kill instances, bulk-select. |
| **Groups** | Bundle accounts and launch the whole set with one click, with group-wide performance presets. |
| **Mixer** | Force graphics level, FPS cap, per-instance RAM limit and OS volume for running clients. |
| **Executers** | Manage your executors; track which Roblox version each one supports via WEAO and install it. |
| **RDD** | Browse and download any Roblox deployment straight from the CDN, keep several side by side. |
| **Swap** | Clean Roblox traces and spoof MAC / machine GUIDs / volume serial between swaps. |
| **Anti-AFK** | A native helper taps each Roblox window before the 20-minute idle kick, background windows included. |
| **Auto-rejoin** | If a launched account is kicked or disconnects, relaunch it into the game it was playing. |
| **Themes** | Presets, accent colour, brightness, corner radius, interface scale, reduce-motion. |

---

## 2. Who it's for, and the honest caveats

**Intended user:** someone who already runs several Roblox accounts and wants a control panel for
launching, watching and tidying them — a personal power-user tool, not a consumer product.

**Caveats you should know before using it:**

- It is a **personal tool, not affiliated with Roblox** (stated in `README.md`). Multi-instancing,
  macro/idle-keeper helpers, machine-identifier spoofing and third-party executors can each violate
  the Roblox Terms of Use. Using it is at your own discretion and can result in account action.
- **Losing the encryption key means losing the stored sessions.** There is no recovery path.
- **Windows 10/11 x64 is the real target.** The multi-instance, Anti-AFK, Swap and RAM-limit
  features depend on a C# helper and Windows APIs; the macOS build hides them.
- The app talks to Roblox's own endpoints and to the third-party **WEAO** API (`weao.xyz`) for
  version/executor data, so it needs internet access for those flows.

---

## 3. Tech stack & architecture

| Layer | Technology |
| --- | --- |
| Shell | **Electron 43** |
| Main process | Node.js (`src/main.js`, ~4,460 lines) — all OS, network and filesystem work |
| Renderer | Plain **HTML/CSS/JS** (`src/index.html`, `src/renderer.js`, `src/styles.css`) — no framework, no bundler |
| Bridge | `src/preload.js` — a `contextBridge` API surface (`window.api`) over IPC |
| Native helper | **C#** single-file program (`src/RobloxNative.cs`) compiled with `csc.exe` |
| Login automation | `puppeteer-core` + `@puppeteer/browsers` (downloads a managed Chrome for login) |
| ZIP handling | `jszip` (renderer) and PowerShell/Node extraction (main) |
| Packaging | `electron-builder` → portable `.exe` + NSIS installer |

**Process split.** The renderer never touches the disk or the network directly. Every privileged
operation is an `ipcMain.handle(...)` in `main.js`, exposed through `preload.js`. That keeps the
Electron window sandboxed and makes the entire capability list enumerable from `preload.js` — which
is a genuinely good, auditable design for a tool that manages credentials.

**Two renderer files exist, and only one is live.** `src/index.html` loads `renderer.js` from the
same `src/` directory. The `renderer.js` copy sitting in the repository root is a stale duplicate
that is **not loaded**; edits made there have no effect.

---

## 4. Build & run

Requirements: **Node.js 18+**, npm, and a .NET Framework compiler (`csc.exe`) for the native
helper. Full details live in [`README.md`](README.md).

```bash
npm install          # install dependencies
npm start            # run unpackaged from source (dev loop)
npm run build        # full Windows x64 build -> dist/
npm run build:fast   # dist/win-unpacked only (no portable/installer targets)
npm run clean:dist   # wipe dist/
```

`npm run build` runs a `prebuild` step (`scripts/build-native.js`) that compiles
`src/RobloxNative.cs` into `src/RobloxNative.exe` using whatever `csc.exe` it finds. That step
**never hard-fails**: on a non-Windows host or a machine without `csc`, it warns and exits `0`, and
the app compiles the helper on first run as a fallback.

Two artifacts land in `dist/`:

- `rbxSWAP.exe` — portable, single file, no installer.
- `rbxSWAP-Setup-1.0.0.exe` — NSIS installer with desktop and Start Menu shortcuts.

CI: [`.github/workflows/build-release.yml`](.github/workflows/build-release.yml) builds on
`windows-latest` for every push to `master`, generates a changelog from `git log <previous-tag>..HEAD`,
and publishes a GitHub Release (`v<run_number>`) containing `release/*` (the exe and blockmap).

---

## 5. Repository layout

```
rbxSWAP/
├─ package.json               # Electron + electron-builder config, scripts, deps
├─ README.md                  # short intro, features, build steps
├─ PRODUCT.md                 # ← this document
├─ build.bat
├─ scripts/
│  ├─ build-native.js         # compiles RobloxNative.cs -> RobloxNative.exe (prebuild)
│  └─ clean-dist.js
└─ src/
   ├─ main.js                 # main process: IPC, crypto, Roblox APIs, process control
   ├─ preload.js              # window.api bridge (the full IPC surface)
   ├─ index.html              # the UI markup (pages + modals)
   ├─ renderer.js             # UI logic (~5,600 lines)
   ├─ styles.css              # theming via CSS variables
   ├─ hwid.js                 # machine-identifier read/spoof/restore + trace purge
   ├─ RobloxNative.cs         # C# helper: mutex, volume, RAM job objects, anti-AFK
   ├─ RobloxNative.exe        # compiled helper (packaged via prebuild)
   ├─ jszip.min.js            # vendored ZIP reader (renderer)
   ├─ icon.ico, roblox_icon.png
   └─ accounts.json           # (dev placeholder; real data lives in userData)
```

---

## 6. First run: the encryption key

On first launch the app shows a blocking **encryption modal** (`#m-enc`) before anything else loads.

- It asks you to **set an encryption key**. This key (scrypt / pbkdf2-derived, AES-256-GCM) protects
  the account file on disk.
- A **`keySet`** flag is persisted; on later launches the same modal asks you to *enter* the key to
  unlock.
- There is a **"skip"** path (`skipEnc()`), which lets you run without a key — but the practical
  consequence is that stored sessions can't be decrypted, so the modal is the normal path.
- The key can be changed later under **Settings → Encryption Key**. Changing it requires re-entering
  it on the next launch.
- An optional **`.keysession`** file (written to userData) can keep the key valid for a bounded
  window (30 days) plus a boot-ID check, so you aren't asked every single start.

**Important:** this is local-at-rest protection only. The key is not escrowed anywhere. Lose it and
the encrypted account data is unrecoverable.

---

## 7. The window: navigation & global UI

The left sidebar groups the app into four clusters:

| Group | Pages |
| --- | --- |
| **Manage** | Accounts · Groups · Mixer |
| **Roblox** | Games · RDD |
| **Advanced** (Windows only) | Swap |
| **App** | Executer · Settings |

The sidebar footer also carries the global **Anti-AFK** toggle (`#sb-antiafk`), which starts/stops the
native idle-keeper for every running client.

**Window chrome** — custom, frameless window controls wired through the preload API
(`window-minimize`, `window-maximize`, `window-close`).

**Accounts header controls** — search, a filter dropdown (All / Running / Not running / Valid first /
Invalid first), the **Boot executor** toggle (a compact lightning bolt button that arms the
"start my executor with the next launch" behaviour), and a grid/list view switch. Both the filter and
the view are remembered in `localStorage` across restarts.

**Toast notifications** (`#toast`) report the outcome of actions — copies, password changes, install
progress, launch failures — and the **topbar download strip** (`tbDlShow`) shows progress for long
operations like a version download without hijacking the screen.

`#page-logs` is referenced by the renderer's log code but **no log page exists in the current
markup**, so the in-app log view is not reachable from the sidebar today; log entries are still
collected internally and the same messages surface as toasts and in the console.

---

## 8. Accounts

The Accounts page is the home screen. It has two sub-tabs:

- **My Accounts** — the card grid/list.
- **Bloxgen** — the account generator (section 11).

### Cards

Each account renders as a card (grid view) or row (list view) showing:

- avatar and display name / alias / username;
- a **presence dot** and badge — `ingame`, `menu`, `online`, `studio`, or offline — from Roblox's
  presence API, polled on a 15-second cadence;
- a **cookie status** indicator (valid / invalid / refreshing);
- **RAM usage vs cap** once a RAM limit is active;
- **launch-state** highlighting for instances this session started.

Cards are **drag-and-drop reorderable** (`initDrag` / `onDragEnd`), and the new order is persisted.

### Search, filter and views

- Free-text search over the visible account set.
- Filter menu: **All accounts · Running · Not running · Valid first · Invalid first**.
- Grid ⇄ list toggle.

### Selection and bulk actions

Clicking selects; Shift-click extends a range; Ctrl/Cmd-click adds. When anything is selected a
**bulk action bar** appears with:

- **Launch** — launch every selected account;
- **Stop** — kill every selected instance;
- **Move to group** — assign the selection to a group;
- **Remove** — delete the selected accounts (with confirmation).

### Per-account live indicators

- **Temp sessions** — Roblox processes the app didn't launch itself are listed as temporary
  sessions, with their own cards and avatars, so a manually-opened client isn't invisible. They can
  be killed (`killTemp`) or promoted into tracked sessions (`addTempSession`).
- **Game label** — once an account is in a game, the card shows the game's name, resolved and
  cached (`mr-gamenames` in `localStorage`).

---

## 9. Adding & maintaining accounts

### Add Account modal

Two sign-in paths:

1. **Sign in with Roblox (browser login).**
   The app downloads a managed **Chrome for Testing** build via `@puppeteer/browsers` (progress shown
   in the modal, "first time only"), opens the real Roblox login page, and waits for you to sign in.
   The `.ROBLOSECURITY` cookie is captured automatically and the account is added. This is handled by
   `puppeteerLogin` / `openLogin` in the main process.
2. **Paste Cookie.**
   Paste a `.ROBLOSECURITY` value directly (the modal shows where to find it: F12 → Application →
   Cookies → roblox.com). The cookie is validated against `users.roblox.com` before being stored.

Either way the app fetches the profile (`fetchUserInfo`), records username, user ID, avatar and an
"added" timestamp.

### Cookie maintenance

- **Health checks** run across all accounts (`checkCookieHealth`, `recheckAllCookies`) and paint the
  per-card cookie badge.
- **Automatic refresh from the cookie store** — if a cookie looks dead, the app can re-read a fresh
  one from a local Roblox cookie store (`refreshCookieFromStore`), which is far less disruptive than
  a manual re-login.
- **Manual refresh** is available per account in the edit and info modals. When Roblox requires a
  captcha or 2-step code the app says so explicitly rather than failing silently.
- **Headless re-login** (`reloginHeadless`) can recover a session from a **saved login password**,
  with an in-memory rate limit (20-minute block per username) to avoid hammering the endpoint.

### Editing an account

The **Account settings** modal is split into three cards:

- **Identity** — username, user ID (read-only) and the editable **alias**. The alias is display-only
  and never changes the Roblox username.
- **Login credentials** — the **saved login password** used for automatic cookie recovery, with
  show/hide. The hint is explicit that this does not change the Roblox password.
- **Session & security** — cookie status plus three actions: **Refresh cookie & profile**,
  **Change Roblox password**, and **Open in browser**.

---

## 10. Account menus & modals

### Right-click context menu

Right-clicking a card opens a context menu (`showCardMenu`). Its contents adapt to whether the
account is live:

| Item | Shown when | Action |
| --- | --- | --- |
| **Account info** | always | opens the Account Info modal |
| **Kill instance** | account is live | kills that instance |
| **Launch** | account is **not** live | opens the launch modal |
| **Launch Game** | always | opens the game picker for that account |
| **Edit account** | always | opens Account settings |
| **Copy user ID** | always | copies the ID |
| **Copy username** | always | copies the username |

Note there is deliberately **no "Relaunch"** entry — launching a live account is not offered from the
menu. (Streamer Mode blurs the menu header, hover to reveal.)

### Account Info modal

A richer read-only view plus quick actions: avatar, display name, username, user ID, Robux balance,
added date, alias (click to edit inline), and the saved password (revealed only when one exists).
Action buttons:

- **Copy cookie** (`aiCopyCookie`)
- **Refresh cookie & profile** (`aiRefreshProfile`)
- **Change password (random)** (`aiChangePassword`) — generates a strong password, applies it, and
  shows a one-time reveal modal.
- **Open in browser** (`aiOpenBrowser`) — opens Roblox with the account's session.

### Password tooling

Password changes are a small subsystem of their own:

- `genSecurePassword` / `genNewRandomPw` build a strong random password.
- `applyPasswordChange` posts the change, and on success either keeps the (renewed) cookie or, if
  Roblox invalidated the session, kicks off a **background cookie refresh** and tells you what to do
  if a captcha or 2-step code is needed.
- A **one-time reveal modal** (`#m-pw-reveal`) shows the new password exactly once, with a prominent
  Copy & Close.

---

## 11. BloxGen account generator

Under **Accounts → Bloxgen** the app can generate a new Roblox account through a BloxGen API:

- Requires a **BloxGen API key**, set either on this tab or in **Settings → BloxGen Integration**
  (stored in settings; the input is a password field).
- **Generate Account** calls `bloxgen:generateAccount`, and the result is added to your accounts.
- Because generated accounts come with a known password, the app immediately offers the **automatic
  password change** flow (regenerate a new password, apply it, then reveal it once).
- A **Recently Generated** list keeps the last five generations for reference.

---

## 12. Groups

"Groups" (internally *packages*) are named sets of accounts that launch together.

- **New group** opens a modal where you name the group and tick the accounts to include (with a live
  `n selected` count).
- Groups can carry their **own performance preset**: **FPS cap**, **graphics level**, **RAM limit**
  and **start volume**. These apply to the accounts launched through that group.
- Each group card supports **launch the whole set** (`launchPackage`), edit and delete.
- Group cards show a **live status** summarizing how many member accounts are currently running,
  and can display a game icon resolved from a place ID (`setPackageLink`, `loadPackageIcon`).

Groups are the answer to "these twelve alts always play together" — one click, with a sane
performance budget so a dozen clients don't melt the machine.

---

## 13. Games (charts browser)

The **Games** page is a Roblox discovery surface:

- Two tabs: **Top Playing Now** and **Top Rated** (`switchChartTab`, `fetchRobloxGames`).
- A search box filters what's loaded, and a second mode searches Roblox's game search API directly
  (`searchRobloxGames`).
- A **recently searched games** strip (`renderRecentGames`) keeps your recent targets a click away.
- Clicking a game opens a **game modal** with thumbnail, live player count/stat line, and its
  **Place ID** with a copy button, plus a **Game Page** button that opens the Roblox page externally.

Resolving a place ID to a name/icon works from either a numeric ID or a URL, and names are cached so
the grid doesn't re-hit the API.

---

## 14. Game picker & launch targets

### Game picker

**Launch Game** (from a card's context menu) opens the game picker (`openGamePicker`):

- Search by **game name** or paste a **Place ID**.
- Up to two **favorites** (`gpFavToggle`) for your usual destinations.
- The selection is remembered and **shared by every account** (`_cachedLaunchGame`, persisted in
  `localStorage`) until you change it, with a compact "cached pick" bar at the top of the modal.
- If the pick requires a Roblox version you don't have installed, an outdated/missing-version notice
  appears right in the picker (`renderGamePickerOutdatedNotice`).

### What a launch target can be

The launch pipeline accepts surprisingly many forms and normalizes them all into a Roblox launcher
URL:

| Input | Handling |
| --- | --- |
| Numeric Place ID | direct `PlaceLauncher` request |
| Game URL (`roblox.com/games/...`) | Place ID extracted from the path |
| **Private server link** (`privateServerLinkCode=`) | access code resolved against Roblox, then `RequestPrivateGame` |
| **Share link** (`/share` or ro.blox.com short link) | resolved through `sharelinks/v1/resolve` → `RequestGameJob` |
| Bare hostnames | normalized to `https://` and parsed |

---

## 15. Mixer (graphics, FPS, RAM, volume)

The Mixer is a single panel of sliders, each with an **Auto/Unlimited** escape hatch, applied to every
running client and re-applied to new launches.

| Control | Range | Mechanism |
| --- | --- | --- |
| **Graphics Quality** | 1–21, or Auto | forces a fixed Roblox render-quality level |
| **FPS Cap** | 5–360, or Unlimited | writes to Roblox's `GlobalBasicSettings_13.xml`; supports caps *below* 30 |
| **RAM Limit** | 256–8192 MB, or Unlimited | a **hard per-instance working-set cap** via a Windows job object — the rest pages out, so the client keeps running (slower at very low caps) |
| **Master Volume** | 0–100%, with mute | adjusts the OS audio level of every running Roblox window instantly (Windows audio session API through the helper) |

- **Save Mixer Settings** persists the choices.
- The RAM cap is **enforced per account** (`applyRamLimit`, `enforceRamLimitForAccount`), and the
  account card shows **usage / cap**, with a tooltip explaining the state (`ramStatText`,
  `ramStatTitle`).
- Group-level presets (section 12) override the launch-time values for their accounts, and
  `collectLaunchOptions()` resolves which of Mixer, group or "Unlimited" wins for a given launch.

---

## 16. Executer (executor management)

The **Executer** page manages third-party executors and keeps them matched to the Roblox version
they support.

### Your Executors

- Queries **WEAO** (`weao.xyz`) for the known executor list and each one's supported version
  (`weaoExploits`, `weaoVersions`).
- Each entry can be shown or hidden, tracked, and marked as the **default**.
- A **Refresh** button re-pulls the list.

### Default Executor & Exclusions

- **Default Executor** — a dropdown picking which executor is used for account launches. It appears
  as a green badge in the executor list. (Kept in `localStorage` and mirrored into the main-process
  settings — the launch path reads the main-process copy.)
- **Executor Program** — the path to that executor's `.exe`, with a **Browse…** button
  (`executor:pick`). This program is what the Accounts page's **Boot executor** toggle starts with
  your launches.
- **Managed Exploits & Exclusions** — a checklist; unchecking an exploit hides it from the executor
  list *and* from the launch filter, so the launch flow only offers what you actually use.
- **Select All / Select None** bulk-toggle the whole list.

### Boot executor with accounts

The accounts header has a compact **Boot executor** toggle (`bootExecutorWithAccount`). When armed, a
launch will start your configured executor program if it isn't already running — with careful
guards:

- it checks the configured **default executor name** and its **path** and warns specifically if
  either is missing;
- it verifies the file still exists (`fs.existsSync`) and says "the program set for X is not there
  anymore" instead of failing silently;
- it checks whether the process is already running by image name and skips booting it again;
- it debounces concurrent boots with a single in-flight promise.

### Version matching

Executors only work against specific Roblox builds, so launches are version-aware:

- `getExecutorVersionHash` / `ensureProtocolVersionUpToDate` resolve the version the selected
  executor needs.
- If that build isn't installed, the launch modal offers **Install Working** — it fetches the exact
  deployment via RDD and installs it before launching.
- An **outdated version** notice (`notifyOutdatedVersionBeforeLaunch`) warns you when the installed
  build is behind what the executor expects.
- The launch modal has an **Exploit / Version Filter** dropdown (defaulting to *All Exploits &
  Official*) plus an **Installed Versions** list, so you can pick exactly which build to launch into.

---

## 17. RDD (Roblox Deployment Downloader)

RDD is a Roblox version browser and installer built on Roblox's public deployment CDN.

### Roblox Versions (WEAO)

A live list of **current, future and past** Roblox versions pulled from WEAO, with a Refresh button —
so you can see what's shipping without launching anything.

### Installed Versions

- Lists every version the app has installed under its own `Versions` folder in userData.
- Shows **disk usage** for the set (`getVersionsDiskUsage`) and a per-version entry with actions:
  **open the folder** and **remove** it.
- Search filters the list.
- **Clean old versions** (`cleanOldVersions`) removes outdated rbxSWAP-installed builds while
  deliberately keeping the version your executor needs and Roblox's own installs.

### Download

The Deployment panel takes:

- **Channel** — e.g. `LIVE` (production), or another deployment channel;
- **Binary type** — `WindowsPlayer`, `WindowsStudio64`, `MacPlayer`, `MacStudio`;
- **Architecture**;
- **Version hash** — blank means "the channel's current version", or paste a specific
  `version-…` hash.

**Download** (`rdd:getVersion`) resolves the manifest from Roblox's CDN (it tries
`setup.rbxcdn.com`, `setup-aws.rbxcdn.com`, `setup-ak.rbxcdn.com` and their `channel/common` and
`channel/zlive` variants), fetches `RobloxApp.zip`, verifies the manifest is a Windows player
deployment, and extracts it into the app's version store. Progress is streamed to the renderer via
`rdd:download-progress` and shown on the topbar strip.

Keeping several builds side by side is the point: different executors need different builds, and
rbxSWAP can install and retain each one.

---

## 18. Swap (identity spoofing & trace cleaning)

**Windows only, administrator rights required for the spoofing half.** The page opens with an admin
banner and a **Relaunch as admin** button (`swapRelaunchAdmin` → `app:relaunchAsAdmin`) when not
elevated.

### Spoof Identity

| Toggle | What it changes | Notes |
| --- | --- | --- |
| **MAC address** | every network adapter's hardware address | applied via adapter advanced properties |
| **Machine GUIDs** | `MachineGuid`, `HwProfileGuid`, `MachineId` registry identifiers | exact hives/values defined in `src/hwid.js` |
| **Volume serial** | the system drive's boot-sector serial | requires a **reboot** to take effect |
| **Create restore point first** | a Windows System Restore checkpoint before spoofing | recommended |

Buttons:

- **MAC only** — randomizes just the MAC addresses, ignoring the toggles.
- **Spoof now** — a deliberate **hold-to-confirm** button (a progress fill runs while you hold), which
  runs the selected spoofing steps.
- **Revert** — restores the pre-spoof identity from the backup.

The app **backs up** the previous identifiers before touching them, so **Restore** (`swapOpenRestore`,
`swapExecuteRestore`) can put the machine back. A **backup status** row tells you whether a backup
exists and when it was taken.

### Anti-cheat awareness

**Spoofing runs a pre-flight anti-cheat check** (`detectAnticheats`). If a kernel-level anti-cheat is
running, a modal lists what's detected and gives **step-by-step shutdown instructions** — Riot
Vanguard (`vgc`/`vgk`), FACEIT AC, EasyAntiCheat, BattlEye, ESEA — along with a **Spoof anyway**
button. The rationale is sound: kernel anti-cheats can flag or interfere with identifier changes.

### Clean Traces

A separate, toggleable wipe of Roblox's local footprint:

| Toggle | Effect |
| --- | --- |
| **Preserve settings** | keep `GlobalBasicSettings` (graphics/FPS) after the wipe |
| **Preserve Fast Flags** | keep Bloxstrap/Fishstrap/Voidstrap `ClientAppSettings` |
| **Delete Roblox Studio too** | off keeps Studio intact |
| **Purge auth tokens** | delete LocalStorage cookies and HKCU Roblox registry keys |

**Clean Roblox traces** is another hold-to-confirm action. Under the hood it terminates Roblox
processes, wipes local app-data/roaming/temp/prefetch traces, removes the relevant registry key,
backs up and restores the settings files you asked to preserve, and can remove the Roblox program-data
install. Everything is emitted to the renderer as streamed swap logs (`swap:log`), a
progress/status channel (`swap:status`) and a completion event (`swap:complete`).

### MAC helpers

Beyond the bulk spoof there are targeted adapter operations exposed to the renderer:
`getAdapters`, `spoofMac`, `resetMac`, `restartAdapter`, `dhcpRefresh`.

---

## 19. Multi-instance, Anti-AFK & protocol handler

### Multi-instance

Roblox normally enforces a single client via a Windows mutex. rbxSWAP's native helper takes that
mutex (`ROBLOX_singletonMutex`, plus the `ROBLOX_singletonEvent` counterpart) and also closes the
singleton handles Roblox already holds, which is what allows several clients to coexist.

The behavior is exposed as `multiinstance:status` and driven by the `multiInstance` setting — turning
it on starts the mutex-holder helper, turning it off stops it. Just before each launch the app runs
`closeSingletonAndHoldMutex()` so the new client can claim the session.

### Anti-AFK

`Anti-AFK` is a native helper loop that periodically sends a keystroke to **each Roblox window**,
including background ones, to keep the client past Roblox's roughly-20-minute idle kick. It then
**restores your previous focus**, so it doesn't yank the foreground while you're doing something else.
Toggle it globally from the sidebar footer, or via the settings.

### Protocol handler

Settings → **Roblox Protocol Registration** registers rbxSWAP as the handler for
`roblox-player://` links (`registerProtocolHandlers`), so Roblox launch links routed to the OS are
caught by the app. The panel shows registration status and offers **Register** / **Remove**.

---

## 20. Auto-rejoin, presence & cookie health

Three always-on background systems make a wall of accounts feel alive:

- **Presence** — polls `roblox:presence` for every account every 15 seconds and paints the card
  states. It is generation-guarded so stale responses can't overwrite newer ones.
- **Cookie health** — validates stored cookies, flags suspect ones, and opportunistically refreshes
  from the local cookie store before declaring an account dead.
- **Auto-rejoin** (Settings → Privacy, `autoRejoin`) — if an account that was in a game gets kicked or
  disconnects, it relaunches into the game it was last playing, **up to 3 attempts**. The last known
  place ID is tracked per account (`_lastInGamePlace`) and the attempts are counted so a permanently
  broken account doesn't loop forever.

Launch watchdogs round this out: after a launch the app watches for the process to appear, tolerates
a long startup grace (up to 90 s) and re-attaches to a pid if the process restarts, and detects a
"quick crash" (Roblox exiting immediately) — surfacing a specific hint to check the cookie and that
the installed version is complete, rather than a generic failure.

---

## 21. Settings

| Section | Contents |
| --- | --- |
| **Roblox Protocol Registration** | Status badge and Register / Remove for `roblox-player://` (Windows only). |
| **BloxGen Integration** | BloxGen API key used by the account generator. |
| **Encryption Key** | Set/change the encryption key, with the "re-enter on next launch" caveat spelled out. |
| **Privacy** | **Streamer Mode** (blur names/IDs, hover to reveal) and **Auto-rejoin on disconnect**. |
| **Appearance & Themes** | Theme presets, accent colour, surface brightness, corner radius, interface scale, reduce motion. |
| **Help** | Replay the welcome tutorial. |
| **Data & Privacy** | **Clear all accounts** — removes all saved accounts and sign-in data. |
| **Anti-AFK** | Global idle-keeper toggle (sidebar footer, persisted in settings). |
| **Platform note** | On non-Windows builds, an explanatory banner replaces the Windows-only sections. |

Settings are stored as JSON and merged on save (`settings:save` merges into the existing object), and
saving a `multiInstance` or `antiAfk` change takes effect immediately by starting/stopping the
corresponding helper.

---

## 22. Themes & appearance

Theming is entirely CSS-variable driven, so every preset is instant with no reload.

- **Presets** — a grid of curated looks (`renderThemePresets`), each applied live and saved
  automatically.
- **Accent colour** — colour picker or hex input, used for highlights, active nav items and buttons.
- **Surface brightness** — a single slider that shifts the whole surface stack from dark to light
  (`themeSurfaces`, `themeMix`), rather than a binary light/dark switch.
- **Corner radius** — 0–22 px.
- **Interface scale** — 85–125%, for dense multi-account screens or small laptops.
- **Reduce motion** — disables hover/transition movement app-wide.
- **Reset all** returns everything to defaults.

Theme state lives in `localStorage` under a single key (`loadTheme`/`saveTheme`), and
`renderThemePresets` highlights whichever preset matches the current values.

---

## 23. Onboarding tutorial

A five-step modal tour (`TUT_STEPS`) runs automatically on first launch (tracked by the
`rblx_tutorial_done` key) and can be replayed from **Settings → Help**:

1. **Welcome to rbxSWAP** — what the app is.
2. **Accounts** — the home screen, cards, search/filter, right-click tools.
3. **Launch & Swap** — launching, and spoofing identifiers with restore points.
4. **RDD & Executors** — version management and choosing which executor attaches to launches.
5. **Make it yours** — themes, and how to replay the tour.

It supports skip, back/next, and animated dots for progress.

---

## 24. Tray, notifications & logging

- **System tray** — the app can live in the tray (`createTray`, `hideToTray`), with a tray menu that
  refreshes as accounts change (`refreshTrayMenu`) and can **launch an account straight from the
  tray** (`trayLaunchAccount`). This is what makes rbxSWAP usable as an always-on background tool.
- **Toasts** — short, colour-coded confirmations and errors for every significant action.
- **Topbar progress strip** — non-blocking progress for downloads (Chrome fetch, RDD installs) and
  other long operations.
- **Logging** — `sendLog` in main and `logEntry` in the renderer maintain a structured, categorized
  log (level, category, message, meta) covering launch, cookie, close, executor, swap and system
  events, mirrored to toasts and the console. As noted in section 7, the log *page* referenced by the
  renderer is not present in the current markup, so there is no dedicated log viewer in the UI today.

---

## 25. Security & encryption model

- **Encryption:** AES-256-GCM, key derived with **scrypt** (N=65536, r=8, p=1) from your key, with a
  **pbkdf2** legacy path retained for older data. A verifier token (`makeVerifier`/`verifyPass`) lets
  the app confirm a key without decrypting the whole account file.
- **What is encrypted:** account records — the cookie, and other sensitive fields — are encrypted
  field-by-field (`encryptAccount`/`decryptAccount`), and the file is written `mode 0600`.
- **Session key (`.keysession`)** — an optional, time-bounded (30 days) cached key tied to a boot ID,
  so you aren't prompted on every launch.
- **`safeStorage`** — where available, the OS keychain is used for the device key
  (`getOrCreateDeviceKey`), with a migration path for older installs
  (`migrateAccountEncryptionToKeychain`).
- **Network discipline** — Roblox API calls go through Node's `https`/Electron `net` with the correct
  `Origin`/`Referer` headers, CSRF tokens are fetched and cached (`getCSRFToken`), and auth tickets
  are requested with a rate-limit gap (`TICKET_MIN_GAP`, 8 s).
- **The Electron window is hardened** — a Chrome UA, `disable-blink-features=AutomationControlled`,
  and — critically — **no direct Node access from the renderer**. Every capability is an explicit IPC
  channel listed in `preload.js`, and no secrets are ever exposed to the page.

**Endpoints and trust:** account data is stored locally only. The app does contact Roblox's public
API/CDN endpoints and the third-party WEAO API, and the browser-login flow downloads a Chrome for
Testing build. Nothing is uploaded to a rbxSWAP-operated server — there isn't one.

---

## 26. Data & file locations

On Windows the app overrides `userData` to `%APPDATA%\rblxswap`:

| File / folder | Contents |
| --- | --- |
| `accounts.json` | Encrypted account records (cookies, IDs, aliases, saved passwords). |
| `packages.json` | Groups and their performance presets. |
| `settings.json` | App settings (executor paths, toggles, BloxGen key, etc.). |
| `.keysession` | Optional cached, time-bounded encryption key. |
| `Versions/` | rbxSWAP-installed Roblox builds (managed by RDD). |
| `chrome-for-login/` | The managed Chrome build used for browser login. |
| `RobloxNative-<version>.exe` | Compiled native helper for this build. |
| `hwid-backup` (via `hwid.js`) | Pre-spoof machine identifier backup used by Restore. |

A handful of UI preferences (account view, filter, game name cache, theme, tutorial flag, executor
default) live in Electron `localStorage` per the app's origin, not in these JSON files.

---

## 27. The native helper (RobloxNative.cs)

`src/RobloxNative.cs` is a single-file C# console program compiled to `RobloxNative.exe`. The app
locates it, compiles it on demand if needed, and prunes stale copies. Its subcommands:

| Command | Purpose |
| --- | --- |
| `mutex` | Holds `ROBLOX_singletonMutex` / `ROBLOX_singletonEvent` so multiple clients can run. |
| `closehandles` | Closes the singleton handles Roblox already holds (`HandleCloser`). |
| `volume <percent> <pids…>` | Sets the OS audio level of specific Roblox processes (COM audio APIs). |
| `volumeafter <percent> <sinceMs>` | Waits for a Roblox process that started after a timestamp, then applies volume. |
| `antiafk <deadlineSec> <vk>` | Sends a keystroke to each Roblox window, restoring prior focus (`AntiAfk.RunLoop`). |
| `setram <pid> <mb>` | Applies a working-set cap to a running process via a job object. |
| `launchram <exe> <cwd> <uri> <mb>` | Launches Roblox *inside* a job object with the RAM cap from the start. |

Because the last two suspend-and-scan the process's working set, the RAM limit is a genuine hard cap
rather than a hint, which is why the app can run many clients on a modest machine.

---

## 28. Platform support & limitations

| Capability | Windows 10/11 x64 | macOS |
| --- | --- | --- |
| Accounts, sign-in, presence, groups | ✅ | ✅ |
| Launching, game picker, auto-rejoin | ✅ | ✅ |
| RDD downloads & version management | ✅ | ✅ |
| Executor management / version matching | ✅ | ✅ |
| Mixer (graphics, FPS) | ✅ | ✅ |
| Mixer RAM limit | ✅ (native job object) | ❌ |
| Mixer per-instance volume | ✅ (native audio) | ❌ |
| Multi-instance | ✅ (native mutex) | ❌ |
| Anti-AFK | ✅ (native helper) | ❌ |
| Swap / spoofer / trace cleaner | ✅ (admin) | ❌ (hidden) |
| Protocol handler | ✅ | ❌ |
| Tray | ✅ | ✅ |

Other known limitations:

- **Two renderer copies exist**; only `src/renderer.js` is loaded. The root `renderer.js` is stale.
- The **launch verification** waits for the Roblox process to *appear* and then watches for a quick
  crash; it cannot prove the client reached in-game, so an executor that attaches instantly may fire
  before the client is ready.
- **WEAO must be reachable** for executor/version matching; without it, that flow degrades.
- The **`#page-logs` log viewer** referenced by the renderer does not exist in the markup.
- **First build after the workflow changelog change** with no previous tag will dump full history into
  the release body.

---

## 29. Launch pipeline, step by step

Putting the pieces together, a single **Start** does roughly this:

1. **Resolve target** — place ID, game URL, private-server link or share link → a Roblox launcher URL
   (`_doLaunch`).
2. **Auth** — fetch a CSRF token for the account's cookie, then an **auth ticket**.
3. **Version** — determine the required build from the selected executor (WEAO), install it via RDD
   if missing, and pass the version hash to the launch.
4. **Multi-instance** — close the singleton handles and hold the mutex so the new client can start.
5. **Options** — resolve FPS cap, graphics level and RAM limit from Mixer, group preset or
   "Unlimited" (`collectLaunchOptions` → `applyLaunchPerformanceSettings`).
6. **Spawn** — start Roblox (inside a RAM-capped job object when a limit applies), staggered from
   other launches to avoid ticket collisions.
7. **Watch** — claim the new pids, attach the account to them, tolerate a long startup window,
   re-attach if the process restarts, and flag a quick crash with a specific message.
8. **Executor** — if the **Boot executor** toggle is armed, start the configured executor program
   (with the existence and already-running guards described in section 16).
9. **Post-launch** — apply the requested volume once the client window exists, start presence
   polling, and register auto-rejoin tracking so a later disconnect can be recovered.

---

## 30. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| "No program is set for the default executor" | **Boot executor** is on but the Executer page has no default executor or no `.exe` path. Pick one; the app tells you which of the two is missing. |
| "The program set for X is not there anymore" | The configured executor path no longer exists — re-Browse to the exe. |
| Executor doesn't start on launch | It may already be running (the app deliberately skips booting it again). Close it to test, and check the toast/log output. |
| Roblox closes immediately after launch | Check the account cookie (re-login if expired) and that the installed version is complete — install it again from RDD. |
| Launch fails with "could not get CSRF token" | The cookie is expired or invalid. Refresh the cookie from the account's info/edit modal. |
| Private-server or share link won't launch | The link may be expired, or the account may lack permission; the app reports both cases explicitly. |
| Spoof buttons greyed out or refused | Spoofing needs administrator rights. Use **Relaunch as admin**. |
| Anti-cheat blocks the spoof | Close the detected anti-cheat using the steps in the modal, then spoof. Volume-serial changes also need a reboot. |
| Accounts vanished | The account file is encrypted; the right key must be supplied at the unlock prompt. There is no recovery for a lost key. |
| macOS build missing features | Expected — multi-instance, Anti-AFK, Swap and the RAM/volume controls are Windows-only. |

---

## 31. Glossary

- **Account** — a stored Roblox identity: cookie, user ID, username, optional alias and saved login
  password.
- **Cookie** — the `.ROBLOSECURITY` session token; the credential rbxSWAP launches with.
- **Group / package** — a named set of accounts launched together, optionally with its own
  performance preset.
- **Executor / exploit** — a third-party program injected into Roblox; rbxSWAP tracks which Roblox
  build each one supports.
- **WEAO** — the third-party API (`weao.xyz`) used for Roblox version and executor information.
- **RDD** — Roblox Deployment Downloader: the page that browses and installs Roblox builds.
- **Deployment / version hash** — a specific Roblox client build, named `version-<hash>`.
- **Instance** — one running Roblox client, associated with one account.
- **Temp session** — a Roblox process rbxSWAP didn't start, listed so it isn't invisible.
- **Boot executor** — the toggle that starts your executor program alongside a launch.
- **Anti-AFK** — the native idle-keeper that taps windows to avoid the ~20-minute kick.
- **HWID / machine GUID** — the machine identifiers (`MachineGuid`, `HwProfileGuid`, `MachineId`)
  the Swap page can randomize and restore.
- **Streamer Mode** — blurs account names and IDs on screen, revealing on hover.
