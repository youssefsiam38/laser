/**
 * The design surfaces (M21-T11): the canvas, its frames, the kit renderer,
 * the sandboxed sketch frame, the inspectors and the Design Index panel;
 * and (M21-T13) the wire they read through and the in-context frame.
 */
export { DesignCanvas, type DesignCanvasProps } from "./DesignCanvas.js";
export { DesignIndexPanel, type DesignIndexAccess, type DesignIndexState, type DesignReindexState, type DesignReviewVerb } from "./DesignIndexPanel.js";
export { HostContextPanel, HOST_PENDING_SENTENCE, type GroundHostPage, type HostContextPanelProps } from "./HostContextPanel.js";
export { useDesignAccess, DISCONNECTED_SENTENCE, type DesignWorkspaceAccess } from "./use-design-access.js";
export { FoundationCanvas, type FoundationCanvasProps } from "./FoundationCanvas.js";
export { FoundationTokenEditor, type FoundationTokenEditorProps } from "./FoundationTokenEditor.js";
export { FoundationWizard, FOUNDATION_STEP_PENDING_SENTENCE, FOUNDATION_UNSAVED_SENTENCE, type FoundationWizardProps } from "./FoundationWizard.js";
export { NodeInspector, TokenField, type NodeInspectorProps } from "./NodeInspector.js";
export { PrototypeStage } from "./PrototypeStage.js";
export { ScreenFrame, FIDELITY_LABEL, FIDELITY_TONE, type SketchBytes } from "./ScreenFrame.js";
export { ScreenInspector, GROUND_PENDING_SENTENCE, type GroundSketch } from "./ScreenInspector.js";
export { SketchFrame } from "./SketchFrame.js";
export { TreeFrame } from "./TreeFrame.js";
export { KitNode, KitTree, type KitIndexEntry, type KitRenderContext } from "./kit/KitNode.js";
