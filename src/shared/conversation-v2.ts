import type { BackendEvent, ConversationMessage, Part } from './types';
import { structuredError, v2Message, v2ToolPart } from './opencode-v2';

/** Native v2 events carry `data`, assistant message IDs and content ordinals, not v1 part IDs. */
export function reduceV2(
  messages: ConversationMessage[],
  event: BackendEvent,
): ConversationMessage[] {
  const p = event.properties,
    now = event.created || Date.now();
  const sid = p.sessionID,
    mid = p.assistantMessageID || p.messageID;
  const current = messages.find((message) => message.info.id === mid);
  const update = (message: ConversationMessage) => {
    const result = messages.some((item) => item.info.id === message.info.id)
      ? messages.map((item) => (item.info.id === message.info.id ? message : item))
      : [...messages, message];
    return result.sort(
      (a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id),
    );
  };
  const assistant = (): ConversationMessage =>
    current ||
    ({
      info: {
        id: mid,
        sessionID: sid,
        role: 'assistant',
        time: { created: now },
        agent: '',
        modelID: '',
        providerID: '',
      },
      parts: [],
    } as unknown as ConversationMessage);
  const putPart = (part: Part) => {
    const message = assistant();
    return update({
      ...message,
      parts: message.parts.some((old) => old.id === part.id)
        ? message.parts.map((old) => (old.id === part.id ? part : old))
        : [...message.parts, part],
    });
  };
  const contentPart = (kind: 'text' | 'reasoning', text: string, end?: number) =>
    ({
      id: `${mid}:content:${p.ordinal}`,
      messageID: mid,
      sessionID: sid,
      type: kind,
      text,
      ...(kind === 'reasoning' ? { time: { start: now, end } } : {}),
    }) as Part;
  if (event.type === 'session.step.started') {
    const message = v2Message(sid, {
      id: mid,
      type: 'assistant',
      agent: p.agent,
      model: p.model,
      content: [],
      time: { created: p.started || now },
    });
    return update({
      info: { ...current?.info, ...message.info },
      parts: current?.parts.length ? current.parts : message.parts,
    } as ConversationMessage);
  }
  if (/^session\.(text|reasoning)\.(started|delta|ended)$/.test(event.type)) {
    const kind = event.type.includes('.reasoning.') ? 'reasoning' : 'text';
    const existing = current?.parts.find((part) => part.id === `${mid}:content:${p.ordinal}`);
    if (event.type.endsWith('.started') && existing) return messages;
    const text = event.type.endsWith('.delta')
      ? String((existing as any)?.text || '') + p.delta
      : p.text || '';
    const part = contentPart(kind, text, event.type.endsWith('.ended') ? now : undefined);
    if (kind === 'reasoning' && existing && 'time' in existing)
      (part as any).time.start = (existing as any).time?.start || now;
    return putPart(part);
  }
  if (event.type.startsWith('session.tool.')) {
    const id = `${mid}:tool:${p.id}`;
    const previous = current?.parts.find((part) => part.id === id) as any;
    if (event.type === 'session.tool.input.started')
      return previous
        ? messages
        : putPart({
            id,
            sessionID: sid,
            messageID: mid,
            type: 'tool',
            callID: p.id,
            tool: p.name,
            state: { status: 'pending', raw: '', input: {} },
          });
    if (!previous) return messages;
    let state = { ...previous.state };
    if (event.type === 'session.tool.input.delta') state.raw = (state.raw || '') + p.delta;
    if (event.type === 'session.tool.input.ended') {
      state.raw = p.text;
      try {
        state.input = JSON.parse(p.text);
      } catch {}
    }
    if (event.type === 'session.tool.called')
      state = {
        status: 'running',
        input: p.input,
        title: previous.tool,
        time: { start: now },
        metadata: {},
      };
    if (event.type === 'session.tool.progress')
      state.metadata = { ...state.metadata, ...p.metadata };
    if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
      const tool = {
        id: p.id,
        name: previous.tool,
        type: 'tool',
        state: event.type.endsWith('.success')
          ? {
              status: 'completed',
              input: state.input || {},
              content: p.content || [],
              metadata: p.metadata || {},
            }
          : { status: 'error', input: state.input || {}, error: p.error },
        time: { created: state.time?.start || now, ran: state.time?.start || now, completed: now },
      };
      return putPart(v2ToolPart(sid, mid, tool as any));
    }
    return putPart({ ...previous, state });
  }
  if (event.type === 'session.step.ended' || event.type === 'session.step.failed') {
    const message = assistant();
    const info: any = { ...message.info, time: { ...message.info.time, completed: now } };
    if (p.error)
      info.error = { name: 'OpenCodeError', data: { message: structuredError(p.error) } };
    const finish = {
      id: `${mid}:finish`,
      sessionID: sid,
      messageID: mid,
      type: 'step-finish',
      reason: p.finish || 'error',
      cost: p.cost || 0,
      tokens: p.tokens || { input: 0, output: 0, reasoning: 0 },
    } as Part;
    return update({
      info,
      parts: [...message.parts.filter((part) => part.id !== finish.id), finish],
    });
  }
  if (event.type === 'session.message.content.updated' && current) {
    const native = v2Message(sid, {
      id: mid,
      type: 'assistant',
      agent: (current.info as any).agent || '',
      model: {
        id: (current.info as any).modelID || '',
        providerID: (current.info as any).providerID || '',
      },
      time: { created: current.info.time.created },
      content: p.content,
    });
    return update({
      ...current,
      parts: [...native.parts, ...current.parts.filter((part) => part.type === 'step-finish')],
    });
  }
  if (event.type === 'session.inbox.enqueued' && p.item?.type === 'user')
    return update(
      v2Message(sid, { id: p.inboxID, type: 'user', time: { created: now }, ...p.item.payload }),
    );
  if (event.type === 'session.deleted')
    return messages.filter((message) => message.info.sessionID !== sid);
  return messages;
}
