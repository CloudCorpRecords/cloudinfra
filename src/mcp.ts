/**
 * cloudinfra MCP server. Core subset: 10 tools.
 *
 * Low-level Server API with explicit inputSchema literals (the
 * McpServer+zod path injects $schema/additionalProperties and breaks
 * parity). Zod still validates call args. The literals match the
 * labelled core-subset fixture exactly.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTool, registryBaseFromEnv, VERSION } from "./terraform.js";
import type { FetchFn } from "./types.js";

const ARG_SCHEMAS: Record<string, z.ZodTypeAny> = {
  search_provider_docs: z.object({
    query: z.string(),
    provider: z.string().optional(),
  }),
  get_provider_doc_details: z.object({
    namespace: z.string(),
    type: z.string(),
    version: z.string().optional(),
  }),
  search_cc_provider_docs: z.object({
    query: z.string(),
  }),
  list_provider_resources: z.object({
    namespace: z.string(),
    type: z.string(),
  }),
  search_modules: z.object({
    query: z.string(),
    limit: z.number().optional(),
  }),
  get_module_details: z.object({
    module_id: z.string(),
  }),
  get_latest_provider_version: z.object({
    namespace: z.string(),
    type: z.string(),
  }),
  search_user_guide: z.object({
    query: z.string(),
  }),
  run_policy_scan: z.object({
    plan: z.record(z.unknown()),
  }),
  explain_resource: z.object({
    resource_type: z.string(),
  }),
};

export const TOOLS = [
  {
    name: "search_provider_docs",
    description: "Search Terraform provider documentation topics.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search text to match against Terraform provider documentation topics." },
        provider: { type: "string", description: "Optional provider name to restrict the documentation search to one provider." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_provider_doc_details",
    description: "Get details for one Terraform provider from the Registry.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: { type: "string", description: "Registry namespace that publishes the provider, for example 'hashicorp'." },
        type: { type: "string", description: "Provider type (name) within the namespace, for example 'aws'." },
        version: { type: "string", description: "Optional specific provider version to fetch details for; omit to get the current release details." },
      },
      required: ["namespace", "type"],
    },
  },
  {
    name: "search_cc_provider_docs",
    description: "Search AWS Cloud Control provider documentation topics.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search text to match against AWS Cloud Control provider documentation topics." },
      },
      required: ["query"],
    },
  },
  {
    name: "list_provider_resources",
    description: "List the documented resources for a Terraform provider.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: { type: "string", description: "Registry namespace that publishes the provider, for example 'hashicorp'." },
        type: { type: "string", description: "Provider type (name) within the namespace, for example 'aws'." },
      },
      required: ["namespace", "type"],
    },
  },
  {
    name: "search_modules",
    description: "Search Terraform Registry modules.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search text to match against Terraform Registry module names and descriptions." },
        limit: { type: "number", description: "Optional maximum number of module search results to return." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_module_details",
    description: "Get details for one Terraform Registry module.",
    inputSchema: {
      type: "object" as const,
      properties: {
        module_id: { type: "string", description: "Full Registry module identifier in namespace/name/provider format identifying the module to fetch." },
      },
      required: ["module_id"],
    },
  },
  {
    name: "get_latest_provider_version",
    description: "Get the latest published version of a Terraform provider.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: { type: "string", description: "Registry namespace that publishes the provider, for example 'hashicorp'." },
        type: { type: "string", description: "Provider type (name) within the namespace, for example 'aws'." },
      },
      required: ["namespace", "type"],
    },
  },
  {
    name: "search_user_guide",
    description: "Search Terraform user guide and AWS IaC guidance topics.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search text to match against Terraform user guide and AWS IaC guidance topics." },
      },
      required: ["query"],
    },
  },
  {
    name: "run_policy_scan",
    description: "Run deterministic policy checks over a Terraform plan JSON.",
    inputSchema: {
      type: "object" as const,
      properties: {
        plan: { type: "object", description: "Terraform plan JSON object to scan, as produced by 'terraform show -json', using planned_values or resource_changes." },
      },
      required: ["plan"],
    },
  },
  {
    name: "explain_resource",
    description: "Explain a common AWS Terraform resource type in plain language.",
    inputSchema: {
      type: "object" as const,
      properties: {
        resource_type: { type: "string", description: "Terraform resource type to explain, for example 'aws_s3_bucket'." },
      },
      required: ["resource_type"],
    },
  },
];

function textResult(value: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }],
  };
}
function errorResult(err: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: err instanceof Error ? err.message : String(err),
    }],
    isError: true,
  };
}

const server = new Server(
  { name: "cloudinfra", version: VERSION },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const schema = ARG_SCHEMAS[name];
  if (!schema) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  try {
    const parsed = schema.parse(args ?? {}) as Record<string, unknown>;
    const fetchFn = globalThis.fetch as unknown as FetchFn;
    return textResult(await callTool(fetchFn, registryBaseFromEnv(), name, parsed));
  } catch (err) {
    return errorResult(err);
  }
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}
void main();
