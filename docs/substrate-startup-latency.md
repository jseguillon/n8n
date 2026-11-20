# Substrate workspace startup latency

## What each duration means

`executionTimeMs` is command execution inside the sandbox, in milliseconds.
It is not the command timeout. Assistant turn time also includes model calls,
context collection, lazy workspace initialization, transport, and lifecycle work.
The first workspace tool prepares workspace files before it executes the
requested command. An unprepared Actor also installs workflow dependencies.

## Template-managed initialization

The companion sandbox image supplies Node.js, the daemon, and system tools.
It does not install npm workspace dependencies or global TypeScript.
The ActorTemplate owns the pinned package manifest, bootstrap `command`, and
`args`. Its command installs and validates dependencies, publishes a manifest
hash marker atomically, and then starts the daemon. A repeated start with the
same marker does not reinstall packages or overwrite user workspace files.

Substrate v1 uses the container `wakeupProbe` to gate readiness. The template
controller creates its golden snapshot after that readiness check succeeds.
Because the daemon starts only after bootstrap completes, its `/healthz` probe
also gates capture of the prepared environment. The template enables golden
snapshots and gives bootstrap a 180-second readiness budget.

The template's registry-only `goldenEgressPolicy` lets the golden Actor install
packages. Enable the `GoldenEgressPolicy` preview gate on both `ate-api-server`
and `ate-controller`, then create the template with `kubectl ate --preview`.
Actor policies are still copied separately by n8n; the golden policy is not
inherited by new Actors.

New Actors use the template's prepared golden snapshot with
`SUBSTRATE_ACTOR_TAG` unset. n8n still validates the local dependency tree before
it skips installation. A manifest mismatch uses the existing install path.
The companion `substrate/README.md` documents the complete bootstrap.

### Preserve existing Actors during a template upgrade

ActorTemplates are immutable. Create a new versioned template instead of
deleting the old one. Set `SUBSTRATE_ACTOR_TEMPLATE` to the new name and list
approved previous names in `SUBSTRATE_PREVIOUS_ACTOR_TEMPLATES`, separated by
commas. n8n accepts existing Actors only from that explicit same-Atespace list.
It keeps each Actor on its original template and preserves its files and state.
The activity repository accepts the approved connection fingerprints and keeps
their operation leases. Recovery cleanup also handles those previous templates.
Remove an old name only after its Actors have been retired.

## Measurements on 2026-11-17

The deployed n8n 2.48.0 async-suspend image was tested on Talos with disposable
Actors. The same daemon image and workspace setup pipeline ran with MEMORY
and ROOTFS ActorTemplates. The setup fixture used an empty node catalog and
no user context. These measurements do not include LLM latency.

| Measurement | MEMORY | ROOTFS |
| --- | ---: | ---: |
| First workspace setup | 19.405 s | 21.269 s |
| Dependency installation within setup | 17.430 s | 19.594 s |
| Reused marker check plus `ls`, five samples | 0.482–0.523 s | 0.385–0.432 s |
| Daemon `ls` execution, same samples | 8–12 ms | 7–9 ms |

The dependency versions in the baseline image differed from the n8n runtime.
The runtime requested workflow SDK `0.41.0`; that image contained `0.36.5`.
Changing snapshot fidelity does not remove that first-use installation.
A separate `--prefer-offline` trial still took 14–17 seconds to install.

Prepared test tags confirmed actual snapshot fidelity `3` for MEMORY and `2`
for ROOTFS. ROOTFS omits packaged process memory but preserves root filesystem
changes. VOLUMES-only snapshots do not preserve this template's writable
workspace without a workspace volume. The application template retains MEMORY.

### Prepared snapshot results

The optimized runtime, published by
[build 44177468310](https://github.com/jseguillon/n8n/actions/runs/44177468310),
uses image digest
`sha256:cbdc0340a0f50c12814566f0eff062f8070d7e255506b86ab688d233e1f7b945`.
Three fresh Actors per template were created from dependency-only durable tags.
Each Actor then ran five marker-check and `ls` pairs.

| Measurement | MEMORY | ROOTFS |
| --- | ---: | ---: |
| Fresh setup, median of three Actors | 3.133 s | 2.847 s |
| Actor initialization plus fresh setup, median | 3.474 s | 3.062 s |
| Local dependency check, all fresh samples | 0.775–0.812 s | 0.892–0.933 s |
| Reused marker check plus `ls`, median of 15 pairs | 0.503 s | 0.422 s |
| Reused pairs, full observed range | 0.459–0.556 s | 0.382–0.756 s |

Both templates passed all 15 packaged-runtime test records, including actual
source-tag provenance and zero npm install calls during workspace setup.
ROOTFS had a modest latency benefit in this same-node test and one noisy warm
sample group. Dependency preparation removed most of the cold-start cost.
These are sandbox measurements, not a promise about total Assistant turn time.
The user thread was not replayed through an LLM.

`preferredFidelity` limits packaged snapshot content. A process resumed in place
can keep its memory even with ROOTFS preference. The fresh-Actor test above used
durable tags with confirmed fidelity `3` and `2`, rather than relying only on
node-local resume behavior.

## Template-bootstrap comparison: 2026-11-19

The finished template-driven deployment uses:

- n8n image: `ghcr.io/jseguillon/n8n@sha256:288303c4a3ce100806d4b64e86c0bab013fd2200554d8d34446532361e4b6cbc`.
- Dependency-free sandbox image: `ghcr.io/jseguillon/n8n-sandbox-service-substrate@sha256:9db537a8246e92825e842ba1d251ce44c10df4e619d74bd993c36e739a4d264f`.
- Application template: `n8n-sandbox-bootstrap`, with MEMORY preference.
- Previous-template allowlist: `n8n-sandbox`. The seven application Actors remain suspended on their existing templates.
- No manually configured seed tag. New Actors use the template's golden snapshot.

The [n8n build](https://github.com/jseguillon/n8n/actions/runs/44184122402)
and [sandbox build](https://github.com/jseguillon/n8n-sandbox-service-substrate/actions/runs/44182458282)
passed. Image smoke checks verified the absence of workspace npm dependencies
and global TypeScript. Bootstrap tests covered idempotence, file preservation,
and failure before readiness. Live suites passed all 16 test records for each
of MEMORY, ROOTFS, and VOLUMES, including compatibility with previous templates.

The fidelity benchmark used the same image, bootstrap, CPU, memory limit, and
durable workspace volume for all three modes. Only `preferredFidelity` changed.
Each mode used three fresh Actors and 15 reused marker-check and `ls` pairs.
The fixture used an empty node catalog and no LLM or user context.

| Median measurement | MEMORY | ROOTFS | VOLUMES |
| --- | ---: | ---: | ---: |
| Actor initialization | 619 ms | 395 ms | 345 ms |
| Fresh workspace setup | 4.191 s | 5.642 s | 3.904 s |
| Initialization plus setup | 4.810 s | 6.037 s | 4.458 s |
| Reused `ls`, complete command call | 357 ms | 373 ms | 308 ms |
| Marker check plus complete command call | 717 ms | 773 ms | 609 ms |
| Daemon `ls` execution | 9 ms | 7 ms | 8 ms |

No benchmark setup invoked npm installation. Reused command-call ranges were
315–531 ms for MEMORY, 319–693 ms for ROOTFS, and 279–338 ms for VOLUMES.
All three golden tags had completed durable snapshots with their requested
fidelity. VOLUMES was fastest in this small same-node sample. ROOTFS was noisy
and did not show a consistent benefit over MEMORY. These measurements do not
establish multi-node restoration performance or total Assistant turn latency.

VOLUMES requires a durable volume. The first no-volume VOLUMES trial failed
snapshot creation with `no durable-dir volumes found for VOLUMES snapshot`.
For the comparison, each template declared `workspace` with `durableDir: {}`
and mounted it at `/home/user/workspace`. This kept the comparison layout equal
and preserved workspace files in every mode. VOLUMES does not preserve other
writable filesystem paths or process memory. The application retains MEMORY
and its original full-state behavior.

The snapshot store was increased from 1 GiB to 4 GiB after the test fixtures
filled it. Its requested Longhorn replica count was corrected from three to
one, matching the single healthy replica on this single-node cluster. All
disposable Actors, templates, tags, and the benchmark Atespace were deleted.

### Reproduce the comparison

Create three disposable templates with the same bootstrap and durable workspace
layout. Select a different `preferredFidelity` for each. Wait for all golden
tags to become ready. Copy `packages/cli/test/live/substrate-fidelity-benchmark.cjs`
into the test pod and run:

```sh
kubectl -n n8n-app exec <pod> -- env \
  SUBSTRATE_INTEGRATION_TEST=1 \
  SUBSTRATE_BENCH_ATESPACE=<isolated-test-atespace> \
  SUBSTRATE_BENCH_TEMPLATES=compare-memory,compare-rootfs,compare-volumes \
  node /tmp/substrate-fidelity-benchmark.cjs
```

The script uses a temporary database and disposable Actors. It requires the
template readiness marker, checks preserved setup markers, asserts zero npm
install calls, and prints timing samples and medians. It deletes its Actors
and temporary database. The operator removes the test templates and Atespace.

## Optional: prepare a tag for a legacy template

The primary approach above uses the template's own golden snapshot. This
manual-tag path remains available for an existing template that cannot be changed.

Use a new tag name for each n8n dependency set. The preparation script creates
its own Actor from the configured template. It writes only the generated public
package manifest and installs runtime dependencies. It does not copy an existing
workspace, user files, context, or the workspace initialization marker.

1. Copy the script into the n8n pod:

   ```sh
   kubectl -n n8n-app cp packages/cli/test/live/prepare-substrate-dependencies.cjs \
     <pod>:/tmp/prepare-substrate-dependencies.cjs
   ```

2. Run it with the pod's mounted Substrate identity:

   ```sh
   kubectl -n n8n-app exec <pod> -- env \
     SUBSTRATE_SEED_TAG=n8n-runtime-dependencies-v1 \
     node /tmp/prepare-substrate-dependencies.cjs
   ```

The identity needs permission to create tags and manage Actors in the Atespace.
The script suspends its Actor, creates a durable Atespace-scoped tag, and deletes
the seed Actor. It does not overwrite an existing tag. It reports dependency
versions, install time, and the stored snapshot fidelity.

3. Configure the new tag:

   ```sh
   kubectl -n n8n-app set env deployment/n8n \
     SUBSTRATE_ACTOR_TAG=n8n-runtime-dependencies-v1
   kubectl -n n8n-app rollout status deployment/n8n --timeout=5m
   ```

New Actors use the tag. Existing Actors keep their state and template identity.
Workspace setup still writes current node catalogs, context-independent guides,
and build files. It validates the complete installed dependency tree locally.
Only a matching tree skips npm installation. An older tag falls back to an
install when n8n requires different dependencies.

Prepare a new tag after changing runtime dependencies. Keep old tags until no
Actors depend on them. To return to the template's default golden snapshot,
remove `SUBSTRATE_ACTOR_TAG` from the deployment and restart n8n. This affects
only subsequent Actor creation.

## Verify a prepared tag

Run the [packaged-runtime live suite](../packages/cli/test/live/README.md) in a
dedicated test Atespace with `SUBSTRATE_ACTOR_TAG` set to its prepared tag.
The additional check verifies Actor source-tag provenance, workspace setup,
and the absence of npm installation. The suite uses its own database and Actors.

## Initialization marker checks on 2026-11-19

The marker reader now treats a Substrate filesystem HTTP 404 as a missing file.
It does not execute the redundant `cat` fallback in that case. Substrate still
checks for a deleted Actor and recovers it within the file operation. Other read
errors and other providers retain the command fallback. Existing markers use
the same file read as before.

The baseline was the deployed n8n image
`sha256:ead81d624e11c8112a3e53e59ee57b72ce68bab6b195c3121bdbf2737d2390cc`.
The candidate used the compiled setup module in a separate Node.js process in
that Pod. The application process kept its deployed code. Each trial used a
disposable Actor from a clone of the MEMORY bootstrap template. The benchmark
requested asynchronous suspension immediately after each operation. It did not
use database operation bookkeeping or an LLM.

Each table cell is the median of ten serial checks. The second block reversed
the baseline and candidate order. The marker was removed or written before
each pair of blocks.

| Marker state | Baseline, block 1 | Candidate, block 1 | Baseline, block 2 | Candidate, block 2 |
| --- | ---: | ---: | ---: | ---: |
| Missing | 971 ms | 614.5 ms | 1,066 ms | 608.5 ms |
| Present | 495.5 ms | 444 ms | 650.5 ms | 482.5 ms |

The missing-marker median fell by 37–43%. Treat the present-marker difference
as run variation: both versions use the same successful read. This is a marker
microbenchmark, not a measurement of full workspace setup or generation time.
The compiled candidate also passed checks after Actor deletion and with an
empty marker file. The setup suite passed 42 tests. The Substrate sandbox suite
passed 28 tests.

A separate transport trial read the mounted CA and token before each RPC.
Ten `GetActor` calls with a new connection had a median of 5 ms. Ten calls with
a reused connection had a median of 1 ms, including its first connection.
Production connection handling remains unchanged. This small observed gain
does not justify a new connection cache and its rotation and cleanup rules.

### Marker optimization deployment on 2026-11-20

Source commit `db44b32d3b` was published from `43b7f291d8` on
`feat/substrate-ghcr-publish-marker` by
[build 44699158752](https://github.com/jseguillon/n8n/actions/runs/44699158752).
The Talos deployment `n8n-app/n8n` now runs:

```text
ghcr.io/jseguillon/n8n@sha256:79143f5ef21ca5a5f86fa80d555a075f2548656fe5b30124903fa36f1c22b43c
```

All 16 packaged-runtime live records passed. Six targeted marker checks passed:
missing, present, empty, permission-error fallback, server-error fallback, and
deleted-Actor recovery. Missing markers executed no fallback command.
Authenticated n8n sandbox verification returned `ok: true`. UI and readiness
checks returned HTTP 200. Cleanup removed the disposable validation resources.
