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

import {
  nativeTextMenuTemplate,
  spellCheckerLanguages,
  spellcheckStateForEvent,
  type NativeTextMenuActions,
  type SpellcheckMenuState,
} from "../src/windows.js";

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
  it("offers Chromium's spelling results even when Electron contradicts them", () => {
    // Electron 44 on Linux measured this exact combination in the real
    // composer: the red squiggle was visible and Chromium supplied both the
    // word and suggestions, but spellcheckEnabled was false.
    const menu = nativeTextMenuTemplate({
      ...nativeParams,
      dictionarySuggestions: ["environment", "environs"],
      editFlags,
      isEditable: true,
      misspelledWord: "enviroment",
      selectionText: "enviroment",
      spellcheckEnabled: false,
    }, actions);

    expect(menu.slice(0, 5).map(item => item.label ?? item.type)).toEqual([
      "environment", "environs", "separator", "Add to dictionary", "separator",
    ]);
    expect(menu.map(item => item.role).filter(Boolean)).toEqual(["undo", "redo", "cut", "copy", "paste", "delete", "selectAll"]);
    menu[0]!.click?.({} as never, undefined, {} as never);
    menu[3]!.click?.({} as never, undefined, {} as never);
    expect(actions.replaceMisspelling).toHaveBeenCalledWith("environment");
    expect(actions.addToDictionary).toHaveBeenCalledWith("enviroment");
  });

  it("caps spelling suggestions at five and separates dictionary actions", () => {
    const menu = nativeTextMenuTemplate({
      ...nativeParams,
      dictionarySuggestions: ["winds", "windows", "wind's", "Windows", "windrows", "windlass"],
      editFlags,
      isEditable: true,
      misspelledWord: "windos",
      selectionText: "windos",
      spellcheckEnabled: false,
    }, actions);

    expect(menu.slice(0, 8).map(item => item.label ?? item.type)).toEqual([
      "winds", "windows", "wind's", "Windows", "windrows",
      "separator", "Add to dictionary", "separator",
    ]);
  });

  it("explains dictionary loading and failures truthfully", () => {
    const params = {
      ...nativeParams,
      dictionarySuggestions: [],
      editFlags,
      isEditable: true,
      misspelledWord: "",
      selectionText: "",
      spellcheckEnabled: false,
    };

    const downloading = nativeTextMenuTemplate(params, actions, "linux", { status: "downloading" });
    expect(downloading[0]).toMatchObject({ label: "Spelling dictionary is downloading", enabled: false });

    const downloadFailure = nativeTextMenuTemplate(params, actions, "linux", { status: "unavailable", reason: "download" });
    expect(downloadFailure[0]).toMatchObject({
      label: "Spelling dictionary unavailable — restart the app to retry",
      enabled: false,
    });

    const noLanguage = nativeTextMenuTemplate(params, actions, "linux", { status: "unavailable", reason: "no-language" });
    expect(noLanguage[0]).toMatchObject({
      label: "No spelling dictionary is available for this language",
      enabled: false,
    });

    const configuration = nativeTextMenuTemplate(params, actions, "linux", { status: "unavailable", reason: "configuration" });
    expect(configuration[0]).toMatchObject({
      label: "Spelling dictionary could not be configured",
      enabled: false,
    });
  });

  it("keeps dictionary results authoritative when no suggestions exist", () => {
    const menu = nativeTextMenuTemplate({
      ...nativeParams,
      dictionarySuggestions: [],
      editFlags,
      isEditable: true,
      misspelledWord: "qzxqzx",
      selectionText: "qzxqzx",
      spellcheckEnabled: false,
    }, actions, "linux", { status: "unavailable", reason: "download" });

    expect(menu.slice(0, 4).map(item => item.label ?? item.type)).toEqual([
      "No spelling suggestions", "separator", "Add to dictionary", "separator",
    ]);
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

  it("escapes native menu mnemonics without changing replacement text", () => {
    const lookupMenu = nativeTextMenuTemplate({
      ...nativeParams,
      dictionarySuggestions: [],
      editFlags,
      isEditable: false,
      misspelledWord: "",
      selectionText: "R&D",
      spellcheckEnabled: false,
    }, actions, "win32");
    expect(lookupMenu[0]?.label).toBe("Look Up “R&&D”");

    const suggestionMenu = nativeTextMenuTemplate({
      ...nativeParams,
      dictionarySuggestions: ["R&D"],
      editFlags,
      isEditable: true,
      misspelledWord: "RnD",
      selectionText: "RnD",
      spellcheckEnabled: false,
    }, actions, "linux");
    expect(suggestionMenu[0]?.label).toBe("R&&D");
    suggestionMenu[0]!.click?.({} as never, undefined, {} as never);
    expect(actions.replaceMisspelling).toHaveBeenCalledWith("R&D");
  });
});

describe("spellcheck dictionary lifecycle", () => {
  it("waits for initialization before marking a downloaded dictionary ready", () => {
    let state: SpellcheckMenuState = { status: "ready" };
    state = spellcheckStateForEvent("download-begin", state);
    expect(state).toEqual({ status: "downloading" });

    state = spellcheckStateForEvent("download-success", state);
    expect(state).toEqual({ status: "downloading" });

    state = spellcheckStateForEvent("initialized", state);
    expect(state).toEqual({ status: "ready" });
    expect(spellcheckStateForEvent("initialized")).toEqual({ status: "ready" });

    state = spellcheckStateForEvent("download-failure", state);
    expect(state).toEqual({ status: "unavailable", reason: "download" });
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
