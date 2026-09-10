import type { ClientRequests } from "@lasercode/protocol";

/** Configuration the composer may attach to one pristine session's first prompt. */
export type TentativeFirstTurn = NonNullable<ClientRequests["session/prompt"]["params"]["firstTurn"]>;

/**
 * Composer state lives outside the persisted app store: choosing an agent is
 * navigation-neutral and disappears when that composer scope disappears.
 * The adapter reads the same object before it creates an anonymous session, so
 * keyboard and pointer sends take the identical path through assistant-ui.
 */
const tentativeByScope = new Map<string, TentativeFirstTurn>();

export function readTentativeFirstTurn(scope: string | undefined): TentativeFirstTurn | undefined {
  return scope ? tentativeByScope.get(scope) : undefined;
}

export function writeTentativeFirstTurn(scope: string, value: TentativeFirstTurn | undefined): void {
  if (value) tentativeByScope.set(scope, value);
  else tentativeByScope.delete(scope);
}

/** Follow an anonymous composer onto the one session its send just created. */
export function moveTentativeFirstTurn(from: string | undefined, to: string, value: TentativeFirstTurn): void {
  if (!from || from === to || tentativeByScope.get(from) !== value) return;
  tentativeByScope.delete(from);
  tentativeByScope.set(to, value);
}

/** Clear only the choice this send consumed; a newer choice must survive. */
export function consumeTentativeFirstTurn(scope: string | undefined, value: TentativeFirstTurn): void {
  if (scope && tentativeByScope.get(scope) === value) tentativeByScope.delete(scope);
}

/** Discard this composer's value even if anonymous initialization moved it. */
export function discardTentativeFirstTurn(value: TentativeFirstTurn): void {
  for (const [scope, candidate] of tentativeByScope) {
    if (candidate === value) tentativeByScope.delete(scope);
  }
}
