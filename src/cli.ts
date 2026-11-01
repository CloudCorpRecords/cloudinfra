#!/usr/bin/env node
/**
 * cloudinfra CLI.
 *   cloudinfra <tool-name> '<json args>'
 *   cloudinfra mcp
 * No credentials required. Exit codes: 0 success, 1 error, 2 usage.
 */
import { callTool, registryBaseFromEnv, VERSION } from "./terraform.js";
import type { FetchFn } from "./types.js";

const TOOL_NAMES = [
  "search_provider_docs", "get_provider_doc_details",
  "search_cc_provider_docs", "list_provider_resources", "search_modules",
  "get_module_details", "get_latest_provider_version",
  "search_user_guide", "run_policy_scan", "explain_resource",
];

function usage(): never {
  console.error(`Usage:
  cloudinfra <tool> '<json args>'   tools: ${TOOL_NAMES.join(", ")}
  cloudinfra mcp
  cloudinfra --version`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") { console.log(VERSION); return; }
  if (cmd === "mcp") { await import("./mcp.js"); return; }
  if (!cmd || !TOOL_NAMES.includes(cmd)) usage();
  let args: Record<string, unknown> = {};
  const raw = rest.join(" ").trim();
  if (raw) {
    try {
      args = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.error("error: args must be a JSON object");
      process.exit(1);
    }
  }
  try {
    const fetchFn = globalThis.fetch as unknown as FetchFn;
    const out = await callTool(fetchFn, registryBaseFromEnv(), cmd, args);
    console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
void main();
