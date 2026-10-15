import type {
  SessionInfo,
  SessionMessageInfo,
  SessionMessageAssistantTool,
} from '@opencode/client';
import type { ConversationMessage, Part, Session } from './types';

/** Normalize native v2 wire records to the view model also used by legacy clients. */
export function v2Session(info: SessionInfo): Session {
  return {
    ...info,
    directory: info.location.directory,
    title: info.title || 'Untitled conversation',
    slug: info.id,
    version: '2',
  } as unknown as Session;
}
export function structuredError(error: unknown): string {
  if (typeof error === 'string') return error;
  const value = error as any;
  return (
    value?.message ||
    value?.data?.message ||
    value?.description ||
    JSON.stringify(error ?? 'OpenCode reported an error.')
  );
}
export function v2ToolPart(
  sessionID: string,
  messageID: string,
  tool: SessionMessageAssistantTool,
): Part {
  const state = tool.state;
  const time = { start: tool.time.ran || tool.time.created, end: tool.time.completed };
  let normalized: any;
  if (state.status === 'streaming') normalized = { status: 'pending', input: {}, raw: state.input };
  else if (state.status === 'running')
    normalized = { ...state, time, title: (state.metadata as any)?.title || tool.name };
  else if (state.status === 'completed')
    normalized = {
      ...state,
      time,
      title: (state.metadata as any)?.title || tool.name,
      metadata: state.metadata || {},
      output: state.content
        .map((item) => (item.type === 'text' ? item.text : JSON.stringify(item)))
        .join('\n'),
    };
  else normalized = { ...state, time, error: structuredError(state.error) };
  return {
    id: `${messageID}:tool:${tool.id}`,
    sessionID,
    messageID,
    type: 'tool',
    callID: tool.id,
    tool: tool.name,
    state: normalized,
  };
}
export function v2Message(sessionID: string, message: SessionMessageInfo): ConversationMessage {
  const base = { sessionID, messageID: message.id };
  const part = (suffix: string, value: Record<string, unknown>): Part =>
    ({ ...base, id: `${message.id}:${suffix}`, ...value }) as Part;
  const info: any = {
    id: message.id,
    sessionID,
    role: message.type === 'user' ? 'user' : 'assistant',
    time: { ...message.time },
    browserContext: message.type === 'system' && message.text.includes('open-extension.browser'),
  };
  let parts: Part[] = [];
  if (message.type === 'assistant') {
    info.agent = message.agent;
    info.modelID = message.model.id;
    info.providerID = message.model.providerID;
    if (message.error)
      info.error = { name: 'OpenCodeError', data: { message: structuredError(message.error) } };
    parts.push(part('step', { type: 'step-start' }));
    parts.push(
      ...message.content.map((content, ordinal) => {
        if (content.type === 'tool') return v2ToolPart(sessionID, message.id, content);
        return part(`content:${ordinal}`, {
          ...content,
          time:
            content.type === 'reasoning'
              ? {
                  start: content.time?.created || message.time.created,
                  end: content.time?.completed,
                }
              : undefined,
        });
      }),
    );
    if (message.finish || message.time.completed)
      parts.push(
        part('finish', {
          type: 'step-finish',
          reason: message.finish || (message.error ? 'error' : 'stop'),
          cost: message.cost || 0,
          tokens: message.tokens || {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        }),
      );
    if (message.retry) parts.push(part('retry', { type: 'retry', ...message.retry }));
  } else if (message.type === 'agent-switched')
    parts = [part('agent', { type: 'agent', name: message.agent })];
  else if (message.type === 'system')
    parts = [
      part('instructions', { type: 'agent', name: message.description || 'Session context' }),
      part('text', { type: 'text', text: message.text }),
    ];
  else if (message.type === 'user' || message.type === 'synthetic' || message.type === 'skill') {
    parts = [part('text', { type: 'text', text: message.text })];
    if (message.type === 'user')
      for (const [index, file] of (message.files || []).entries())
        parts.push(part(`file:${index}`, { type: 'file', ...file }));
  } else if (message.type === 'compaction')
    parts = [
      part('compaction', { type: 'compaction', auto: false }),
      part('details', {
        type: 'text',
        text: 'text' in message ? String(message.text || '') : `Compaction ${message.status}`,
      }),
    ];
  else if (message.type === 'idle') {
    parts = [
      part('outcome', {
        type: 'text',
        text:
          message.outcome === 'succeeded'
            ? 'OpenCode turn finished.'
            : `OpenCode turn ${message.outcome}.`,
      }),
    ];
    if (message.error)
      info.error = { name: 'OpenCodeError', data: { message: structuredError(message.error) } };
  } else
    parts = [
      part('context', {
        type: 'text',
        text:
          message.type === 'model-switched'
            ? `Model selected: ${message.model.providerID}/${message.model.id}`
            : message.type === 'location-switched'
              ? `Project selected: ${message.location.directory}`
              : JSON.stringify(message, null, 2),
      }),
    ];
  return { info, parts };
}
