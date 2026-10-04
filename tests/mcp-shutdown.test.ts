import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerMcp } from "../apps/api/src/routes/mcp.ts";

test("closing the API drains a live MCP subscription before closing HTTP", { timeout: 5000 }, async () => {
  const app = Fastify();
  registerMcp(app);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${address}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "subscriptions/listen" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "subscriptions/listen", params: {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
      notifications: { toolsListChanged: true },
    } }),
  });
  try {
    assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /acknowledged/);
    await app.close();
    while (!(await reader.read()).done) { /* consume the SDK's graceful-close result */ }
  } finally {
    app.server.closeAllConnections();
    await app.close();
  }
});
