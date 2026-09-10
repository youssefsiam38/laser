// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, ComposerPrimitive, useExternalStoreRuntime, type Unstable_TriggerItem } from "@assistant-ui/react";
import { ComposerTriggerPopover, revealPickerOption } from "../../src/components/assistant-ui/elements/composer-trigger-popover.aui.js";

const items: Unstable_TriggerItem[] = Array.from({ length: 30 }, (_, index) => ({ id: `file-${index}`, type: "file", label: `src/file-${index}.ts` }));
const adapter = { categories: () => [], categoryItems: () => [], search: (query: string) => items.filter((item) => item.label.includes(query)) };
const inserted = vi.fn();
const sent = vi.fn();
let container: HTMLDivElement;
let root: Root;
function Fixture({ source = false }: { source?: boolean }) {
  const runtime = useExternalStoreRuntime({ messages: [], isRunning: false, onNew: sent });
  const sourceAdapter = { ...adapter, search: () => [{ id: "skill", type: "skill", label: "/skill:review", description: "A detailed skill description. ".repeat(100) + "Final instruction.", metadata: { filePath: "/tmp/SKILL.md" } }] };
  return <AssistantRuntimeProvider runtime={runtime}><ComposerPrimitive.Unstable_TriggerPopoverRoot><ComposerPrimitive.Root>
    <button type="button">Before input</button>
    <ComposerPrimitive.Input aria-label="Message" onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.shiftKey) { event.preventDefault(); sent(); } }} />
    <ComposerTriggerPopover char="@" adapter={source ? sourceAdapter : adapter} directive={{ onInserted: inserted }} title="Files & agents" />
    <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
  </ComposerPrimitive.Root></ComposerPrimitive.Unstable_TriggerPopoverRoot><button type="button">Outside</button></AssistantRuntimeProvider>;
}
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  inserted.mockReset(); sent.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Fixture />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const input = () => container.querySelector('textarea')!;
const popup = () => container.querySelector('[role="listbox"]');
const selected = () => container.querySelector('[role="option"][aria-selected="true"]');
async function type(value: string, position = value.length) {
  await act(async () => {
    input().focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), value);
    input().setSelectionRange(position, position);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  await act(async () => { input().dispatchEvent(event); });
  return event;
}

it('opens a labelled combobox; arrows wrap and retain composer focus and ARIA', async () => {
  await type('@');
  expect(popup()?.getAttribute('aria-label')).toBe('Files & agents');
  expect(input().getAttribute('aria-controls')).toBe(popup()?.id);
  await key('ArrowUp'); expect(selected()?.textContent).toContain('file-29');
  expect(input().getAttribute('aria-activedescendant')).toBe(selected()?.id);
  await key('ArrowDown'); expect(selected()?.textContent).toContain('file-0');
  expect(document.activeElement).toBe(input());
});
it('scrolls only the results when keyboard selection leaves either edge', () => {
  const list = document.createElement('div'), row = document.createElement('button');
  list.scrollTop = 100;
  list.getBoundingClientRect = () => ({ top: 100, bottom: 300 } as DOMRect);
  row.getBoundingClientRect = () => ({ top: 280, bottom: 340 } as DOMRect);
  revealPickerOption(list, row); expect(list.scrollTop).toBe(140);
  row.getBoundingClientRect = () => ({ top: 80, bottom: 120 } as DOMRect);
  revealPickerOption(list, row); expect(list.scrollTop).toBe(120);
});
it('pages through results while leaving caret-navigation keys untouched', async () => {
  await type('@');
  const list = container.querySelector<HTMLElement>('[data-slot="composer-picker-results"]')!;
  Object.defineProperty(list, 'clientHeight', { value: 150 });
  for (const row of container.querySelectorAll<HTMLElement>('[role="option"]')) row.getBoundingClientRect = () => ({ height: 50, top: 0, bottom: 50 } as DOMRect);
  await key('PageDown'); expect(selected()?.textContent).toContain('file-3');
  await key('PageUp'); expect(selected()?.textContent).toContain('file-0');
  expect((await key('ArrowLeft')).defaultPrevented).toBe(false);
  expect((await key('Home')).defaultPrevented).toBe(false);
});
it('dismisses outside pointer, outside focus and Escape without altering the draft', async () => {
  for (const method of ['pointer', 'focus', 'escape']) {
    await type('');
    await type('@file');
    expect(popup()).not.toBeNull();
    if (method === 'escape') await key('Escape');
    else await act(async () => {
      const outside = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Outside')!;
      if (method === 'pointer') outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      else outside.focus();
    });
    expect(popup()).toBeNull(); expect(input().value).toBe('@file');
  }
});
it('Enter selects once without submitting and preserves the suffix around the caret', async () => {
  await type('Read @file-2 then keep this\nand this', 12);
  expect(popup()).not.toBeNull();
  await key('Enter');
  expect(inserted).toHaveBeenCalledTimes(1); expect(sent).not.toHaveBeenCalled();
  expect(input().value).toContain('then keep this\nand this');
  expect(input().value).toMatch(/^Read /);
});
it('Tab selects, Shift+Tab exits, and empty results do not trap Tab or submit Enter', async () => {
  await type('@file-2'); await key('Tab'); expect(inserted).toHaveBeenCalledTimes(1);
  await type('@'); expect((await key('Tab', { shiftKey: true })).defaultPrevented).toBe(false); expect(popup()).toBeNull();
  await type('@no-such-file'); expect(popup()?.textContent).toContain('No matches');
  await key('Enter'); expect(sent).not.toHaveBeenCalled();
  expect((await key('Tab')).defaultPrevented).toBe(false); expect(popup()).toBeNull();
});
it('does not select or submit an IME confirmation', async () => {
  await type('@'); await key('Enter', { isComposing: true });
  expect(inserted).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled(); expect(popup()).not.toBeNull();
});
it('pointer selection keeps focus and inserts once; hovering updates the active descendant', async () => {
  await type('@');
  const option = container.querySelectorAll<HTMLButtonElement>('[role="option"]')[12]!;
  await act(async () => option.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
  expect(selected()).toBe(option);
  await act(async () => { option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); option.click(); });
  expect(inserted).toHaveBeenCalledTimes(1); expect(document.activeElement).toBe(input());
});
it('keeps verbose skill previews compact and provides a scrollable full-description view', async () => {
  await act(async () => root.render(<Fixture source />)); await type('@');
  const preview = container.querySelector<HTMLElement>('[data-slot="composer-picker-preview"]')!;
  expect(preview.classList.contains('line-clamp-1')).toBe(true);
  expect(preview.classList.contains('block')).toBe(false);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-picker-details]')!.click());
  expect(container.querySelector('[data-slot="composer-picker-description"]')?.textContent).toContain('Final instruction.');
  expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
  const list = container.querySelector<HTMLElement>('[data-slot="composer-picker-results"]')!;
  Object.defineProperty(list, 'clientHeight', { value: 200 });
  await key('PageDown'); expect(list.scrollTop).toBe(200);
  await key('Enter'); expect(container.querySelector('[data-slot="composer-picker-description"]')).not.toBeNull();
  expect(inserted).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled();
  await key('Escape');
  expect(popup()).not.toBeNull(); expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
  await key('Enter'); expect(inserted).toHaveBeenCalledOnce(); expect(sent).not.toHaveBeenCalled();
});
it('opens a skill source with Alt+O without selecting or running it', async () => {
  const openSourceFile = vi.fn().mockResolvedValue({ opened: true }); vi.stubGlobal('desktop', { openSourceFile });
  await act(async () => root.render(<Fixture source />));
  await type('@'); await key('o', { altKey: true });
  expect(openSourceFile).toHaveBeenCalledWith('/tmp/SKILL.md');
  expect(inserted).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled(); expect(input().value).toBe('@');
});
