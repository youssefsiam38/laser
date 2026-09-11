"use client";
/**
 * The custom door and the edit form (docs/mcp.md "Adding" → *Custom*): a
 * transport picker and only the fields that transport has. Nothing here is
 * engine vocabulary — a command, an address or a socket file, and the words a
 * person would use for the rest.
 *
 * Secrets are write-only everywhere in this form: a saved value is never
 * fetched back, so a field says "Saved" or "Needs a value" and only what the
 * person types now travels to `mcp/save`.
 */
import { MCP_STARTUP_MODES, MCP_PROTOCOL_VERSIONS, type McpAuthKind, type McpScope, type McpStartup, type McpTransportKind } from "@lasercode/protocol";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useId, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { SettingsSwitch } from "@/components/assistant-ui/elements/settings-panel";
import { cn } from "@/lib/utils";

import { selectClass } from "../fields.js";
import { deriveName, formIssues, keepsStoredSecret, valueRow, type SecretField, type ServerForm, type ValueRow } from "./model.js";

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children(id)}
      {hint && <p className="text-xs leading-5 text-ink-3">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs leading-5 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A labelled group of controls. `Field`'s `<label for=…>` needs one control to
 * point at; a set of rows has none, so it gets a group with a name instead.
 */
export function FieldGroup({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div role="group" aria-label={label} className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && <p className="text-xs leading-5 text-ink-3">{hint}</p>}
    </div>
  );
}

export function SwitchRow({
  label,
  detail,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm text-ink">{label}</span>
        {detail && <span className="text-xs leading-5 text-ink-3">{detail}</span>}
      </span>
      <SettingsSwitch checked={checked} disabled={disabled} aria-label={label} onCheckedChange={onChange} />
    </div>
  );
}

/** A password field that says whether something is stored, and never shows it. */
export function SecretInput({
  id,
  field,
  onChange,
  placeholder,
  autoComplete = "new-password",
}: {
  id?: string;
  field: SecretField;
  onChange: (next: SecretField) => void;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Input
        id={id}
        type="password"
        autoComplete={autoComplete}
        value={field.value}
        placeholder={placeholder ?? (field.stored ? "Saved — type to replace it" : "Paste the value")}
        onChange={(event) => onChange({ ...field, value: event.target.value })}
      />
      <p className="text-xs text-ink-3">
        {field.value ? "Will be saved when you add the server." : field.stored ? "Saved. It is never shown again." : "Needs a value."}
      </p>
    </div>
  );
}

/** Environment variables and headers: a key, a value, and whether it is a secret. */
export function ValueRows({
  rows,
  onChange,
  keyLabel,
  addLabel,
  ariaLabel,
}: {
  rows: ValueRow[];
  onChange: (rows: ValueRow[]) => void;
  keyLabel: string;
  addLabel: string;
  ariaLabel: string;
}) {
  const update = (id: string, patch: Partial<ValueRow>) => onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  return (
    <div className="flex flex-col gap-2" aria-label={ariaLabel} role="group">
      {rows.map((row) => (
        <div key={row.id} data-slot="mcp-value-row" className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={`${keyLabel} name`}
            value={row.key}
            placeholder={keyLabel}
            className="w-40 flex-1"
            onChange={(event) => update(row.id, { key: event.target.value })}
          />
          <span className="flex w-40 min-w-0 flex-1 flex-col gap-0.5">
            <Input
              aria-label={`${row.key || keyLabel} value`}
              type={row.secret ? "password" : "text"}
              autoComplete={row.secret ? "new-password" : "off"}
              value={row.value}
              placeholder={row.stored ? "Saved — type to replace it" : "Value"}
              onChange={(event) => update(row.id, { value: event.target.value })}
            />
            {/* Un-marking a secret is how you look, not how you delete: the
                saved value stays until something is typed over it. */}
            {keepsStoredSecret(row) && <span className="text-xs text-ink-3">Type a value to replace the saved one.</span>}
          </span>
          <Button
            type="button"
            variant={row.secret ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={row.secret}
            title={row.secret ? "Kept in the app’s secret store, out of the file" : "Kept in the configuration file"}
            onClick={() => update(row.id, { secret: !row.secret })}
          >
            {row.secret ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />} Secret
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${row.key || keyLabel}`}
            onClick={() => onChange(rows.filter((entry) => entry.id !== row.id))}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      ))}
      <div>
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...rows, valueRow()])}>
          <Plus aria-hidden="true" /> {addLabel}
        </Button>
      </div>
    </div>
  );
}

/** Where the server is saved. The same two words the Features screen uses. */
export function ScopeChoice({
  scope,
  onChange,
  disabled,
  allowProject = true,
  label = "Save it for",
}: {
  scope: McpScope;
  onChange: (scope: McpScope) => void;
  disabled?: boolean;
  /** False with no project open: there is no project to save anything for. */
  allowProject?: boolean;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-ink-2">{label}</span>
      <div role="group" aria-label={label} className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
        {(["global", "project"] as const).map((option) => (
          <Button
            key={option}
            type="button"
            aria-pressed={scope === option}
            disabled={disabled || (option === "project" && !allowProject)}
            variant="ghost"
            size="sm"
            onClick={() => onChange(option)}
            className={cn(scope === option && "bg-surface text-ink")}
          >
            {option === "global" ? "Every project" : "This project"}
          </Button>
        ))}
      </div>
    </div>
  );
}

const TRANSPORTS: Array<{ kind: McpTransportKind; label: string; hint: string }> = [
  { kind: "stdio", label: "Command", hint: "A program on this machine that the app starts." },
  { kind: "http", label: "URL", hint: "A server reached over the network, by HTTP." },
  { kind: "socket", label: "Socket", hint: "A socket file another program is already listening on." },
];

const AUTH: Array<{ kind: McpAuthKind; label: string }> = [
  { kind: "none", label: "None" },
  { kind: "bearer", label: "Token" },
  { kind: "oauth", label: "Sign in with the service" },
];

const STARTUP_LABEL: Record<McpStartup, string> = {
  "on-demand": "When a tool is first used, then let it idle out",
  "on-demand-keep": "When a tool is first used, then keep it running",
  "at-start": "When a conversation starts",
  always: "Keep it running at all times",
};

export function McpServerForm({
  form,
  onChange,
  showIssues,
  disabled,
}: {
  form: ServerForm;
  onChange: (next: ServerForm) => void;
  /** Issues are silent until the person tries to test or add. */
  showIssues: boolean;
  disabled?: boolean;
}) {
  const issues = showIssues ? formIssues(form) : {};
  const set = (patch: Partial<ServerForm>) => onChange({ ...form, ...patch });

  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-4 disabled:opacity-60">
      {/* Buttons that press in rather than a radio group: they are three
          alternatives, but they behave like a row of buttons, and saying
          "radio" without arrow keys is a promise the keyboard does not keep. */}
      <div role="group" aria-label="How to reach the server" className="flex flex-wrap items-center gap-1 rounded-lg bg-surface-2 p-0.5">
        {TRANSPORTS.map((option) => (
          <Button
            key={option.kind}
            type="button"
            aria-pressed={form.kind === option.kind}
            variant="ghost"
            size="sm"
            title={option.hint}
            onClick={() => set({ kind: option.kind, ...(option.kind === "http" ? {} : { authKind: "none" }) })}
            className={cn(form.kind === option.kind && "bg-surface text-ink")}
          >
            {option.label}
          </Button>
        ))}
      </div>

      <Field label="Name it" hint="What you will see in the list.">
        {(id) => (
          <Input
            id={id}
            value={form.label}
            placeholder="Playwright"
            onChange={(event) =>
              set({ label: event.target.value, ...(form.nameEdited ? {} : { name: deriveName(event.target.value) }) })
            }
          />
        )}
      </Field>

      <Field
        label="Short name"
        error={issues.name}
        hint="Goes in front of every tool the model sees. Letters, digits, hyphens and underscores."
      >
        {(id) => (
          <Input
            id={id}
            value={form.name}
            aria-invalid={issues.name ? true : undefined}
            placeholder="playwright"
            onChange={(event) => set({ name: event.target.value, nameEdited: true })}
          />
        )}
      </Field>

      {form.kind === "stdio" && (
        <>
          <Field
            label="Command"
            error={issues.commandLine}
            hint="Paste it the way you would run it yourself, arguments and all."
          >
            {(id) => (
              <Input
                id={id}
                value={form.commandLine}
                aria-invalid={issues.commandLine ? true : undefined}
                placeholder="npx -y @playwright/mcp@latest"
                spellCheck={false}
                onChange={(event) => set({ commandLine: event.target.value })}
              />
            )}
          </Field>
          <FieldGroup label="Environment variables" hint="Anything the program needs. Mark a value secret to keep it out of the file.">
            <ValueRows rows={form.env} keyLabel="Variable" addLabel="Add a variable" ariaLabel="Environment variables" onChange={(env) => set({ env })} />
          </FieldGroup>
          <Field label="Run it in" hint="Leave empty to run it in the project folder.">
            {(id) => <Input id={id} value={form.cwd} placeholder="/path/to/a/folder" onChange={(event) => set({ cwd: event.target.value })} />}
          </Field>
          <SwitchRow
            label="Pass this app’s environment to it"
            detail="Off means it starts with only the variables above."
            checked={form.inheritEnv}
            onChange={(inheritEnv) => set({ inheritEnv })}
          />
        </>
      )}

      {form.kind === "http" && (
        <>
          <Field label="Address" error={issues.url}>
            {(id) => (
              <Input
                id={id}
                type="url"
                value={form.url}
                aria-invalid={issues.url ? true : undefined}
                placeholder="https://mcp.example.com/mcp"
                spellCheck={false}
                onChange={(event) => set({ url: event.target.value })}
              />
            )}
          </Field>
          <FieldGroup label="Headers" hint="Sent with every request. Mark a value secret to keep it out of the file.">
            <ValueRows rows={form.headers} keyLabel="Header" addLabel="Add a header" ariaLabel="Headers" onChange={(headers) => set({ headers })} />
          </FieldGroup>
          <Field label="How it streams" hint="Leave on automatic unless the server only speaks one of them.">
            {(id) => (
              <select
                id={id}
                className={selectClass}
                value={form.stream}
                onChange={(event) => set({ stream: event.target.value as ServerForm["stream"] })}
              >
                <option value="auto">Automatic</option>
                <option value="streamable-http">Streaming HTTP only</option>
                <option value="sse">Server-sent events only</option>
              </select>
            )}
          </Field>
          <Field label="Certificate file" hint="Only for a server with its own certificate authority.">
            {(id) => <Input id={id} value={form.caFile} placeholder="/path/to/ca.pem" onChange={(event) => set({ caFile: event.target.value })} />}
          </Field>

          <section data-slot="mcp-sign-in-options" aria-label="Sign-in options" className="flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-3">
            <Field label="Sign-in" hint="How this server knows who you are.">
              {(id) => (
                <select
                  id={id}
                  className={selectClass}
                  value={form.authKind}
                  onChange={(event) => set({ authKind: event.target.value as McpAuthKind })}
                >
                  {AUTH.map((option) => (
                    <option key={option.kind} value={option.kind}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {form.authKind === "bearer" && (
              <Field label="Token" error={issues.token} hint="Kept in the app’s secret store, never in the configuration file.">
                {(id) => <SecretInput id={id} field={form.token} onChange={(token) => set({ token })} />}
              </Field>
            )}
            {form.authKind === "oauth" && (
              <>
                <p className="text-sm leading-6 text-ink-2">
                  You will sign in through your browser after adding it. Most servers need nothing more.
                </p>
                <Collapsible>
                  <CollapsibleTrigger className="text-start text-sm text-live underline-offset-4 hover:underline">
                    Advanced sign-in settings
                  </CollapsibleTrigger>
                  <CollapsibleContent className="flex flex-col gap-3 pt-3">
                    <Field label="Client id">
                      {(id) => <Input id={id} value={form.oauthClientId} onChange={(event) => set({ oauthClientId: event.target.value })} />}
                    </Field>
                    <Field label="Client secret">
                      {(id) => (
                        <SecretInput id={id} field={form.oauthClientSecret} onChange={(oauthClientSecret) => set({ oauthClientSecret })} />
                      )}
                    </Field>
                    <Field label="Scope">
                      {(id) => <Input id={id} value={form.oauthScope} onChange={(event) => set({ oauthScope: event.target.value })} />}
                    </Field>
                    <Field label="Redirect address">
                      {(id) => <Input id={id} value={form.oauthRedirectUri} onChange={(event) => set({ oauthRedirectUri: event.target.value })} />}
                    </Field>
                    <Field label="Sign-in details address">
                      {(id) => <Input id={id} value={form.oauthMetadataUrl} onChange={(event) => set({ oauthMetadataUrl: event.target.value })} />}
                    </Field>
                    <Field label="How it signs in">
                      {(id) => (
                        <select
                          id={id}
                          className={selectClass}
                          value={form.oauthGrantType}
                          onChange={(event) => set({ oauthGrantType: event.target.value as ServerForm["oauthGrantType"] })}
                        >
                          <option value="authorization_code">In your browser</option>
                          <option value="client_credentials">With the client id and secret above</option>
                        </select>
                      )}
                    </Field>
                  </CollapsibleContent>
                </Collapsible>
              </>
            )}
          </section>
        </>
      )}

      {form.kind === "socket" && (
        <Field label="Socket file" error={issues.socketPath} hint="The path another program is listening on.">
          {(id) => (
            <Input
              id={id}
              value={form.socketPath}
              aria-invalid={issues.socketPath ? true : undefined}
              placeholder="/tmp/memory.sock"
              onChange={(event) => set({ socketPath: event.target.value })}
            />
          )}
        </Field>
      )}

      <Field label="When it starts">
        {(id) => (
          <select id={id} className={selectClass} value={form.startup} onChange={(event) => set({ startup: event.target.value as McpStartup })}>
            {MCP_STARTUP_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {STARTUP_LABEL[mode]}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Collapsible>
        <CollapsibleTrigger className="text-start text-sm text-live underline-offset-4 hover:underline">Advanced</CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-4 pt-3">
          <Field label="Stop it after this many idle minutes" hint="Leave empty to use the app’s own timing.">
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                value={form.idleMinutes}
                placeholder="10"
                onChange={(event) => set({ idleMinutes: event.target.value })}
              />
            )}
          </Field>
          <Field label="Give up on a call after this many milliseconds" hint="Leave empty to use the app’s own timing.">
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                value={form.requestTimeoutMs}
                placeholder="30000"
                onChange={(event) => set({ requestTimeoutMs: event.target.value })}
              />
            )}
          </Field>
          <Field label="Protocol version" hint="Only change this for a server that asks for it.">
            {(id) => (
              <select
                id={id}
                className={selectClass}
                value={form.protocolVersion}
                onChange={(event) => set({ protocolVersion: event.target.value as ServerForm["protocolVersion"] })}
              >
                {MCP_PROTOCOL_VERSIONS.map((version) => (
                  <option key={version} value={version}>
                    {version === "auto" ? "Whatever the server speaks" : version === "legacy" ? "The older one" : version}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <SwitchRow
            label="Offer its documents as tools"
            detail="Some servers publish files and pages; this lets the model read them."
            checked={form.resourcesAsTools}
            onChange={(resourcesAsTools) => set({ resourcesAsTools })}
          />
          <SwitchRow
            label="Keep a detailed log"
            detail="Everything it says goes to the app’s log, for when something is wrong."
            checked={form.debug}
            onChange={(debug) => set({ debug })}
          />
        </CollapsibleContent>
      </Collapsible>
    </fieldset>
  );
}
