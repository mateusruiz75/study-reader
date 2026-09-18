import { strFromU8, strToU8 } from "fflate";
import { createHash } from "node:crypto";
import { readStudy } from "../src/index.ts";
import {
	BACKUP_FILE,
	BACKUP_ROOT,
	DeployError,
	STATE_FILES,
	deployReview,
	requireDevice,
	validateReviewPackage,
	type DeployIO,
	type DeployReport,
	type StateHashes,
} from "./deploy-review.ts";
import { dedupeKey } from "./error-event.ts";
import {
	DEFAULT_LIMIT,
	DEFAULT_MAX_PER_MATERIA,
	buildStableStudy,
	runReviewPipeline,
	studyContextFromFiles,
	type ReviewPipelineResult,
} from "./review-pipeline.ts";
import { PRIORITY_BANDS, type PriorityBand, type PriorityProfile, type PrioritizedError } from "./review-priority.ts";
import { STUDY_SIGNAL_ORDER, type StudySignal } from "./study-feedback.ts";
import { FEEDBACK_ROOT, SyncError, syncFeedback } from "./sync-feedback.ts";

export const LOCK_PATH = ".indio-virtual/locks/refresh-review.lock";
export const REPORT_ROOT = ".indio-virtual/daily-refresh";
export const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

export class RefreshError extends Error {}

export type RefreshIO = DeployIO & {
	exists(path: string): Promise<boolean>;
	remove(path: string): Promise<void>;
};

export type RefreshStep =
	| "validate-args"
	| "lock"
	| "validate-device"
	| "sync-feedback"
	| "load-ledger"
	| "priority"
	| "build"
	| "validate-package"
	| "compare-and-deploy"
	| "delta"
	| "report"
	| "unlock";

export type RefreshOptions = {
	serial: string | undefined;
	ledgerPath: string | undefined;
	dryRun: boolean;
	restartKoreader: boolean;
	limit: number;
	maxPerMateria: number;
	asOf?: string;
	profile?: PriorityProfile;
	localPath: string;
	feedbackRoot: string;
	backupRoot: string;
	reportRoot: string;
	lockPath: string;
	tempDir: string;
	onStep?: (step: RefreshStep) => void;
};

export const DEFAULT_REFRESH_OPTIONS = {
	limit: DEFAULT_LIMIT,
	maxPerMateria: DEFAULT_MAX_PER_MATERIA,
	localPath: "examples/INDIO-REVISAO.study",
	feedbackRoot: FEEDBACK_ROOT,
	backupRoot: BACKUP_ROOT,
	reportRoot: REPORT_ROOT,
	lockPath: LOCK_PATH,
} as const;

export type DeltaEntry = {
	questionId: string;
	materia: string;
	priority: PriorityBand | null;
	studySignal: StudySignal | null;
	reason: string;
};

export type RefreshDelta = { entered: DeltaEntry[]; left: DeltaEntry[]; stayed: string[] };

export type RefreshResult = "NO_CHANGE" | "DEPLOYED" | "DRY_RUN" | "FAILED";

export type RefreshReport = {
	runId: string;
	startedAt: string;
	finishedAt: string;
	serial: string;
	deviceModel: string | null;
	ledgerAsOf: string | null;
	ledgerSha: string | null;
	feedbackSnapshot: string | null;
	feedbackHashes: Record<string, string>;
	candidateCount: number | null;
	priorityBands: Record<PriorityBand, number> | null;
	selectedCount: number | null;
	selectedByMateria: Record<string, number> | null;
	studySignals: Record<StudySignal, number> | null;
	enteredSincePreviousBuild: string[];
	leftSincePreviousBuild: string[];
	delta: RefreshDelta;
	localStudySha: string | null;
	localVersion: number | null;
	remoteStudyShaBefore: string | null;
	remoteStudyShaAfter: string | null;
	remoteVersionBefore: number | null;
	remoteVersionAfter: number | null;
	deploymentStatus: "NO CHANGE" | "DEPLOYED" | "WOULD DEPLOY" | "NOT REACHED";
	stateHashesBefore: StateHashes;
	stateHashesAfter: StateHashes;
	statePreserved: boolean;
	restartPerformed: boolean;
	backupDir: string | null;
	reportDir: string;
	staleLockReplaced: boolean;
	result: RefreshResult;
	error?: string;
};

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function stamp(now: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function countBy<K extends string>(keys: readonly K[], items: K[]): Record<K, number> {
	const counts = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
	for (const item of items) counts[item]++;
	return counts;
}

type LockState = { acquired: boolean; staleReplaced: boolean };

async function acquireLock(path: string, io: RefreshIO): Promise<LockState> {
	let staleReplaced = false;
	if (await io.exists(path)) {
		let startedAt = Number.NaN;
		try {
			startedAt = Date.parse(JSON.parse(strFromU8(await io.readFile(path))).startedAt);
		} catch {
			startedAt = Number.NaN;
		}
		const age = io.now().getTime() - startedAt;
		if (!Number.isNaN(startedAt) && age < STALE_LOCK_MS) {
			throw new RefreshError(`REFRESH ALREADY RUNNING (lock ${path}, started ${new Date(startedAt).toISOString()})`);
		}
		await io.remove(path);
		staleReplaced = true;
	}
	const slash = path.lastIndexOf("/");
	if (slash > 0) await io.mkdir(path.slice(0, slash));
	await io.writeFile(path, strToU8(JSON.stringify({ pid: process.pid, startedAt: io.now().toISOString() })));
	return { acquired: true, staleReplaced };
}

type PreviousBook = {
	keys: string[];
	priorities: Record<string, { priority?: PriorityBand; study?: { signal?: StudySignal } }>;
	materias: Record<string, string>;
};

function readPreviousBook(bytes: Uint8Array): PreviousBook {
	const { manifest } = readStudy(bytes);
	const indio = (manifest.extensions?.indio ?? {}) as Record<string, unknown>;
	const priorities = (indio.priorities ?? {}) as PreviousBook["priorities"];
	const keys: string[] = [];
	const materias: Record<string, string> = {};
	for (const module of manifest.modules) {
		for (const lesson of module.lessons) {
			const key = lesson.id.startsWith("error-") ? lesson.id.slice("error-".length) : lesson.id;
			keys.push(key);
			materias[key] = module.title;
		}
	}
	return { keys, priorities, materias };
}

function computeDelta(previous: PreviousBook | null, pipeline: ReviewPipelineResult): RefreshDelta {
	const current = pipeline.selection.selected.map((item) => dedupeKey(item.event));
	if (!previous) {
		return { entered: current.map((key) => describe(key, "first build on this device")), left: [], stayed: [] };
	}
	const previousSet = new Set(previous.keys);
	const currentSet = new Set(current);
	const stayed = current.filter((key) => previousSet.has(key));
	const entered = current.filter((key) => !previousSet.has(key)).map((key) => describe(key, "selected in this build"));
	const left = previous.keys.filter((key) => !currentSet.has(key)).map((key) => describeLeft(key));
	return { entered, left, stayed };

	function find(key: string): PrioritizedError | undefined {
		return pipeline.prioritized.find((item) => dedupeKey(item.event) === key);
	}

	function describe(key: string, reason: string): DeltaEntry {
		const item = find(key)!;
		return {
			questionId: key,
			materia: item.event.materia,
			priority: item.priority,
			studySignal: item.study?.signal ?? null,
			reason,
		};
	}

	function describeLeft(key: string): DeltaEntry {
		const item = find(key);
		if (item) {
			const rejected = pipeline.selection.rejected.find((r) => dedupeKey(r.event) === key);
			return {
				questionId: key,
				materia: item.event.materia,
				priority: item.priority,
				studySignal: item.study?.signal ?? null,
				reason: rejected ? `outranked (${rejected.rejectedBecause})` : "not selected",
			};
		}
		const meta = previous!.priorities[key] ?? {};
		return {
			questionId: key,
			materia: previous!.materias[key] ?? "?",
			priority: meta.priority ?? null,
			studySignal: meta.study?.signal ?? null,
			reason: "no longer a candidate in the ledger",
		};
	}
}

function renderMarkdown(report: RefreshReport): string {
	const lines = [
		`# INDIO REVISÃO — daily refresh ${report.runId}`,
		"",
		`- result: **${report.result}** (${report.deploymentStatus})`,
		`- device: ${report.serial} (${report.deviceModel ?? "?"})`,
		`- ledger as-of: ${report.ledgerAsOf ?? "?"} · sha256 ${report.ledgerSha ?? "?"}`,
		`- feedback snapshot: ${report.feedbackSnapshot ?? "(none)"}`,
		`- candidates: ${report.candidateCount ?? "?"} · selected: ${report.selectedCount ?? "?"}`,
		`- bands: ${JSON.stringify(report.priorityBands)}`,
		`- study signals: ${JSON.stringify(report.studySignals)}`,
		`- by materia: ${JSON.stringify(report.selectedByMateria)}`,
		`- local sha256: ${report.localStudySha ?? "?"} (v${report.localVersion ?? "?"})`,
		`- remote sha256: ${report.remoteStudyShaBefore ?? "(none)"} → ${report.remoteStudyShaAfter ?? "(none)"} (v${report.remoteVersionBefore ?? "-"} → v${report.remoteVersionAfter ?? "-"})`,
		`- state preserved: ${report.statePreserved}`,
		`- restart performed: ${report.restartPerformed}`,
		`- backup: ${report.backupDir ?? "(none)"}`,
		...(report.error ? [`- error: ${report.error}`] : []),
		"",
		`## Delta (stayed ${report.delta.stayed.length})`,
		"",
		"| change | questionId | materia | priority | studySignal | reason |",
		"| --- | --- | --- | --- | --- | --- |",
		...report.delta.entered.map((e) => `| ENTERED | ${e.questionId} | ${e.materia} | ${e.priority ?? ""} | ${e.studySignal ?? ""} | ${e.reason} |`),
		...report.delta.left.map((e) => `| LEFT | ${e.questionId} | ${e.materia} | ${e.priority ?? ""} | ${e.studySignal ?? ""} | ${e.reason} |`),
	];
	return `${lines.join("\n")}\n`;
}

export async function refreshReview(options: RefreshOptions, io: RefreshIO): Promise<RefreshReport> {
	const step = (name: RefreshStep) => options.onStep?.(name);
	const startedAt = io.now();
	const runId = stamp(startedAt);
	const reportDir = `${options.reportRoot}/${runId}`;

	step("validate-args");
	const serial = options.serial?.trim();
	if (!serial) throw new RefreshError("an explicit --serial is required (never uses the default adb device)");
	if (!options.ledgerPath) throw new RefreshError("ledger path is required (--ledger or INDIO_LEDGER)");
	if (!(options.limit > 0) || !(options.maxPerMateria > 0)) throw new RefreshError("limit and max-per-materia must be > 0");

	const report: RefreshReport = {
		runId,
		startedAt: startedAt.toISOString(),
		finishedAt: startedAt.toISOString(),
		serial,
		deviceModel: null,
		ledgerAsOf: null,
		ledgerSha: null,
		feedbackSnapshot: null,
		feedbackHashes: {},
		candidateCount: null,
		priorityBands: null,
		selectedCount: null,
		selectedByMateria: null,
		studySignals: null,
		enteredSincePreviousBuild: [],
		leftSincePreviousBuild: [],
		delta: { entered: [], left: [], stayed: [] },
		localStudySha: null,
		localVersion: null,
		remoteStudyShaBefore: null,
		remoteStudyShaAfter: null,
		remoteVersionBefore: null,
		remoteVersionAfter: null,
		deploymentStatus: "NOT REACHED",
		stateHashesBefore: {},
		stateHashesAfter: {},
		statePreserved: true,
		restartPerformed: false,
		backupDir: null,
		reportDir,
		staleLockReplaced: false,
		result: "FAILED",
	};

	step("lock");
	const lock = await acquireLock(options.lockPath, io);
	report.staleLockReplaced = lock.staleReplaced;

	try {
		step("validate-device");
		const device = await requireDevice(io.adb, serial, (message) => new RefreshError(message));
		report.deviceModel = device.model;

		step("sync-feedback");
		const sync = await syncFeedback({ serial, root: options.feedbackRoot }, io);
		report.feedbackSnapshot = sync.snapshotDir;
		report.feedbackHashes = Object.fromEntries(Object.entries(sync.metadata.files).map(([name, meta]) => [name, meta.sha256]));
		const readJson = async (path: string) => JSON.parse(strFromU8(await io.readFile(path)));
		const study = studyContextFromFiles({
			progress: await readJson(`${sync.latestDir}/progress.json`),
			answers: await readJson(`${sync.latestDir}/answers.json`),
			reviews: await readJson(`${sync.latestDir}/reviews.json`),
			metadata: await readJson(`${sync.latestDir}/metadata.json`),
		});

		step("load-ledger");
		let ledgerBytes: Uint8Array;
		try {
			ledgerBytes = await io.readFile(options.ledgerPath);
		} catch (error) {
			throw new RefreshError(`ledger not readable at ${options.ledgerPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
		report.ledgerSha = sha256(ledgerBytes);
		let rawLedger: unknown;
		try {
			rawLedger = JSON.parse(strFromU8(ledgerBytes));
		} catch (error) {
			throw new RefreshError(`ledger is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}

		step("priority");
		const run = (version: number) =>
			runReviewPipeline(rawLedger, {
				limit: options.limit,
				maxPerMateria: options.maxPerMateria,
				version,
				asOf: options.asOf,
				profile: options.profile,
				study,
			});
		const pipeline = run(1);
		report.ledgerAsOf = pipeline.asOf;
		report.candidateCount = pipeline.prioritized.length;
		report.priorityBands = countBy(PRIORITY_BANDS, pipeline.prioritized.map((p) => p.priority));
		report.studySignals = countBy(STUDY_SIGNAL_ORDER, pipeline.prioritized.map((p) => p.study?.signal ?? "UNSEEN"));
		report.selectedCount = pipeline.selection.selected.length;
		const byMateria: Record<string, number> = {};
		for (const item of pipeline.selection.selected) byMateria[item.event.materia] = (byMateria[item.event.materia] ?? 0) + 1;
		report.selectedByMateria = byMateria;

		step("build");
		const build = (version: number) => buildStableStudy(run(version).pkg);
		const expectedLessons = pipeline.selection.selected.length;

		step("validate-package");
		const validation = validateReviewPackage(build(1), { expectedLessons });
		if (validation.errors.length > 0) {
			throw new RefreshError(`package validation failed:\n- ${validation.errors.join("\n- ")}`);
		}

		step("compare-and-deploy");
		let deploy: DeployReport;
		try {
			deploy = await deployReview(
				{
					serial,
					dryRun: options.dryRun,
					restartKoreader: options.restartKoreader,
					backupRoot: options.backupRoot,
					localPath: options.localPath,
					tempDir: options.tempDir,
					build,
					expectedLessons,
				},
				io,
			);
		} catch (error) {
			if (error instanceof DeployError && /state changed/i.test(error.message)) report.statePreserved = false;
			throw error;
		}
		report.localStudySha = deploy.localSha;
		report.localVersion = deploy.localVersion;
		report.remoteStudyShaBefore = deploy.remoteShaBefore;
		report.remoteVersionBefore = deploy.remoteVersion;
		report.remoteStudyShaAfter = deploy.status === "DEPLOYED" ? deploy.finalSha : deploy.remoteShaBefore;
		report.remoteVersionAfter = deploy.status === "DEPLOYED" ? deploy.localVersion : deploy.remoteVersion;
		report.deploymentStatus = deploy.status === "DRY RUN" ? (deploy.wouldDeploy ? "WOULD DEPLOY" : "NO CHANGE") : deploy.status;
		report.stateHashesBefore = deploy.stateBefore;
		report.stateHashesAfter = deploy.stateAfter;
		report.statePreserved = STATE_FILES.every((name) => deploy.stateBefore[name] === deploy.stateAfter[name]);
		report.restartPerformed = deploy.restarted;
		report.backupDir = deploy.backupDir;

		step("delta");
		const previous = deploy.remoteShaBefore ? readPreviousBook(await io.readFile(`${options.tempDir}/${BACKUP_FILE}`)) : null;
		report.delta = computeDelta(previous, pipeline);
		report.enteredSincePreviousBuild = report.delta.entered.map((e) => e.questionId);
		report.leftSincePreviousBuild = report.delta.left.map((e) => e.questionId);

		report.result = options.dryRun ? "DRY_RUN" : deploy.status === "DEPLOYED" ? "DEPLOYED" : "NO_CHANGE";
	} catch (error) {
		report.result = "FAILED";
		report.error = error instanceof Error ? error.message : String(error);
		report.finishedAt = io.now().toISOString();
		await writeReport(report, options, io);
		await io.remove(options.lockPath);
		step("unlock");
		if (error instanceof SyncError || error instanceof DeployError) throw new RefreshError(error.message);
		throw error;
	}

	step("report");
	report.finishedAt = io.now().toISOString();
	await writeReport(report, options, io);
	await io.remove(options.lockPath);
	step("unlock");
	return report;
}

async function writeReport(report: RefreshReport, options: RefreshOptions, io: RefreshIO): Promise<void> {
	await io.mkdir(report.reportDir);
	await io.writeFile(`${report.reportDir}/report.json`, strToU8(JSON.stringify(report, null, "\t")));
	await io.writeFile(`${report.reportDir}/report.md`, strToU8(renderMarkdown(report)));
	await io.mkdir(options.reportRoot);
	await io.writeFile(`${options.reportRoot}/latest.json`, strToU8(JSON.stringify(report, null, "\t")));
}
