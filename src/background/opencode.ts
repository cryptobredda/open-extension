import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { OpenCode as NativeOpenCode } from '@opencode/client';
import type { FormInfo } from '@opencode/client';
import type {
  Settings,
  BackendEvent,
  ConversationMessage,
  Session,
  ModelCatalog,
} from '../shared/types';
import { localUrl, pairingLink } from '../shared/validation';
import { readSSE } from '../shared/sse';
import { v2Message, v2Session } from '../shared/opencode-v2';
import { BROWSER_PERMISSIONS } from '../shared/browser-context';

export type Protocol = 'auto' | 'v1' | 'v2';

export class OpenCode {
  readonly settings: Settings;
  readonly native;
  private readonly legacy;
  protocol: Protocol;
  constructor(settings: Settings, protocol: Protocol = 'auto') {
    this.settings = { ...settings, serverUrl: localUrl(settings.serverUrl) };
    this.protocol = protocol;
    const proxy: typeof fetch = (input, init) => this.fetch(new Request(input, init));
    this.legacy = createOpencodeClient({
      baseUrl: this.settings.serverUrl,
      directory: settings.directory || undefined,
      throwOnError: true,
      fetch: proxy,
    });
    this.native = NativeOpenCode.make({ baseUrl: this.settings.serverUrl, fetch: proxy });
  }
  private get location() {
    return this.settings.directory ? { directory: this.settings.directory } : undefined;
  }

  /** One view-facing contract; native v2 operations use the actual v2 client. */
  get client(): ReturnType<typeof createOpencodeClient> {
    if (this.protocol !== 'v2') return this.legacy;
    return {
      session: {
        list: async () => ({ data: await this.sessions() }),
        create: async (input: { title?: string }) => ({
          data: v2Session(
            await this.native.session.create({ title: input.title, location: this.location }),
          ),
        }),
        get: async ({ sessionID }: { sessionID: string }) => ({
          data: v2Session(await this.native.session.get({ sessionID })),
        }),
        messages: async ({ sessionID }: { sessionID: string }) => ({
          data: await this.messages(sessionID),
        }),
        status: async () => ({
          data: Object.fromEntries(
            Object.keys(await this.native.session.active()).map((id) => [id, { type: 'busy' }]),
          ),
        }),
        abort: async ({ sessionID }: { sessionID: string }) => ({
          data: await this.native.session.interrupt({ sessionID }),
        }),
        promptAsync: async (input: {
          sessionID: string;
          parts: { type: string; text?: string }[];
          system?: string;
          agent?: string;
          model?: { providerID: string; modelID: string };
        }) => {
          const { sessionID } = input;
          // These rules affect this session only. Tool.snapshot removes denied tools from
          // the model's catalog as well as rejecting any attempted calls to them.
          await this.restrictToBrowser(sessionID);
          if (input.agent) {
            const agents = (await this.native.agent.list({ location: this.location })).data;
            const agent = agents.find(
              (agent) =>
                agent.id === input.agent || agent.name.toLowerCase() === input.agent!.toLowerCase(),
            );
            if (!agent)
              throw new Error(
                agents.length
                  ? 'The selected agent is unavailable in this OpenCode project. Choose an agent using the Build control.'
                  : 'OpenCode has no agents configured for this project. Open the same project in OpenCode and configure an agent before sending a message.',
              );
            await this.native.session.switchAgent({ sessionID, agent: agent.id });
          }
          if (input.model)
            await this.native.session.switchModel({
              sessionID,
              model: { providerID: input.model.providerID, id: input.model.modelID },
            });
          const available = await this.models(sessionID);
          const selected = available.models.find((model) => model.value === available.selected);
          if (!selected?.tools)
            throw new Error(
              'Select a connected model with tool calling support before editing this website.',
            );
          // Native durable entries are rendered as model-visible session context.
          if (input.system)
            await this.native.session.instructions.entry.put({
              sessionID,
              key: 'open-extension.browser',
              value: input.system,
            });
          await this.native.session.prompt({
            sessionID,
            text: input.parts
              .filter((part) => part.type === 'text')
              .map((part) => part.text || '')
              .join('\n'),
          });
          return { data: undefined };
        },
      },
      app: {
        agents: async () => ({
          data: (await this.native.agent.list({ location: this.location })).data.map((agent) => ({
            ...agent,
            displayName: agent.name,
            name: agent.id,
          })),
        }),
      },
      provider: {
        list: async () => {
          const models = (await this.native.model.list({ location: this.location })).data.filter(
            (model) => model.enabled,
          );
          const ids = [...new Set(models.map((model) => model.providerID))];
          return {
            data: {
              all: ids.map((id) => ({
                id,
                name: id,
                models: Object.fromEntries(
                  models
                    .filter((model) => model.providerID === id)
                    .map((model) => [model.id, model]),
                ),
              })),
              connected: ids,
              default: {},
            },
          };
        },
      },
      mcp: {
        add: async ({
          name,
          config,
        }: {
          name: string;
          config: { url: string; headers?: Record<string, string> };
        }) => {
          await this.native.mcp.add({
            server: name,
            location: this.location,
            config: {
              type: 'remote',
              url: config.url,
              headers: config.headers,
              oauth: false,
              disabled: false,
              codemode: false,
              timeout: { startup: 20000, catalog: 20000, execution: 60000 },
            },
          });
          let servers = (await this.native.mcp.list({ location: this.location })).data;
          for (
            let n = 0;
            n < 20 && servers.find((server) => server.name === name)?.status.status === 'pending';
            n++
          ) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            servers = (await this.native.mcp.list({ location: this.location })).data;
          }
          return {
            data: Object.fromEntries(servers.map((server) => [server.name, server.status])),
          };
        },
      },
      permission: {
        list: async () => ({
          data: (await this.native.permission.request.list({ location: this.location })).data.map(
            (item) => ({
              ...item,
              permission: item.action,
              patterns: item.resources,
              always: item.save || [],
            }),
          ),
        }),
        reply: async ({
          requestID,
          reply,
        }: {
          requestID: string;
          reply: 'once' | 'always' | 'reject';
        }) => {
          const request = (
            await this.native.permission.request.list({ location: this.location })
          ).data.find((item) => item.id === requestID);
          if (!request) throw new Error('This permission request is no longer pending.');
          await this.native.permission.reply({
            sessionID: request.sessionID,
            requestID,
            decision: reply,
          });
          return { data: true };
        },
      },
      question: { list: async () => ({ data: [] }) },
    } as unknown as ReturnType<typeof createOpencodeClient>;
  }
  async restrictToBrowser(sessionID: string) {
    if (this.protocol === 'v2')
      await this.native.session.update({ sessionID, permissions: BROWSER_PERMISSIONS });
    else
      await this.legacy.session.update({
        sessionID,
        permission: BROWSER_PERMISSIONS.map((rule) => ({
          permission: rule.action,
          pattern: rule.resource,
          action: rule.effect,
        })),
      });
  }
  async models(sessionID?: string): Promise<ModelCatalog> {
    if (this.protocol === 'v2') {
      const [catalog, providers, defaultModel, session] = await Promise.all([
        this.native.model.list({ location: this.location }),
        this.native.provider.list({ location: this.location }),
        this.native.model.default({ location: this.location }),
        sessionID ? this.native.session.get({ sessionID }) : undefined,
      ]);
      const models = catalog.data
        .filter((model) => model.enabled)
        .map((model) => ({
          value: `${model.providerID}/${model.id}`,
          id: model.id,
          providerID: model.providerID,
          provider:
            providers.data.find((provider) => provider.id === model.providerID)?.name ||
            model.providerID,
          name: model.name,
          tools: model.capabilities.tools,
        }));
      const agent = session?.agent
        ? (await this.native.agent.list({ location: this.location })).data.find(
            (agent) => agent.id === session.agent,
          )
        : undefined;
      const fallback = agent?.model || defaultModel.data;
      const selected = session?.model || fallback;
      return {
        models,
        selected: selected ? `${selected.providerID}/${selected.id}` : '',
        default: fallback ? `${fallback.providerID}/${fallback.id}` : '',
      };
    }
    const result = (await this.legacy.provider.list()).data;
    const models = (result?.all || [])
      .filter((provider) => result?.connected.includes(provider.id))
      .flatMap((provider) =>
        Object.values(provider.models).map((model) => ({
          value: `${provider.id}/${model.id}`,
          id: model.id,
          providerID: provider.id,
          provider: provider.name,
          name: model.name,
          tools: model.capabilities?.toolcall !== false,
        })),
      );
    const firstDefault = Object.entries(result?.default || {}).find(([providerID, id]) =>
      models.some((model) => model.value === `${providerID}/${id}`),
    );
    const fallback = firstDefault ? `${firstDefault[0]}/${firstDefault[1]}` : '';
    return { models, selected: this.settings.model || fallback, default: fallback };
  }
  async selectModel(value: string, sessionID?: string) {
    const catalog = await this.models(sessionID);
    const model = catalog.models.find((model) => model.value === (value || catalog.default));
    if (!model && value)
      throw new Error('This model is no longer connected to OpenCode. Refresh the model list.');
    if (model && !model.tools)
      throw new Error('Choose a model with tool calling support to edit websites.');
    if (sessionID && this.protocol === 'v2') {
      if (!model)
        throw new Error('OpenCode has no default model configured. Select a connected model.');
      await this.native.session.switchModel({
        sessionID,
        model: { id: model.id, providerID: model.providerID },
      });
    }
    this.settings.model = value;
  }
  private async sessions(): Promise<Session[]> {
    const list: Session[] = [],
      cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.native.session.list({
        ...(cursor ? { cursor } : { order: 'desc' as const }),
        limit: 100,
        ...(this.settings.directory ? { directory: this.settings.directory } : {}),
      });
      list.push(...page.data.map(v2Session));
      cursor = page.cursor.next || undefined;
      if (cursor && cursors.has(cursor))
        throw new Error('OpenCode returned a repeated session pagination cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...new Map(list.map((item) => [item.id, item])).values()];
  }
  private async messages(sessionID: string): Promise<ConversationMessage[]> {
    const messages: ConversationMessage[] = [],
      cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.native.message.list({
        sessionID,
        limit: 100,
        ...(cursor ? { cursor } : { order: 'asc' as const }),
      });
      messages.push(...page.data.map((message) => v2Message(sessionID, message)));
      cursor = page.cursor.next || undefined;
      if (cursor && cursors.has(cursor))
        throw new Error('OpenCode returned a repeated message pagination cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...new Map(messages.map((item) => [item.info.id, item])).values()];
  }
  async forms(): Promise<FormInfo[]> {
    return this.protocol === 'v2'
      ? (await this.native.form.list({ location: this.location })).data
      : [];
  }
  headers(): Headers {
    const headers = new Headers();
    if (this.settings.password) {
      const bytes = new TextEncoder().encode(`${this.settings.username}:${this.settings.password}`);
      headers.set(
        'Authorization',
        `Basic ${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))}`,
      );
    }
    return headers;
  }
  async fetch(input: Request | string, init: RequestInit = {}): Promise<Response> {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== this.settings.serverUrl)
      throw new Error('Blocked a request outside the configured OpenCode server.');
    const headers = new Headers(request.headers);
    this.headers().forEach((value, key) => headers.set(key, value));
    const streaming = new URL(request.url).pathname.endsWith('/event');
    let response: Response;
    try {
      response = await fetch(
        new Request(request, {
          headers,
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          signal: streaming
            ? request.signal
            : AbortSignal.any([request.signal, AbortSignal.timeout(20000)]),
        }),
      );
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw new Error(
        `Cannot reach OpenCode at ${this.settings.serverUrl}. Check the address from opencode service status and that the service is running.`,
      );
    }
    if ([401, 403].includes(response.status))
      throw new Error(
        'OpenCode rejected the credentials. Use the OpenCode service password or paste a fresh opencode pair link. The browser bridge token is a separate credential.',
      );
    return response;
  }
  async inspect() {
    const infoResponse = await this.fetch(`${this.settings.serverUrl}/api/info`);
    if (infoResponse.ok && infoResponse.headers.get('content-type')?.includes('json')) {
      const info = await infoResponse.json();
      if (
        typeof info.version === 'string' &&
        Number.isInteger(info.pid) &&
        Array.isArray(info.urls)
      ) {
        this.protocol = 'v2';
        return {
          version: info.version as string,
          protocol: 'v2' as const,
          spec: await this.inspectSpec('/openapi.json', [
            '/api/info',
            '/api/session',
            '/api/event',
          ]),
        };
      }
    }
    const response = await this.fetch(`${this.settings.serverUrl}/global/health`);
    if (!response.ok || !response.headers.get('content-type')?.includes('json'))
      throw new Error(
        `The address returned HTTP ${response.status} (${response.headers.get('content-type') || 'no content type'}) instead of an OpenCode API. Checked v2 /api/info and legacy /global/health. Use the URL from opencode service status or pair using a fresh link.`,
      );
    const health = await response.json();
    if (health.healthy !== true || typeof health.version !== 'string')
      throw new Error('This address did not identify as an OpenCode server.');
    this.protocol = 'v1';
    return {
      version: health.version as string,
      protocol: 'v1' as const,
      spec: await this.inspectSpec('/doc', ['/session', '/event', '/mcp']),
    };
  }
  private async inspectSpec(path: string, expected: string[]) {
    try {
      const response = await this.fetch(`${this.settings.serverUrl}${path}`);
      if (response.ok && response.headers.get('content-type')?.includes('json')) {
        const spec = await response.json();
        if (spec.paths) {
          for (const prefix of expected)
            if (!Object.keys(spec.paths).some((path) => path.startsWith(prefix)))
              throw new Error(
                `Server spec is missing ${prefix}. This server version is not compatible with the selected API.`,
              );
          return `OpenAPI ${spec.openapi || '3.1'} · live ${path} verified`;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Server spec')) throw error;
    }
    return `${this.protocol === 'v2' ? 'Native v2' : 'Legacy'} API verified · OpenAPI unavailable`;
  }
  async *events(signal: AbortSignal): AsyncGenerator<BackendEvent> {
    if (this.protocol === 'v2') {
      for await (const event of this.native.event.subscribe({ signal }))
        yield {
          id: event.id,
          type: event.type,
          protocol: 'v2',
          created: 'created' in event ? event.created : Date.now(),
          properties: event.data,
        };
      return;
    }
    const url = new URL('/event', this.settings.serverUrl);
    if (this.settings.directory) url.searchParams.set('directory', this.settings.directory);
    const response = await this.fetch(
      new Request(url, { signal, headers: { Accept: 'text/event-stream' } }),
    );
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get('content-type')?.includes('text/event-stream')
    )
      throw new Error('OpenCode did not return an event stream.');
    for await (const item of readSSE(response.body, signal)) {
      try {
        const data = JSON.parse(item.data),
          event = data.payload || data;
        if (typeof event.type === 'string') yield event;
      } catch {}
    }
  }
}

export async function redeemPairing(settings: Settings, link: string): Promise<Settings> {
  const { origin, code } = pairingLink(link);
  let response: Response;
  try {
    response = await fetch(`${origin}/auth/connect/${encodeURIComponent(code)}`, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error(
      'Cannot reach the server in this pairing link. Generate the link on the same OpenCode service and check its local address.',
    );
  }
  if ([400, 401, 403, 404, 410].includes(response.status))
    throw new Error(
      'The OpenCode pairing link is expired, already used, or belongs to another service. Run opencode pair again and paste the new link here without opening it in the browser.',
    );
  if (!response.ok || !response.headers.get('content-type')?.includes('json'))
    throw new Error(
      `Pairing returned HTTP ${response.status} instead of JSON. Use a fresh OpenCode 2 pairing link.`,
    );
  const result = await response.json();
  if (typeof result.token !== 'string' || !result.token || result.token.length > 4096)
    throw new Error('OpenCode did not return a valid pairing credential.');
  return { ...settings, serverUrl: origin, password: result.token };
}

export async function discover(settings: Settings) {
  const candidates = [
    ...new Set([
      localUrl(settings.serverUrl),
      ...[49374, 45278, 4096, 3000].map((port) => `http://127.0.0.1:${port}`),
      'http://localhost:49374',
      'http://localhost:4096',
    ]),
  ];
  const results = await Promise.allSettled(
    candidates.map(async (url) => {
      for (const [path, protocol] of [
        ['/api/info', 'v2'],
        ['/global/health', 'v1'],
      ] as const) {
        const response = await fetch(`${url}${path}`, {
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          signal: AbortSignal.timeout(1500),
        });
        if (response.status === 401) return { url, authRequired: true, verified: false };
        if (!response.ok || !response.headers.get('content-type')?.includes('json')) continue;
        const info = await response.json();
        if (
          typeof info.version === 'string' &&
          (protocol === 'v2'
            ? Number.isInteger(info.pid) && Array.isArray(info.urls)
            : info.healthy === true)
        )
          return { url, version: info.version, protocol, authRequired: false, verified: true };
      }
      return null;
    }),
  );
  return results.flatMap((item) => (item.status === 'fulfilled' && item.value ? [item.value] : []));
}
