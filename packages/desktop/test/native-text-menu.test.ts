import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getLocale: () => "en-US" },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  Menu: {},
  nativeTheme: { on: () => {} },
  screen: {},
  shell: {},
}));

import { nativeTextMenuTemplate, spellCheckerLanguages, type NativeTextMenuActions } from "../src/windows.js";

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
  openLink: vi.fn(),
  copyLinkAddress: vi.fn(),
  copyImageAt: vi.fn(),
  selectAllTranscript: vi.fn(),
};

const nativeParams = {
  linkURL: "",
  mediaType: "none" as const,
  x: 12,
  y: 24,
};

beforeEach(() => {
  vi.mocked(actions.replaceMisspelling).mockReset();
  vi.mocked(actions.addToDictionary).mockReset();
  vi.mocked(actions.lookupSelection!).mockReset();
  vi.mocked(actions.openLink).mockReset();
  vi.mocked(actions.copyLinkAddress).mockReset();
  vi.mocked(actions.copyImageAt).mockReset();
  vi.mocked(actions.selectAllTranscript).mockReset();
});

describe("the native text context menu", () => {
  it("offers spell replacements and native editing roles in the composer", () => {
    const menu = nativeTextMenuTemplate({
      ...nativeParams,
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
      ...nativeParams,
      dictionarySuggestions: [],
      editFlags: { ...editFlags, canCut: false, canPaste: false, canDelete: false },
      isEditable: false,
      misspelledWord: "",
      selectionText: "selected transcript text",
      spellcheckEnabled: false,
    }, actions);

    expect(menu[0]?.label).toBe("Look Up “selected transcript text”");
    expect(menu.map(item => item.role).filter(Boolean)).toEqual(["copy"]);
    expect(menu.at(-1)?.label).toBe("Select All");
    menu.at(-1)?.click?.({} as never, undefined, {} as never);
    expect(actions.selectAllTranscript).toHaveBeenCalledOnce();
  });

  it("does not replace the product menu on controls with no text selection", () => {
    expect(nativeTextMenuTemplate({
      ...nativeParams,
      dictionarySuggestions: [],
      editFlags: { ...editFlags, canCopy: false, canSelectAll: false },
      isEditable: false,
      misspelledWord: "",
      selectionText: "",
      spellcheckEnabled: false,
    }, actions)).toEqual([]);
  });

  it("offers safe link and image actions without navigating non-web schemes", () => {
    const menu = nativeTextMenuTemplate({
      ...nativeParams,
      dictionarySuggestions: [],
      editFlags: { ...editFlags, canCopy: false, canSelectAll: false },
      isEditable: false,
      linkURL: "https://example.com/docs",
      mediaType: "image",
      misspelledWord: "",
      selectionText: "",
      spellcheckEnabled: false,
    }, actions);

    expect(menu.map(item => item.label).filter(Boolean)).toEqual([
      "Open Link", "Copy Link Address", "Copy Image",
    ]);
    menu.find(item => item.label === "Open Link")?.click?.({} as never, undefined, {} as never);
    menu.find(item => item.label === "Copy Link Address")?.click?.({} as never, undefined, {} as never);
    menu.find(item => item.label === "Copy Image")?.click?.({} as never, undefined, {} as never);
    expect(actions.openLink).toHaveBeenCalledWith("https://example.com/docs");
    expect(actions.copyLinkAddress).toHaveBeenCalledWith("https://example.com/docs");
    expect(actions.copyImageAt).toHaveBeenCalledWith(12, 24);

    const file = nativeTextMenuTemplate({
      ...nativeParams,
      dictionarySuggestions: [],
      editFlags: { ...editFlags, canCopy: false, canSelectAll: false },
      isEditable: false,
      linkURL: "file:///project/AGENTS.md",
      mediaType: "none",
      misspelledWord: "",
      selectionText: "",
      spellcheckEnabled: false,
    }, actions);
    expect(file.map(item => item.label).filter(Boolean)).toEqual(["Copy Link Address"]);
  });

  it("escapes native menu mnemonics outside macOS", () => {
    const menu = nativeTextMenuTemplate({
      ...nativeParams,
      dictionarySuggestions: [],
      editFlags,
      isEditable: false,
      misspelledWord: "",
      selectionText: "R&D",
      spellcheckEnabled: false,
    }, actions, "win32");
    expect(menu[0]?.label).toBe("Look Up “R&&D”");
  });
});

describe("spellcheck languages", () => {
  it("prefers the exact app locale, then its language, then English", () => {
    const available = ["en-US", "fr-FR", "de"];
    expect(spellCheckerLanguages("fr_FR", available)).toEqual(["fr-FR"]);
    expect(spellCheckerLanguages("de-DE", available)).toEqual(["de"]);
    expect(spellCheckerLanguages("ja-JP", available)).toEqual(["en-US"]);
    expect(spellCheckerLanguages("en-US", [])).toEqual([]);
  });
});
