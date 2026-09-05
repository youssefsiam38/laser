/**
 * The one place the worker re-exports Pi's UI types, so ui-bridge.ts reads as
 * plain TypeScript and a Pi rename shows up here first.
 */
export type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
export type { UiDialogRequest, UiDialogResponse, UiFireAndForget } from "@piorbit/protocol";
