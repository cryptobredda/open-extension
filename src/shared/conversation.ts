import type { ConversationMessage, BackendEvent } from './types';
import { reduceV2 } from './conversation-v2';
/** Backend state is authoritative; deltas update existing parts without duplicating messages. */
export function reduceConversation(
  messages: ConversationMessage[],
  event: BackendEvent,
): ConversationMessage[] {
  if (event.protocol === 'v2') return reduceV2(messages, event);
  const p = event.properties;
  if (event.type === 'message.updated') {
    const found = messages.find((item) => item.info.id === p.info.id);
    const result = found
      ? messages.map((item) => (item.info.id === p.info.id ? { ...item, info: p.info } : item))
      : [...messages, { info: p.info, parts: [] }];
    return result.sort(
      (a, b) =>
        (a.info.time?.created || 0) - (b.info.time?.created || 0) ||
        a.info.id.localeCompare(b.info.id),
    );
  }
  if (event.type === 'message.removed')
    return messages.filter((item) => item.info.id !== p.messageID);
  if (event.type === 'message.part.updated')
    return messages.map((item) => {
      if (item.info.id !== p.part.messageID) return item;
      const previous = item.parts.find((part) => part.id === p.part.id);
      const part =
        p.delta && previous && 'text' in previous
          ? { ...p.part, text: previous.text + p.delta }
          : p.part;
      return {
        ...item,
        parts: previous
          ? item.parts.map((old) => (old.id === part.id ? part : old))
          : [...item.parts, part],
      };
    });
  if (event.type === 'message.part.delta')
    return messages.map((item) =>
      item.info.id !== p.messageID
        ? item
        : {
            ...item,
            parts: item.parts.map((part) =>
              part.id === p.partID
                ? {
                    ...part,
                    [p.field]: String((part as any)[p.field] || '') + p.delta,
                  }
                : part,
            ),
          },
    );
  if (event.type === 'message.part.removed')
    return messages.map((item) => ({
      ...item,
      parts: item.parts.filter((part) => part.id !== p.partID),
    }));
  return messages;
}
