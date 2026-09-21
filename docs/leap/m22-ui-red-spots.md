# M22 · red spots in packages/ui after the profile rename

Produced by `npx tsc -p packages/ui/tsconfig.json --noEmit` at the head of
`agents/model-profiles-backend-819b3a73`. The raw compiler output, with line
numbers, is beside this file in `m22-ui-cli-red-spots.txt`.

`packages/cli` typechecks clean; its four failing tests are unrelated (see the
backend report).

## packages/ui/src/agents/actions.ts
- Argument of type '"agents/builtin/set-model"' is not assignable to parameter of type 'keyof ClientRequests'.
- Argument of type '"agents/namer/qualify"' is not assignable to parameter of type 'keyof ClientRequests'.
- Module '"@lasercode/protocol"' has no exported member 'AgentModelChoice'.
- Module '"@lasercode/protocol"' has no exported member 'NamerState'.
- Property 'snapshot' does not exist on type '{} | AgentsSnapshot | ProjectFileContent | { entries: unknown[]; leafId?: string | null; window?: HistoryWindow; } | { state: SessionState; replayFrom: number; seq: number; revision?: string; environmentKey?: string; } | ... 144 more ... | { ...; }'.

## packages/ui/src/agents/model.ts
- Object literal may only specify known properties, and 'model' does not exist in type 'AgentDefinitionInput'.

## packages/ui/src/components/agents/page/AgentEditor.tsx
- Object literal may only specify known properties, and 'model' does not exist in type 'Partial<AgentDefinitionInput>'.
- Property 'model' does not exist on type 'AgentDefinitionInput'.

## packages/ui/src/components/agents/page/AgentEditorFields.tsx
- Property 'model' does not exist on type 'AgentDefinitionInput'.

## packages/ui/src/components/agents/page/AgentEditorResources.tsx
- Property 'model' does not exist on type 'AgentDefinitionInput'.

## packages/ui/src/components/agents/page/BuiltinPanel.tsx
- Module '"@lasercode/protocol"' has no exported member 'AgentModelChoice'.
- Module '"@lasercode/protocol"' has no exported member 'NamerCandidate'.
- Module '"@lasercode/protocol"' has no exported member 'NamerState'.
- Property 'beam' does not exist on type 'AgentsSnapshot'.
- Property 'chat' does not exist on type 'AgentsSnapshot'.
- Property 'model' does not exist on type 'AgentDefinition'.
- Property 'namer' does not exist on type 'AgentsSnapshot'.

## packages/ui/src/components/agents/page/dialogs.tsx
- Module '"@lasercode/protocol"' has no exported member 'AgentModelChoice'.

## packages/ui/src/components/agents/page/instruction-template-model.ts
- Module '"@lasercode/protocol"' has no exported member 'AgentModelChoice'.

## packages/ui/src/components/agents/page/model.ts
- Function lacks ending return statement and return type does not include 'undefined'.
- Module '"@lasercode/protocol"' has no exported member 'AgentModelChoice'.
- Module '"@lasercode/protocol"' has no exported member 'NamerState'.
- Parameter 'candidate' implicitly has an 'any' type.
- Property 'model' does not exist on type 'AgentDefinitionInput'.

## packages/ui/src/components/assistant-ui/elements/model-selector.tsx
- Property 'chain' does not exist on type 'SessionFallbackSummary'.
- Property 'defaultModel' does not exist on type '{ models: ModelCatalogEntry[]; enabledPatterns: string[] | null; disabledModels?: string[]; profiles?: ModelProfile[]; assignments?: ProfileAssignments; refreshedAt: string; errors: string[]; }'.
- Property 'defaultProvider' does not exist on type '{ models: ModelCatalogEntry[]; enabledPatterns: string[] | null; disabledModels?: string[]; profiles?: ModelProfile[]; assignments?: ProfileAssignments; refreshedAt: string; errors: string[]; }'.
- Property 'model' does not exist on type 'AgentDefinition'.

## packages/ui/src/components/assistant-ui/elements/reasoning-effort.tsx
- Property 'model' does not exist on type 'AgentDefinition'.

## packages/ui/src/components/beam/BeamEmptyState.tsx
- Property 'beam' does not exist on type 'AgentsSnapshot'.

## packages/ui/src/components/beam/BeamModelDialog.tsx
- Module '"@lasercode/protocol"' has no exported member 'AgentModelChoice'.
- Property 'beam' does not exist on type 'AgentsSnapshot'.

## packages/ui/src/components/onboarding/FirstRunFlow.tsx
- Property 'defaultModel' does not exist on type '{ models: ModelCatalogEntry[]; enabledPatterns: string[] | null; disabledModels?: string[]; profiles?: ModelProfile[]; assignments?: ProfileAssignments; refreshedAt: string; errors: string[]; }'.
- Property 'defaultProvider' does not exist on type '{ models: ModelCatalogEntry[]; enabledPatterns: string[] | null; disabledModels?: string[]; profiles?: ModelProfile[]; assignments?: ProfileAssignments; refreshedAt: string; errors: string[]; }'.

## packages/ui/src/components/onboarding/ModelStep.tsx
- Property 'defaultModel' does not exist on type '{ models: ModelCatalogEntry[]; enabledPatterns: string[] | null; disabledModels?: string[]; profiles?: ModelProfile[]; assignments?: ProfileAssignments; refreshedAt: string; errors: string[]; }'.
- Property 'defaultProvider' does not exist on type '{ models: ModelCatalogEntry[]; enabledPatterns: string[] | null; disabledModels?: string[]; profiles?: ModelProfile[]; assignments?: ProfileAssignments; refreshedAt: string; errors: string[]; }'.

## packages/ui/src/components/settings/SettingsForm.tsx
- Property 'defaultModel' does not exist on type '{ models: ModelCatalogEntry[]; enabledPatterns: string[] | null; disabledModels?: string[]; profiles?: ModelProfile[]; assignments?: ProfileAssignments; refreshedAt: string; errors: string[]; }'.
- Property 'defaultProvider' does not exist on type '{ models: ModelCatalogEntry[]; enabledPatterns: string[] | null; disabledModels?: string[]; profiles?: ModelProfile[]; assignments?: ProfileAssignments; refreshedAt: string; errors: string[]; }'.

## packages/ui/src/components/settings/fallback/FallbackChainsTab.tsx
- Module '"@lasercode/protocol"' has no exported member 'FALLBACK_CHAINS_SETTING'.
- Module '"@lasercode/protocol"' has no exported member 'FallbackChain'.
- Module '"@lasercode/protocol"' has no exported member 'FallbackChainIssue'.
- Module '"@lasercode/protocol"' has no exported member 'FallbackModelRef'.
- Module '"@lasercode/protocol"' has no exported member 'readFallbackChainsValue'.
- Module '"@lasercode/protocol"' has no exported member 'validateFallbackChains'.
- Parameter 'issue' implicitly has an 'any' type.

## packages/ui/src/runtime/provisional-paint.ts
- Property 'profile' is missing in type '{ agent?: SessionAgentInfo; model: null; thinkingLevel: "off"; isStreaming: false; isCompacting: false; steeringMode: "all"; followUpMode: "all"; autoCompactionEnabled: false; ... 5 more ...; cwd: string; }' but required in type 'SessionState'.

## packages/ui/src/store.ts
- Module '"@lasercode/protocol"' has no exported member 'AgentModelChoice'.
- Property 'agents/beam/choose-model' does not exist on type 'HostNotifications'.
- Property 'chain' does not exist on type 'SessionFallbackSummary'.
- Type '"agents/beam/choose-model"' is not comparable to type 'keyof HostNotifications'.
