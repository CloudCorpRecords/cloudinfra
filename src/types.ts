/**
 * cloudinfra types.
 *
 * A core subset of the AWS Terraform MCP surface: Terraform Registry
 * provider/module documentation lookups, a local deterministic policy
 * scan over a terraform plan JSON, and curated explanations of common
 * AWS resource types. HTTP access is described by a minimal response
 * surface so tests can inject a fake fetch.
 */

export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: string;
  },
) => Promise<HttpResponse>;

export interface SearchProviderDocsOptions {
  query: string;
  provider?: string;
}

export interface GetProviderDocDetailsOptions {
  namespace: string;
  type: string;
  version?: string;
}

export interface SearchCcProviderDocsOptions {
  query: string;
}

export interface ListProviderResourcesOptions {
  namespace: string;
  type: string;
}

export interface SearchModulesOptions {
  query: string;
  limit?: number;
}

export interface GetModuleDetailsOptions {
  module_id: string;
}

export interface GetLatestProviderVersionOptions {
  namespace: string;
  type: string;
}

export interface SearchUserGuideOptions {
  query: string;
}

export interface RunPolicyScanOptions {
  plan: Record<string, unknown>;
}

export interface ExplainResourceOptions {
  resource_type: string;
}

export interface PolicyFinding {
  rule: string;
  severity: string;
  address: string;
  message: string;
}

export interface PolicyScanResult {
  findings: PolicyFinding[];
  summary: {
    resources_scanned: number;
    findings: number;
    by_rule: Record<string, number>;
  };
}

/** Optional external scanner hook; the local checker is the default. */
export type PolicyScanExecutor = (
  plan: Record<string, unknown>,
) => Promise<PolicyScanResult> | PolicyScanResult;
