/** Self-contained: serialized into userScripts. Never include extension credentials here. */
export function installRuntime(): {
  run(id: string, revision: string, callback: (api: any) => any, force?: boolean): Promise<any>;
  dispose(id: string): boolean;
  resetExperiments(): void;
  list(): string[];
} {
  const root = globalThis as any;
  if (root.__openExtension_v1?.implementation === 2) return root.__openExtension_v1;
  if (root.__openExtension_v1)
    for (const id of root.__openExtension_v1.list()) root.__openExtension_v1.dispose(id);
  type Cleanup = () => void;
  type Scope = { cleanups: Cleanup[]; disposed: boolean };
  const scopes = new Map<string, Scope>();
  const versions = new Map<string, string>();
  const layers = new WeakMap<
    Node,
    Map<
      string,
      {
        base: any;
        write: (v: any) => void;
        stack: { scope: Scope; value: any }[];
      }
    >
  >();
  const resolve = (target: string | Element) =>
    typeof target === 'string' ? Array.from(document.querySelectorAll(target)) : [target];
  const dispose = (id: string) => {
    const scope = scopes.get(id);
    if (!scope) return false;
    scope.disposed = true;
    for (const cleanup of scope.cleanups.reverse()) {
      try {
        cleanup();
      } catch (e) {
        console.warn('[Open Extension] Cleanup failed', e);
      }
    }
    scopes.delete(id);
    versions.delete(id);
    return true;
  };
  const create = (id: string) => {
    dispose(id);
    const scope: Scope = { cleanups: [], disposed: false };
    scopes.set(id, scope);
    const onCleanup = (cleanup: Cleanup) => {
      if (scope.disposed) cleanup();
      else scope.cleanups.push(cleanup);
    };
    const layer = (
      node: Node,
      key: string,
      read: () => any,
      write: (v: any) => void,
      value: any,
    ) => {
      if (scope.disposed) return;
      let properties = layers.get(node);
      if (!properties) {
        properties = new Map();
        layers.set(node, properties);
      }
      let property = properties.get(key);
      if (!property) {
        property = { base: read(), write, stack: [] };
        properties.set(key, property);
      }
      const existing = property.stack.find((item) => item.scope === scope);
      if (existing) {
        existing.value = value;
        if (property.stack.at(-1) === existing) write(value);
        return;
      }
      const entry = { scope, value };
      property.stack.push(entry);
      write(value);
      onCleanup(() => {
        const index = property!.stack.indexOf(entry),
          top = index === property!.stack.length - 1;
        property!.stack.splice(index, 1);
        if (top)
          property!.write(property!.stack.length ? property!.stack.at(-1)!.value : property!.base);
        if (!property!.stack.length) properties!.delete(key);
      });
    };
    return {
      get active() {
        return !scope.disposed;
      },
      onCleanup,
      css(text: string) {
        if (scope.disposed) return;
        // Constructed sheets also work on sites that forbid inline <style> through CSP.
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(text);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        onCleanup(() => {
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
            (item) => item !== sheet,
          );
        });
        return sheet;
      },
      hide(target: string | Element) {
        if (typeof target === 'string') return this.css(`${target}{display:none !important}`);
        this.attr(target, 'hidden', '');
      },
      attr(target: string | Element, name: string, value: string | null) {
        for (const node of resolve(target))
          layer(
            node,
            `attr:${name}`,
            () => node.getAttribute(name),
            (v) => {
              if (node.getAttribute(name) !== v)
                v === null ? node.removeAttribute(name) : node.setAttribute(name, v);
            },
            value,
          );
      },
      text(target: string | Element, value: string) {
        for (const node of resolve(target)) {
          // Preserve actual child nodes (and their listeners), rather than cloning HTML on undo.
          let original: Node[] | undefined;
          layer(
            node,
            'children',
            () => (original = Array.from(node.childNodes)),
            (v) => {
              if (typeof v === 'string') {
                if (
                  node.childNodes.length !== 1 ||
                  node.firstChild?.nodeType !== Node.TEXT_NODE ||
                  node.textContent !== v
                )
                  node.replaceChildren(document.createTextNode(v));
              } else node.replaceChildren(...v);
            },
            value,
          );
        }
      },
      remove(target: string | Element) {
        for (const node of resolve(target)) {
          if (scope.disposed || !node.parentNode) continue;
          const marker = document.createComment(`open-extension:${id}`);
          node.before(marker);
          node.remove();
          onCleanup(() => {
            if (marker.parentNode) marker.replaceWith(node);
          });
        }
      },
      append(target: string | Element, node: Node) {
        if (scope.disposed) return;
        const parent = resolve(target)[0];
        if (!parent) throw new Error('Append target not found.');
        parent.append(node);
        onCleanup(() => {
          if (node.parentNode === parent) parent.removeChild(node);
        });
        return node;
      },
      on(
        target: EventTarget,
        event: string,
        handler: EventListener,
        options?: AddEventListenerOptions,
      ) {
        if (scope.disposed) return;
        target.addEventListener(event, handler, options);
        onCleanup(() => target.removeEventListener(event, handler, options));
      },
      watch(callback: () => void, target: Node = document.documentElement) {
        if (scope.disposed) return;
        let pending = false;
        const observer = new MutationObserver(() => {
          if (pending || scope.disposed) return;
          pending = true;
          queueMicrotask(() => {
            pending = false;
            if (!scope.disposed) {
              observer.disconnect();
              try {
                callback();
              } finally {
                if (!scope.disposed)
                  observer.observe(target, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    characterData: true,
                  });
              }
            }
          });
        });
        callback();
        if (!scope.disposed)
          observer.observe(target, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
        onCleanup(() => observer.disconnect());
        return observer;
      },
      interval(callback: () => void, ms: number) {
        if (scope.disposed) return;
        const handle = setInterval(
          () => {
            if (!scope.disposed) callback();
          },
          Math.max(50, ms),
        );
        onCleanup(() => clearInterval(handle));
      },
      timeout(callback: () => void, ms: number) {
        if (scope.disposed) return;
        const handle = setTimeout(() => {
          if (!scope.disposed) callback();
        }, ms);
        onCleanup(() => clearTimeout(handle));
      },
      query(selector: string) {
        return document.querySelector(selector);
      },
      queryAll(selector: string) {
        return Array.from(document.querySelectorAll(selector));
      },
    };
  };
  const runtime = {
    implementation: 2,
    async run(
      id: string,
      revision: string,
      callback: (api: ReturnType<typeof create>) => any,
      force = false,
    ) {
      if (!force && versions.get(id) === revision) return { skipped: true };
      const api = create(id);
      versions.set(id, revision);
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          Promise.resolve().then(() => callback(api)),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Script execution exceeded 20 seconds.')),
              20_000,
            );
          }),
        ]).finally(() => clearTimeout(timer));
        if (typeof result === 'function') {
          api.onCleanup(result);
          return { applied: true };
        }
        // Bound values returned by page code; DOM nodes and cycles need safe serialization.
        const seen = new WeakSet();
        const serialized = JSON.stringify(result ?? { applied: true }, (_key, value) => {
          if (value instanceof Node)
            return {
              node: value.nodeName,
              text: value.textContent?.slice(0, 1000),
            };
          if (typeof value === 'bigint') return String(value);
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return '[Circular]';
            seen.add(value);
          }
          return value;
        });
        return JSON.parse(
          serialized.slice(0, 200_000).length < serialized.length
            ? JSON.stringify({
                truncated: true,
                preview: serialized.slice(0, 190_000),
              })
            : serialized,
        );
      } catch (error) {
        if (api.active) dispose(id);
        throw error;
      }
    },
    dispose,
    resetExperiments() {
      for (const id of [...scopes.keys()]) if (id.startsWith('experiment-')) dispose(id);
    },
    list() {
      return [...scopes.keys()];
    },
  };
  Object.defineProperty(root, '__openExtension_v1', {
    value: runtime,
    configurable: true,
  });
  return runtime;
}

export function scriptSource(id: string, revision: string, code: string, force = false): string {
  return `;(${installRuntime.toString()})().run(${JSON.stringify(id)},${JSON.stringify(revision)},async function(api){\n"use strict";\n${code}\n},${force});`;
}
