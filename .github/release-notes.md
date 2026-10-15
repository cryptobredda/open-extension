Open Extension 1.3.0 replaces the separate browser bridge with native OpenCode tools and recreates the compact dark side-panel UI.

- No separate process, port, Node installation or browser pairing key for the prebuilt extension. Browser commands use the existing authenticated OpenCode HTTP/event connection.
- Enable the bundled native OpenCode plugin once from Connection settings. All AI, models and history remain on your existing server; live tools stay restricted to the active website.
- Compact conversation bubbles, slim composer with agent/model controls, review cards and a centered **Open Extension** welcome screen.
- Dedicated top-level **Scripts** tab with **This site / All sites**, search, website/name/date sorting, status filters, toggles, code editing, agent-assisted updates and deletion.
- Verified full-domain script persistence across refreshes, SPA navigation and alternate DOM layouts.
- Free-tier diagnostics: the reported OpenCode free-model rejection also occurs with browser-only permissions on a real native backend. Removing the bridge does not resolve that provider policy. Errors now explain how to select another connected model.

Download **open-extension-chrome-v1.3.0.zip**, extract it, and load its `open-extension/extension` directory using Chrome/Brave’s **Load unpacked**. Requires Chrome/Brave 138+ and OpenCode 2.0.29. Enable **Allow User Scripts**, connect to your existing OpenCode service, then click **Enable native browser tools**. This installs `.opencode/plugins/open-extension.js` in the selected backend project and reloads its plugins. The project ZIP also includes sources and a compiled `dist` build.

Upgrading from 1.2: replace the build files in your **existing unpacked extension folder**, then click **Reload** on its existing Chrome entry. Keeping the same folder/extension ID preserves saved scripts and connection preferences. Loading a different folder can create a separate extension with fresh storage. Old bridge credentials are discarded. Stop `npm run bridge` after enabling the native plugin. Existing approved site scripts continue to work offline.

Validation includes TypeScript/unit checks, native RPC integration in real Chrome, script-library/browser-restart coverage, and an isolated actual OpenCode 2.0.29 server with a controlled local provider driving the complete browser workflow. See the README for setup, architecture and provider-policy details.
