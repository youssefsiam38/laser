export * from "./driver.js";
export { StableSdkDriver } from "./drivers/stable-sdk.js";
export { ChordDriver } from "./drivers/chord.js";
export { createUiBridge, type UiBridge, type UiBridgeOptions } from "./ui-bridge.js";
export { WorkerServer, type WorkerServerOptions } from "./server.js";

// M4 · settings, packages, providers and models.
export {
  PI_SETTINGS_TOP_LEVEL_KEYS,
  SETTINGS_FIELDS,
  SETTINGS_SECTIONS,
  SettingsAdapter,
  SettingsError,
  getAtPath,
  mergeSettings,
  setAtPath,
  settingsCatalog,
  unsetAtPath,
  validateSettingValue,
  type SettingsAdapterOptions,
} from "./settings.js";
export {
  ModelsAdapter,
  PackagesAdapter,
  PackagesError,
  supportedThinkingLevels,
  type ModelCatalogResult,
  type ModelsAdapterOptions,
  type PackagesAdapterOptions,
} from "./packages.js";

// M4-T7 · the agent's own keybindings, and the `@` popover's file list.
export { KeybindingsAdapter, KeybindingsError } from "./keybindings.js";
export { ProjectFilesService, scoreMatch } from "./files.js";

// M8-T2 · dictation. The service the server owns, and the contracts the UI's
// level meter and the companion extension share with it.
export {
  DEFAULT_DRAIN_TIMEOUT_MS,
  MAX_UPLOADS_IN_FLIGHT,
  MAX_UPLOAD_BYTES,
  TRANSCRIBE_BRIDGE_KEY,
  TRANSCRIBE_BRIDGE_SYMBOL,
  TranscribeError,
  TranscribeService,
  WAVE_ATTACK,
  WAVE_CEIL_DB,
  WAVE_FLOOR_DB,
  WAVE_RELEASE,
  audioExtensionFor,
  followEnvelope,
  levelToUnit,
  loadTranscribeConfig,
  resolveTranscriptionKey,
  transcribeAudio,
  transcribeBridge,
  transcribeConfigPath,
  type BeginUpload,
  type KeySources,
  type TranscribeBridge,
  type TranscribeConfig,
  type TranscribeErrorReason,
  type TranscribeServiceOptions,
  type WidgetState,
} from "./transcribe.js";
export * from "./resolve-pi.js";
