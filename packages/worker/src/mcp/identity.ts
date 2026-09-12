import { HOMEPAGE, PRODUCT_DISPLAY_NAME, PRODUCT_NAME, PRODUCT_VERSION } from "@lasercode/protocol";
import type { McpClientIdentity } from "pi-mcp-adapter/types";

/** One host-owned identity for session, inspector, discovery and OAuth clients. */
export function mcpClientIdentity(): McpClientIdentity {
  return {
    name: `${PRODUCT_NAME}-mcp`,
    title: PRODUCT_DISPLAY_NAME,
    version: PRODUCT_VERSION,
    oauthClientName: PRODUCT_DISPLAY_NAME,
    oauthClientUri: HOMEPAGE,
  };
}
