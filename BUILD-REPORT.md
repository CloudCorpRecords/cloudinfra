# cloudinfra — BUILD REPORT

Original: aws-terraform (AWS Terraform MCP server) → Rebuild: cloudinfra
Tier C core subset. Local only, nothing pushed or published.

## Scope
10 tools. Eight are shaped GET clients over public endpoints through
an injectable FetchFn (Terraform Registry API v1,
https://registry.terraform.io/v1, base overridable via
TERRAFORM_REGISTRY_URL): search_provider_docs (GET /providers?q=,
optional provider filter), get_provider_doc_details
(GET /providers/{namespace}/{type}[/{version}]),
search_cc_provider_docs (GET /providers?q=&provider=awscc),
list_provider_resources (GET /providers/{namespace}/{type}, shaped
into resources/data_sources string lists), search_modules
(GET /modules?q=, optional limit), get_module_details
(GET /modules/{module_id}, segment-encoded),
get_latest_provider_version (GET /providers/{namespace}/{type},
extracts version / latest_version / last versions[] entry),
search_user_guide (GET /guides?q=).
run_policy_scan is a REAL local deterministic checker over a supplied
terraform plan JSON: it walks planned_values (recursing child
modules, resource_changes as fallback) and reports public-s3 (public
bucket ACLs), unencrypted-storage (RDS storage_encrypted not true,
EBS encrypted not true, S3 with no encryption configuration),
wildcard-iam (wildcard Action/Resource in IAM policy documents) and
open-security-group (ingress from 0.0.0.0/0 or ::/0 across
aws_security_group, aws_security_group_rule and
aws_vpc_security_group_ingress_rule). explain_resource answers from
a local curated catalogue of 12 common AWS resource types written
fresh for this rebuild, and states plainly when a type is outside it.

Omitted groups (fixture `_source` lists them): Terraform/Tofu CLI
execution and plan/apply wrappers, provider schema generation,
pricing/cost estimation, LLM-assisted code and module generation,
state inspection/manipulation, workspace management, and all
write/deploy operations.

Ground truth: schemas are docs-derived from the public Terraform
Registry API documentation and public AWS IaC guidance. Fixture:
harness/fixtures/aws-terraform-tools-original.json (labelled
core-subset).

## Verified (foreground, from disk)
- Tools: 10/10 — parity.json identical_tools = 10 = total.
- Unit tests: 16/16 pass (fake FetchFn; URL/method shaping for all
  eight registry tools, resource-list shaping, latest-version
  extraction, upstream error surfacing; policy scan flags all four
  rule families including a child-module resource, returns zero
  findings on a hardened plan, reads resource_changes fallback,
  delegates to an injected executor; explain known/unknown).
- tsc: exit 0. dist/cli.js present; `node dist/cli.js --version`
  prints 0.1.0.
- Parity: harness/parity.py vs the fixture → PASS, parity_pct 100.0
  (parity-out/parity.json).
- Keyless env check: with an empty environment (`env -i`), the CLI
  ran run_policy_scan on a small plan JSON and returned 1 finding
  (open-security-group for aws_security_group.web; the encrypted RDS
  instance was clean), exit 0; explain_resource also exited 0. No
  tool errors on missing env, as designed.
- server.json description 78 chars (≤100); OCI entry has no version
  field; npm entry carries version 0.1.0; Dockerfile label
  io.github.CloudCorpRecords/cloudinfra; full 19-file factory set
  present.

## Honest gaps
- No live Registry call was made — request/response behaviour is
  fake-fetch proven only. The /guides search path is a docs-shaped
  endpoint; live Registry coverage for it is unverified.
- External policy scanning (checkov or similar) is NOT implemented.
  run_policy_scan optionally delegates to an injectable
  PolicyScanExecutor through the library API, but the only scanner
  shipped is the local deterministic checker.
- The policy checker reads plan JSON values only; it does not
  evaluate Terraform expressions, variables or cross-resource
  references, and its four rule families are a subset, not a full
  security audit.
- Lockfile is a copied fleet lockfile with identity fields edited —
  clean lockfile regeneration is REQUIRED before publish.
- mcpaudit / mcpvet / shipcheck not yet run — pre-publish gate.
