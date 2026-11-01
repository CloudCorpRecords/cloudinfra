/**
 * cloudinfra core: a 10-tool core subset of the AWS Terraform MCP
 * server surface, implemented clean-room from public documentation.
 *
 * Eight tools are thin, shaped clients over public endpoints through
 * an injectable FetchFn: the Terraform Registry API v1
 * (https://registry.terraform.io/v1, base overridable via
 * TERRAFORM_REGISTRY_URL) for provider docs, Cloud Control provider
 * docs, module search/details and latest provider versions, plus a
 * guides search endpoint for user-guide topics. No credentials are
 * required for any of them.
 *
 * run_policy_scan is a REAL local deterministic checker: it walks a
 * supplied terraform plan JSON (planned_values, recursing into child
 * modules, with resource_changes as a fallback) and reports public
 * S3 buckets, unencrypted storage, wildcard IAM policies and open
 * security groups. An external scanner can be injected as a
 * PolicyScanExecutor; the local checker is the default and no
 * external scanner (checkov or otherwise) is implemented here.
 *
 * explain_resource answers from a small curated catalogue of common
 * AWS resource types, written fresh for this rebuild.
 */
import type {
  ExplainResourceOptions,
  FetchFn,
  GetLatestProviderVersionOptions,
  GetModuleDetailsOptions,
  GetProviderDocDetailsOptions,
  ListProviderResourcesOptions,
  PolicyFinding,
  PolicyScanExecutor,
  PolicyScanResult,
  RunPolicyScanOptions,
  SearchCcProviderDocsOptions,
  SearchModulesOptions,
  SearchProviderDocsOptions,
  SearchUserGuideOptions,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_REGISTRY_BASE = "https://registry.terraform.io/v1";

export function registryBaseFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.TERRAFORM_REGISTRY_URL;
  const base = typeof raw === "string" ? raw.trim() : "";
  return (base || DEFAULT_REGISTRY_BASE).replace(/\/+$/, "");
}

const enc = encodeURIComponent;

async function registryRequest(
  fetchFn: FetchFn,
  base: string,
  path: string,
): Promise<unknown> {
  const res = await fetchFn(`${base}${path}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const errors = parsed.errors;
      if (Array.isArray(errors) && typeof errors[0] === "string") {
        detail = errors[0];
      } else if (typeof parsed.message === "string") {
        detail = parsed.message;
      }
    } catch {
      // Keep the raw body as the detail.
    }
    throw new Error(`Terraform Registry error ${res.status}: ${detail}`);
  }
  if (!text) return { status: res.status };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function query(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export async function searchProviderDocs(
  fetchFn: FetchFn, base: string, opts: SearchProviderDocsOptions,
): Promise<unknown> {
  return registryRequest(
    fetchFn, base,
    `/providers${query({ q: opts.query, provider: opts.provider })}`,
  );
}

export async function getProviderDocDetails(
  fetchFn: FetchFn, base: string, opts: GetProviderDocDetailsOptions,
): Promise<unknown> {
  const version = opts.version ? `/${enc(opts.version)}` : "";
  return registryRequest(
    fetchFn, base,
    `/providers/${enc(opts.namespace)}/${enc(opts.type)}${version}`,
  );
}

export async function searchCcProviderDocs(
  fetchFn: FetchFn, base: string, opts: SearchCcProviderDocsOptions,
): Promise<unknown> {
  return registryRequest(
    fetchFn, base,
    `/providers${query({ q: opts.query, provider: "awscc" })}`,
  );
}

export async function listProviderResources(
  fetchFn: FetchFn, base: string, opts: ListProviderResourcesOptions,
): Promise<unknown> {
  const payload = (await registryRequest(
    fetchFn, base,
    `/providers/${enc(opts.namespace)}/${enc(opts.type)}`,
  )) as Record<string, unknown>;
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : [];
  return {
    provider: `${opts.namespace}/${opts.type}`,
    resources: list(payload.resources),
    data_sources: list(payload.data_sources),
  };
}

export async function searchModules(
  fetchFn: FetchFn, base: string, opts: SearchModulesOptions,
): Promise<unknown> {
  return registryRequest(
    fetchFn, base,
    `/modules${query({ q: opts.query, limit: opts.limit })}`,
  );
}

export async function getModuleDetails(
  fetchFn: FetchFn, base: string, opts: GetModuleDetailsOptions,
): Promise<unknown> {
  const id = opts.module_id.split("/").map(enc).join("/");
  return registryRequest(fetchFn, base, `/modules/${id}`);
}

export async function getLatestProviderVersion(
  fetchFn: FetchFn, base: string, opts: GetLatestProviderVersionOptions,
): Promise<unknown> {
  const payload = (await registryRequest(
    fetchFn, base,
    `/providers/${enc(opts.namespace)}/${enc(opts.type)}`,
  )) as Record<string, unknown>;
  let version: string | undefined;
  if (typeof payload.version === "string") version = payload.version;
  if (typeof payload.latest_version === "string") {
    version = payload.latest_version;
  }
  if (version === undefined && Array.isArray(payload.versions)) {
    const last = payload.versions[payload.versions.length - 1] as
      | Record<string, unknown>
      | undefined;
    if (last && typeof last.version === "string") version = last.version;
  }
  return {
    namespace: opts.namespace,
    type: opts.type,
    version: version ?? null,
  };
}

export async function searchUserGuide(
  fetchFn: FetchFn, base: string, opts: SearchUserGuideOptions,
): Promise<unknown> {
  return registryRequest(
    fetchFn, base,
    `/guides${query({ q: opts.query })}`,
  );
}

// ---------------------------------------------------------------------------
// Local deterministic policy scan over a terraform plan JSON.
// ---------------------------------------------------------------------------

interface PlanResource {
  address: string;
  type: string;
  values: Record<string, unknown>;
}

function collectFromModule(
  mod: Record<string, unknown>,
  out: PlanResource[],
): void {
  const resources = mod.resources;
  if (Array.isArray(resources)) {
    for (const raw of resources) {
      const r = raw as Record<string, unknown>;
      if (typeof r.type === "string") {
        out.push({
          address: typeof r.address === "string" ? r.address : r.type,
          type: r.type,
          values: (r.values ?? {}) as Record<string, unknown>,
        });
      }
    }
  }
  const children = mod.child_modules;
  if (Array.isArray(children)) {
    for (const child of children) {
      collectFromModule(child as Record<string, unknown>, out);
    }
  }
}

export function collectPlanResources(
  plan: Record<string, unknown>,
): PlanResource[] {
  const out: PlanResource[] = [];
  const planned = plan.planned_values as Record<string, unknown> | undefined;
  const root = planned?.root_module as Record<string, unknown> | undefined;
  if (root) collectFromModule(root, out);
  if (out.length === 0 && Array.isArray(plan.resource_changes)) {
    for (const raw of plan.resource_changes) {
      const rc = raw as Record<string, unknown>;
      const change = (rc.change ?? {}) as Record<string, unknown>;
      const after = change.after as Record<string, unknown> | undefined;
      if (typeof rc.type === "string" && after) {
        out.push({
          address: typeof rc.address === "string" ? rc.address : rc.type,
          type: rc.type,
          values: after,
        });
      }
    }
  }
  return out;
}

const PUBLIC_ACLS = new Set([
  "public-read",
  "public-read-write",
  "authenticated-read",
]);

function isWildcard(value: unknown): boolean {
  if (value === "*") return true;
  if (Array.isArray(value)) return value.some(isWildcard);
  return false;
}

function checkResource(r: PlanResource, findings: PolicyFinding[]): void {
  const v = r.values;
  const add = (rule: string, severity: string, message: string) =>
    findings.push({ rule, severity, address: r.address, message });

  if (r.type === "aws_s3_bucket") {
    if (typeof v.acl === "string" && PUBLIC_ACLS.has(v.acl)) {
      add("public-s3", "high",
        `S3 bucket has a public ACL (${v.acl}); use a private ACL and a bucket policy instead.`);
    }
    if (!v.server_side_encryption_configuration) {
      add("unencrypted-storage", "medium",
        "S3 bucket has no server-side encryption configuration in the plan.");
    }
  }
  if (r.type === "aws_db_instance" && v.storage_encrypted !== true) {
    add("unencrypted-storage", "high",
      "RDS instance does not have storage_encrypted = true.");
  }
  if (r.type === "aws_ebs_volume" && v.encrypted !== true) {
    add("unencrypted-storage", "high",
      "EBS volume does not have encrypted = true.");
  }
  if (r.type === "aws_iam_policy" || r.type === "aws_iam_role_policy") {
    let wildcard = false;
    if (typeof v.policy === "string") {
      try {
        const doc = JSON.parse(v.policy) as Record<string, unknown>;
        const statements = Array.isArray(doc.Statement)
          ? doc.Statement
          : doc.Statement
            ? [doc.Statement]
            : [];
        for (const raw of statements) {
          const st = raw as Record<string, unknown>;
          if (isWildcard(st.Action) || isWildcard(st.Resource)) {
            wildcard = true;
          }
        }
      } catch {
        if (v.policy.includes('"*"')) wildcard = true;
      }
    }
    if (wildcard) {
      add("wildcard-iam", "high",
        "IAM policy grants a wildcard Action or Resource; scope it to the exact actions and ARNs needed.");
    }
  }
  const openCidr = (cidrs: unknown): boolean =>
    Array.isArray(cidrs) &&
    cidrs.some((c) => c === "0.0.0.0/0" || c === "::/0");
  if (r.type === "aws_security_group") {
    const ingress = Array.isArray(v.ingress) ? v.ingress : [];
    for (const raw of ingress) {
      const rule = raw as Record<string, unknown>;
      if (openCidr(rule.cidr_blocks) || openCidr(rule.ipv6_cidr_blocks)) {
        add("open-security-group", "high",
          "Security group ingress is open to the world (0.0.0.0/0 or ::/0); restrict the CIDR range.");
        break;
      }
    }
  }
  if (r.type === "aws_security_group_rule" && v.type === "ingress") {
    if (openCidr(v.cidr_blocks) || openCidr(v.ipv6_cidr_blocks)) {
      add("open-security-group", "high",
        "Security group rule ingress is open to the world (0.0.0.0/0 or ::/0); restrict the CIDR range.");
    }
  }
  if (r.type === "aws_vpc_security_group_ingress_rule") {
    if (v.cidr_ipv4 === "0.0.0.0/0" || v.cidr_ipv6 === "::/0") {
      add("open-security-group", "high",
        "Security group ingress rule is open to the world; restrict the CIDR range.");
    }
  }
}

export function scanPlanLocally(
  plan: Record<string, unknown>,
): PolicyScanResult {
  const resources = collectPlanResources(plan);
  const findings: PolicyFinding[] = [];
  for (const r of resources) checkResource(r, findings);
  const byRule: Record<string, number> = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  return {
    findings,
    summary: {
      resources_scanned: resources.length,
      findings: findings.length,
      by_rule: byRule,
    },
  };
}

export async function runPolicyScan(
  opts: RunPolicyScanOptions,
  executor?: PolicyScanExecutor,
): Promise<PolicyScanResult> {
  if (executor) return executor(opts.plan);
  return scanPlanLocally(opts.plan);
}

// ---------------------------------------------------------------------------
// Curated explanations of common AWS resource types (written fresh).
// ---------------------------------------------------------------------------

export const EXPLANATIONS: Record<string, string> = {
  aws_s3_bucket:
    "An S3 bucket is a flat object store: it holds files (objects) under keys, with versioning, encryption and lifecycle rules configured separately. Most findings against buckets are about public access and missing default encryption.",
  aws_lambda_function:
    "A Lambda function is a unit of code that runs only when invoked by an event, an API call or a schedule. You manage the handler, runtime, memory and IAM role; AWS manages the machines. Watch the execution role: it should grant only the actions the code actually calls.",
  aws_iam_role:
    "An IAM role is a set of permissions that a service or principal assumes temporarily instead of using long-lived keys. Roles are attached to compute (EC2, Lambda, ECS) or granted cross-account. The trust policy decides who may assume it; the attached policies decide what it may do.",
  aws_iam_policy:
    "An IAM policy is a JSON document of Allow/Deny statements over actions and resource ARNs. Attached to users, groups or roles. Wildcard actions or resources are the most common audit finding because they quietly grant far more than the workload needs.",
  aws_vpc:
    "A VPC is a private network boundary in one AWS region. Subnets, route tables, gateways and security controls all live inside it. Public subnets route to an internet gateway; private subnets should reach the internet only through NAT, if at all.",
  aws_security_group:
    "A security group is a stateful virtual firewall attached to instances, load balancers and databases. Ingress rules should name the narrowest source range that works; an ingress from 0.0.0.0/0 on an admin or database port is treated as a critical exposure.",
  aws_db_instance:
    "An RDS DB instance is a managed relational database (MySQL, PostgreSQL and others). Key settings are storage encryption, public accessibility, backup retention and the security groups that control which hosts can connect.",
  aws_instance:
    "An EC2 instance is a virtual server. Beyond size and image, the plan-level risks are public IPs on sensitive workloads, missing IMDSv2 enforcement and overly broad IAM instance profiles.",
  aws_dynamodb_table:
    "A DynamoDB table is a managed key-value store billed by read/write capacity or on demand. Point-in-time recovery and server-side encryption are the baseline settings auditors look for.",
  aws_sqs_queue:
    "An SQS queue is a managed message buffer between producers and consumers. Server-side encryption and a dead-letter queue for poison messages are the standard hardening steps.",
  aws_cloudwatch_log_group:
    "A CloudWatch log group collects log streams from AWS services and applications. Set a retention period so logs do not accumulate forever, and encrypt sensitive groups with a KMS key.",
  aws_ecs_service:
    "An ECS service keeps a set of task replicas running on Fargate or EC2. Network mode, task role permissions and whether tasks receive public IPs decide most of its exposure.",
};

export function explainResource(opts: ExplainResourceOptions): unknown {
  const explanation = EXPLANATIONS[opts.resource_type];
  if (explanation) {
    return { resource_type: opts.resource_type, explanation };
  }
  return {
    resource_type: opts.resource_type,
    explanation:
      `No curated explanation for '${opts.resource_type}' in this core subset. ` +
      "In Terraform, the name before the first underscore group is the provider (here likely aws) " +
      "and the rest is the resource kind; check the provider documentation for its arguments and risks.",
    known_types: Object.keys(EXPLANATIONS),
  };
}

/** Dispatch a tool call by name. Used by both the MCP server and the CLI. */
export async function callTool(
  fetchFn: FetchFn,
  base: string,
  name: string,
  args: Record<string, unknown>,
  scanExecutor?: PolicyScanExecutor,
): Promise<unknown> {
  switch (name) {
    case "search_provider_docs":
      return searchProviderDocs(fetchFn, base, args as unknown as SearchProviderDocsOptions);
    case "get_provider_doc_details":
      return getProviderDocDetails(fetchFn, base, args as unknown as GetProviderDocDetailsOptions);
    case "search_cc_provider_docs":
      return searchCcProviderDocs(fetchFn, base, args as unknown as SearchCcProviderDocsOptions);
    case "list_provider_resources":
      return listProviderResources(fetchFn, base, args as unknown as ListProviderResourcesOptions);
    case "search_modules":
      return searchModules(fetchFn, base, args as unknown as SearchModulesOptions);
    case "get_module_details":
      return getModuleDetails(fetchFn, base, args as unknown as GetModuleDetailsOptions);
    case "get_latest_provider_version":
      return getLatestProviderVersion(fetchFn, base, args as unknown as GetLatestProviderVersionOptions);
    case "search_user_guide":
      return searchUserGuide(fetchFn, base, args as unknown as SearchUserGuideOptions);
    case "run_policy_scan":
      return runPolicyScan(args as unknown as RunPolicyScanOptions, scanExecutor);
    case "explain_resource":
      return explainResource(args as unknown as ExplainResourceOptions);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
