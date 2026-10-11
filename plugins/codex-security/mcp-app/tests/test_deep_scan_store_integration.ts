import { readJson, writeJsonLine } from "./support/json.ts";
import { temporaryDirectory } from "./support/temporary-directories.ts";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { importModule } from "./import-module.ts";
import type { ScanDraftInput } from "../src/artifact-scan-draft.js";
import {
  DeepScanCoordinator,
  FakeExecutor,
} from "./deep_scan_coordinator_fixture.ts";

const execFileAsync = promisify(execFile);
const mcpAppRoot = path.resolve(import.meta.dirname, "..");
const pluginRoot = path.resolve(mcpAppRoot, "..");
const workbenchPath = path.join(pluginRoot, "scripts", "workbench_db.py");
const {
  WorkbenchDeepScanStore,
  createScanArtifactContext,
  recordCodexSecurityScanDraftViaWorkbench,
} = await importModule({
  stdin: {
    contents: `export { WorkbenchDeepScanStore } from "./src/deep-scan/store.ts";
export { createScanArtifactContext } from "./src/artifact-context.ts";
export { recordCodexSecurityScanDraftViaWorkbench } from "./src/artifact-scan-draft.ts";`,
    resolveDir: mcpAppRoot,
  },
});

await testFreeformFailureMessagesAgainstRealWorkbench();
await testReducerCommitAndFinishAgainstRealWorkbench();
await testReducerCommitAndFinishAgainstRealWorkbench(true);
await testExpiredDeadlineWithoutCompletedDiscoveryAgainstRealWorkbench();
await testPartialWorkerCoverageSurvivesParentCompletion();
await testReceiptRepairSurvivesStoppedRecovery();
await testReceiptRepairSurvivesStoppedRecovery("nonportable");
await testReceiptRepairSurvivesStoppedRecovery("case_collision");
await testReceiptRepairSurvivesStoppedRecovery("control");
await testReceiptRepairSurvivesStoppedRecovery("cross_surface_collision");
await testLateParentDraftPreservesCheckpointWithoutOverwritingTerminalSeal();
await testRecoveredPublicationRejectsLateFailure();
await testNoopStoppedRefreshRetainsPublicationFailure();
await testConcurrentParentDraftsPreserveBothCheckpoints();
await testCoordinatorCommitResponseRecovery();
await testCoordinatorCommitResponseRecovery("commit-deep-scan-dedup");
await testCoordinatorCommitResponseRecovery("finish-deep-scan");

async function testCoordinatorCommitResponseRecovery(
  exhaustOperation?: "commit-deep-scan-dedup" | "finish-deep-scan",
) {
  const { fixtureRoot, targetPath, environment } = await createWorkbenchFixture(
    "deep-scan-commit-response-",
  );
  const exhaustCommitRetries = exhaustOperation === "commit-deep-scan-dedup";
  const runWorkbench = createWorkbenchRunner(environment);
  const attempts = new Map<string, string[][]>();
  let failureWrites = 0;
  let committedManifest: string | undefined;
  const store = new WorkbenchDeepScanStore(async (args: string[]) => {
    const result = await runWorkbench(args);
    if (args[0] === "fail-deep-scan") failureWrites += 1;
    if (args[0] === "finish-deep-scan") {
      committedManifest ??= await readFile(
        args[args.indexOf("--manifest-path") + 1],
        "utf8",
      );
    }
    if (
      args[0] !== "commit-deep-scan-dedup" &&
      args[0] !== "finish-deep-scan" &&
      !(
        args[0] === "upsert-deep-scan-worker" &&
        args[args.indexOf("--kind") + 1] === "discovery" &&
        args[args.indexOf("--status") + 1] === "succeeded"
      )
    )
      return result;
    const calls = attempts.get(args[0]) ?? [];
    calls.push([...args]);
    attempts.set(args[0], calls);
    if (
      args[0] === "commit-deep-scan-dedup" &&
      (calls.length === 1 || exhaustCommitRetries)
    ) {
      throw Object.assign(
        new Error("workbench response timed out after commit"),
        {
          code: "ETIMEDOUT",
        },
      );
    }
    // Reproduce truncated stdout after the actual SQLite mutation committed.
    if (calls.length === 1 || args[0] === exhaustOperation)
      return JSON.parse('{"deepScan":');
    return result;
  });
  try {
    await mkdir(path.join(environment.CODEX_HOME, "codex-security"), {
      recursive: true,
    });
    await writeFile(
      path.join(environment.CODEX_HOME, "codex-security", "config.toml"),
      "[deep_scan]\nworkers = 1\nstop_after_no_new = 1\nmax_discovery_runs = 1\n",
    );
    const threadId = "commit-response-owner";
    const run = await store.begin({
      targetPath,
      threadId,
      scanRoot: path.join(fixtureRoot, "scans"),
    });
    const claim = await store.claimCoordinator({
      scanId: run.scanId,
      threadId,
    });
    const coordinator = new DeepScanCoordinator({
      run: claim.run,
      store,
      pluginRoot,
      threadId,
      executor: new FakeExecutor(),
      heartbeatIntervalMs: 60_000,
      onComplete: async (draft: ScanDraftInput, signal: AbortSignal) => {
        const context = await createScanArtifactContext(
          run.scanId,
          runWorkbench,
          {
            requireRunning: true,
            pluginRoot,
          },
        );
        await recordCodexSecurityScanDraftViaWorkbench(
          context,
          draft,
          runWorkbench,
          signal,
        );
      },
    });
    coordinator.start();
    const terminal = await coordinator.wait(undefined, 30_000);
    assert.equal(
      terminal?.status,
      exhaustCommitRetries ? "failed" : "succeeded",
      terminal?.error,
    );
    assert.equal(failureWrites, exhaustCommitRetries ? 1 : 0);
    assert.equal(
      attempts.get("commit-deep-scan-dedup")?.length,
      exhaustCommitRetries ? 3 : 2,
    );
    assert.equal(attempts.get("upsert-deep-scan-worker")?.length, 2);
    assert.equal(
      attempts.get("finish-deep-scan")?.length,
      exhaustCommitRetries
        ? undefined
        : exhaustOperation === "finish-deep-scan"
          ? 3
          : 2,
    );
    for (const calls of attempts.values()) {
      for (const call of calls) assert.deepEqual(call, calls[0]);
    }
    const persisted = await store.get(run.scanId, threadId);
    assert.equal(persisted.status, terminal.status);
    assert.equal(
      persisted.noNewStreak,
      1,
      "replayed commits must not double-count discovery",
    );
    assert.equal(
      persisted.persistedWorkers.filter(
        (worker: { status: string }) => worker.status === "succeeded",
      ).length,
      2,
    );
    if (!exhaustCommitRetries) {
      assert.equal(
        await readFile(terminal.manifestPath, "utf8"),
        committedManifest,
        "lost finish replies must not overwrite the published manifest",
      );
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function createWorkbenchFixture(prefix: string) {
  const fixtureRoot = await temporaryDirectory(prefix);
  const targetPath = path.join(fixtureRoot, "target");
  const environment = {
    ...process.env,
    CODEX_HOME: path.join(fixtureRoot, "codex-home"),
    CODEX_SECURITY_STATE_DIR: path.join(fixtureRoot, "state"),
  };
  try {
    await mkdir(targetPath, { recursive: true });
    await writeFile(path.join(targetPath, "fixture.py"), "print('fixture')\n");
    return { fixtureRoot, targetPath, environment };
  } catch (error) {
    await rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

function createWorkbenchRunner(environment: NodeJS.ProcessEnv, bounded = true) {
  const python = process.env.PYTHON?.trim() || "python3";
  return async (args: string[]) => {
    const { stdout } = await execFileAsync(python, [workbenchPath, ...args], {
      cwd: pluginRoot,
      env: environment,
      ...(bounded ? { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 } : {}),
    });
    return JSON.parse(stdout);
  };
}

async function testFreeformFailureMessagesAgainstRealWorkbench() {
  const { fixtureRoot, targetPath, environment } = await createWorkbenchFixture(
    "deep-scan-error-transport-",
  );
  const store = new WorkbenchDeepScanStore(createWorkbenchRunner(environment));
  try {
    const run = await store.begin({
      targetPath,
      threadId: "error-owner",
      scanRoot: path.join(fixtureRoot, "scans"),
    });
    await store.claimCoordinator({
      scanId: run.scanId,
      threadId: "error-owner",
    });
    const worker = await createWorkerFixture(run, "discovery", "discovery");
    await store.updateWorker({ ...worker, status: "running" });
    const message = "--provider-error=café\nretry the request";
    const failed = await store.updateWorker({
      ...worker,
      status: "failed",
      error: message,
    });
    assert.equal(failed.error, message);
    assert.equal((await store.fail(run.scanId, message)).error, message);
    const reloaded = await store.get(run.scanId, "error-owner");
    assert.equal(reloaded.error, message);
    assert.equal(reloaded.persistedWorkers[0].error, message);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function testRecoveredPublicationRejectsLateFailure() {
  const { fixtureRoot, targetPath, environment } = await createWorkbenchFixture(
    "deep-scan-publication-failure-",
  );
  const runWorkbench = createWorkbenchRunner(environment);
  try {
    const store = new WorkbenchDeepScanStore(runWorkbench);
    const run = await store.begin({
      targetPath,
      scope: ".",
      threadId: "publication-failure-owner",
      scanRoot: path.join(fixtureRoot, "scans"),
    });
    const claim = await store.claimCoordinator({
      scanId: run.scanId,
      threadId: "publication-failure-owner",
    });
    assert.equal(claim.acquired, true);
    assert.equal(claim.run.coordinatorGeneration > 1, true);
    const context = await createScanArtifactContext(run.scanId, runWorkbench, {
      requireRunning: true,
    });
    await recordCodexSecurityScanDraftViaWorkbench(
      context,
      checkpoint(
        run.scanId,
        "publication-recovery-candidate",
        "Publication recovery remains pending.",
      ),
      runWorkbench,
    );
    await runWorkbench([
      "cancel-scan",
      "--scan-id",
      run.scanId,
      "--thread-id",
      "publication-failure-owner",
    ]);
    assert.equal(
      (await store.get(run.scanId, "publication-failure-owner")).status,
      "canceled",
    );
    const message =
      "Saved result publication failed: stale fixture publication failure";
    await store.recordStoppedPublicationFailure(
      run.scanId,
      message,
      claim.run.coordinatorGeneration,
    );
    const reloaded = await new WorkbenchDeepScanStore(runWorkbench).get(
      run.scanId,
      "publication-failure-owner",
    );
    assert.equal(reloaded.status, "canceled");
    assert.equal(
      reloaded.error,
      undefined,
      "a delayed failure write must not restore an error after publication recovered",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function testNoopStoppedRefreshRetainsPublicationFailure() {
  const { fixtureRoot, targetPath, environment } = await createWorkbenchFixture(
    "deep-scan-noop-publication-",
  );
  const runWorkbench = createWorkbenchRunner(environment);
  try {
    const store = new WorkbenchDeepScanStore(runWorkbench);
    const run = await store.begin({
      targetPath,
      scope: ".",
      threadId: "noop-publication-owner",
      scanRoot: path.join(fixtureRoot, "scans"),
    });
    const claim = await store.claimCoordinator({
      scanId: run.scanId,
      threadId: "noop-publication-owner",
    });
    await runWorkbench([
      "cancel-scan",
      "--scan-id",
      run.scanId,
      "--thread-id",
      "noop-publication-owner",
    ]);
    const message =
      "--publication-error=café\nSaved result publication failed.";
    await store.recordStoppedPublicationFailure(
      run.scanId,
      message,
      claim.run.coordinatorGeneration,
    );
    await runWorkbench(["get-scan", "--scan-id", run.scanId]);
    assert.equal(
      (
        await new WorkbenchDeepScanStore(runWorkbench).get(
          run.scanId,
          "noop-publication-owner",
        )
      ).error,
      message,
      "a no-op retained-result refresh must keep its publication failure",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function checkpoint(scanId: string, candidateId: string, reason: string) {
  return {
    scanId,
    complete: false,
    findings: [],
    coverage: {
      completeness: "partial",
      surfaces: [],
      explicitExclusions: [],
      deferred: [{ candidateId, reason, paths: ["fixture.py"] }],
    },
  };
}

async function testConcurrentParentDraftsPreserveBothCheckpoints() {
  const { fixtureRoot, targetPath, environment } = await createWorkbenchFixture(
    "scan-draft-concurrency-integration-",
  );
  const rawRunWorkbench = createWorkbenchRunner(environment);
  let stagedWrites = 0;
  const initialWritesReady = Promise.withResolvers<void>();
  const runWorkbench = async (args: string[]) => {
    if (args[0] === "write-scan-draft" && ++stagedWrites <= 2) {
      if (stagedWrites === 2) initialWritesReady.resolve();
      await initialWritesReady.promise;
    }
    return rawRunWorkbench(args);
  };
  try {
    const run = await new WorkbenchDeepScanStore(rawRunWorkbench).begin({
      targetPath,
      scope: ".",
      threadId: "concurrent-draft-owner",
      scanRoot: path.join(fixtureRoot, "scans"),
    });
    const context = await createScanArtifactContext(run.scanId, runWorkbench, {
      requireRunning: true,
    });

    await Promise.all([
      recordCodexSecurityScanDraftViaWorkbench(
        context,
        checkpoint(
          run.scanId,
          "concurrent-a",
          "Independent review remains pending.",
        ),
        runWorkbench,
      ),
      recordCodexSecurityScanDraftViaWorkbench(
        context,
        checkpoint(
          run.scanId,
          "concurrent-b",
          "Independent review remains pending.",
        ),
        runWorkbench,
      ),
    ]);
    assert.equal(
      stagedWrites,
      3,
      "the stale writer retries after the host rejects its digest",
    );

    const coverage = await readJson(run.scanDir, "coverage.json");
    assert.deepEqual(
      new Set(
        coverage.deferred.map(
          (item: { candidateId: string }) => item.candidateId,
        ),
      ),
      new Set(["concurrent-a", "concurrent-b"]),
      "overlapping canonical writes must merge every immutable checkpoint",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function testLateParentDraftPreservesCheckpointWithoutOverwritingTerminalSeal() {
  const { fixtureRoot, targetPath, environment } = await createWorkbenchFixture(
    "scan-draft-cancel-integration-",
  );
  const runWorkbench = createWorkbenchRunner(environment);
  try {
    const run = await new WorkbenchDeepScanStore(runWorkbench).begin({
      targetPath,
      scope: ".",
      threadId: "checkpoint-owner",
      scanRoot: path.join(fixtureRoot, "scans"),
    });
    const context = await createScanArtifactContext(run.scanId, runWorkbench, {
      requireRunning: true,
    });
    await recordCodexSecurityScanDraftViaWorkbench(
      context,
      checkpoint(
        run.scanId,
        "early-result",
        "Source validation remains pending.",
      ),
      runWorkbench,
    );
    await runWorkbench([
      "cancel-scan",
      "--scan-id",
      run.scanId,
      "--thread-id",
      "checkpoint-owner",
    ]);
    const manifestPath = path.join(run.scanDir, "scan-manifest.json");
    const sealed = await readFile(manifestPath, "utf8");
    assert.equal(JSON.parse(sealed).scan.status, "canceled");

    await assert.rejects(
      recordCodexSecurityScanDraftViaWorkbench(
        context,
        checkpoint(
          run.scanId,
          "late-result",
          "Source validation remains pending.",
        ),
        runWorkbench,
      ),
      /not running|stopped|terminal/i,
    );
    assert.equal(
      await readFile(manifestPath, "utf8"),
      sealed,
      "a stale writer cannot overwrite a terminal seal",
    );
    const stopped = await runWorkbench(["get-scan", "--scan-id", run.scanId]);
    assert.equal(stopped.scan.progress.status, "canceled");
    const coverage = await readJson(run.scanDir, "coverage.json");
    const pending = coverage.deferred.map(
      (item: { candidateId: string }) => item.candidateId,
    );
    assert.ok(pending.includes("early-result"));
    assert.ok(
      !pending.includes("late-result"),
      "a checkpoint written after cancellation must not change retained results",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function testReducerCommitAndFinishAgainstRealWorkbench(
  replaceFailedReducer = false,
) {
  const { fixtureRoot, targetPath, environment } = await createWorkbenchFixture(
    "deep-scan-store-integration-",
  );
  const scanRoot = path.join(fixtureRoot, "scans");
  const codexHome = path.join(fixtureRoot, "codex-home");
  const threadId = "deep-scan-store-integration-thread";
  const python = process.env.PYTHON?.trim() || "python3";
  const runWorkbench = mock.fn(createWorkbenchRunner(environment));
  const store = new WorkbenchDeepScanStore(runWorkbench);

  try {
    await mkdir(path.join(codexHome, "codex-security"), { recursive: true });
    await writeFile(
      path.join(codexHome, "codex-security", "config.toml"),
      `[deep_scan]
workers = 2
subagents = 0
stop_after_no_new = 2
max_discovery_runs = 3
max_time_hours = 2.5
`,
    );

    const run = await store.begin({
      targetPath,
      scope: ".",
      threadId,
      scanRoot,
    });
    assert.equal(typeof run.createdAt, "string");
    assert.equal(run.config.maxTimeHours, 2.5);
    const owned = await store.claimCoordinator({
      scanId: run.scanId,
      threadId,
    });
    assert.equal(owned.run.coordinatorGeneration, 2);
    const observer = new WorkbenchDeepScanStore(runWorkbench);
    const joined = await observer.begin({
      scanId: run.scanId,
      threadId,
      scanRoot,
    });
    const observed = await observer.claimCoordinator({
      scanId: joined.scanId,
      threadId,
    });
    assert.equal(observed.acquired, false);
    assert.equal(
      observed.run.coordinatorGeneration,
      owned.run.coordinatorGeneration,
    );
    assert.equal(observed.run.config.maxTimeHours, 2.5);
    await assert.rejects(
      observer.fail(run.scanId, "observer cannot fail its owner"),
      /current coordinator lease/,
    );
    const writer = spawn(python, [
      "-c",
      `import sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
connection.execute("UPDATE deep_scan_runs SET updated_at = ? WHERE scan_id = ?", ("2000-01-01T00:00:00Z", sys.argv[2]))
connection.commit()
connection.execute("BEGIN IMMEDIATE")
print("locked", flush=True)
sys.stdin.read(1)
connection.rollback()`,
      path.join(fixtureRoot, "state", "workbench.sqlite3"),
      run.scanId,
    ]);
    await once(writer.stdout, "data");
    const heartbeat = store.heartbeatCoordinator({
      scanId: run.scanId,
      threadId,
    });
    let timeout;
    try {
      const renewed = await Promise.race([
        heartbeat,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("heartbeat blocked by SQLite writer lock")),
            1_000,
          );
        }),
      ]);
      assert.equal(
        renewed.coordinatorGeneration,
        owned.run.coordinatorGeneration,
      );
      const lease = await readJson(
        run.scanDir,
        "artifacts",
        "deep_discovery",
        `coordinator-heartbeat-${owned.run.coordinatorGeneration}.json`,
      );
      assert.deepEqual(lease, {
        coordinatorGeneration: owned.run.coordinatorGeneration,
        updatedAt: renewed.updatedAt,
      });
    } finally {
      clearTimeout(timeout);
      const unlocked = once(writer, "exit");
      writer.stdin.end("x");
      await unlocked;
      await Promise.allSettled([heartbeat]);
    }
    const observedAfterLockedHeartbeat = await observer.claimCoordinator({
      scanId: run.scanId,
      threadId,
    });
    assert.equal(observedAfterLockedHeartbeat.acquired, false);
    assert.equal(
      observedAfterLockedHeartbeat.run.coordinatorGeneration,
      owned.run.coordinatorGeneration,
    );

    const first = await createDiscovery(store, run, "first", "succeeded");
    const second = await createDiscovery(store, run, "second", "succeeded");
    const late = await createDiscovery(store, run, "late", "running");
    if (replaceFailedReducer) {
      const retired = await createWorkerFixture(
        run,
        "retired-reducer",
        "dedup",
      );
      await store.claimDedup({
        ...retired,
        workerIds: [first.id, second.id],
      });
      await store.updateWorker({ ...retired, status: "running" });
      await store.updateWorker({
        ...retired,
        status: "failed",
        error: "Request blocked by cyberPolicy.",
      });
      const afterRetirement = await store.get(run.scanId, threadId);
      assert.equal(afterRetirement.status, "running");
      for (const workerId of [first.id, second.id]) {
        assert.equal(
          afterRetirement.persistedWorkers.find(
            (worker: { id: string }) => worker.id === workerId,
          )?.mergeState,
          "buffered",
          "a retired reducer must release every input for its replacement",
        );
      }
    }
    const reducer = await createWorkerFixture(run, "dedup-0001", "dedup");
    await writeJsonLine(reducer.resultPath, {
      schemaVersion: 1,
      consumedWorkerIds: [first.id, second.id],
      merges: [],
    });
    await store.claimDedup({
      ...reducer,
      workerIds: [first.id, second.id],
    });
    await store.updateWorker({
      ...reducer,
      status: "running",
      threadId: "fixture-reducer-thread",
    });

    const canonical = await createCanonicalFixture(run.scanDir);
    const stagedCandidateLedgerPath = path.join(
      reducer.artifactDir,
      "canonical",
      "candidate_ledger.jsonl",
    );
    await writePrivateFile(
      stagedCandidateLedgerPath,
      '{"candidate_id":"replacement"}\n',
    );
    const afterCommit = await store.commitDedup({
      id: reducer.id,
      scanId: run.scanId,
      newFindings: 0,
      resultManifestPath: reducer.resultPath,
      candidateLedgerPath: stagedCandidateLedgerPath,
    });
    assert.equal(afterCommit.status, "running");
    assert.equal(afterCommit.terminalReason, undefined);
    assert.equal(afterCommit.manifestPath, undefined);
    assert.equal(afterCommit.noNewStreak, 2);
    assert.equal(
      (await runWorkbench.mock.calls.at(-1)!.result).deepScan
        .canonicalArtifacts,
      null,
    );
    assert.equal(
      await readFile(canonical.candidateLedgerPath, "utf8"),
      '{"candidate_id":"replacement"}\n',
    );
    assert.equal(
      await readFile(stagedCandidateLedgerPath, "utf8"),
      '{"candidate_id":"replacement"}\n',
    );

    const acceptedLate = await store.updateWorker({
      ...late,
      status: "succeeded",
      resultManifestPath: late.resultPath,
    });
    assert.equal(acceptedLate.status, "succeeded");
    assert.equal(acceptedLate.mergeState, "buffered");
    assert.equal(acceptedLate.completionSequence, 3);

    const manifestPath = path.join(
      run.scanDir,
      "artifacts",
      "deep_discovery",
      "coordinator-manifest.json",
    );
    const stagedManifestPath = path.join(
      run.scanDir,
      "artifacts",
      "deep_discovery",
      "coordinator-manifest.generation-2.staged.json",
    );
    await writePrivateFile(
      stagedManifestPath,
      `${JSON.stringify({ status: "succeeded" })}\n`,
    );
    const finished = await store.finish({
      scanId: run.scanId,
      reason: "saturated",
      manifestPath,
      stagedManifestPath,
      omittedWorkerIds: [late.id],
    });
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.terminalReason, "saturated");
    assert.equal(finished.manifestPath, manifestPath);

    const continued = await store.begin({
      targetPath,
      scope: ".",
      threadId: "deep-scan-store-continuation-thread",
      scanRoot,
    });
    assert.equal(continued.scanId, run.scanId);
    assert.equal(continued.status, "succeeded");
    assert.equal(continued.manifestPath, manifestPath);
    assert.equal(continued.config.maxTimeHours, 2.5);

    const replay = await store.finish({
      scanId: run.scanId,
      reason: "saturated",
      manifestPath,
      stagedManifestPath,
      omittedWorkerIds: [late.id],
    });
    assert.equal(replay.status, "succeeded");

    const differentManifestPath = path.join(
      run.scanDir,
      "artifacts",
      "deep_discovery",
      "different-manifest.json",
    );
    await writePrivateFile(differentManifestPath, "{}\n");
    await assert.rejects(
      store.finish({
        scanId: run.scanId,
        reason: "saturated",
        manifestPath: differentManifestPath,
        omittedWorkerIds: [late.id],
      }),
      /terminal state is immutable/,
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
}

async function testExpiredDeadlineWithoutCompletedDiscoveryAgainstRealWorkbench() {
  const { fixtureRoot, targetPath, environment } = await createWorkbenchFixture(
    "deep-scan-store-zero-discovery-",
  );
  const codexHome = path.join(fixtureRoot, "codex-home");
  const threadId = "deep-scan-store-zero-discovery-thread";
  const runWorkbench = mock.fn(createWorkbenchRunner(environment, false));
  const store = new WorkbenchDeepScanStore(runWorkbench);

  try {
    await mkdir(path.join(codexHome, "codex-security"), { recursive: true });
    await writeFile(
      path.join(codexHome, "codex-security", "config.toml"),
      "[deep_scan]\nworkers = 1\nmax_discovery_runs = 3\nmax_time_hours = 1e-12\n",
    );

    const run = await store.begin({
      targetPath,
      scope: ".",
      threadId,
      scanRoot: path.join(fixtureRoot, "scans"),
    });
    assert.equal(run.config.maxTimeHours, 1e-12);
    const owned = await store.claimCoordinator({
      scanId: run.scanId,
      threadId,
    });
    assert.equal(owned.acquired, true);
    assert.equal(
      (await runWorkbench.mock.calls.at(-1)!.result).deepScan
        .canonicalArtifacts,
      null,
    );
    const canonical = await createCanonicalFixture(run.scanDir);
    const manifestPath = path.join(
      run.scanDir,
      "artifacts",
      "deep_discovery",
      "coordinator-manifest.json",
    );
    await writePrivateFile(
      manifestPath,
      '{"status":"succeeded","discoveryCount":0}\n',
    );

    const finished = await store.finish({
      scanId: run.scanId,
      reason: "capped",
      manifestPath,
      omittedWorkerIds: [],
    });
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.terminalReason, "capped");
    assert.equal(finished.dispatchedCount, 0);
    assert.deepEqual(
      (await runWorkbench.mock.calls.at(-1)!.result).deepScan
        .canonicalArtifacts,
      canonical,
    );
    assert.equal(await readFile(canonical.candidateLedgerPath, "utf8"), "");
    assert.equal(
      await readFile(canonical.inScopeFilesPath, "utf8"),
      "fixture.py\n",
    );

    const observed = await new WorkbenchDeepScanStore(runWorkbench).get(
      run.scanId,
      threadId,
    );
    assert.equal(observed.status, "succeeded");
    assert.equal(observed.terminalReason, "capped");
    assert.deepEqual(
      (await runWorkbench.mock.calls.at(-1)!.result).deepScan
        .canonicalArtifacts,
      canonical,
    );
    assert.deepEqual(observed.persistedWorkers, []);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
}

async function testPartialWorkerCoverageSurvivesParentCompletion() {
  const { fixtureRoot, targetPath, environment } = await createWorkbenchFixture(
    "deep-scan-partial-coverage-",
  );
  const runWorkbench = createWorkbenchRunner(environment);
  const store = new WorkbenchDeepScanStore(runWorkbench);
  const threadId = "partial-coverage-owner";
  try {
    await mkdir(path.join(environment.CODEX_HOME, "codex-security"), {
      recursive: true,
    });
    await writeFile(
      path.join(environment.CODEX_HOME, "codex-security", "config.toml"),
      "[deep_scan]\nworkers = 2\nmax_discovery_runs = 2\nstop_after_no_new = 2\n",
    );
    const run = await store.begin({
      targetPath,
      threadId,
      scanRoot: path.join(fixtureRoot, "scans"),
    });
    const claim = await store.claimCoordinator({
      scanId: run.scanId,
      threadId,
    });
    const executor = new FakeExecutor();
    const execute = executor.run.bind(executor);
    executor.run = async (request) => {
      const result = await execute(request);
      if (request.kind === "discovery") {
        const root = request.artifactContext!.root;
        const draft = await readJson(root, "result.json");
        draft.coverage = {
          completeness: "partial",
          surfaces: [
            {
              id: "1",
              label: "Request entry",
              disposition: "needs_follow_up",
              receiptRefs: ["artifacts/review.md"],
            },
            { label: "Response writer", disposition: "no_issue_found" },
          ],
          explicitExclusions: [
            { id: "1", pattern: "vendor/**", reason: "Third-party source." },
            { pattern: "generated/**", reason: "Generated output." },
          ],
          deferred: [
            {
              id: "1",
              surfaceIds: ["1"],
              reason: "Deployment configuration remains unreviewed.",
            },
            { reason: "Parent routing review remains pending." },
          ],
          openQuestions: ["Which deployments enable the handler?"],
        };
        await mkdir(path.join(root, "artifacts"), { recursive: true });
        await writeFile(
          path.join(root, "artifacts/review.md"),
          "Independent source review receipt.\n",
        );
        await writeJsonLine(path.join(root, "result.json"), draft);
      }
      return result;
    };
    const coordinator = new DeepScanCoordinator({
      run: claim.run,
      store,
      pluginRoot,
      threadId,
      executor,
      onComplete: async (draft: ScanDraftInput, signal: AbortSignal) => {
        const context = await createScanArtifactContext(
          run.scanId,
          runWorkbench,
          { requireRunning: true },
        );
        await recordCodexSecurityScanDraftViaWorkbench(
          context,
          draft,
          runWorkbench,
          signal,
        );
      },
    });
    coordinator.start();
    const terminal = await coordinator.wait(undefined, 30_000);
    assert.equal(terminal?.status, "succeeded", terminal?.error);
    await runWorkbench(["complete-scan", "--scan-id", run.scanId]);
    const coverage = await readJson(run.scanDir, "coverage.json");
    assert.equal(coverage.completeness, "partial");
    for (const field of ["surfaces", "explicitExclusions", "deferred"]) {
      assert.equal(coverage[field].length, 4, field);
      assert.equal(
        new Set(coverage[field].map((row: { id: string }) => row.id)).size,
        4,
        field,
      );
    }
    assert.equal(coverage.openQuestions.length, 2);
    for (const row of coverage.surfaces) {
      if (row.label !== "Request entry") continue;
      assert.equal(
        row.id,
        `${row.workerId}/1`,
        "explicit source IDs retain their links",
      );
      assert.equal(
        await readFile(path.join(run.scanDir, row.receiptRefs[0]), "utf8"),
        "Independent source review receipt.\n",
      );
      assert.equal(
        coverage.deferred.some((item: { surfaceIds: string[] }) =>
          item.surfaceIds?.includes(row.id),
        ),
        true,
      );
    }
    assert.equal(
      typeof (await readJson(run.scanDir, "scan-manifest.json")).scan.sealedAt,
      "string",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function createDiscovery(
  store: import("../src/deep-scan/types.js").DeepScanStore,
  run: import("../src/deep-scan/types.js").DeepScanRunState,
  label: string,
  finalState: "running" | "succeeded",
) {
  const fixture = await createWorkerFixture(
    run,
    `discovery-${label}`,
    "discovery",
  );
  await writeFile(fixture.resultPath, "{}\n");
  if (finalState === "succeeded") {
    await store.updateWorker({ ...fixture, status: "queued" });
  }
  const started = { ...fixture, threadId: `fixture-${label}-thread` };
  await store.updateWorker({ ...started, status: "running" });
  if (finalState === "succeeded") {
    await store.updateWorker({
      ...started,
      status: "succeeded",
      resultManifestPath: fixture.resultPath,
    });
  }
  return started;
}

async function createWorkerFixture(
  run: import("../src/deep-scan/types.js").DeepScanRunState,
  label: string,
  kind: "discovery" | "dedup",
) {
  const root = path.join(run.scanDir, "artifacts", "deep_discovery", label);
  const artifactDir = path.join(root, "output");
  const promptPath = path.join(root, "prompt.md");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(promptPath, "fixture prompt\n");
  return {
    id: randomUUID(),
    scanId: run.scanId,
    kind,
    artifactDir,
    promptPath,
    resultPath: path.join(artifactDir, "result.json"),
    attempt: 1,
  };
}

async function createCanonicalFixture(scanDir: string) {
  const paths = {
    inScopeFilesPath: path.join(
      scanDir,
      "artifacts",
      "02_discovery",
      "in_scope_files.txt",
    ),
    candidateLedgerPath: path.join(
      scanDir,
      "artifacts",
      "02_discovery",
      "candidate_ledger.jsonl",
    ),
  };
  await writePrivateFile(paths.inScopeFilesPath, "fixture.py\n");
  await writePrivateFile(paths.candidateLedgerPath, "");
  return paths;
}

async function writePrivateFile(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, { mode: 0o600 });
}

console.log("deep scan store integration tests passed");

async function testReceiptRepairSurvivesStoppedRecovery(
  receiptFailure:
    | "missing"
    | "nonportable"
    | "case_collision"
    | "control"
    | "cross_surface_collision" = "missing",
) {
  const { recordCodexSecurityWorkerScanDraft } = await importModule({
    stdin: {
      contents:
        'export { recordCodexSecurityWorkerScanDraft } from "./src/artifact-scan-draft.ts";',
      resolveDir: mcpAppRoot,
    },
  });
  const { fixtureRoot, targetPath, environment } = await createWorkbenchFixture(
    "deep-receipt-repair-",
  );
  const runWorkbench = createWorkbenchRunner(environment);
  const store = new WorkbenchDeepScanStore(runWorkbench);
  const threadId = "receipt-repair-owner";
  try {
    await mkdir(path.join(environment.CODEX_HOME, "codex-security"), {
      recursive: true,
    });
    await writeFile(
      path.join(environment.CODEX_HOME, "codex-security/config.toml"),
      "[deep_scan]\nworkers = 1\nmax_discovery_runs = 1\n",
    );
    const run = await store.begin({
      targetPath,
      threadId,
      scanRoot: path.join(fixtureRoot, "scans"),
    });
    const claim = await store.claimCoordinator({
      scanId: run.scanId,
      threadId,
    });
    const executor = new FakeExecutor();
    const execute = executor.run.bind(executor);
    let discoveryAttempts = 0;
    let firstOutput: string | undefined;
    let originalResult: string | undefined;
    const crossSurface = receiptFailure === "cross_surface_collision";
    const caseCollision = receiptFailure === "case_collision" || crossSurface;
    const createInvalidFiles =
      receiptFailure !== "missing" &&
      !(
        process.platform === "win32" &&
        (receiptFailure === "nonportable" || receiptFailure === "control")
      );
    const archivedContents = (ref: string) =>
      process.platform === "win32" && caseCollision
        ? "Archived case-insensitive evidence.\n"
        : `Archived evidence for ${ref}.\n`;
    const pending =
      receiptFailure === "missing" ||
      receiptFailure === "control" ||
      crossSurface;
    const invalidRefs = caseCollision
      ? ["artifacts/review.md", "artifacts/Review.md"]
      : [
          receiptFailure === "nonportable"
            ? "artifacts/review?.md"
            : receiptFailure === "control"
              ? "artifacts/rev\tiew.md"
              : "artifacts/missing.md",
        ];
    executor.run = async (request) => {
      const execution = await execute(request);
      if (request.kind !== "discovery") return execution;
      discoveryAttempts++;
      const context = { ...request.artifactContext!, scanId: run.scanId };
      firstOutput ??= context.root;
      const draft = await readJson(context.root, "result.json");
      await rm(path.join(context.root, "result.json"));
      await mkdir(path.join(context.root, "artifacts"), { recursive: true });
      if (discoveryAttempts === 1) {
        if (createInvalidFiles) {
          for (const ref of invalidRefs)
            await writeFile(
              path.join(context.root, ref),
              archivedContents(ref),
            );
        }
        await writeFile(
          path.join(context.root, "artifacts/original.md"),
          "Original valid evidence.\n",
        );
        await recordCodexSecurityWorkerScanDraft(context, {
          ...draft,
          complete: true,
          coverage: {
            completeness: pending ? "partial" : "complete",
            explicitExclusions: [],
            surfaces: [
              {
                id: "api",
                label: "API",
                disposition: pending ? "needs_follow_up" : "no_issue_found",
                receiptRefs: [
                  ...(crossSurface ? [invalidRefs[0]] : invalidRefs),
                  "artifacts/original.md",
                ],
              },
              ...(crossSurface
                ? [
                    {
                      id: "api-other",
                      label: "Other API",
                      disposition: "needs_follow_up",
                      receiptRefs: [invalidRefs[1]],
                    },
                  ]
                : []),
            ],
            deferred: pending
              ? [
                  {
                    id: "review",
                    reason: "Review remains.",
                    surfaceIds: crossSurface ? ["api", "api-other"] : ["api"],
                  },
                ]
              : [],
          },
        });
        originalResult = await readFile(
          path.join(context.root, "result.json"),
          "utf8",
        );
      } else if (discoveryAttempts === 2) {
        if (crossSurface)
          await writeFile(
            path.join(context.root, "artifacts/replacement-other.md"),
            "Replacement other evidence.\n",
          );
        await writeFile(
          path.join(context.root, "artifacts/replacement.md"),
          "Replacement evidence.\n",
        );
        await recordCodexSecurityWorkerScanDraft(context, {
          ...draft,
          complete: true,
          coverage: {
            completeness: "complete",
            explicitExclusions: [],
            deferred: [],
            surfaces: [
              {
                id: "api",
                label: "API",
                disposition: "no_issue_found",
                receiptRefs: ["artifacts/replacement.md"],
              },
              ...(crossSurface
                ? [
                    {
                      id: "api-other",
                      label: "Other API",
                      disposition: "no_issue_found",
                      receiptRefs: ["artifacts/replacement-other.md"],
                    },
                  ]
                : []),
            ],
            resolvedDeferred: pending
              ? [{ id: "review", reason: "Review completed." }]
              : [],
          },
        });
        for (const complete of [false, true]) {
          await recordCodexSecurityWorkerScanDraft(context, {
            ...draft,
            complete,
            coverage: {
              completeness: "complete",
              surfaces: [],
              explicitExclusions: [],
              deferred: [],
            },
          });
        }
        throw Object.assign(
          new Error("Worker transport timed out after checkpoint."),
          { code: "ETIMEDOUT" },
        );
      } else {
        await recordCodexSecurityWorkerScanDraft(context, {
          ...draft,
          complete: true,
          coverage: {
            completeness: "complete",
            surfaces: [],
            explicitExclusions: [],
            deferred: [],
          },
        });
      }
      return execution;
    };
    const coordinator = new DeepScanCoordinator({
      run: claim.run,
      store,
      pluginRoot,
      threadId,
      executor,
      retryDelaysMs: [0, 0],
      onComplete: async (draft: ScanDraftInput, signal: AbortSignal) => {
        const context = await createScanArtifactContext(
          run.scanId,
          runWorkbench,
          { requireRunning: true },
        );
        await recordCodexSecurityScanDraftViaWorkbench(
          context,
          draft,
          runWorkbench,
          signal,
        );
      },
    });
    coordinator.start();
    const terminal = await coordinator.wait(undefined, 30_000);
    assert.equal(terminal?.status, "succeeded", terminal?.error);
    assert.equal(
      discoveryAttempts,
      3,
      "invalid receipts must be rejected before a repaired worker is accepted",
    );
    const before = await readJson(run.scanDir, "coverage.json");
    assert.equal(before.surfaces[0].disposition, "no_issue_found");
    const originalTitles = (
      await readJson(run.scanDir, "findings.json")
    ).findings.map((row: { title: string }) => row.title);
    await runWorkbench([
      "cancel-scan",
      "--scan-id",
      run.scanId,
      "--thread-id",
      threadId,
    ]);
    const recovered = await readJson(run.scanDir, "coverage.json");
    const surfaces = recovered.surfaces as {
      id: string;
      disposition: string;
      receiptRefs: string[];
    }[];
    assert.equal(surfaces.length, crossSurface ? 2 : 1);
    assert.deepEqual(
      surfaces.map((row) => row.id).sort(),
      before.surfaces.map((row: { id: string }) => row.id).sort(),
    );
    assert.ok(surfaces.every((row) => row.disposition === "no_issue_found"));
    assert.equal(
      recovered.deferred.some((row: { id: string }) =>
        row.id.endsWith("/review"),
      ),
      false,
    );
    const evidence = await Promise.all(
      surfaces
        .flatMap((row) => row.receiptRefs)
        .map((ref: string) => readFile(path.join(run.scanDir, ref), "utf8")),
    );
    const expected = ["Original valid evidence.\n", "Replacement evidence.\n"];
    if (crossSurface) expected.push("Replacement other evidence.\n");
    if (caseCollision) {
      const retained = [
        ...new Set(
          invalidRefs
            .map(archivedContents)
            .filter((contents) => evidence.includes(contents)),
        ),
      ];
      assert.equal(
        retained.length,
        1,
        "keep representable earlier evidence without case-colliding manifest entries",
      );
      expected.push(...retained);
    }
    assert.deepEqual(new Set(evidence), new Set(expected));
    assert.equal(
      await readFile(
        path.join(
          path.dirname(firstOutput!),
          "attempts/attempt-01/result.json",
        ),
        "utf8",
      ),
      originalResult,
    );
    if (createInvalidFiles) {
      for (const ref of invalidRefs)
        assert.equal(
          await readFile(
            path.join(path.dirname(firstOutput!), "attempts/attempt-01", ref),
            "utf8",
          ),
          archivedContents(ref),
        );
    }
    assert.deepEqual(
      (await readJson(run.scanDir, "findings.json")).findings.map(
        (row: { title: string }) => row.title,
      ),
      originalTitles,
    );
    const manifest = await readJson(run.scanDir, "scan-manifest.json");
    assert.equal(manifest.scan.status, "canceled");
    assert.equal(typeof manifest.scan.sealedAt, "string");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}
