Open Extension connects a Chrome or Brave side panel to your existing local OpenCode backend. All model reasoning, tool calls and conversation history stay on OpenCode.

- Edit and verify the active website's live DOM with browser-only MCP tools.
- Save reversible scripts for every route on a domain, including dynamic SPA content.
- Update an existing script for another page layout while preserving its earlier behavior.
- Select connected OpenCode models directly in the composer.
- OpenCode-style dark theme, real reasoning/tool events and shared backend sessions.

Download the **open-extension-project** ZIP for the complete project, including the compiled extension and browser bridge. Requires Node.js 22+, Chrome/Brave 138+, and an existing OpenCode service with a configured agent and model. Run `npm ci` and `npm run bridge`, then load the project's `dist` directory as an unpacked extension. The smaller **open-extension-chrome** ZIP contains only the browser extension; the bridge is still required.

The **OpenCode pairing credential** and **browser bridge token** are separate. Paste the token printed by the running bridge into Browser bridge token, and confirm Browser tools says Ready in OpenCode.

See the repository README for installation, permissions, script persistence and development instructions. Verified with OpenCode 2.0.29, including real backend model requests and browser execution using a controlled local provider.
