// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { installRuntime } from '../../src/content/runtime';

afterEach(() => {
  const runtime = (globalThis as any).__openExtension_v1;
  if (runtime) for (const id of runtime.list()) runtime.dispose(id);
  delete (globalThis as any).__openExtension_v1;
  document.body.innerHTML = '';
});
describe('reversible lifecycle', () => {
  it('restores original DOM nodes and their listeners after removal and text replacement', async () => {
    document.body.innerHTML =
      '<div id="title"><button>Original</button></div><aside>Sidebar</aside>';
    const original = document.querySelector('button')!;
    let clicked = 0;
    original.addEventListener('click', () => clicked++);
    const runtime = installRuntime();
    await runtime.run('site-a', '1', (api) => {
      api.text('#title', 'Changed');
      api.remove('aside');
    });
    expect(document.querySelector('#title')?.textContent).toBe('Changed');
    expect(document.querySelector('aside')).toBeNull();
    runtime.dispose('site-a');
    expect(document.querySelector('button')).toBe(original);
    original.click();
    expect(clicked).toBe(1);
    expect(document.querySelector('aside')?.textContent).toBe('Sidebar');
  });
  it('removes only its layer when scripts overlap, even when an attribute value is null', async () => {
    document.body.innerHTML = '<h1 title="Original">Text</h1>';
    const runtime = installRuntime(),
      title = document.querySelector('h1')!;
    await runtime.run('a', '1', (api) => api.attr('h1', 'title', 'First'));
    await runtime.run('b', '1', (api) => api.attr('h1', 'title', null));
    runtime.dispose('a');
    expect(title.getAttribute('title')).toBeNull();
    runtime.dispose('b');
    expect(title.getAttribute('title')).toBe('Original');
  });
  it('does not duplicate listeners on rerun and cleans observers and temporary effects separately', async () => {
    document.body.innerHTML = '<button>Click</button><h1>Original</h1>';
    const runtime = installRuntime();
    let clicks = 0,
      observations = 0;
    const run = (force = false) =>
      runtime.run(
        'site-a',
        '1',
        (api) => {
          api.on(document, 'click', () => clicks++);
          api.watch(() => observations++);
        },
        force,
      );
    await run();
    await run();
    document.querySelector('button')!.click();
    expect(clicks).toBe(1);
    await run(true);
    document.querySelector('button')!.click();
    expect(clicks).toBe(2);
    await runtime.run('experiment-a', '1', (api) => api.text('h1', 'Temporary'));
    runtime.resetExperiments();
    expect(document.querySelector('h1')!.textContent).toBe('Original');
    expect(runtime.list()).toEqual(['site-a']);
    runtime.dispose('site-a');
    const count = observations;
    document.body.append(document.createElement('div'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.querySelector('button')!.click();
    expect(clicks).toBe(2);
    expect(observations).toBe(count);
  });
  it('cleans partial mutations after code throws and late async effects after disable', async () => {
    document.body.innerHTML = '<h1>Original</h1>';
    const runtime = installRuntime();
    await expect(
      runtime.run('bad', '1', (api) => {
        api.text('h1', 'Bad');
        throw new Error('Oops');
      }),
    ).rejects.toThrow('Oops');
    expect(document.querySelector('h1')!.textContent).toBe('Original');
    let release: () => void = () => {};
    const wait = new Promise<void>((resolve) => (release = resolve));
    const running = runtime.run('late', '1', async (api) => {
      await wait;
      api.text('h1', 'Late');
    });
    runtime.dispose('late');
    release();
    await running;
    expect(document.querySelector('h1')!.textContent).toBe('Original');
  });
  it('handles late sections, changed labels and attributes without repeated observer mutations, then restores them', async () => {
    document.body.innerHTML = '<main>Keep me</main><section><h2>Loading</h2></section>';
    const runtime = installRuntime();
    let observations = 0;
    await runtime.run('site-semantic', '1', (api) =>
      api.watch(() => {
        observations++;
        for (const heading of document.querySelectorAll('h2, h3'))
          if (heading.textContent === 'Relevant people') api.hide(heading.closest('section'));
      }),
    );
    document.querySelector('h2')!.textContent = 'Relevant people';
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('section')!.hasAttribute('hidden')).toBe(true);
    document.body.insertAdjacentHTML('beforeend', '<section><h3>Relevant people</h3></section>');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelectorAll('section[hidden]')).toHaveLength(2);
    const count = observations;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observations).toBe(count);
    runtime.dispose('site-semantic');
    expect(document.querySelectorAll('[hidden]')).toHaveLength(0);
    expect(document.querySelector('main')!.textContent).toBe('Keep me');
  });
});
