import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  callTool,
  explainResource,
  getLatestProviderVersion,
  getModuleDetails,
  getProviderDocDetails,
  listProviderResources,
  registryBaseFromEnv,
  runPolicyScan,
  scanPlanLocally,
  searchCcProviderDocs,
  searchModules,
  searchProviderDocs,
  searchUserGuide,
} from "../src/terraform.js";
import type { FetchFn, HttpResponse } from "../src/types.js";

interface Recorded {
  url: string;
  method: string;
}

function fakeFetch(steps: Array<{ match: string; payload: unknown; status?: number }>) {
  const calls: Recorded[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    const step = steps.find((s) => url.includes(s.match)) ?? { match: "", payload: {} };
    const res: HttpResponse = {
      ok: (step.status ?? 200) < 300,
      status: step.status ?? 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(step.payload),
    };
    return res;
  };
  return { fn, calls };
}

const BASE = "https://registry.terraform.io/v1";

const RISKY_PLAN = {
  planned_values: {
    root_module: {
      resources: [
        {
          address: "aws_s3_bucket.public",
          type: "aws_s3_bucket",
          values: {
            acl: "public-read",
            server_side_encryption_configuration: [{ rule: {} }],
          },
        },
        {
          address: "aws_db_instance.main",
          type: "aws_db_instance",
          values: { storage_encrypted: false },
        },
        {
          address: "aws_iam_policy.wild",
          type: "aws_iam_policy",
          values: {
            policy: JSON.stringify({
              Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
            }),
          },
        },
        {
          address: "aws_security_group.web",
          type: "aws_security_group",
          values: { ingress: [{ cidr_blocks: ["0.0.0.0/0"] }] },
        },
      ],
      child_modules: [
        {
          resources: [
            {
              address: "module.storage.aws_ebs_volume.data",
              type: "aws_ebs_volume",
              values: { encrypted: false },
            },
          ],
        },
      ],
    },
  },
};

describe("cloudinfra core", () => {
  it("registry base defaults and is overridable, with no env required", () => {
    assert.equal(registryBaseFromEnv({}), "https://registry.terraform.io/v1");
    assert.equal(
      registryBaseFromEnv({ TERRAFORM_REGISTRY_URL: "https://example.test/v1/" }),
      "https://example.test/v1",
    );
  });

  it("search_provider_docs gets /providers?q= with optional provider filter", async () => {
    const { fn, calls } = fakeFetch([{ match: "/providers", payload: { providers: [] } }]);
    await searchProviderDocs(fn, BASE, { query: "s3 bucket" });
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].url, "https://registry.terraform.io/v1/providers?q=s3%20bucket");
    await searchProviderDocs(fn, BASE, { query: "vpc", provider: "aws" });
    assert.equal(calls[1].url, "https://registry.terraform.io/v1/providers?q=vpc&provider=aws");
  });

  it("get_provider_doc_details gets /providers/{ns}/{type}[/{version}]", async () => {
    const { fn, calls } = fakeFetch([{ match: "/providers/hashicorp/aws", payload: { id: "p" } }]);
    await getProviderDocDetails(fn, BASE, { namespace: "hashicorp", type: "aws" });
    assert.equal(calls[0].url, "https://registry.terraform.io/v1/providers/hashicorp/aws");
    await getProviderDocDetails(fn, BASE, { namespace: "hashicorp", type: "aws", version: "5.0.0" });
    assert.equal(calls[1].url, "https://registry.terraform.io/v1/providers/hashicorp/aws/5.0.0");
  });

  it("search_cc_provider_docs searches with the awscc provider filter", async () => {
    const { fn, calls } = fakeFetch([{ match: "awscc", payload: { providers: [] } }]);
    await searchCcProviderDocs(fn, BASE, { query: "s3 bucket" });
    assert.equal(calls[0].url, "https://registry.terraform.io/v1/providers?q=s3%20bucket&provider=awscc");
  });

  it("list_provider_resources shapes resources and data_sources lists", async () => {
    const { fn, calls } = fakeFetch([{
      match: "/providers/hashicorp/aws",
      payload: { resources: ["aws_s3_bucket", "aws_vpc"], data_sources: ["aws_ami", 42] },
    }]);
    const out = (await listProviderResources(fn, BASE, {
      namespace: "hashicorp", type: "aws",
    })) as Record<string, unknown>;
    assert.equal(calls[0].url, "https://registry.terraform.io/v1/providers/hashicorp/aws");
    assert.deepEqual(out, {
      provider: "hashicorp/aws",
      resources: ["aws_s3_bucket", "aws_vpc"],
      data_sources: ["aws_ami"],
    });
  });

  it("search_modules gets /modules?q= with optional limit", async () => {
    const { fn, calls } = fakeFetch([{ match: "/modules", payload: { modules: [] } }]);
    await searchModules(fn, BASE, { query: "vpc", limit: 5 });
    assert.equal(calls[0].url, "https://registry.terraform.io/v1/modules?q=vpc&limit=5");
  });

  it("get_module_details gets /modules/{id} segment-encoded", async () => {
    const { fn, calls } = fakeFetch([{ match: "/modules/", payload: { id: "m" } }]);
    await getModuleDetails(fn, BASE, { module_id: "terraform-aws-modules/vpc/aws/5.0.0" });
    assert.equal(
      calls[0].url,
      "https://registry.terraform.io/v1/modules/terraform-aws-modules/vpc/aws/5.0.0",
    );
  });

  it("get_latest_provider_version extracts version fields", async () => {
    const { fn } = fakeFetch([{
      match: "/providers/hashicorp/aws",
      payload: { version: "4.0.0", latest_version: "5.31.0" },
    }]);
    const out = (await getLatestProviderVersion(fn, BASE, {
      namespace: "hashicorp", type: "aws",
    })) as Record<string, unknown>;
    assert.deepEqual(out, { namespace: "hashicorp", type: "aws", version: "5.31.0" });
    const { fn: fn2 } = fakeFetch([{
      match: "/providers/hashicorp/random",
      payload: { versions: [{ version: "3.5.0" }, { version: "3.6.0" }] },
    }]);
    const out2 = (await getLatestProviderVersion(fn2, BASE, {
      namespace: "hashicorp", type: "random",
    })) as Record<string, unknown>;
    assert.equal(out2.version, "3.6.0");
  });

  it("search_user_guide gets /guides?q=", async () => {
    const { fn, calls } = fakeFetch([{ match: "/guides", payload: { guides: [] } }]);
    await searchUserGuide(fn, BASE, { query: "state locking" });
    assert.equal(calls[0].url, "https://registry.terraform.io/v1/guides?q=state%20locking");
  });

  it("run_policy_scan flags all four rule families, recursing child modules", async () => {
    const out = scanPlanLocally(RISKY_PLAN);
    assert.equal(out.summary.resources_scanned, 5);
    assert.equal(out.summary.findings, 5);
    assert.deepEqual(out.summary.by_rule, {
      "public-s3": 1,
      "unencrypted-storage": 2,
      "wildcard-iam": 1,
      "open-security-group": 1,
    });
    const addresses = out.findings.map((f) => f.address).sort();
    assert.deepEqual(addresses, [
      "aws_db_instance.main",
      "aws_iam_policy.wild",
      "aws_s3_bucket.public",
      "aws_security_group.web",
      "module.storage.aws_ebs_volume.data",
    ]);
    const viaTool = await runPolicyScan({ plan: RISKY_PLAN });
    assert.equal(viaTool.summary.findings, 5);
  });

  it("run_policy_scan returns zero findings for a hardened plan", () => {
    const clean = {
      planned_values: {
        root_module: {
          resources: [
            {
              address: "aws_s3_bucket.private",
              type: "aws_s3_bucket",
              values: {
                acl: "private",
                server_side_encryption_configuration: [{ rule: {} }],
              },
            },
            {
              address: "aws_db_instance.main",
              type: "aws_db_instance",
              values: { storage_encrypted: true },
            },
            {
              address: "aws_security_group.app",
              type: "aws_security_group",
              values: { ingress: [{ cidr_blocks: ["10.0.0.0/8"] }] },
            },
          ],
        },
      },
    };
    const out = scanPlanLocally(clean);
    assert.equal(out.summary.resources_scanned, 3);
    assert.deepEqual(out.findings, []);
  });

  it("run_policy_scan reads resource_changes when planned_values is absent", () => {
    const plan = {
      resource_changes: [
        {
          address: "aws_ebs_volume.x",
          type: "aws_ebs_volume",
          change: { after: { encrypted: false } },
        },
      ],
    };
    const out = scanPlanLocally(plan);
    assert.equal(out.summary.findings, 1);
    assert.equal(out.findings[0].rule, "unencrypted-storage");
  });

  it("run_policy_scan delegates to an injected executor when provided", async () => {
    const out = await runPolicyScan({ plan: {} }, async () => ({
      findings: [],
      summary: { resources_scanned: 0, findings: 0, by_rule: { external: 1 } },
    }));
    assert.deepEqual(out.summary.by_rule, { external: 1 });
  });

  it("explain_resource covers known types and answers honestly for unknown ones", () => {
    const known = explainResource({ resource_type: "aws_s3_bucket" }) as Record<string, unknown>;
    assert.match(String(known.explanation), /object store/);
    const unknown = explainResource({ resource_type: "aws_made_up_thing" }) as Record<string, unknown>;
    assert.match(String(unknown.explanation), /No curated explanation/);
    assert.ok(Array.isArray(unknown.known_types));
  });

  it("surfaces upstream registry errors with status", async () => {
    const { fn } = fakeFetch([{
      match: "/providers", payload: { errors: ["not found"] }, status: 404,
    }]);
    await assert.rejects(
      () => searchProviderDocs(fn, BASE, { query: "x" }),
      /Terraform Registry error 404: not found/,
    );
  });

  it("callTool dispatches local tools without any fetch and rejects unknown tools", async () => {
    const { fn, calls } = fakeFetch([]);
    const out = (await callTool(fn, BASE, "explain_resource", {
      resource_type: "aws_vpc",
    })) as Record<string, unknown>;
    assert.match(String(out.explanation), /private network/);
    assert.equal(calls.length, 0);
    await assert.rejects(
      () => callTool(fn, BASE, "nope", {}),
      /Unknown tool: nope/,
    );
  });
});
