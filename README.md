# Open Extension

A Manifest V3 Chrome side panel for your **existing local OpenCode server**. Describe a page change, see it happen, inspect the result, then approve a reusable site script. There is no embedded model, separate chat database, or third-party AI service in the extension.

[Download v1.2.0](https://github.com/cryptobredda/open-extension/releases/tag/v1.2.0) · [Report an issue](https://github.com/cryptobredda/open-extension/issues)

## Install

Version **1.2.0** supports the native **OpenCode 2.0.29** API and automatically detects legacy 1.x servers. Requires **Chrome/Brave 138+**, **Node.js 22+**, and an existing OpenCode service with a configured agent and model/provider.

```sh
git clone https://github.com/cryptobredda/open-extension.git
cd open-extension
npm ci
npm run build
npm run bridge
```

For a prebuilt installation, download **`open-extension-project-v1.2.0.zip`** from Releases. It contains both the compiled extension and browser bridge source. Extract it, run `npm ci` and `npm run bridge` inside the project folder, then load its `dist` directory. The smaller Chrome ZIP contains only the extension and requires a separately running bridge.

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this project's **`dist`** directory. Alternatively, extract `release/open-extension-chrome.zip` and select its `open-extension/extension` directory.
2. On Open Extension's **Details** page, enable **Allow User Scripts**.
3. Click the extension icon, or press **Alt+Shift+O**, to open the side panel.
4. For OpenCode 2, run **`opencode pair`** and paste a **fresh, unopened full link** into **OpenCode pairing link** in Connection settings. The extension redeems it with `Accept: application/json` and uses the returned session credential as the Basic Auth password. Alternatively, enter the service URL and actual service password. The username defaults to `opencode`. The v2 defaults are `http://127.0.0.1:49374` on macOS/Linux/WSL and port `45278` on Windows; legacy CLI defaults to `4096`. Use `opencode service status` to check your actual address.
5. Paste the token printed by `npm run bridge` into **Browser bridge token**. This is separate from the OpenCode pairing link/password. Leave Bridge URL at `http://127.0.0.1:49375` unless configured otherwise. Click **Pair & connect** when using a link, or **Save & connect** with a service password. OpenCode should report its actual version and Browser tools should show **Ready in OpenCode**.
6. Select a normal website tab, choose a connected model in the composer, and send a message. Open Extension creates a real backend session, or you can attach an existing one from **Conversations**. **Build** selects a primary agent from your backend; **Fast Open** opens the same server's web interface.

**Two different credentials:** the OpenCode password/pairing link authenticates the AI server. The **Browser bridge token** must match the token printed by the running `npm run bridge` process. A green OpenCode connection does not mean the browser bridge is connected; Browser tools must also show **Ready in OpenCode**. If the panel reports that browser tools are disconnected, check the bridge process and that its token matches the value saved in settings.

Do not launch a second OpenCode server just for this extension. It attaches to the service you already use. The build and bridge commands above do not start an OpenCode instance.

**Discovery** checks native v2 `/api/info` and legacy `/global/health` at the configured URL and common localhost ports without sending stored credentials to those ports. A protected candidate is marked unverified until you connect. Loopback, IPv6 loopback, private LAN addresses (including `192.168.x.x`) and configured `.local` names are supported. `.local` resolution uses the operating system; the extension does not perform a DNS-SD service enumeration or inspect your machine's process list or secret files.

### Upgrade from 1.0.0 or 1.1.0

Replace the files in the existing project folder with the **1.2.0 project ZIP**, keeping the same loaded `dist` path so Chrome retains scripts, settings and the extension ID. Stop the old bridge, run `npm ci`, then `npm run bridge`. The ZIP includes the compiled extension; use `npm run build` only after editing source. Click **Reload** on Open Extension in `chrome://extensions`, then reopen the panel. Its Details page should show **1.2.0**. Existing OpenCode pairing and user-script permission remain valid; re-pair only if your service credential expired.

Version 1.2.0 fixes requests being interpreted as local coding tasks. Panel turns now get a fresh DOM snapshot, explicit website instructions and session-scoped permissions that expose only this extension's browser tools. File, shell, subagent and unrelated MCP tools are denied in these sessions. This applies to a session you use from the panel, including attached sessions, and is shared with other OpenCode clients; global agents, project files and provider configuration are unchanged. A missing bridge or disabled user scripting stops the request before any prompt is sent.

The composer model selector lists the server's enabled models by provider, filters by name or ID, switches the actual session immediately and remembers the preference for new chats. Model changes made by other clients appear in the selector. **OpenCode default** selects the backend/agent default. Models without tool calling cannot be used for page changes. The dark UI follows OpenCode's official `oc-2` palette.

Version 1.0.0 used a legacy health API on native v2 servers. If upgrading from that version without a working connection, run `opencode pair` and paste a fresh unopened link into **OpenCode pairing link**, retaining your Browser bridge token. Links work once and expire after five minutes. A pairing link opened in a normal browser creates a cookie that is separate from the extension's own connection.

### Why a small local bridge is included

OpenCode must receive real tools through MCP. An MV3 service worker cannot listen for inbound HTTP requests or run a local process. The included Node process exposes an authenticated, loopback-only MCP endpoint and relays tool calls over a paired WebSocket to the extension. It has no model, chat storage, OpenCode credentials, filesystem tools, or browser automation engine.

The extension registers it dynamically through native v2 **`PUT /api/experimental/mcp/open_extension`**, or **`POST /mcp`** on a legacy server, in the selected project. The v2 registration uses `codemode: false` to expose the `open_extension_*` tools directly to the agent. This does not rewrite your `opencode.json`. The bridge must be running while using browser tools. To run it as a background service, point your OS service manager at `node /absolute/path/to/open-extension/dist/bridge.mjs` with Node 22+ and the project's installed dependencies available. Startup and shutdown are controlled by your service manager; no system services are installed automatically.

The pairing token is created once in the user's configuration directory: `%APPDATA%/open-extension/bridge-token` on Windows, `$XDG_CONFIG_HOME/open-extension/bridge-token` when configured, otherwise `~/.config/open-extension/bridge-token`. It is created with owner-only Unix permissions. Keep it private. The token is also stored in the extension's trusted local storage for automatic reconnection.

```sh
# Optional bridge overrides; no OpenCode provider credentials belong here.
OPEN_EXTENSION_BRIDGE_PORT=49375 npm run bridge
# Or provide a persistent token of at least 32 characters through
# OPEN_EXTENSION_BRIDGE_TOKEN in your service configuration.
```

## Workflow

- **Observe:** every request automatically supplies a fresh snapshot of the active page URL, title, text, relevant element attributes, geometry and sanitized HTML. The agent can query the live DOM for more detail. Requests such as “remove Relevant people” refer to this website.
- **Experiment:** JavaScript executes immediately in the active page's main context through Chrome's userScripts API. CSS, DOM operations, listeners and observers can use cleanup helpers. Every mutation returns a fresh observation for the agent to compare against the request; code execution alone is not labeled a successful verification.
- **Review:** after a live change and observation, the agent can call `site_script_propose`. **Update site script?** shows the name, domains, description, and complete code. Nothing is saved before the user's approval.
- **Keep:** proposals default to **every route on the current domain**, such as `*://x.com/*`, and cannot silently add other domains. Approving saves a named, versioned script in `chrome.storage.local` and registers it with `chrome.userScripts`. It applies immediately and on future page loads, even with the panel and OpenCode closed. SPA URL changes trigger cleanup and reinjection. Use `api.watch` for DOM updates that do not change the URL.
- **Improve:** if another page has a different layout, disable the script, open that page and click the script’s **Update with OpenCode** icon. Describe what else to remove. The agent receives the existing code and script ID, tests the new layout and proposes one complete replacement revision that preserves earlier behavior. Approval updates and enables the same script. You can also ask for an update in ordinary chat.
- **Undo:** toggling off or deleting a script unregisters future injection and runs its tracked cleanup on currently matching tabs. The undo icon above the script list cleans up temporary experiments without disabling saved scripts. You can review, edit, add, or delete scripts from their list.

Live agent tools are bound to a short-lived capability for **the foreground tab and exact URL authorized when sending the message**. They never accept a tab ID from the agent. Switching tabs, moving to another URL, closing the panel, or finishing a turn revokes control. Send a new message to authorize the new page. Already-approved saved scripts run on their approved domain matchers in all matching tabs.

## Reversible script API

Script code is the body of an async function with `api` and DOM globals available. Saved scripts default to the isolated `USER_SCRIPT` world; select `MAIN` only when access to the page's JavaScript globals is needed. Live experiments execute in `MAIN`. Credentials and extension APIs are never injected into either world.

```js
api.css(`
  .promo, .newsletter-popup { display: none !important; }
  main { max-width: 76ch; margin-inline: auto; }
`);

// Runs immediately and when content, attributes or text change. DOM writes inside the callback
// do not trigger the same observer again. Helpers keep per-script undo layers.
api.watch(() => {
  api.text('.page-title', 'My workspace');
});

const button = document.querySelector('.shortcut');
if (button) {
  api.on(button, 'click', () => {
    document.querySelector('main')?.scrollIntoView({ block: 'center' });
  });
}
```

| Helper                                                     | Behavior on disable/delete/reset                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `api.css(css)`                                             | Removes its constructed stylesheet; also works under strict inline-style CSP. |
| `api.hide(selectorOrElement)`                              | Removes its hiding rule or restores the element's hidden attribute.           |
| `api.remove(selectorOrElement)`                            | Restores original nodes at retained placeholders.                             |
| `api.text(selectorOrElement, text)`                        | Restores original child nodes, including their event listeners.               |
| `api.attr(selectorOrElement, name, valueOrNull)`           | Restores the preceding attribute layer.                                       |
| `api.append(selectorOrElement, node)`                      | Removes the appended node.                                                    |
| `api.on(target, event, listener, options?)`                | Removes its listener.                                                         |
| `api.watch(callback, root?)`                               | Disconnects its MutationObserver. Defaults to the document element.           |
| `api.interval(callback, ms)` / `api.timeout(callback, ms)` | Clears its timer.                                                             |
| `api.onCleanup(callback)`                                  | Runs custom cleanup in reverse registration order.                            |
| `api.query(selector)` / `api.queryAll(selector)`           | Returns matching DOM elements.                                                |

Callbacks should be idempotent. A script may return a cleanup function, and partial helper effects are cleaned up if execution fails. Async setup has a 20-second deadline; event handlers and registered observers may live for the document lifetime. If you construct an observer or listener directly, disconnect/remove it in `api.onCleanup`.

**Reversibility has a concrete boundary:** helper-managed page effects are undone immediately. Arbitrary JavaScript that changes untracked application state may require a page reload. External effects such as sending a request, submitting a form, or clicking a purchase button cannot be undone by a script toggle. Persistent scripts generated by the agent are instructed to use the helpers and explicit cleanup.

## OpenCode integration

Uses the official browser-compatible **`@opencode/client@2.0.29`** for native OpenCode 2. The older **`@opencode-ai/sdk/v2/client`** is retained only for legacy servers; that package entrypoint is not the native OpenCode 2 server protocol. Neither client launches an OpenCode process. All authenticated HTTP and SSE traffic is proxied through the extension service worker. Requests prohibit redirects and omit ambient browser credentials.

| Operation                | Native OpenCode 2 API                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Identity / compatibility | `GET /api/info`, `GET /openapi.json`                                                                          |
| Pairing                  | `GET /auth/connect/{code}` with JSON negotiation; returned token is used as Basic Auth password               |
| Shared sessions          | `GET/POST /api/session`, `GET /api/session/{sessionID}`, `GET /api/session/active`                            |
| Full conversation        | Paginated `GET /api/session/{sessionID}/message`; all pages are read                                          |
| Send / stop              | `POST /api/session/{sessionID}/prompt`, `POST /api/session/{sessionID}/interrupt`                             |
| Browser instructions     | `PUT /api/experimental/session/{sessionID}/instructions/entries/open-extension.browser`                       |
| Streaming                | Authenticated native `GET /api/event` with reconnect and authoritative history refresh                        |
| Browser tools            | `PUT /api/experimental/mcp/open_extension`, `GET /api/mcp`, authenticated Streamable HTTP MCP over the bridge |
| Approvals                | `/api/permission/request`, `/api/session/{sessionID}/permission/{requestID}/reply`                            |
| Questions                | Native v2 pending forms and `/api/session/{sessionID}/form/{formID}/reply`/cancel                             |
| Models / agents          | `GET /api/model`, `GET /api/agent`, session model/agent switch APIs                                           |

The native v2 prompt body contains text and attachments, not the legacy `system`, `parts`, or `tools` fields. Browser context is delivered through a durable native instruction entry before the prompt. Model and agent selections use their native session APIs. The extension does not change global agent, provider, or service configuration.

The conversation renders backend-provided reasoning, native assistant units, tool inputs/results, execution outcomes, and historical context. Native text/reasoning deltas use assistant IDs and ordinals; they are not treated as v1 message-part events. The client reads all session/message pages and handles native permissions and typed forms. Some models do not emit reasoning. The backend remains authoritative for its own permissions and session state.

The native service is recognized by `/api/info` before any legacy health probe. The live native OpenAPI JSON is at `/openapi.json`; on 2.0.29 `/doc` serves HTML. Legacy 1.x servers continue to use `/global/health`, `/doc`, `/session`, `/event` and their existing request formats.

Official references:

- [OpenCode 2 HTTP API and pairing](https://opencode.ai/v2/docs/api)
- [OpenCode 2 JavaScript client](https://opencode.ai/v2/docs/build/client)
- [OpenCode 2 pairing and service configuration](https://opencode.ai/v2/docs/cli/web)
- [OpenCode 2 MCP tool names and Code Mode](https://opencode.ai/v2/docs/mcp-servers)
- [Legacy server API](https://opencode.ai/docs/server/)
- [Chrome sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Chrome userScripts](https://developer.chrome.com/docs/extensions/reference/api/userScripts)

## Permissions and storage

`sidePanel` hosts the persistent client. `scripting` and `userScripts` provide observation and page code. `tabs` and `activeTab` identify the foreground page; `webNavigation` catches SPA routes; `alarms` repairs persisted script registrations after updates or worker restarts. HTTP(S) host permissions support both arbitrary websites and the configured local backend. The extension does not request file or incognito access.

Settings and site scripts live in trusted-context Chrome local storage, inaccessible to the content script. The OpenCode password defaults to session-only storage. **Remember password** opts into local storage, which is not an encrypted credential vault. Conversations are fetched from OpenCode and are not mirrored into Chrome storage. No telemetry, remote executable extension code, model API keys, or external UI assets are used.

Chrome protects internal pages, the Web Store, and some browser-managed viewers; those cannot be modified. Observation targets the top-level document. Closed shadow roots and cross-origin frames are not included in DOM snapshots. Page data is treated as untrusted and is never allowed to call privileged extension RPC. Normal user-generated JavaScript runs through the required userScripts API rather than `eval` or a relaxed extension CSP.

## Development and verification

```sh
npm run check              # Typecheck, unit/transport tests, production build
npx playwright install chromium
npm run test:e2e           # Actual MV3 Chromium integration, isolated local fixture
npm run package           # Creates the Chrome and complete project ZIPs
```

The browser test checks strict-CSP execution, the paired MCP transport, observe/change/verify/propose/approve, immediate cleanup, listeners, browser-restart persistence, reload and SPA reinjection, dynamic DOM, backend event rendering, and refusal after the active tab changes. Fixture conversation text lives only in the test suite; the extension has no demo mode or preloaded chats/scripts.

Native v2 browser tests verify pairing through the actual extension UI, v2 prompts and instructions, reasoning/tool streams, real browser MCP calls, script approval and cleanup. An additional live-server test checks real OpenCode **2.0.29**, including session creation/attachment, native instructions, real MCP registration, and native form submission. Run these against a disposable test server:

```sh
OPENCODE2_TEST_URL=http://127.0.0.1:49374 \
OPENCODE2_TEST_PASSWORD=your-test-server-password \
npm run test:e2e
```

Use a disposable test server: the native test creates/deletes a session and registers/removes an `open_extension` runtime MCP entry. It does not invoke a model. Legacy live-server regression tests can additionally be enabled with `OPENCODE_TEST_URL` and `OPENCODE_TEST_PASSWORD`; those register/disconnect `open_extension_contract_test`. Both native 2.0.29 and legacy 1.19.0 were verified. The separate real-server DOM test launches an isolated **actual OpenCode 2.0.29 binary** with a local deterministic OpenAI-compatible provider. OpenCode makes its own provider requests and executes MCP calls; the test never invokes browser tools on the agent’s behalf. It asserts that the provider receives the fresh page context and only the seven browser tools, then exercises live DOM removal, verification, approval, full-domain reload/SPA persistence, disabled-script updates for another layout, cleanup and model switching across clients. Run it without affecting your shared service:

```sh
OPENCODE2_BINARY=/absolute/path/to/opencode npm run test:e2e
```

This verifies real backend execution and the browser workflow with controlled model outputs. It does not establish that every provider/model will choose correct selectors for every website.

Source layout: `src/panel` (React client), `src/background` (proxy, sessions, tool authorization, persistence), `src/content` (DOM observation and reversible runtime), `bridge` (loopback MCP relay), and `tests` (transport, lifecycle, browser and live-server contracts).

Licensed under MIT. Dependencies retain their own licenses; bundled extension files preserve their license notices.
