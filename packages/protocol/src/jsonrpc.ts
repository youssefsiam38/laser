/** Minimal JSON-RPC 2.0 envelope. One record per line when carried over a byte stream. */

export type JsonRpcId = string | number;

export interface JsonRpcRequest<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: M;
  params: P;
}

export interface JsonRpcNotification<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  method: M;
  params: P;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: R;
  error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  // piorbit-specific range
  SessionNotFound: -32000,
  SessionBusy: -32001,
  DriverUnavailable: -32002,
  Cancelled: -32003,
  Unsupported: -32004,
} as const;

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return "method" in m && "id" in m;
}
export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return "method" in m && !("id" in m);
}
export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return !("method" in m) && "id" in m;
}

/**
 * Split a byte-stream chunk into complete JSON lines. LF is the only record
 * delimiter; a trailing CR is stripped. Do not use Node `readline`: it also
 * splits on U+2028/U+2029, which are valid inside JSON strings.
 */
export class LineDecoder {
  private buffer = "";
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) lines.push(line);
    }
    return lines;
  }
  end(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest.length > 0 ? [rest] : [];
  }
}
