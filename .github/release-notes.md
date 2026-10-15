Open Extension 1.3.1 fixes the reported OpenCode free-model failure while preserving website-only execution.

- Addresses the upstream tool-catalog bug tracked in [OpenCode #51241](https://github.com/anomalyco/opencode/issues/51241) and [#50627](https://github.com/anomalyco/opencode/issues/50627): genuine OpenCode requests can be rejected when standard tools are removed.
- Retains OpenCode’s real file-reading and shell interfaces in the permission-gated `ask` state, while a separate native server guard blocks every call before execution. File/shell access is not granted, and the guard cannot be bypassed by approving a permission in another client.
- The browser-only guard persists across panel closure, plugin reloads and backend restarts. Ordinary OpenCode sessions remain unaffected.
- Requires the updated native plugin. Protocol validation prevents applying the compatibility policy through an older, unguarded plugin.
- Corrects the old error guidance and shows **Step failed** for failed model steps.

**Upgrade both components:** download `open-extension-chrome-v1.3.1.zip`, replace the compiled files in your **existing unpacked extension folder**, then click Reload on its existing Chrome entry. Keeping the same folder/extension ID preserves saved scripts and connection preferences. Open **Connection settings → Enable native browser tools** (or **Update native browser tools**) to install the backend guard. Retry your message; you can keep the same conversation.

Requires Chrome/Brave 138+ and an existing OpenCode 2.0.29 service. No bridge process, extra port, pairing key or Node installation is needed for the prebuilt extension. The project ZIP includes all sources and a compiled `dist` build.

The previous 1.3.0 diagnosis was incomplete: bridge removal was unrelated, but this is an upstream compatibility bug rather than an unavoidable restriction on the extension. See the README for the native policy, regression tests and opt-in real free-provider DOM test. Provider quotas and service availability still apply.

Validated with **38 unit tests and three Chrome integration tests**, including an actual **OpenCode 2.0.29 + DeepSeek V4.1 Flash Free** workflow: live DOM removal, re-observation, script proposal/approval and refresh persistence. Deliberate native file and shell attempts were rejected, including after plugin reload and a permission change from another client.
