/**
 * Runtime discovery, once per process generation.
 *
 * `Runtime.queryObjects` is the hard checkpoint that proves the harness is
 * reading the real object and not a name: it walks the heap for live instances
 * of a prototype, and it forces a garbage collection to do it. That is exactly
 * what a memory measurement must not repeat every phase. So each
 * `(pid, startToken)` generation gets exactly one checkpoint; the instance it
 * finds is then published on that process's own global, and every later phase
 * reads the published handle with a plain evaluate — no query, no forced
 * collection, and no pretending discovery happened when it did not.
 */
import { queryInstances, callFunction } from './inspector.mjs';

export const PUBLISHED = '__resourceSoakInstances';

export class DiscoveryRegistry {
  constructor({ query = queryInstances } = {}) {
    this.query = query;
    /** generation key -> { exports: Map<name, {checkpointedAt, count}> } */
    this.generations = new Map();
  }
  key(pid, startToken) { return `${pid}:${startToken}`; }
  checkpoints() {
    return [...this.generations.entries()].map(([generation, value]) => ({
      generation: generation.split(':')[0] === '' ? 'unknown' : 'one process generation',
      exports: [...value.exports.entries()].map(([name, row]) => ({ name, instances: row.count })),
    }));
  }
  /** Was this export ever proved live in this generation, by query, not by name? */
  proved(name) {
    for (const value of this.generations.values()) if (value.exports.has(name)) return true;
    return false;
  }

  /**
   * The instance handle for one export in one process generation: queried once,
   * published on the target's global, and afterwards fetched from that global.
   */
  async handle(client, { pid, startToken, moduleUrl, exportName }) {
    const key = this.key(pid, startToken);
    const generation = this.generations.get(key) ?? { exports: new Map() };
    this.generations.set(key, generation);
    if (generation.exports.has(exportName)) {
      const published = await client.send('Runtime.evaluate', {
        expression: `globalThis.${PUBLISHED}?.[${JSON.stringify(exportName)}]`,
        objectGroup: 'resource-published',
      });
      if (published.result?.objectId) return { objectId: published.result.objectId, source: 'published handle', group: 'resource-published' };
      // The publication is gone (a reloaded module, a replaced instance): the
      // checkpoint has to be paid again rather than quietly reported as done.
      generation.exports.delete(exportName);
    }
    const found = await this.query(client, moduleUrl, exportName);
    try {
      await callFunction(client, found.instanceId,
        `function(){ (globalThis.${PUBLISHED} ??= Object.create(null))[${JSON.stringify(exportName)}] = this; return true; }`,
        { returnByValue: true });
      generation.exports.set(exportName, { count: found.count, checkpointedAt: Date.now() });
      const published = await client.send('Runtime.evaluate', {
        expression: `globalThis.${PUBLISHED}[${JSON.stringify(exportName)}]`,
        objectGroup: 'resource-published',
      });
      if (!published.result?.objectId) throw new Error(`${exportName} could not be published for later phases.`);
      return { objectId: published.result.objectId, source: 'queryObjects checkpoint', group: 'resource-published', count: found.count };
    } finally {
      await client.send('Runtime.releaseObjectGroup', { objectGroup: found.group }).catch(() => {});
    }
  }
}
