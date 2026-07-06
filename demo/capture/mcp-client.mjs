// Minimal stdio MCP client for driving mcp/hop-mcp.js from rig scripts
// (spawn-aurora.mjs, dispatch-task.mjs).
import { spawn } from "node:child_process";
import path from "node:path";
import { REPO_ROOT } from "./capture-env.mjs";

export function startMcp(clientName) {
  const mcp = spawn(process.execPath, [path.join(REPO_ROOT, "mcp", "hop-mcp.js")], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  mcp.stderr.on("data", () => {});
  let nextId = 1;
  const pending = new Map();
  let buf = "";
  mcp.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {}
    }
  });
  const rpc = (method, params, timeoutMs = 240000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`rpc timeout: ${method}`));
        }
      }, timeoutMs);
    });
  const callTool = async (name, args, timeoutMs = 240000) => {
    const res = await rpc("tools/call", { name, arguments: args }, timeoutMs);
    const text = res.result?.content?.[0]?.text ?? "";
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { isError: res.result?.isError === true, text, parsed };
  };
  const init = async () => {
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: "0" }
    });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  };
  return { rpc, callTool, init, kill: () => mcp.kill() };
}
