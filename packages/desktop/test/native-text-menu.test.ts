import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  Menu: {},
  nativeTheme: { on: () => {} },
  screen: {},
  shell: {},
}));

import { nativeTextMenuTemplate, type NativeTextMenuActions } from "../src/windows.js";

const editFlags = {
  canUndo: true,
  canRedo: false,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: true,
  canSelectAll: true,
  canEditRichly: false,
};

const actions: NativeTextMenuActions = {
  replaceMisspelling: vi.fn(),
  addToDictionary: vi.fn(),
  lookupSelection: vi.fn(),
};

beforeEach(() => {
  vi.mocked(actions.replaceMisspelling).mockReset();
  vi.mocked(actions.addToDictionary).mockReset();
  vi.mocked(actions.lookupSelection!).mockReset();
});

describe("the native text context menu", () => {
  it("offers spell replacements and native editing roles in the composer", () => {
    const menu = nativeTextMenuTemplate({
      dictionarySuggestions: ["correct", "correction"],
      editFlags,
      isEditable: true,
      misspelledWord: "corect",
      selectionText: "corect",
      spellcheckEnabled: true,
    }, actions);

    expect(menu.slice(0, 3).map(item => item.label)).toEqual(["correct", "correction", "Add to dictionary"]);
    expect(menu.map(item => item.role).filter(Boolean)).toEqual(["undo", "redo", "cut", "copy", "paste", "delete", "selectAll"]);
    menu[0]!.click?.({} as never, undefined, {} as never);
    menu[2]!.click?.({} as never, undefined, {} as never);
    expect(actions.replaceMisspelling).toHaveBeenCalledWith("correct");
    expect(actions.addToDictionary).toHaveBeenCalledWith("corect");
  });

  it("keeps Copy, Select All and platform lookup for selected transcript text", () => {
    const menu = nativeTextMenuTemplate({
      dictionarySuggestions: [],
      editFlags: { ...editFlags, canCut: false, canPaste: false, canDelete: false },
      isEditable: false,
      misspelledWord: "",
      selectionText: "selected transcript text",
      spellcheckEnabled: false,
    }, actions);

    expect(menu[0]?.label).toBe("Look Up “selected transcript text”");
    expect(menu.map(item => item.role).filter(Boolean)).toEqual(["copy", "selectAll"]);
  });

  it("does not replace the product menu on controls with no text selection", () => {
    expect(nativeTextMenuTemplate({
      dictionarySuggestions: [],
      editFlags: { ...editFlags, canCopy: false, canSelectAll: false },
      isEditable: false,
      misspelledWord: "",
      selectionText: "",
      spellcheckEnabled: false,
    }, actions)).toEqual([]);
  });
});
