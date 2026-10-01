# Desktop app shell options

Research for wayfinder ticket #7. It feeds decision ticket #12 (Tech stack and local database). Researched 2026-10-01. Every claim links to its source. Local measurements and observations on the author's machine are labelled as such. Benchmarks from third parties are labelled **secondary**.

## Question

Which desktop app shell should Commander use, given that it runs entirely on the User's machine, keeps a background Agent running, and must not rule out a phone app later?

Find out:

- How Tauri v2, Electron, and alternatives (Wails, a local web server opened in the browser, native toolkits) compare.
- Linux Wayland/Hyprland support, plus macOS and Windows for testers.
- Running long-lived background work (the Agent, Source polling) and a local model runtime alongside the UI; system tray; start on login.
- Rendering untrusted HTML email safely inside the shell.
- Packaging, code signing and auto-update for testers.
- Footprint, and developer ergonomics with the installed toolchains (Node 24/pnpm, Rust).
- The phone story (e.g. Tauri mobile), as a tiebreaker only.

## Short answer

- **Only two real contenders: Electron (44.x) and Tauri (2.12.x).** A full email client has to render HTML email, so every option needs a browser engine somewhere. Native toolkits would need an embedded web engine anyway, plus a hand-built UI. Wails needs Go and its v3 is still in beta. Electrobun is young, and Arch is only community-supported. A local web server opened in a browser loses the tray, the app identity and a safe IPC boundary. Details are in the comparison section below.
- **The deciding fact for #12 is the language of the always-on core (the Agent plus Source sync), not the UI.** Linear, Microsoft Graph, Gmail and GitHub all publish official TypeScript/JavaScript SDKs. None of them publishes an official Rust SDK. GitHub lists the Rust client `octocrab` as third-party.
  - With a TypeScript core, Electron runs it directly: Electron 44 bundles Node 24, and `utilityProcess` runs it beside the UI. Tauri would have to ship a Node sidecar, which cancels most of Tauri's size advantage.
  - With a Rust core, Tauri is the natural fit, and the core can later be reused on iOS and Android.
- **Leaning (the researcher's reading; #12 makes the decision): Electron for v1, unless #12 chooses a Rust core.** Reasons:
  - It uses the same Chromium engine on Linux, macOS and Windows.
  - It has run natively on Wayland by default since Electron 38.
  - Its global shortcuts go through the desktop portal, which Hyprland's portal implements.
  - It can block email content at the network level (`session.webRequest`), and it has Chromium-only email-hardening features (the iframe `csp` attribute and `Element.setHTML`).
  - It has built-in OS-keychain encryption (`safeStorage`) and an updater that covers AppImage, deb, rpm and pacman. Caveat: on Hyprland, `safeStorage` falls back to a hard-coded key unless the app passes `--password-store=gnome-libsecret` (section 6).
  - The cost is about a 117 MiB download and 283 MiB on disk for the runtime, plus more RAM. A multi-GB local model dwarfs both.
  - Tauri wins on footprint and on the phone tiebreaker.
- **Hard constraints whatever the shell:**
  - **macOS:** testers need a notarized build. That requires a paid Apple Developer membership ($99/yr). Since macOS Sequoia, the Control-click bypass is gone.
  - **Windows:** unsigned or newly signed builds trigger SmartScreen warnings. EV certificates no longer skip the warning.
  - **Hyprland:** it does not run XDG autostart entries by itself, so "start on login" needs a systemd user unit or an `exec-once` line. A tray icon only shows if a StatusNotifierItem host is running.
  - **Email:** untrusted email HTML must be sanitized and shown in a sandboxed iframe without `allow-scripts`. This matters most on Tauri/Linux, where IPC calls from an iframe can't be told apart from the main window.
- **Not answered first-hand:**
  - RAM and CPU were not measured. Only secondary benchmarks are cited.
  - Neither shell was launched on the Hyprland desktop, to avoid opening windows on the author's session. A short spike should confirm Wayland behaviour, tray and shortcuts before #12 locks in.

## 1. How the options compare

**Status as of 2026-10-01**

| Option | Web engine per OS | Core language | Status | Main fit issue for Commander |
|---|---|---|---|---|
| **Electron** | Bundled Chromium on every OS. Electron 44.5.1 = Chromium 152 + Node 24.21 ([releases](https://releases.electronjs.org/)) | JS/TS (Node) | Stable. New major every 8 weeks, and only the latest 3 majors are supported ([timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)). 44.0.0 shipped 2026-08-25. 45.0.0 is due 2026-10-20 ([schedule](https://releases.electronjs.org/schedule)). | Size and RAM. No mobile. |
| **Tauri v2** | System webviews: WebView2 (Chromium) on Windows, WKWebView on macOS, WebKitGTK on Linux ([webview versions](https://v2.tauri.app/reference/webview-versions/)) | Rust core + any web frontend | Stable since 2.0 on 2024-10-02 ([blog](https://v2.tauri.app/blog/tauri-20/)). 2.12.0 shipped 2026-09-26 ([blog](https://v2.tauri.app/blog/tauri-2.12/)); 2.12.1 shipped 2026-09-30 ([releases](https://github.com/tauri-apps/tauri/releases)). | Three engines to test. Linux uses WebKitGTK. Official Source SDKs are TS, not Rust. |
| Tauri v3 (preview) | Adds an optional bundled-Chromium runtime, `tauri-runtime-cef` | Rust | **Alpha.** 3.0.0-alpha.0 shipped 2026-09-13; alpha.3 and runtime-cef alpha.4 shipped 2026-09-26 ([release notes](https://github.com/tauri-apps/tauri/releases/tag/tauri-v3.0.0-alpha.0)). Breaking changes include how the runtime is selected and the plugin trait. | Not ready for v1. If it ships, the CEF runtime would remove the WebKitGTK concern at Electron-like size. |
| **Wails** | System webviews. On Linux, v3 defaults to GTK4 + WebKitGTK 6.0 ([v3 status](https://github.com/wailsapp/wails/blob/master/docs/mpress/content/status.md)) | Go | v2 is the stable line (2.14.0, 2026-08-10, [releases](https://github.com/wailsapp/wails/releases)). v3 is **beta** (beta.0 on 2026-08-02, beta.26 on 2026-09-25); Android/iOS are experimental ([v3 beta notes](https://github.com/wailsapp/wails/releases/tag/v3.0.0-beta.0)). | Go isn't in the project's stated toolchain (it happens to be installed; see section 6). Same Linux engine concerns as Tauri, with a smaller ecosystem. |
| Electrobun | System webview, or bundled CEF via `bundleCEF` ([README](https://github.com/blackboardsh/electrobun)) | TS on its own JSC-based runtime ("Cottontail") or Bun | 2.0.2 shipped 2026-09-29. First GitHub releases were 0.0.19 betas in July 2025, and 0.1.0 shipped 2025-08-25 ([releases](https://github.com/blackboardsh/electrobun/releases)). Official on Ubuntu 24.04+; **other Linux distros (Arch) are "Community"** ([README](https://github.com/blackboardsh/electrobun)). | Young. Non-Node runtime. Arch isn't officially supported. |
| Local web server + browser | Whatever browser the User runs | Any | n/a | No tray or app identity unless the User installs a PWA. MDN says Firefox needs an extension for that ([MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Installing)). The localhost server is reachable by other local processes and by web pages, so it needs its own auth. Chrome only began prompting for public-site→loopback requests in Chrome 142 ([Chrome blog](https://developer.chrome.com/blog/local-network-access)). Tauri's own docs warn that its localhost plugin (which serves the app over localhost) "brings considerable security risks" ([localhost plugin](https://v2.tauri.app/plugin/localhost/)). |
| Native toolkits | Need an embedded engine for email HTML anyway | C++/Python (Qt), Dart (Flutter), Rust (Slint/iced/egui) | n/a | Qt WebEngine's platform notes cover only Windows, macOS and Linux ([Qt docs](https://doc-snapshots.qt.io/qtwebengine/qtwebengine-platform-notes.html)). Flutter's official `webview_flutter` supports Android, iOS and macOS only, **not Linux or Windows** ([pub.dev](https://pub.dev/packages/webview_flutter)). Inference (not separately sourced): pure-Rust GUIs (Slint/iced/egui) don't include an HTML engine, and a full email client, calendar and notes UI would all be hand-built. |
| (Dioxus desktop) | Uses `wry`, the same webview layer as Tauri ([Cargo.toml](https://github.com/DioxusLabs/dioxus/blob/main/packages/desktop/Cargo.toml)) | Rust | 0.7.10 (2026-07-30) | Has the same engine trade-offs as Tauri. Its desktop plumbing (tray, updater, signing) was not evaluated. |

Tauri also published an experimental Servo/Verso integration (2025-03-17, [blog](https://v2.tauri.app/blog/tauri-verso-integration/)). It is not a production option.

## 2. Linux Wayland/Hyprland, plus macOS and Windows

### Wayland and Hyprland (the author's machine)

**Electron**
- Electron 38 (2025-09-02) made native Wayland the default when `XDG_SESSION_TYPE=wayland`. `--ozone-platform=x11` forces XWayland ([breaking changes, 38.0](https://www.electronjs.org/docs/latest/breaking-changes)).

**Tauri v2**
- It renders through GTK3 + WebKitGTK 4.1 ([prerequisites](https://v2.tauri.app/start/prerequisites/)). Arch packages it as `webkit2gtk-4.1`; 2.52.6 is installed on the author's machine (observed).
- Tauri's Linux graphics page says most breakage comes from WebKitGTK's DMABUF renderer, "most often NVIDIA GPUs". The author's AMD APU is outside the main risk group.
- The same page warns that WebGL/canvas can "silently land on a slow path" and that WebKitGTK hides the real renderer string ([Linux graphics issues](https://v2.tauri.app/develop/debug/linux-graphics/)).
- Open Wayland issues that touch Commander-like features:
  - a child webview (multi-webview) renders with wrong bounds on WebKitGTK 2.52.3 under Wayland ([#15656](https://github.com/tauri-apps/tauri/issues/15656));
  - the tray icon is missing in `.deb` builds on Wayland ([#14234](https://github.com/tauri-apps/tauri/issues/14234));
  - the IME window appears in the wrong position ([#11412](https://github.com/tauri-apps/tauri/issues/11412)).

Electron has its own open Wayland issues, e.g. [#54594](https://github.com/electron/electron/issues/54594) and [#53814](https://github.com/electron/electron/issues/53814). Neither shell is issue-free, so a spike on Hyprland is worth an hour.

**Protocol limits that apply to every shell.** Wayland forbids apps from reading or setting global window coordinates. Electron documents that position getters return 0 and that always-on-top is "Not supported on Wayland" ([BaseWindow](https://www.electronjs.org/docs/latest/api/base-window)). Tauri has the matching open issues ([#14913](https://github.com/tauri-apps/tauri/issues/14913), [#12411](https://github.com/tauri-apps/tauri/issues/12411)). Pop-ups placed next to the tray or at fixed spots won't work. On a tiling compositor, Hyprland window rules decide placement.

**Global shortcuts** (e.g. a quick-capture key)
- **Electron** binds through the `org.freedesktop.portal.GlobalShortcuts` portal. This is on by default, and the app needs a valid `desktopName` ([globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut)).
- Hyprland's portal implements `GlobalShortcuts` ([xdph `hyprland.portal`](https://github.com/hyprwm/xdg-desktop-portal-hyprland/blob/master/hyprland.portal)). The User then binds the key with Hyprland's `global` dispatcher ([Hyprland binds](https://wiki.hypr.land/Configuring/Basics/Binds/)).
- **Tauri's** global-shortcut plugin is built on `global-hotkey`, whose README says "Linux (X11 Only)" ([global-hotkey](https://github.com/tauri-apps/global-hotkey)). Wayland support has been an open request since 2022 ([tauri#3578](https://github.com/tauri-apps/tauri/issues/3578)).
- Note that Tauri's plugin metadata still marks Linux as "full" support ([Cargo.toml](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/global-shortcut/Cargo.toml)).
- Workaround (inference): a Hyprland `bind` that runs `commander --toggle`, which the single-instance plugin forwards to the running app.

**Tray.** Both shells use StatusNotifierItem on Linux:
- Electron's tray uses it by default ([Tray](https://www.electronjs.org/docs/latest/api/tray)).
- Tauri v2 uses libappindicator. v3 alpha switches to `ksni`, a StatusNotifierItem client over D-Bus ([v3 alpha.0 notes](https://github.com/tauri-apps/tauri/releases/tag/tauri-v3.0.0-alpha.0)).

Hyprland has no built-in bar, so a tray icon needs a StatusNotifierItem host. The author's session has one: Quickshell (`qs`) owns `org.kde.StatusNotifierWatcher` (observed via `busctl --user`). Click behaviour differs:
- **Tauri:** tray click events are "Linux: Unsupported". The icon only offers its menu ([System Tray](https://v2.tauri.app/learn/system-tray/)).
- **Electron:** emits `click` on activation, but the spec doesn't say which gesture counts as activation ([Tray](https://www.electronjs.org/docs/latest/api/tray)).

**Start on login under Hyprland.** Hyprland does not run `~/.config/autostart/*.desktop` entries by itself. Maintainers point to systemd's XDG-autostart generator through a session target ([discussion #3389](https://github.com/hyprwm/Hyprland/discussions/3389)), or to uwsm, which adds XDG autostart support ([uwsm](https://wiki.hypr.land/useful-utilities/uwsm/)). On the author's machine, `xdg-desktop-autostart.target` is inactive (observed), so an XDG autostart entry written by either shell would not fire. Section 3 covers the options.

### macOS and Windows testers

**Tauri**
- macOS uses the OS's WKWebView, which only updates with the OS. "Unsupported macOS versions do not receive WebKit updates."
- Windows uses WebView2, which updates itself and comes preinstalled on Windows 11 ([webview versions](https://v2.tauri.app/reference/webview-versions/)).
- Tauri 2.12 dropped Windows 7 ([2.12 blog](https://v2.tauri.app/blog/tauri-2.12/)).
- In total, the UI must be tested on three engines.

**Electron**
- It ships the same Chromium everywhere.
- Electron 44 removed macOS 12 support, and Electron 38 removed macOS 11 ([breaking changes](https://www.electronjs.org/docs/latest/breaking-changes)).

## 3. Background work, local model runtime, tray, start on login

**Keeping the process alive with no window open**
- **Electron:** if the app listens for `window-all-closed`, it doesn't quit when the last window closes ([app](https://www.electronjs.org/docs/latest/api/app)).
- **Tauri:** handle `RunEvent::ExitRequested` and call `api.prevent_exit()` ([source docs](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/app.rs)).

**Where the Agent and Source polling run**
- **Electron:**
  - `utilityProcess.fork()` starts a child process with Node and MessagePorts, launched through Chromium's Services API ([utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)). A TypeScript Agent can live there, isolated from the UI renderer.
  - `node-llama-cpp` (in-process llama.cpp) supports Electron but "only on the main process"; using it in a renderer "will crash the application" ([guide](https://node-llama-cpp.withcat.ai/guide/electron)). The guide does not say whether a `utilityProcess` works.
  - An external `llama-server` or Ollama can be spawned as a child process instead.
- **Tauri:**
  - Background work runs as Rust async tasks in the core process.
  - Other binaries ship as **sidecars** via `bundle.externalBin`. Each one needs a `-$TARGET_TRIPLE` suffixed copy per platform ([sidecar](https://v2.tauri.app/develop/sidecar/)).
  - Tauri's Node sidecar guide packages Node with `@yao-pkg/pkg`. It notes the alternative of embedding the Node runtime, which "is usually larger" ([Node.js as a sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)).
  - Node's own single-executable-application feature is still "Stability: 1.1 - Active development" in Node 24 ([Node SEA](https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html)).
  - v3 alpha adds a `cleanup_before_exit` plugin hook "so plugins can release resources such as sidecar processes" ([v3 alpha.3 notes](https://github.com/tauri-apps/tauri/releases/tag/tauri-v3.0.0-alpha.3)).

**A layout that works with either shell (inference).** Run the Agent as its own headless process, and make the shell a client of it.
- The Agent can be a sidecar or utility process while the app runs, or a systemd user service on Linux.
- On Hyprland a systemd user unit is also the idiomatic way to autostart (see section 2).
- It survives UI restarts, and it leaves a seam for a later phone or second client.
- Costs: two processes to package and update, and a local IPC channel that needs auth.

**Start on login**
- **Electron:** `app.setLoginItemSettings` covers macOS and Windows only. On macOS the app should be signed and notarized, or `openAtLogin` "may silently fail" ([app](https://www.electronjs.org/docs/latest/api/app)). Linux needs a hand-written autostart entry or a systemd unit.
- **Tauri:** the autostart plugin covers macOS, Windows and Linux ([autostart](https://v2.tauri.app/plugin/autostart/)). It uses the `auto-launch` crate:
  - macOS: a LaunchAgent plist, or AppleScript;
  - Windows: the registry `Run` key;
  - Linux: XDG autostart by default. The crate also has a systemd mode ([auto-launch docs](https://docs.rs/auto-launch/latest/auto_launch/)), but the plugin's builder exposes only the macOS launcher choice ([plugin source](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/autostart/src/lib.rs)).
- Either way, plain Hyprland needs the systemd or `exec-once` route described in section 2.

**Tray.** Both shells have one. Electron has a built-in `Tray`. Tauri needs the `tray-icon` feature ([System Tray](https://v2.tauri.app/learn/system-tray/)). The Linux caveats are in section 2.

## 4. Rendering untrusted HTML email safely

**A pattern that works in either shell**

1. **Sanitize** before rendering.
   - In JS: DOMPurify, "a DOM-only … XSS sanitizer for HTML, MathML and SVG", currently 3.4.16 ([DOMPurify](https://github.com/cure53/DOMPurify)).
   - In Rust: `ammonia`, a whitelist-based sanitizer built on html5ever ([ammonia](https://github.com/rust-ammonia/ammonia)).
2. **Isolate** the sanitized HTML in `<iframe sandbox srcdoc="…">` with **no `allow-scripts`**. A bare `sandbox` gives the content a unique opaque origin and disables forms, scripts, popups and top-level navigation.
   - Never combine `allow-scripts` with `allow-same-origin`: the spec warns this lets same-origin content remove the sandbox ([HTML spec, sandbox](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox)).
3. **Restrict network loads with CSP.**
   - A `srcdoc` document clones its parent's policy container, so the app's CSP (e.g. `img-src`) applies to it ([HTML spec, navigation params policy container](https://html.spec.whatwg.org/multipage/browsers.html#determining-navigation-params-policy-container)).
   - Adding a `<meta http-equiv="Content-Security-Policy">` inside the `srcdoc` as well is cheap defence in depth.
   - Block remote images by default (tracking pixels). Load them on demand through a backend proxy on a custom scheme:
     - Electron: `protocol.handle` ([protocol](https://www.electronjs.org/docs/latest/api/protocol)).
     - Tauri: `register_asynchronous_uri_scheme_protocol` ([Builder](https://docs.rs/tauri/latest/tauri/struct.Builder.html)).
4. **Open links outside the app.** Intercept navigation and new windows, and send links to the system browser after validation. Electron's security checklist covers this in items 13–15 ([security](https://www.electronjs.org/docs/latest/tutorial/security)). Tauri has `on_navigation` and `on_new_window` on `WebviewWindowBuilder` ([WebviewWindowBuilder](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html)).

**Where the shells differ**

**Electron** (Chromium) offers more layers:
- Sandboxing has been the renderer default since Electron 20 ([security #4](https://www.electronjs.org/docs/latest/tutorial/security)).
- For embedding, Electron recommends sandboxed iframes or `WebContentsView` over `<webview>` ([web embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds)). A dedicated `WebContentsView` with its own session can host the email viewer.
- `session.webRequest` can intercept and block *any* request at the network layer, for example per message view ([WebRequest](https://www.electronjs.org/docs/latest/api/web-request)).
- Chromium-only features, per [MDN browser-compat-data](https://github.com/mdn/browser-compat-data):
  - the iframe `csp` attribute (Chrome 61+; not in Firefox or Safari);
  - `Element.setHTML` with the HTML Sanitizer API (Chrome 146+, Firefox 148+, not Safari).
  - Electron 44 is on Chromium 152, so it has both.
- Chromium can run sandboxed iframes without `allow-same-origin` in their own process (`IsolateSandboxedIframes`). Microsoft announced it would be on by default in WebView2 "latest by" runtime 132 ([WebView2 announcement](https://github.com/MicrosoftEdge/WebView2Announcements/issues/99)). Chromium defines it as `FEATURE_ENABLED_BY_DEFAULT` ("only iframes with origin-restricted sandboxes are isolated") ([blink features.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/common/features.cc)). Electron's feature overrides on the `44-x-y` branch don't disable it ([feature_list.cc](https://github.com/electron/electron/blob/44-x-y/shell/browser/feature_list.cc)). So it is very likely on in Electron 44 (inferred from source; not checked at runtime).

**Tauri:**
- CSP is enforced only if set in the config, and Tauri adds nonces and hashes for bundled assets ([CSP](https://v2.tauri.app/security/csp/)).
- Capabilities limit which commands the frontend may call. But the docs warn, in a caution under "Remote API Access": **"On Linux and Android, Tauri is unable to distinguish between requests from an embedded `<iframe>` and the window itself"** ([capabilities](https://v2.tauri.app/security/capabilities/)). An email iframe that could run script would have the main window's IPC rights on Linux. The no-`allow-scripts` sandbox is therefore mandatory, not optional.
- `on_web_resource_request` only works for the `tauri` protocol ([WebviewBuilder](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html)). Blocking remote content therefore relies on CSP and HTML rewriting, not network interception.
- A separate capability-less webview for email needs the multi-webview API, which is behind the `unstable` feature in v2 ([Window::add_child](https://docs.rs/tauri/latest/tauri/window/struct.Window.html)). It also has the open Wayland bounds bug ([#15656](https://github.com/tauri-apps/tauri/issues/15656)).
- The optional isolation pattern intercepts all IPC through a sandboxed iframe ([isolation](https://v2.tauri.app/concept/inter-process-communication/isolation/)).
- WebKit has neither the iframe `csp` attribute nor `setHTML` (see above), so Tauri on macOS and Linux needs DOMPurify or ammonia.

## 5. Packaging, code signing and auto-update for testers

**Build artifacts and CI**
- **Tauri** builds AppImage, deb and rpm on Linux, app/dmg on macOS, and MSI/NSIS on Windows. It also has Flatpak, Snap and AUR guides ([distribute](https://v2.tauri.app/distribute/)).
  - AppImages must be built on the oldest base system to be supported (e.g. Ubuntu 22.04 or Debian 12), or glibc errors appear ([AppImage](https://v2.tauri.app/distribute/appimage/)).
  - `tauri-action` builds the full OS matrix on GitHub Actions ([pipeline guide](https://v2.tauri.app/distribute/pipelines/github/)).
- **Electron's** official tool is Forge. With pnpm, Forge needs `node-linker=hoisted` ([Forge docs](https://www.electronforge.io/)). electron-builder is the other common choice.
- GitHub Actions is free for public repositories on standard runners ([GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)). Commander is public. Signed macOS builds need macOS runners in either case.

**Auto-update**
- **Tauri updater:**
  - Signatures are required: "This cannot be disabled." Losing the private key means existing installs can never be updated again.
  - Updates can be served from a static JSON file, e.g. on GitHub Releases ([updater](https://v2.tauri.app/plugin/updater/)).
  - On Linux it updates AppImage, deb (since plugin 2.1.0) and rpm (since 2.10.0, which added "all bundle types"). deb/rpm installs prompt for sudo ([plugin changelog](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/CHANGELOG.md)).
- **Electron's built-in `autoUpdater`:**
  - macOS and Windows only; "There is no built-in support for auto-updater on Linux."
  - On macOS it requires a signed app ([autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)).
  - The free `update.electronjs.org` service works for apps with a **public GitHub repository**, builds on GitHub Releases, and signed macOS builds. It covers macOS and Windows only ([update.electronjs.org](https://github.com/electron/update.electronjs.org)).
- **electron-builder's `electron-updater`** auto-updates DMG, NSIS and, on Linux, **AppImage, DEB, Pacman and RPM**. It also validates code signatures on Windows ([electron-builder auto-update](https://www.electron.build/docs/features/auto-update)).

**Signing (applies to both shells)**

| Platform | What testers see unsigned | Cost to fix |
|---|---|---|
| macOS | Since Sequoia, users "will no longer be able to Control-click to override Gatekeeper". They must use System Settings > Privacy & Security ([Apple, 2024-08-06](https://developer.apple.com/news/?id=saqachfa); [Apple support](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)). Ad-hoc signing doesn't avoid this ([Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)). | Apple Developer Program, $99/yr. A free account cannot notarize ([Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/); [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)). |
| Windows | Unsigned: "Strong SmartScreen block". Newly signed builds still warn until reputation builds. EV has given no instant bypass since 2024 ([Microsoft, updated 2026-08-29](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)). | Azure Artifact Signing (formerly Trusted Signing): about $9.99/month, but **individuals must be in the USA or Canada** (organizations: USA, Canada, EU, UK). It gives no instant SmartScreen trust either. OV certificate: $150–300/yr, key on an HSM. Microsoft Store MSIX: free re-signing. SignPath Foundation: free for open source ([same page](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)), but it requires "an OSI-approved Open Source license without commercial dual-licensing for all components", no proprietary code, and an already-released, actively maintained project ([SignPath terms](https://signpath.org/terms)). That conflicts with possible monetization, and the repo has no license today (`license: null` via GitHub API). |
| Linux | No signing is required. AppImages can be GPG-signed ([Tauri Linux signing](https://v2.tauri.app/distribute/sign/linux/)). | None |

## 6. Footprint and developer ergonomics

**Disk size (measured on the author's machine, 2026-10-01)**
- **Tauri hello-world:** `create-tauri-app` 4.7.4, vanilla-ts template, Tauri 2.12.1, release profile with LTO.
  - Binary: 5.8 MiB. `.deb`: **2.3 MiB**. AppImage: **98.1 MiB**, because it bundles WebKitGTK and its dependencies.
  - Clean release build: 3 min 32 s.
  - This matches Tauri's docs: "a minimal Tauri app can be less than 600KB" ([What is Tauri](https://v2.tauri.app/start/)), and AppImages grow "from the 2-6 MB range to 70+ MB" ([AppImage](https://v2.tauri.app/distribute/appimage/)).
  - So on Linux, Tauri's size advantage only holds for distro packages (deb, rpm, AUR) that use the system WebKitGTK.
- **Electron 44.5.1 runtime:**
  - Linux x64 zip: **117 MiB**. macOS arm64: 124 MiB. Windows x64: 150 MiB ([release assets](https://github.com/electron/electron/releases/tag/v44.5.1)).
  - Unpacked on Linux: **283 MiB** (measured, `du -sh`), before any app code.

**RAM and startup (secondary sources only; not measured here)**
- Hopp (2025-04-09, a single run on macOS): Tauri about 172 MB vs Electron about 409 MB with 6 windows open; bundle 8.6 MiB vs 244 MiB. Startup differences were negligible ([gethopp.app](https://www.gethopp.app/blog/tauri-vs-electron)).
- An informal 2022 Windows comparison: about 80 MB vs 120 MB idle ([levminer.com](https://www.levminer.com/blog/tauri-vs-electron)).
- Context (inference): Commander's default local model will take several GB of RAM, so the shell's difference of a few hundred MB matters far less here than in a typical app.

**Ergonomics with the installed toolchains** (observed: Node 24.20.0, pnpm 12.4.2, rustc 1.98.1)

**Electron**
- Electron 44 ships **Node 24** (24.18.1 at 44.0.0, 24.21.0 in 44.5.1), the same major as the author's Node ([schedule](https://releases.electronjs.org/schedule)).
- Official SDKs run unmodified in the main or utility process:
  - Linear: TypeScript `@linear/sdk` ([Linear](https://linear.app/developers/sdk));
  - Microsoft Graph: TS/JS among its official SDKs, with no Rust ([Graph SDKs](https://learn.microsoft.com/en-us/graph/sdks/sdks-overview));
  - Gmail: Node.js/JS client libraries, with no Rust ([Gmail](https://developers.google.com/gmail/api/downloads));
  - GitHub: official octokit.js, with Rust's octocrab listed as third-party ([GitHub](https://docs.github.com/en/rest/using-the-rest-api/libraries-for-the-rest-api)).
- `node:sqlite` is built in. In Node 24 it is "1.2 - Release candidate" ([Node](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)). Electron fixed the missing binding in July 2025 ([electron#47706](https://github.com/electron/electron/pull/47706)).
- Native modules (e.g. `better-sqlite3`) must be recompiled for Electron's ABI ([native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)).
- Since Electron 42, the `electron` package downloads its binary on first run, not in `postinstall`, so it works with `--ignore-scripts` ([breaking changes, 42.0](https://www.electronjs.org/docs/latest/breaking-changes)).
- `safeStorage` encrypts with the OS keychain (Keychain, DPAPI, or libsecret/KWallet/the Secret portal). It falls back to a hard-coded plaintext key (`basic_text`) when Linux has no secret store, **or "when the desktop environment is not recognised"**. Only Cinnamon, Deepin, GNOME, Pantheon, XFCE, UKUI, Unity and KDE are recognised ([safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)).
  - On the author's machine, `XDG_CURRENT_DESKTOP=Hyprland`, while gnome-keyring owns `org.freedesktop.secrets` (observed). So Electron would likely pick `basic_text` unless the app appends `--password-store=gnome-libsecret` before `ready`. The docs list the Secret portal as "preferred for sandboxed environments like Flatpak", and it's unclear whether it is tried outside Flatpak. Check `safeStorage.getSelectedStorageBackend()` in the spike.
- Upkeep: a new major every 8 weeks, with 3 supported at a time ([timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)).

**Tauri**
- `create-tauri-app` scaffolds with pnpm. The frontend tooling is ordinary Vite.
- Backend logic is Rust; rustc 1.98 is well above Tauri 2.12's minimum of 1.90 ([2.12 blog](https://v2.tauri.app/blog/tauri-2.12/)).
- Source clients would be written by hand against REST and GraphQL, or use community crates, because no Source ships an official Rust SDK (see above).
- There is no first-party secret store. The `keyring` crate is community-maintained ([keyring-rs](https://github.com/open-source-cooperative/keyring-rs)), and the Stronghold plugin is an alternative ([stronghold](https://v2.tauri.app/plugin/stronghold/)).
- Upkeep: v2 gets minor releases. Expect a v3 migration (runtime selection, plugin traits) once v3 leaves alpha.

**Wails** needs Go 1.25+ ([v3 status](https://github.com/wailsapp/wails/blob/master/docs/mpress/content/status.md)). Go 1.27.1 happens to be installed on the author's machine (observed), even though it isn't in the project's stated toolchain.

## 7. Phone story (tiebreaker only)

- **Tauri:** iOS and Android have been supported since 2.0 (2024-10-02). "On mobile not all of the official plugins are supported" ([2.0 blog](https://v2.tauri.app/blog/tauri-20/)).
  - Plugin metadata marks autostart, updater, global-shortcut and single-instance as *none* on Android and iOS; notification and sql as *full* ([plugins-workspace](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins)).
  - 2.12 updated the Android template to targetSdk 37 ([2.12 blog](https://v2.tauri.app/blog/tauri-2.12/)).
  - The Rust core and the web UI could both be reused.
- **Electron** is desktop-only: "Windows, macOS, and Linux" ([docs](https://www.electronjs.org/docs/latest/)). The web UI could be wrapped with Capacitor (v8), "a cross-platform native runtime" for web apps on iOS and Android ([Capacitor](https://capacitorjs.com/docs)). Inference: Node main-process code would not carry over.
- **Wails v3:** Android and iOS are experimental ([v3 status](https://github.com/wailsapp/wails/blob/master/docs/mpress/content/status.md)).
- **Flutter:** strong on mobile, but it has no official Linux webview (section 1).
- **Inference:** the phone app is out of scope for v1 ([map #1](https://github.com/sethtorrence/commander/issues/1)). Its real blockers will be data sync and model hosting rather than the shell. This tiebreaker only matters if the two leading options are otherwise close.

## Implications for the decisions

For **#12 Tech stack and local database** (language, UI framework, local database, process layout):

1. **Choose the core language first. The shell follows from it.**
   - **TypeScript core → Electron.** All four Sources' official SDKs run on Electron 44's Node 24. A Tauri + Node-sidecar combination keeps the WebKitGTK costs and loses most of the size win.
   - **Rust core → Tauri v2.** Budget for hand-written Source clients, and for a v3 migration later.
2. **Process layout.**
   - Treat the Agent (Source polling, Bucket sorting, Todo suggestions) as its own process with a narrow IPC to the UI: an Electron `utilityProcess`, a Tauri sidecar, or a systemd user service.
   - Treat the model runtime (llama.cpp server or Ollama) as a child process or an external service. Embedding it in the main process is the riskier option.
   - This keeps the Agent alive across UI restarts. It fits Hyprland's systemd-based autostart, and it leaves a seam for a later phone or second client.
3. **Local database.**
   - Electron gets SQLite with no native build via `node:sqlite` (release candidate in Node 24). `better-sqlite3` needs Electron ABI rebuilds.
   - Tauri gets SQLite through Rust (e.g. `rusqlite`/`sqlx`) or the official sql plugin, which supports all five platforms ([plugin metadata](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/sql/Cargo.toml)).
   - Wherever the database lives, it belongs to the Agent process, not the UI.
4. **Email security is part of the stack.** Fix the rule "sanitize + sandboxed `srcdoc` iframe without `allow-scripts` + CSP that blocks remote loads + external links via the system browser" in the spec. On Tauri/Linux, the iframe/IPC caveat makes it mandatory.
5. **Tester distribution** (still unspecified on the map) carries fixed costs whatever the shell:
   - $99/yr Apple membership for notarization;
   - a Windows signing route (Artifact Signing only if the signer is a US/Canada individual or an eligible organization; otherwise OV);
   - a license decision, because the free open-source signing routes (SignPath, and update.electronjs.org's "open-source" framing) conflict with future monetization or need a public repo.
6. **Before locking in, do a one-hour Hyprland spike** with both hello-worlds: tray via Quickshell, a portal shortcut, a sandboxed email iframe, window behaviour, and (Electron) which `safeStorage` backend gets picked. This closes the gaps this research didn't measure (RAM, real Wayland behaviour).

## Verification

Adversarial fact-check on 2026-10-01. Each load-bearing claim was re-opened at its primary source, or checked through the GitHub/crates.io APIs and raw source files.

**Confirmed as written:**
- **Versions and dates.** Electron 44.0.0 on 2026-08-25 (Chromium M152, Node 24.18.1); 44.5.1 on 2026-09-29/30 (Chromium 152.0.7977.130, Node 24.21.0); 45.0.0 due 2026-10-20. 8-week cadence, 3 supported majors. Tauri 2.12.0 on 2026-09-26 and 2.12.1 on 2026-09-30. Tauri v3.0.0-alpha.0 on 2026-09-13, and alpha.3 plus runtime-cef alpha.4 on 2026-09-26. Wails 2.14.0 on 2026-08-10; v3 beta.0 on 2026-08-02 and beta.26 on 2026-09-25. Electrobun 2.0.2 on 2026-09-29. Electron 38.0.0 on 2025-09-02. DOMPurify 3.4.16.
- **Tauri v3 alpha notes.** Runtime selection moved to `Builder::runtime`. The Linux tray moves to ksni. `cleanup_before_exit` was added in alpha.3.
- **Electron breaking changes.** Wayland default in 38. macOS 11 dropped in 38 and macOS 12 in 44. Binary download on first run since 42.
- **Electron APIs.** The `globalShortcut` portal path is on by default and needs `desktopName`. Electron's 44 feature list also enables `GlobalShortcutsPortalPreferredTrigger`. `xdg-desktop-portal-hyprland` implements `GlobalShortcuts`. `global-hotkey` says "Linux (X11 Only)", and tauri#3578 has been open since 2022-03-01.
- **Trays.** Electron's Tray uses StatusNotifierItem and doesn't specify the activation gesture. Tauri's tray click events are "Linux: Unsupported".
- **Login items.** Electron's `setLoginItemSettings` is macOS/Windows only, with the "may silently fail" note. Tauri's autostart plugin exposes only the macOS launcher, uses `auto-launch` 0.6 (which has a systemd mode), and handles the AppImage path on Linux.
- **Hyprland autostart.** Hyprland doesn't run XDG autostart entries itself (discussion #3389). uwsm adds XDG autostart support.
- **Signing.** Microsoft's code-signing page (ms.date 2026-08-29): Artifact Signing about $9.99/month, individuals USA/Canada only; OV $150–300/yr; EV has had no instant bypass since 2024; unsigned gets a "Strong SmartScreen block". Apple's Sequoia Control-click removal was announced 2024-08-06. Tauri's macOS signing page says a free account cannot notarize.
- **Updaters.** Tauri updater signatures "cannot be disabled". electron-updater supports AppImage/DEB/Pacman/RPM and validates Windows signatures. update.electronjs.org needs a public GitHub repo and runs on macOS and Windows only.
- **Web platform.** MDN BCD: iframe `csp` is Chrome 61 only; `setHTML` is Chrome 146 and Firefox 148, not Safari. Chrome 142 Local Network Access prompt.
- **Node.** `node:sqlite` is 1.2 (RC since 24.15.0). SEA is 1.1. Both checked in the v24.21.0 docs.
- **Source SDKs.** Linear `@linear/sdk`; the Graph SDK list has TS/JS and no Rust; Gmail has Node.js and no Rust; GitHub lists octocrab as third-party.
- **Other platforms.** `webview_flutter` is Android/iOS/macOS only. Capacitor is on v8. Wails v3 needs Go 1.25+, defaults to GTK4 + WebKitGTK 6.0, and treats mobile as experimental.
- **Tauri API.** `on_web_resource_request` is "only implemented for the tauri URI protocol". `add_child` is behind `unstable`.
- **Footprint.** Electron 44.5.1 asset sizes: 117.2, 124.2 and 150.7 MiB. Hopp benchmark: 172 vs 409 MB and 8.6 vs 244 MiB, N=1. The Tauri docs' "<600KB" and AppImage "2-6 MB to 70+ MB" quotes.
- **Cited issues.** All seven cited Tauri/Electron issues are still open.
- **Repo and local machine.** The repo is public with `license: null`. Local observations were re-checked: Node 24.20.0, pnpm 12.4.2, rustc 1.98.1, Go 1.27.1, webkit2gtk-4.1 2.52.6, xdph 1.4.1, StatusNotifierWatcher owned by `qs`, `xdg-desktop-autostart.target` inactive.

**Corrected or added:**
- `safeStorage` on Hyprland. The original said it falls back only when there is no secret store. The docs also fall back to `basic_text` when the desktop environment is "not recognised", and Hyprland isn't on the list. Added this caveat, the `--password-store=gnome-libsecret` mitigation, and the observation that gnome-keyring is running. Also added it to the short answer and the spike list.
- `IsolateSandboxedIframes`, previously "not verified". It is `FEATURE_ENABLED_BY_DEFAULT` in Chromium, and Electron's 44-x-y feature list doesn't disable it. It is now marked very likely on, from source rather than a runtime check.
- Tauri localhost quote. The warning is about the localhost *plugin*, not localhost serving in general. Reworded.
- Tauri capabilities iframe caution. Noted that it sits under "Remote API Access". It still applies to any script-capable iframe in a window.
- Tauri updater. Replaced the unsourced `rpm -U` detail with the changelog versions: deb in 2.1.0, all bundle types in 2.10.0.
- node-llama-cpp. The guide's warning is about renderers, and it doesn't address `utilityProcess`.
- Electrobun history. 0.0.19 betas were released in July 2025, before 0.1.0 (2025-08-25).
- Artifact Signing: added the organization regions and "no instant SmartScreen trust". SignPath: added the "for all components" and no-proprietary-code / already-released conditions.

**Could not confirm:**
- RAM and startup on this machine. No first-hand measurement; only secondary data.
- Real Hyprland behaviour of either shell (tray click, portal shortcut, window rules). Neither app was launched.
- Whether Electron's Secret-portal backend is tried outside Flatpak on Hyprland.
- A Tauri v3 / runtime-cef stable timeline. None is published.
- Whether Tauri's `keyring` crate route behaves differently from `safeStorage` on Hyprland. It talks to the Secret Service directly, but this wasn't tested.

## Sources

All accessed 2026-10-01.

**Tauri**
- Releases (2.12.1, v3 alphas, runtime-cef): https://github.com/tauri-apps/tauri/releases ; https://github.com/tauri-apps/tauri/releases/tag/tauri-v3.0.0-alpha.0 ; https://github.com/tauri-apps/tauri/releases/tag/tauri-v3.0.0-alpha.3
- Tauri 2.12 announcement: https://v2.tauri.app/blog/tauri-2.12/
- Tauri 2.0 stable announcement: https://v2.tauri.app/blog/tauri-20/
- Verso integration: https://v2.tauri.app/blog/tauri-verso-integration/
- What is Tauri: https://v2.tauri.app/start/
- Prerequisites: https://v2.tauri.app/start/prerequisites/
- Webview versions: https://v2.tauri.app/reference/webview-versions/
- Linux graphics issues: https://v2.tauri.app/develop/debug/linux-graphics/
- App size: https://v2.tauri.app/concept/size/
- Sidecar: https://v2.tauri.app/develop/sidecar/
- Node.js as a sidecar: https://v2.tauri.app/learn/sidecar-nodejs/
- System tray: https://v2.tauri.app/learn/system-tray/
- Autostart plugin: https://v2.tauri.app/plugin/autostart/ ; source https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/autostart/src/lib.rs
- auto-launch crate: https://docs.rs/auto-launch/latest/auto_launch/
- Updater plugin: https://v2.tauri.app/plugin/updater/ ; changelog https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/CHANGELOG.md
- Global shortcut plugin: https://v2.tauri.app/plugin/global-shortcut/ ; https://github.com/tauri-apps/global-hotkey ; https://github.com/tauri-apps/tauri/issues/3578
- Localhost plugin: https://v2.tauri.app/plugin/localhost/
- Stronghold plugin: https://v2.tauri.app/plugin/stronghold/
- Plugin platform metadata: https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins
- Security, CSP: https://v2.tauri.app/security/csp/
- Security, capabilities (iframe caveat): https://v2.tauri.app/security/capabilities/
- Isolation pattern: https://v2.tauri.app/concept/inter-process-communication/isolation/
- API docs: https://docs.rs/tauri/latest/tauri/struct.Builder.html ; https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html ; https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html ; https://docs.rs/tauri/latest/tauri/window/struct.Window.html ; https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/app.rs
- Distribution: https://v2.tauri.app/distribute/ ; https://v2.tauri.app/distribute/appimage/ ; https://v2.tauri.app/distribute/pipelines/github/
- Signing: https://v2.tauri.app/distribute/sign/macos/ ; https://v2.tauri.app/distribute/sign/windows/ ; https://v2.tauri.app/distribute/sign/linux/
- Open issues cited: https://github.com/tauri-apps/tauri/issues/15656 ; https://github.com/tauri-apps/tauri/issues/14234 ; https://github.com/tauri-apps/tauri/issues/11412 ; https://github.com/tauri-apps/tauri/issues/14913 ; https://github.com/tauri-apps/tauri/issues/12411

**Electron**
- Releases and schedule: https://releases.electronjs.org/ ; https://releases.electronjs.org/schedule ; v44.5.1 assets https://github.com/electron/electron/releases/tag/v44.5.1
- Timelines and support policy: https://www.electronjs.org/docs/latest/tutorial/electron-timelines
- Breaking changes (Wayland default in 38, postinstall removal in 42, macOS support removals): https://www.electronjs.org/docs/latest/breaking-changes
- Docs index: https://www.electronjs.org/docs/latest/
- Tray: https://www.electronjs.org/docs/latest/api/tray
- app (login items, window-all-closed): https://www.electronjs.org/docs/latest/api/app
- utilityProcess: https://www.electronjs.org/docs/latest/api/utility-process
- globalShortcut (portal): https://www.electronjs.org/docs/latest/api/global-shortcut
- BaseWindow (Wayland notes): https://www.electronjs.org/docs/latest/api/base-window
- autoUpdater: https://www.electronjs.org/docs/latest/api/auto-updater ; updates tutorial https://www.electronjs.org/docs/latest/tutorial/updates ; https://github.com/electron/update.electronjs.org
- electron-builder auto-update: https://www.electron.build/docs/features/auto-update
- Code signing: https://www.electronjs.org/docs/latest/tutorial/code-signing
- Security checklist: https://www.electronjs.org/docs/latest/tutorial/security
- Web embeds: https://www.electronjs.org/docs/latest/tutorial/web-embeds
- WebRequest: https://www.electronjs.org/docs/latest/api/web-request ; protocol: https://www.electronjs.org/docs/latest/api/protocol
- safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage
- Native modules: https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules
- node:sqlite fix: https://github.com/electron/electron/pull/47706
- Forge (pnpm note): https://www.electronforge.io/
- Open issues cited: https://github.com/electron/electron/issues/54594 ; https://github.com/electron/electron/issues/53814
- node-llama-cpp in Electron: https://node-llama-cpp.withcat.ai/guide/electron

**Other shells**
- Wails releases: https://github.com/wailsapp/wails/releases ; v3 beta notes: https://github.com/wailsapp/wails/releases/tag/v3.0.0-beta.0 ; status page source https://github.com/wailsapp/wails/blob/master/docs/mpress/content/status.md
- Electrobun: https://github.com/blackboardsh/electrobun ; releases https://github.com/blackboardsh/electrobun/releases
- Dioxus desktop: https://github.com/DioxusLabs/dioxus/blob/main/packages/desktop/Cargo.toml
- Qt WebEngine platform notes: https://doc-snapshots.qt.io/qtwebengine/qtwebengine-platform-notes.html
- webview_flutter: https://pub.dev/packages/webview_flutter
- Capacitor: https://capacitorjs.com/docs
- PWA install support: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Installing
- Chrome Local Network Access: https://developer.chrome.com/blog/local-network-access

**Linux / Hyprland**
- Hyprland binds (global dispatcher): https://wiki.hypr.land/Configuring/Basics/Binds/
- uwsm (XDG autostart): https://wiki.hypr.land/useful-utilities/uwsm/
- XDG autostart under Hyprland: https://github.com/hyprwm/Hyprland/discussions/3389
- xdg-desktop-portal-hyprland interfaces: https://github.com/hyprwm/xdg-desktop-portal-hyprland/blob/master/hyprland.portal

**Web platform and email HTML**
- HTML spec, iframe sandbox and srcdoc: https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox
- HTML spec, srcdoc policy container inheritance: https://html.spec.whatwg.org/multipage/browsers.html#determining-navigation-params-policy-container
- MDN iframe: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe
- MDN browser-compat-data (iframe `csp`, `Element.setHTML`): https://github.com/mdn/browser-compat-data
- WebView2 IsolateSandboxedIframes: https://github.com/MicrosoftEdge/WebView2Announcements/issues/99
- DOMPurify: https://github.com/cure53/DOMPurify
- ammonia: https://github.com/rust-ammonia/ammonia

**Signing and distribution**
- Apple, macOS Sequoia Gatekeeper change: https://developer.apple.com/news/?id=saqachfa
- Apple, opening apps from unknown developers: https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac
- Microsoft, code signing options (updated 2026-08-29): https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
- SignPath Foundation terms: https://signpath.org/terms
- GitHub Actions billing: https://docs.github.com/en/billing/concepts/product-billing/github-actions

**Source SDK languages**
- Linear SDK: https://linear.app/developers/sdk
- Microsoft Graph SDKs: https://learn.microsoft.com/en-us/graph/sdks/sdks-overview
- Gmail client libraries: https://developers.google.com/gmail/api/downloads
- GitHub REST libraries: https://docs.github.com/en/rest/using-the-rest-api/libraries-for-the-rest-api

**Node**
- node:sqlite: https://nodejs.org/docs/latest-v24.x/api/sqlite.html
- Single executable applications: https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html

**Secondary (benchmarks, labelled as such)**
- Hopp, "Tauri vs. Electron" (2025-04-09, N=1): https://www.gethopp.app/blog/tauri-vs-electron
- levminer, "Tauri vs Electron" (2022-08-22, informal): https://www.levminer.com/blog/tauri-vs-electron
- Third-party standalone CEF runtime README (CEF status context): https://github.com/SableClient/tauri-runtime-cef

**Local observations (author's machine, 2026-10-01)**
- Toolchains: Node 24.20.0, pnpm 12.4.2, rustc 1.98.1, Go 1.27.1. Packages: webkit2gtk-4.1 2.52.6, xdg-desktop-portal-hyprland 1.4.1, libayatana-appindicator 0.6.0.
- Session: `XDG_SESSION_TYPE=wayland`, Hyprland. StatusNotifierWatcher owned by Quickshell (`qs`). `xdg-desktop-autostart.target` inactive.
- Builds: Tauri hello-world built with `pnpm tauri build --bundles deb,appimage`. Electron 44.5.1 runtime downloaded by the `electron` package's `install.js` and measured with `du`. Neither app was launched.
