# Agents LEAP — implementation preparation

All material specific to this LEAP is collected here. The consolidated implementation prompt has not been written; the three specifications below are its source material.

**Current scope:** one visual agent editor, one configuration model and one execution system, from a lone agent or parent → worker to detailed coordination. Instructions are supplemented by enforceable relationships, dependencies, shared inputs, checks and outcome rules. The entire LEAP is one complete waterfall delivery; no simple/advanced interface split or deferred coordination editor.

**Product terms:** **Agent name**, **Agent definition**, **Assignment** and **Session** follow the [terminology contract](agents-responsibility-contract.md#product-terminology). “Character” is a metaphor, not a product label.

**Runtime ownership:** D-134 requires a complete replacement of `pi-subagents` with our own implementation while retaining the Pi coding-agent engine. The [implementation study](implementation-study/README.md) maps the pinned source, workflow scripts, replacement responsibilities and regression cases.

## Try the experience

Open the [interactive learning prototype](prototype/index.html). Its ten-step guide builds one configuration from a lone agent into a coordinated team, with simulated live control, conversations, shared state and supporting agents. [Prototype guide and file map](prototype/README.md) · [validation](prototype/VALIDATION.md).

## Read in this order

| File | Purpose |
| --- | --- |
| [Discovery and feasibility](agents-leap-discovery.md) | Scope, agreed decisions, verified source findings, implementation gaps and remaining proposed defaults |
| [Responsibility contract](agents-responsibility-contract.md) | Universal agents, capabilities/access, communication, goal ownership, approvals, full conversations and transparent control |
| [Live experience](agents-live-experience.md) | Unified React Flow editor, live visualization/control, conversations, changes, shared information and acceptance scenarios |
| [Subagent implementation study](implementation-study/README.md) | Exact source/test snapshot, runtime and workflow walkthroughs, replacement blueprint and acceptance matrix |
| [React Flow skill](skills/react-flow/SKILL.md) | Implementation guidance; includes 14 reference guides, license and [source provenance](skills/react-flow/UPSTREAM.md) |

## Source material

| File | Purpose |
| --- | --- |
| [Original request](references/original-request.md) | The user's original proposal, preserved verbatim; later decisions in the specifications take precedence |
| [Multi-agent architecture example](references/multi-agent-arch.md) | Examples achievable through the unified editor; not mandatory framework modes or evidence for delivery periods |
| [Pi and pi-subagents reference](references/pi-subagents-reference.md) | Detailed source reference; the specifications identify outdated statements such as historical Goal budgets |

## Reference map

```text
README.md
  ├─ prototype/README.md → prototype/index.html
  │    └─ src/ → build.mjs → standalone page; tests/ verify interactions
  ├─ implementation-study/README.md
  │    ├─ runtime-walkthrough.md → workflow-scripting.md
  │    ├─ contracts-and-controls.md → replacement-blueprint.md → acceptance-matrix.md
  │    └─ source-map.md + test-index.md → upstream/ + upstream-tests/; verification.md
  └─ agents-leap-discovery.md
       ├─ agents-responsibility-contract.md ←→ agents-live-experience.md
       │                                        └─ skills/react-flow/
       └─ references/
            ├─ original-request.md
            ├─ multi-agent-arch.md
            └─ pi-subagents-reference.md
```

The responsibility contract and live experience are binding specification content. Source examples and the upstream skill cannot override the user's decisions or repository boundaries. The original request is preserved verbatim from the supplied attachment in `references/original-request.md`. Historical proposal text is source material; the active specifications govern the implementation.

Repository-wide documents remain in their required locations: [AGENTS.md](../../AGENTS.md), [PLAN.md](../../PLAN.md), [STATUS.md](../../STATUS.md), [STATUS_DETAILED.md](../../STATUS_DETAILED.md), [architecture](../architecture.md) and the existing UI constitution. M3-T11 tracks specification preparation; M3-T12 tracks the interactive teaching prototype; M3-T13 tracks the source study for complete replacement. Historical ledger paths are preserved; the current task rows and relocation decision identify the new locations.

The old `.agents/skills/react-flow` path is a relative symlink to `skills/react-flow` here. There is one physical copy of the skill, with the original skill entry point retained.
