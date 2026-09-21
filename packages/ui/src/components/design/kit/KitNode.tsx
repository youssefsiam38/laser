"use client";
/**
 * The renderer: one design node, drawn by the kit (M21-T11, D-354).
 *
 * This is the only code that turns a `DesignNode` into elements, and it can
 * only produce what the kit has. Nothing it draws comes from markup, a style
 * string or a handler in the body — those cannot be expressed (the schema) and
 * are refused if they somehow are (`validateDesignTree`). Colour, size and
 * spacing come from the `--design-*` custom properties on the shadow root; the
 * classes here name a role, never a value.
 *
 * It renders inside a shadow root, so it carries no utility classes: the kit
 * stylesheet in the same root is the whole skin.
 */
import { Fragment, type CSSProperties, type ReactNode } from "react";
import type { DesignBody, DesignFlowEdge, DesignNode, DesignPropValue, DesignScreen } from "@lasercode/protocol";
import { designTokenProperty } from "@lasercode/protocol";

import { fixtureItems, fixtureTable, type FixtureData } from "@/design/fixtures";
import { kitNameForEntry, kitPrimitive } from "@/design/kit";
import { treeOf } from "@/design/tree-model";

export interface KitIndexEntry {
  id: string;
  name: string;
  detail?: Readonly<Record<string, string>>;
  reviewed: boolean;
}

export interface KitRenderContext {
  body: DesignBody;
  screen: DesignScreen;
  fixtures?: FixtureData | undefined;
  entries?: ReadonlyMap<string, KitIndexEntry> | undefined;
  /** `edit` selects and edits; `prototype` plays flows; `read` does neither. */
  mode: "edit" | "prototype" | "read";
  selectedNodeId?: string | undefined;
  /** The node whose text is being edited inline right now. */
  editingNodeId?: string | undefined;
  nodeStates: Readonly<Record<string, string>>;
  nodeVariants: Readonly<Record<string, string>>;
  /** Node ids a comment is anchored to, so the frame can mark them. */
  commentedNodeIds?: ReadonlySet<string> | undefined;
  onSelect?: ((nodeId: string) => void) | undefined;
  onActivate?: ((nodeId: string, trigger: DesignFlowEdge["trigger"]) => void) | undefined;
  onBeginTextEdit?: ((nodeId: string) => void) | undefined;
  onCommitText?: ((nodeId: string, text: string) => void) | undefined;
  onReorder?: ((parentId: string, from: number, to: number) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Reading a node's props
// ---------------------------------------------------------------------------

function propOf(node: DesignNode, name: string): DesignPropValue | undefined {
  return node.props[name];
}

function textOf(node: DesignNode, name: string): string | undefined {
  const value = propOf(node, name);
  if (value?.type === "text" || value?.type === "choice") return value.value;
  if (value?.type === "number") return String(value.value);
  return undefined;
}

function boolOf(node: DesignNode, name: string): boolean {
  const value = propOf(node, name);
  return value?.type === "boolean" ? value.value : false;
}

function numberOf(node: DesignNode, name: string): number | undefined {
  const value = propOf(node, name);
  return value?.type === "number" ? value.value : undefined;
}

function fixtureOf(node: DesignNode, name: string): string | undefined {
  const value = propOf(node, name);
  return value?.type === "fixture" ? value.fixtureId : undefined;
}

/** A token prop becomes the custom property the frame already carries. */
function tokenVarOf(node: DesignNode, name: string): string | undefined {
  const value = propOf(node, name);
  return value?.type === "token" ? `var(${designTokenProperty(value.tokenId)})` : undefined;
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

export function KitNode({ nodeId, context }: { nodeId: string; context: KitRenderContext }): ReactNode {
  const tree = treeOf(context.screen);
  const node = tree?.nodes.find((candidate) => candidate.id === nodeId);
  if (!tree || !node) return null;

  const entry = "indexEntryId" in node.component ? context.entries?.get(node.component.indexEntryId) : undefined;
  const primitiveName =
    "primitive" in node.component ? node.component.primitive : kitNameForEntry(entry?.name ?? node.component.indexEntryId, entry?.detail);
  const primitive = kitPrimitive(primitiveName);
  const variant = context.nodeVariants[node.id] ?? node.variant ?? primitive?.variants[0];
  const state = context.nodeStates[node.id] ?? node.state;
  const selected = context.selectedNodeId === node.id;
  const interactive = context.mode === "prototype" && context.body.flows.some((flow) => flow.fromScreenId === context.screen.id && flow.fromNodeId === node.id);

  const classes = [
    "kit-node",
    `kit-${primitiveName}`,
    variant ? `kit-${primitiveName}--${variant}` : undefined,
    state ? `is-${state}` : undefined,
    selected ? "kit-selected" : undefined,
  ].filter((value): value is string => value !== undefined);

  const common = {
    "data-node-id": node.id,
    "data-primitive": primitiveName,
    "data-fidelity": node.fidelity,
    ...(node.unreviewed === true || entry?.reviewed === false ? { "data-unreviewed": "true" } : {}),
    ...(entry ? { "data-entry": entry.id } : {}),
    ...(state ? { "data-state": state } : {}),
    ...(variant ? { "data-variant": variant } : {}),
    ...(context.commentedNodeIds?.has(node.id) === true ? { "data-commented": "true" } : {}),
    ...(interactive ? { "data-interactive": "true" } : {}),
    className: classes.join(" "),
    onClick: (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      if (context.mode === "prototype") context.onActivate?.(node.id, "click");
      else if (context.mode === "edit") context.onSelect?.(node.id);
    },
    ...(context.mode === "edit" && primitive?.inlineText === true
      ? { onDoubleClick: (event: { stopPropagation: () => void }) => {
          event.stopPropagation();
          context.onBeginTextEdit?.(node.id);
        } }
      : {}),
    ...dragHandlers(node.id, context),
  };

  const children = node.children.map((child) => <KitNode key={child} nodeId={child} context={context} />);
  const inlineStyle: CSSProperties = {};
  const colour = tokenVarOf(node, "color");
  if (colour) inlineStyle.color = colour;
  const gap = tokenVarOf(node, "gap");
  if (gap) inlineStyle.gap = gap;
  const columns = numberOf(node, "columns");
  if (columns !== undefined) (inlineStyle as Record<string, string>)["--kit-columns"] = String(columns);
  const ratio = textOf(node, "ratio");
  if (ratio) (inlineStyle as Record<string, string>)["--kit-ratio"] = ratio.replace("/", " / ");

  const editing = context.editingNodeId === node.id;
  const label = textOf(node, "label") ?? node.text ?? "";

  const text = (value: string): ReactNode =>
    editing ? (
      <span
        contentEditable
        suppressContentEditableWarning
        data-editing="true"
        role="textbox"
        tabIndex={0}
        onBlur={(event) => context.onCommitText?.(node.id, event.currentTarget.textContent ?? "")}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            context.onCommitText?.(node.id, event.currentTarget.textContent ?? "");
          }
          if (event.key === "Escape") context.onCommitText?.(node.id, value);
        }}
      >
        {value}
      </span>
    ) : (
      value
    );

  switch (primitiveName) {
    case "stack":
      return (
        <div
          {...common}
          className={[...classes, boolOf(node, "padded") ? "kit-stack--padded" : undefined, textOf(node, "align") ? `kit-stack--align-${String(textOf(node, "align"))}` : undefined]
            .filter((value): value is string => value !== undefined)
            .join(" ")}
          style={inlineStyle}
        >
          {children}
        </div>
      );
    case "grid":
      return (
        <div {...common} style={inlineStyle}>
          {children}
        </div>
      );
    case "text": {
      const content = node.text ?? textOf(node, "label") ?? "";
      return (
        <p {...common} style={inlineStyle}>
          {text(content)}
        </p>
      );
    }
    case "button":
      return (
        <button {...common} type="button" style={inlineStyle} disabled={state === "disabled"}>
          {text(label || "Button")}
        </button>
      );
    case "input":
      return (
        <label {...common} className={[...classes, "kit-field"].join(" ")} style={inlineStyle}>
          {label ? <span className="kit-label">{label}</span> : null}
          <span className={["kit-control", state ? `is-${state}` : undefined].filter((value): value is string => value !== undefined).join(" ")}>
            {textOf(node, "value") ?? <span className="kit-placeholder">{textOf(node, "placeholder") ?? "Type here"}</span>}
          </span>
          {textOf(node, "help") ? <span className="kit-help">{textOf(node, "help")}</span> : null}
        </label>
      );
    case "select": {
      const options = fixtureOf(node, "options") ? fixtureItems(context.body, String(fixtureOf(node, "options")), context.fixtures) : [];
      return (
        <label {...common} className={[...classes, "kit-field"].join(" ")} style={inlineStyle}>
          {label ? <span className="kit-label">{label}</span> : null}
          <span className={["kit-control", state ? `is-${state}` : undefined].filter((value): value is string => value !== undefined).join(" ")}>
            {textOf(node, "value") ?? options[0] ?? <span className="kit-placeholder">Choose one</span>}
          </span>
          {state === "open" && options.length > 0 ? (
            <span className="kit-card kit-card--elevated">
              {options.map((option) => (
                <span key={option} className="kit-text kit-text--caption">
                  {option}
                </span>
              ))}
            </span>
          ) : null}
        </label>
      );
    }
    case "checkbox":
      return (
        <span {...common} style={inlineStyle}>
          <span className={["kit-checkbox__box", boolOf(node, "checked") ? "is-checked" : undefined].filter((value): value is string => value !== undefined).join(" ")} aria-hidden="true" />
          <span>{label || "Option"}</span>
        </span>
      );
    case "card":
      return (
        <section {...common} style={inlineStyle}>
          {textOf(node, "title") ? <span className="kit-card__title">{textOf(node, "title")}</span> : null}
          {textOf(node, "subtitle") ? <span className="kit-card__subtitle">{textOf(node, "subtitle")}</span> : null}
          {entry && node.children.length === 0 && !textOf(node, "title") ? <span className="kit-card__title">{entry.name}</span> : null}
          {children}
        </section>
      );
    case "dialog":
      return (
        <section {...common} style={inlineStyle} role="group" aria-label={textOf(node, "title") ?? "Dialog"}>
          {textOf(node, "title") ? <span className="kit-card__title">{textOf(node, "title")}</span> : null}
          {textOf(node, "description") ? <span className="kit-card__subtitle">{textOf(node, "description")}</span> : null}
          {children}
        </section>
      );
    case "toast":
      return (
        <div {...common} style={inlineStyle} role="status">
          <span className="kit-card__title">{textOf(node, "title") ?? "Something happened"}</span>
          {textOf(node, "detail") ? <span className="kit-card__subtitle">{textOf(node, "detail")}</span> : null}
        </div>
      );
    case "nav": {
      const items = fixtureOf(node, "items") ? fixtureItems(context.body, String(fixtureOf(node, "items")), context.fixtures) : [];
      return (
        <nav {...common} style={inlineStyle}>
          {items.map((item, index) => (
            <span key={item} className={["kit-nav__item", index === 0 ? "is-current" : undefined].filter((value): value is string => value !== undefined).join(" ")}>
              {item}
            </span>
          ))}
          {children}
        </nav>
      );
    }
    case "table": {
      const fixtureId = fixtureOf(node, "rows") ?? fixtureOf(node, "columns");
      const table = fixtureId ? fixtureTable(context.body, fixtureId, context.fixtures) : undefined;
      if (state === "loading") return <KitStateBlock {...common} style={inlineStyle} title="Loading" detail="Rows are on their way." />;
      if (state === "empty") return <KitStateBlock {...common} style={inlineStyle} title="Nothing here yet" detail="The first row will show up here." />;
      if (state === "error") return <KitStateBlock {...common} style={inlineStyle} title="These rows could not be read" detail="Try again in a moment." />;
      return (
        <table {...common} style={inlineStyle}>
          <thead>
            <tr>
              {(table?.columns ?? ["Column"]).map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(table?.rows ?? []).map((row, index) => (
              <tr key={`${String(index)}-${row[0] ?? ""}`}>
                {row.map((cell, cellIndex) => (
                  <td key={`${String(cellIndex)}-${cell}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case "empty":
      return <KitStateBlock {...common} style={inlineStyle} title={textOf(node, "title") ?? "Nothing here yet"} detail={textOf(node, "detail")} />;
    case "loading":
      return <KitStateBlock {...common} style={inlineStyle} title={textOf(node, "label") ?? "Working"} detail={textOf(node, "detail")} />;
    case "error":
      return <KitStateBlock {...common} style={inlineStyle} title={textOf(node, "title") ?? "That did not work"} detail={textOf(node, "detail")} />;
    case "image":
      return (
        <div {...common} style={inlineStyle} role="img" aria-label={textOf(node, "alt") ?? "Image"}>
          {state === "missing" ? "This image is not in the project yet" : (textOf(node, "alt") ?? "Image")}
        </div>
      );
    default:
      // An unknown primitive is never invented: the node says what it wanted.
      return (
        <div {...common} style={inlineStyle}>
          <span className="kit-text kit-text--caption">{`${primitiveName} is not in the kit`}</span>
          {children}
        </div>
      );
  }
}

function KitStateBlock({ title, detail, ...rest }: { title: string; detail?: string | undefined } & Record<string, unknown>): ReactNode {
  const className = [String(rest["className"] ?? ""), "kit-state"].join(" ");
  const props = { ...rest, className } as Record<string, unknown>;
  return (
    <div {...props}>
      <span className="kit-state__title">{title}</span>
      {detail ? <span className="kit-state__detail">{detail}</span> : null}
    </div>
  );
}

/**
 * Drag-reorder inside a layout container.
 *
 * Only inside: a design's structure is the model's to change, and dragging a
 * node across containers on a canvas is how a tree quietly becomes something
 * nobody meant. The keyboard form (Alt+Arrow on the selected node) is the
 * accessible path and is what the tests exercise; these handlers are the
 * pointer form of the same one operation.
 */
function dragHandlers(nodeId: string, context: KitRenderContext): Record<string, unknown> {
  if (context.mode !== "edit" || !context.onReorder) return {};
  const tree = treeOf(context.screen);
  const parent = tree ? tree.nodes.find((candidate) => candidate.children.includes(nodeId)) : undefined;
  if (!parent) return {};
  return {
    draggable: true,
    onDragStart: (event: { dataTransfer?: { setData: (format: string, value: string) => void } | null; stopPropagation: () => void }) => {
      event.stopPropagation();
      event.dataTransfer?.setData("text/plain", nodeId);
    },
    onDragOver: (event: { preventDefault: () => void }) => {
      event.preventDefault();
    },
    onDrop: (event: { preventDefault: () => void; stopPropagation: () => void; dataTransfer?: { getData: (format: string) => string } | null }) => {
      event.preventDefault();
      event.stopPropagation();
      const moved = event.dataTransfer?.getData("text/plain");
      if (!moved || moved === nodeId) return;
      const from = parent.children.indexOf(moved);
      const to = parent.children.indexOf(nodeId);
      // Only inside the one container: a design's structure is the model's to
      // change, and a drag that re-parents a node on a canvas is how a tree
      // quietly becomes something nobody meant.
      if (from < 0 || to < 0) return;
      context.onReorder?.(parent.id, from, to);
    },
  };
}

/** The whole screen: its root node and everything under it. */
export function KitTree({ context }: { context: KitRenderContext }): ReactNode {
  const tree = treeOf(context.screen);
  if (!tree) return null;
  return (
    <Fragment>
      <KitNode nodeId={tree.rootNodeId} context={context} />
    </Fragment>
  );
}
