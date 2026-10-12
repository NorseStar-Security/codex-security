import { isRecord } from "./record.js";
import { isSafeNonNegativeInteger, parseJson } from "./value.js";

const WORKER_STATUS_PREFIX = "CODEX_SECURITY_WORKER_STATUS ";
const SCAN_PROGRESS_PREFIX = "CODEX_SECURITY_SCAN_PROGRESS ";
const WORKER_PHASES = new Set([
  "ranking",
  "file_review",
  "validation",
  "attack_path",
]);

export type ScanWorkerPhase =
  "ranking" | "file_review" | "validation" | "attack_path";

export type ScanPhase =
  | "preflight"
  | "threat_model"
  | "discovery"
  | "validation"
  | "attack_path"
  | "reporting";

export interface ScanProgress {
  phase: ScanPhase;
  filesCompleted: number;
  filesTotal: number;
}

export function scanPhaseLabel(value: ScanWorkerPhase | ScanPhase): string {
  return {
    preflight: "preflight",
    threat_model: "building threat model",
    discovery: "reviewing files",
    ranking: "ranking scan targets",
    file_review: "reviewing files",
    validation: "validating findings",
    attack_path: "analyzing attack paths",
    reporting: "writing report",
  }[value];
}

/** Dispatch counts depend on model-emitted markers. */
export interface ScanWorkerStatus {
  kind: "dispatch";
  phase: ScanWorkerPhase;
  planned: number;
  started: number;
}

export function workerStatusFromEvent(
  event: Readonly<Record<string, unknown>>,
): ScanWorkerStatus | null {
  if (event["type"] !== "item.completed" || !isRecord(event["item"])) {
    return null;
  }
  const item = event["item"];
  if (item["type"] === "agent_message") return dispatchStatus(item);
  return null;
}

export function scanProgressUpdatesFromEvent(
  event: Readonly<Record<string, unknown>>,
): ScanProgress[] {
  if (event["type"] !== "item.completed" || !isRecord(event["item"])) {
    return [];
  }
  const item = event["item"];
  const output =
    item["type"] === "agent_message"
      ? item["text"]
      : item["type"] === "command_execution"
        ? item["aggregated_output"]
        : null;
  return typeof output === "string" ? scanProgressUpdatesFromText(output) : [];
}

export function scanProgressUpdatesFromText(output: string): ScanProgress[] {
  const updates: ScanProgress[] = [];
  for (const line of linesOutsideFences(output)) {
    if (!line.startsWith(SCAN_PROGRESS_PREFIX)) continue;
    const progress = scanProgressFromMarker(line);
    if (progress !== null) updates.push(progress);
  }
  return updates;
}

/** Return lines outside Markdown fences so quoted markers are not read as live. */
function linesOutsideFences(text: string): string[] {
  const lines: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  for (const line of text.split(/\r?\n/u)) {
    const delimiter = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
    if (delimiter !== null) {
      const run = delimiter[1]!;
      if (fence === null) {
        fence = { marker: run[0]!, length: run.length };
      } else if (
        run[0] === fence.marker &&
        run.length >= fence.length &&
        delimiter[2]!.trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    if (fence === null) lines.push(line);
  }
  return lines;
}

function scanProgressFromMarker(marker: string): ScanProgress | null {
  const payload = parseJson(() => marker.slice(SCAN_PROGRESS_PREFIX.length));
  if (
    !isRecord(payload) ||
    !isScanPhase(payload["phase"]) ||
    !isSafeNonNegativeInteger(payload["filesCompleted"]) ||
    !isSafeNonNegativeInteger(payload["filesTotal"]) ||
    payload["filesCompleted"] > payload["filesTotal"]
  ) {
    return null;
  }
  return {
    phase: payload["phase"],
    filesCompleted: payload["filesCompleted"],
    filesTotal: payload["filesTotal"],
  };
}

function dispatchStatus(
  item: Readonly<Record<string, unknown>>,
): ScanWorkerStatus | null {
  if (typeof item["text"] !== "string") return null;
  const markers = linesOutsideFences(item["text"]).filter((line) =>
    line.startsWith(WORKER_STATUS_PREFIX),
  );
  const marker = markers[0];
  if (markers.length !== 1 || marker === undefined) return null;
  const payload = parseJson(() => marker.slice(WORKER_STATUS_PREFIX.length));
  if (
    !isRecord(payload) ||
    typeof payload["phase"] !== "string" ||
    !WORKER_PHASES.has(payload["phase"]) ||
    !isSafeNonNegativeInteger(payload["planned"]) ||
    !isSafeNonNegativeInteger(payload["started"]) ||
    payload["started"] > payload["planned"]
  ) {
    return null;
  }
  return {
    kind: "dispatch",
    phase: payload["phase"] as ScanWorkerPhase,
    planned: payload["planned"],
    started: payload["started"],
  };
}

function isScanPhase(value: unknown): value is ScanPhase {
  return (
    value === "preflight" ||
    value === "threat_model" ||
    value === "discovery" ||
    value === "validation" ||
    value === "attack_path" ||
    value === "reporting"
  );
}
