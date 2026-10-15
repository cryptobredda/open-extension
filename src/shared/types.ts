import type {
  Message,
  Part,
  Session,
  PermissionRequest,
  QuestionRequest,
} from '@opencode-ai/sdk/v2/client';
export type { Message, Part, Session, PermissionRequest, QuestionRequest };
export type { FormInfo as PendingForm } from '@opencode/client';
export type ConversationMessage = { info: Message; parts: Part[] };
export type Settings = {
  serverUrl: string;
  username: string;
  password: string;
  rememberPassword: boolean;
  directory: string;
  bridgeUrl: string;
  bridgeToken: string;
  showReasoning: boolean;
  model: string;
  agent: string;
};
export const DEFAULT_SETTINGS: Settings = {
  serverUrl: 'http://127.0.0.1:49374',
  username: 'opencode',
  password: '',
  rememberPassword: false,
  directory: '',
  bridgeUrl: 'http://127.0.0.1:49375',
  bridgeToken: '',
  showReasoning: true,
  model: '',
  agent: 'build',
};
export type SiteScript = {
  id: string;
  name: string;
  description: string;
  matches: string[];
  code: string;
  enabled: boolean;
  world: 'USER_SCRIPT' | 'MAIN';
  revision: number;
  createdAt: number;
  updatedAt: number;
};
export type Proposal = {
  id: string;
  sessionID: string;
  tabId: number;
  url: string;
  name: string;
  description: string;
  matches: string[];
  code: string;
  world: 'USER_SCRIPT' | 'MAIN';
  scriptId?: string;
  experimentIds: string[];
  verifiedAt: number;
};
export type BackendEvent = {
  id?: string;
  created?: number;
  protocol?: 'v2';
  type: string;
  properties: Record<string, any>;
};
export type ConnectionState = {
  state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  version?: string;
  error?: string;
  spec?: string;
  protocol?: 'v1' | 'v2';
};
export type BridgeState = {
  state: 'disconnected' | 'connecting' | 'connected';
  error?: string;
  registered?: boolean;
};
export type TabInfo = {
  id: number;
  windowId: number;
  url: string;
  title: string;
  supported: boolean;
};
export type ToolCall = { id: string; name: string; args: Record<string, any> };
export type ToolAudit = {
  id: string;
  name: string;
  at: number;
  status: 'running' | 'completed' | 'error';
  summary?: string;
};
export type ModelCatalog = {
  models: {
    value: string;
    id: string;
    providerID: string;
    provider: string;
    name: string;
    tools: boolean;
  }[];
  selected: string;
  default: string;
};
export type Envelope<T = unknown> = { ok: true; data: T } | { ok: false; error: string };
