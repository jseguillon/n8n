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
