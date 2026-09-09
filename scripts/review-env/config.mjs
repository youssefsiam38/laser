import { resolve } from "node:path";
import { identity as product } from "../identity/identity.mjs";

export const projectName = `${product.name}-review-env`;
export const defaultPort = 43187;
export const roots = Object.freeze({
  home: "/review/home", config: "/review/config", data: "/review/data",
  state: "/review/state", cache: "/review/cache", logs: "/review/logs",
  repositories: "/review/repositories", runtime: "/review/runtime",
  temporary: "/review/tmp", workspace: "/review/workspace",
});
export const applicationPaths = Object.freeze({
  agent: `${roots.data}/agent`, sessions: `${roots.data}/sessions`,
  hostRecord: `${roots.state}/host.json`,
});

/** Plain JSON is a Compose document; no shell interpolation or env-file reads. */
export function composeConfiguration(checkout, port = defaultPort) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Review port must be between 1024 and 65535.");
  const environment = {
    HOME: roots.home, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data,
    XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
    TMPDIR: roots.temporary, npm_config_cache: `${roots.cache}/npm`,
    npm_config_userconfig: `${roots.config}/npmrc`, PNPM_HOME: `${roots.cache}/pnpm`,
    ELECTRON_CACHE: `${roots.cache}/electron`, ELECTRON_BUILDER_CACHE: `${roots.cache}/electron-builder`,
    PLAYWRIGHT_BROWSERS_PATH: `${roots.cache}/browsers`,
    GIT_CONFIG_GLOBAL: `${roots.config}/gitconfig`, GIT_CONFIG_NOSYSTEM: "1",
    REVIEW_ISOLATED: "1", REVIEW_PUBLIC_PORT: String(port),
    [product.env.agentDir]: applicationPaths.agent,
    [product.env.sessionDir]: applicationPaths.sessions,
    [product.env.stateDir]: roots.state,
    [product.env.node]: "/usr/local/bin/node",
    PI_CODING_AGENT_DIR: applicationPaths.agent,
    PI_CODING_AGENT_SESSION_DIR: applicationPaths.sessions,
  };
  return {
    name: projectName,
    services: {
      app: {
        image: `${projectName}:runtime`,
        build: { context: resolve(checkout, "scripts/review-env") },
        init: true, user: "1000:1000", read_only: true,
        cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"],
        pids_limit: 1024, shm_size: "512mb", stop_grace_period: "45s",
        environment,
        volumes: [
          { type: "bind", source: resolve(checkout), target: "/source", read_only: true, bind: { create_host_path: false } },
          ...Object.entries(roots).map(([source, target]) => ({ type: "volume", source, target })),
        ],
        ports: [{ target: 43187, published: String(port), host_ip: "127.0.0.1", protocol: "tcp" }],
        healthcheck: {
          test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:43187/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
          interval: "5s", timeout: "3s", retries: 12, start_period: "10s",
        },
        logging: { driver: "local", options: { "max-size": "10m", "max-file": "3" } },
      },
    },
    volumes: Object.fromEntries(Object.keys(roots).map(name => [name, {}])),
  };
}
