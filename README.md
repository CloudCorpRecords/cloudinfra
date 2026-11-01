# cloudinfra

AWS infrastructure-as-code guidance as MCP tools: Terraform Registry
documentation and module lookups, a local policy scan for terraform
plan files, and plain-language explanations of common AWS resource
types. cloudinfra is a clean-room rebuild of the core surface of the
aws-terraform MCP server, under a new name: fresh code and prose, no
copied branding.

## Tools (core subset, 10)

`search_provider_docs`, `get_provider_doc_details`,
`search_cc_provider_docs`, `list_provider_resources`, `search_modules`,
`get_module_details`, `get_latest_provider_version`,
`search_user_guide`, `run_policy_scan`, `explain_resource`.

Not in this subset: Terraform/Tofu CLI execution (init/plan/apply),
provider schema generation, pricing and cost estimation, LLM-assisted
code or module generation, state manipulation, and any write or
deploy operation.

## How it works

The docs and module tools are shaped GET requests against the public
Terraform Registry API (`https://registry.terraform.io/v1`, base
overridable with `TERRAFORM_REGISTRY_URL`) through an injectable fetch
function. No credentials are needed for any tool.

`run_policy_scan` is fully local and deterministic. Give it a
terraform plan JSON (the output of `terraform show -json`) and it
walks `planned_values` (including child modules; `resource_changes`
is a fallback) checking four rule families:

- `public-s3` — S3 buckets with a public ACL
- `unencrypted-storage` — RDS/EBS without encryption, S3 buckets with
  no server-side encryption configuration
- `wildcard-iam` — IAM policies granting wildcard actions or resources
- `open-security-group` — ingress open to `0.0.0.0/0` or `::/0`

An external scanner can be injected through the library API as a scan
executor; none is bundled — the local checker is the default and the
only implemented scanner.

`explain_resource` answers from a small curated catalogue of common
AWS resource types written for this rebuild, and says so plainly for
types outside the catalogue.

## CLI

```bash
npx @reneturcios/cloudinfra explain_resource '{"resource_type":"aws_s3_bucket"}'
npx @reneturcios/cloudinfra run_policy_scan '{"plan":{...}}'
npx @reneturcios/cloudinfra mcp        # stdio MCP server
```

Each tool name is a subcommand taking one JSON object argument.

## MCP client config

```json
{
  "mcpServers": {
    "cloudinfra": {
      "command": "npx",
      "args": ["-y", "@reneturcios/cloudinfra", "mcp"]
    }
  }
}
```

## Docker

```bash
docker run -i ghcr.io/cloudcorprecords/cloudinfra
```

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
