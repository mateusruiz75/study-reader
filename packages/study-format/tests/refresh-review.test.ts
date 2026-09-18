import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync } from "fflate";
import { createHash } from "node:crypto";
import { adaptLedger } from "../scripts/adapters/error-notebook-ledger.ts";
import { BACKUP_ROOT, KOREADER_PACKAGE, REMOTE_DATA_DIR, REMOTE_DIR, REMOTE_FILE, REMOTE_TMP } from "../scripts/deploy-review.ts";
import {
	LOCK_PATH,
	REPORT_ROOT,
	RefreshError,
	STALE_LOCK_MS,
	refreshReview,
	type RefreshIO,
	type RefreshOptions,
	type RefreshReport,
} from "../scripts/refresh-review.ts";
import { buildStableStudy, runReviewPipeline } from "../scripts/review-pipeline.ts";
import { deriveFeatures, prioritizeEvents } from "../scripts/review-priority.ts";
import { normalizeStudyFeedback } from "../scripts/study-feedback.ts";
import { FEEDBACK_ROOT, REMOTE_FEEDBACK_DIR } from "../scripts/sync-feedback.ts";

const SERIAL = "RX2X102891H";
const AS_OF = "2026-09-17T12:00:00.000Z";
const NOW = new Date("2026-09-18T12:00:00.000Z");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);
const LEDGER_PATH = "ledger/ledger.json";

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

const QUESTION = {
	statement: "Questão sintética de teste (não é conteúdo real).",
	alternatives: [
		{ label: "A", text: "Alternativa A" },
		{ label: "B", text: "Alternativa B" },
	],
	correctAnswer: "B",
};

let seq = 0;

function daysAgo(days: number): string {
	const d = new Date(Date.parse(AS_OF) - days * 86_400_000);
	d.setUTCHours(10, 0, 0, 0);
	return d.toISOString();
}

function error(questionId: string, materia: string, occurredAt: string) {
	seq++;
	return {
		eventId: `ev-${String(seq).padStart(3, "0")}`,
		eventType: "knowledge.error_recorded",
		questionId,
		materia,
		assunto: `Assunto ${questionId}`,
		urlCanonica: null,
		respostaUsuario: "A",
		occurredAt,
		date: occurredAt.slice(0, 10),
		content: QUESTION,
	};
}

const TRIB = "Direito Tributário";
const CONT = "Contabilidade Geral";

function ledger() {
	seq = 0;
	return [
		error("q-1", TRIB, daysAgo(2)),
		error("q-2", TRIB, daysAgo(3)),
		error("q-3", CONT, daysAgo(4)),
		error("q-4", CONT, daysAgo(5)),
		error("q-5", TRIB, daysAgo(6)),
	];
}

function previousLedger() {
	seq = 100;
	return [error("q-1", TRIB, daysAgo(2)), error("q-2", TRIB, daysAgo(3)), error("q-old", CONT, daysAgo(4))];
}

const REVIEWS = { "q-5-card": { due: NOW_EPOCH + 600, interval: 0, ef: 2.5, reps: 0, lapses: 1 } };

function studyContext() {
	return {
		store: normalizeStudyFeedback({
			progress: { currentLesson: null, completedLessons: {} },
			answers: {},
			reviews: REVIEWS,
			collectedAt: NOW_EPOCH,
		}),
		now: NOW_EPOCH,
	};
}

function studyBytes(raw: ReturnType<typeof ledger>, version: number, limit = 3): Uint8Array {
	return buildStableStudy(
		runReviewPipeline(raw, { limit, maxPerMateria: 6, version, asOf: AS_OF, study: studyContext() }).pkg,
	);
}

type Device = { files: Map<string, Uint8Array>; dirs: Set<string>; state: string };

function device(options: { remoteStudy?: Uint8Array; state?: string } = {}): Device {
	const files = new Map<string, Uint8Array>();
	if (options.remoteStudy) files.set(REMOTE_FILE, options.remoteStudy);
	files.set(`${REMOTE_FEEDBACK_DIR}/progress.json`, strToU8(JSON.stringify({ currentLesson: null, completedLessons: {} })));
	files.set(`${REMOTE_FEEDBACK_DIR}/answers.json`, strToU8(JSON.stringify({})));
	files.set(`${REMOTE_FEEDBACK_DIR}/reviews.json`, strToU8(JSON.stringify(REVIEWS)));
	return { files, dirs: new Set([REMOTE_DIR, REMOTE_DATA_DIR, REMOTE_FEEDBACK_DIR]), state: options.state ?? "device" };
}

function world(dev: Device | null, options: { mutateFeedbackOnPull?: boolean; ledger?: unknown } = {}) {
	const calls: string[][] = [];
	const local = new Map<string, Uint8Array>();
	const removed: string[] = [];
	let feedbackPulls = 0;
	if (options.ledger !== null) local.set(LEDGER_PATH, strToU8(JSON.stringify(options.ledger ?? ledger())));

	const io: RefreshIO = {
		adb: async (args) => {
			calls.push(args);
			const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
			const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });
			if (args[0] === "devices") {
				return ok(`List of devices attached\n${dev ? `${SERIAL}\t${dev.state} product:gts9fexx model:SM_X516B device:gts9fe` : ""}\n`);
			}
			if (args[0] !== "-s" || args[1] !== SERIAL || !dev || dev.state !== "device") return fail("device not found");
			const rest = args.slice(2);
			if (rest[0] === "shell") {
				const [bin, ...argv] = rest.slice(1);
				if (bin === "ls" && argv[0] === "-d") return dev.dirs.has(argv[1]) ? ok(`${argv[1]}\n`) : fail("No such file or directory");
				if (bin === "sha256sum") {
					const lines = argv.map((p) => (dev.files.has(p) ? `${sha256(dev.files.get(p)!)}  ${p}` : null));
					if (lines.some((l) => l === null)) return fail("No such file or directory");
					return ok(`${lines.join("\n")}\n`);
				}
				if (bin === "mv") {
					const data = dev.files.get(argv[0]);
					if (!data) return fail("mv: missing");
					dev.files.delete(argv[0]);
					dev.files.set(argv[1], data);
					return ok();
				}
				if (bin === "rm") {
					dev.files.delete(argv[argv.length - 1]);
					return ok();
				}
				if (bin === "touch") return dev.files.has(argv[0]) ? ok() : fail("touch: missing");
				if (bin === "am" || bin === "monkey") return ok();
				return fail(`unknown shell ${bin}`);
			}
			if (rest[0] === "pull") {
				const data = dev.files.get(rest[1]);
				if (!data) return fail("remote object does not exist");
				local.set(rest[2], data);
				if (options.mutateFeedbackOnPull && rest[1].startsWith(REMOTE_FEEDBACK_DIR)) {
					feedbackPulls++;
					dev.files.set(rest[1], strToU8(`${strFromU8(data)} `));
				}
				return ok("1 file pulled");
			}
			if (rest[0] === "push") {
				const data = local.get(rest[1]);
				if (!data) return fail("local file missing");
				dev.files.set(rest[2], data);
				return ok("1 file pushed");
			}
			return fail(`unknown adb ${rest.join(" ")}`);
		},
		readFile: async (path) => {
			const data = local.get(path);
			if (!data) throw new Error(`ENOENT: ${path}`);
			return data;
		},
		writeFile: async (path, data) => {
			local.set(path, data);
		},
		mkdir: async () => {},
		exists: async (path) => local.has(path),
		remove: async (path) => {
			local.delete(path);
			removed.push(path);
		},
		now: () => NOW,
	};
	return { io, calls, local, removed, dev, feedbackPulls: () => feedbackPulls };
}

function options(overrides: Partial<RefreshOptions> = {}): RefreshOptions {
	return {
		serial: SERIAL,
		ledgerPath: LEDGER_PATH,
		dryRun: false,
		restartKoreader: false,
		limit: 3,
		maxPerMateria: 6,
		asOf: AS_OF,
		localPath: "examples/INDIO-REVISAO.study",
		feedbackRoot: FEEDBACK_ROOT,
		backupRoot: BACKUP_ROOT,
		reportRoot: REPORT_ROOT,
		lockPath: LOCK_PATH,
		tempDir: "tmp/refresh",
		...overrides,
	};
}

function verbs(calls: string[][]): string[] {
	return calls.map((c) => (c[0] === "devices" ? "devices" : c[2] === "shell" ? `shell:${c[3]}` : c[2]));
}

describe("phase 3: daily closed loop", () => {
	it("requires an explicit serial", async () => {
		const { io } = world(device());

		await expect(refreshReview(options({ serial: undefined }), io)).rejects.toThrow(RefreshError);
		await expect(refreshReview(options({ serial: "" }), io)).rejects.toThrow(/serial/);
	});

	it("fails closed when the ledger is missing without touching the device", async () => {
		const { io, calls } = world(device(), { ledger: null });

		await expect(refreshReview(options(), io)).rejects.toThrow(/ledger/);
		expect(calls.some((c) => c.includes("push"))).toBe(false);
	});

	it("fails when the device is not connected", async () => {
		const { io } = world(null);

		await expect(refreshReview(options(), io)).rejects.toThrow(/not connected/);
	});

	it("aborts when the feedback snapshot keeps changing", async () => {
		const { io, calls } = world(device(), { mutateFeedbackOnPull: true });

		await expect(refreshReview(options(), io)).rejects.toThrow(/STATE CHANGED DURING SNAPSHOT/);
		expect(calls.some((c) => c.includes("push"))).toBe(false);
	});

	it("runs the steps in the documented order", async () => {
		const dev = device({ remoteStudy: studyBytes(previousLedger(), 1) });
		const { io, calls } = world(dev);
		const steps: string[] = [];

		const report = await refreshReview(options({ onStep: (s) => steps.push(s) }), io);

		expect(report.result).toBe("DEPLOYED");
		expect(steps).toEqual([
			"validate-args",
			"lock",
			"validate-device",
			"sync-feedback",
			"load-ledger",
			"priority",
			"build",
			"validate-package",
			"compare-and-deploy",
			"delta",
			"report",
			"unlock",
		]);
		const v = verbs(calls);
		const first = (name: string) => v.indexOf(name);
		expect(first("devices")).toBeLessThan(first("pull"));
		expect(v.lastIndexOf("push")).toBeGreaterThan(v.indexOf("pull"));
		expect(v.indexOf("shell:mv")).toBeGreaterThan(v.indexOf("push"));
		expect(v.indexOf("shell:touch")).toBeGreaterThan(v.indexOf("shell:mv"));
	});

	it("reports NO_CHANGE without backup, push, rename or restart", async () => {
		const dev = device({ remoteStudy: studyBytes(ledger(), 7) });
		const before = new Map(dev.files);
		const { io, calls, local } = world(dev);

		const report = await refreshReview(options({ restartKoreader: true }), io);

		expect(report.result).toBe("NO_CHANGE");
		expect(report.deploymentStatus).toBe("NO CHANGE");
		expect(report.restartPerformed).toBe(false);
		expect(report.remoteVersionBefore).toBe(7);
		expect(report.remoteVersionAfter).toBe(7);
		expect(report.remoteStudyShaAfter).toBe(report.remoteStudyShaBefore);
		expect(calls.some((c) => c.includes("push") || c.includes("mv") || c.includes("am") || c.includes("monkey"))).toBe(false);
		expect(dev.files).toEqual(before);
		expect([...local.keys()].some((k) => k.startsWith(BACKUP_ROOT))).toBe(false);
		expect(local.has(`${report.reportDir}/report.json`)).toBe(true);
	});

	it("deploys through the 2D mechanism when the book changed", async () => {
		const previous = studyBytes(previousLedger(), 2);
		const dev = device({ remoteStudy: previous });
		const { io, local } = world(dev);

		const report = await refreshReview(options(), io);

		expect(report.result).toBe("DEPLOYED");
		expect(report.remoteVersionBefore).toBe(2);
		expect(report.remoteVersionAfter).toBe(3);
		expect(report.remoteStudyShaAfter).toBe(report.localStudySha);
		expect(sha256(dev.files.get(REMOTE_FILE)!)).toBe(report.localStudySha);
		expect(dev.files.has(REMOTE_TMP)).toBe(false);
		expect(report.backupDir).toBe(`${BACKUP_ROOT}/20260918-120000`);
		expect(local.get(`${report.backupDir}/INDIO-REVISAO.study`)).toEqual(previous);
		expect(report.restartPerformed).toBe(false);
	});

	it("keeps dry-run free of mutations and reports WOULD DEPLOY", async () => {
		const dev = device({ remoteStudy: studyBytes(previousLedger(), 2) });
		const before = new Map(dev.files);
		const { io, calls, local } = world(dev);

		const report = await refreshReview(options({ dryRun: true, restartKoreader: true }), io);

		expect(report.result).toBe("DRY_RUN");
		expect(report.deploymentStatus).toBe("WOULD DEPLOY");
		expect(report.restartPerformed).toBe(false);
		expect(dev.files).toEqual(before);
		expect(calls.some((c) => c.includes("push") || c.includes("mv") || c.includes("rm") || c.includes("am"))).toBe(false);
		expect([...local.keys()].some((k) => k.startsWith(BACKUP_ROOT))).toBe(false);
		expect(local.has(`${report.reportDir}/report.json`)).toBe(true);
	});

	it("reports NO CHANGE inside a dry-run when nothing would change", async () => {
		const { io } = world(device({ remoteStudy: studyBytes(ledger(), 7) }));

		const report = await refreshReview(options({ dryRun: true }), io);

		expect(report.result).toBe("DRY_RUN");
		expect(report.deploymentStatus).toBe("NO CHANGE");
	});

	it("restarts KOReader only after a real successful deploy", async () => {
		const { io, calls } = world(device({ remoteStudy: studyBytes(previousLedger(), 2) }));

		const report = await refreshReview(options({ restartKoreader: true }), io);

		expect(report.result).toBe("DEPLOYED");
		expect(report.restartPerformed).toBe(true);
		const flat = calls.map((c) => c.join(" "));
		expect(flat.some((c) => c.includes(`am force-stop ${KOREADER_PACKAGE}`))).toBe(true);
		expect(flat.findIndex((c) => c.includes("force-stop"))).toBeGreaterThan(flat.findIndex((c) => c.includes(" mv ")));
	});

	it("records identical student state hashes before and after a deploy", async () => {
		const dev = device({ remoteStudy: studyBytes(previousLedger(), 2) });
		const { io } = world(dev);

		const report = await refreshReview(options(), io);

		expect(Object.keys(report.stateHashesBefore)).toEqual(["progress.json", "answers.json", "reviews.json"]);
		expect(report.stateHashesAfter).toEqual(report.stateHashesBefore);
		expect(report.stateHashesBefore["progress.json"]).toBe(sha256(dev.files.get(`${REMOTE_FEEDBACK_DIR}/progress.json`)!));
		expect(report.statePreserved).toBe(true);
	});

	it("fails and reports STATE CHANGED when the student state moves during the deploy", async () => {
		const dev = device({ remoteStudy: studyBytes(previousLedger(), 2) });
		const base = world(dev);
		const io: RefreshIO = {
			...base.io,
			adb: async (args) => {
				const result = await base.io.adb(args);
				if (args.includes("push")) dev.files.set(`${REMOTE_FEEDBACK_DIR}/answers.json`, strToU8("{\"changed\":1}"));
				return result;
			},
		};

		await expect(refreshReview(options(), io)).rejects.toThrow(/state changed/i);
		const reportPath = [...base.local.keys()].find((k) => k.startsWith(REPORT_ROOT) && k.endsWith("report.json"))!;
		const report = JSON.parse(strFromU8(base.local.get(reportPath)!)) as RefreshReport;
		expect(report.result).toBe("FAILED");
		expect(report.error).toMatch(/state changed/i);
		expect(report.statePreserved).toBe(false);
	});

	it("refuses to run while another refresh holds the lock", async () => {
		const { io, calls, local } = world(device());
		local.set(LOCK_PATH, strToU8(JSON.stringify({ pid: 1, startedAt: NOW.toISOString() })));

		await expect(refreshReview(options(), io)).rejects.toThrow(/REFRESH ALREADY RUNNING/);
		expect(calls.length).toBe(0);
	});

	it("takes over a stale lock", async () => {
		const { io, local } = world(device({ remoteStudy: studyBytes(ledger(), 7) }));
		local.set(
			LOCK_PATH,
			strToU8(JSON.stringify({ pid: 1, startedAt: new Date(NOW.getTime() - STALE_LOCK_MS - 1).toISOString() })),
		);

		const report = await refreshReview(options(), io);

		expect(report.result).toBe("NO_CHANGE");
		expect(report.staleLockReplaced).toBe(true);
	});

	it("removes the lock after success and after failure", async () => {
		const okWorld = world(device({ remoteStudy: studyBytes(ledger(), 7) }));
		await refreshReview(options(), okWorld.io);
		expect(okWorld.local.has(LOCK_PATH)).toBe(false);
		expect(okWorld.removed).toContain(LOCK_PATH);

		const badWorld = world(device(), { ledger: null });
		await expect(refreshReview(options(), badWorld.io)).rejects.toThrow();
		expect(badWorld.local.has(LOCK_PATH)).toBe(false);
	});

	it("computes ENTERED / LEFT / STAYED against the previous remote book", async () => {
		const { io } = world(device({ remoteStudy: studyBytes(previousLedger(), 2) }));

		const report = await refreshReview(options(), io);

		expect(report.delta.stayed).toEqual(["q-1", "q-2"]);
		expect(report.delta.entered.map((e) => e.questionId)).toEqual(["q-5"]);
		expect(report.delta.left.map((e) => e.questionId)).toEqual(["q-old"]);
		expect(report.delta.entered[0]).toMatchObject({ materia: TRIB, priority: "MEDIUM", studySignal: "LAPSING" });
		expect(report.delta.left[0]).toMatchObject({ materia: CONT, priority: "MEDIUM" });
		expect(report.delta.left[0].reason).toMatch(/no longer a candidate/);
	});

	it("keeps the report deterministic in its content fields", async () => {
		const a = await refreshReview(options(), world(device({ remoteStudy: studyBytes(previousLedger(), 2) })).io);
		const b = await refreshReview(options(), world(device({ remoteStudy: studyBytes(previousLedger(), 2) })).io);
		const content = (r: RefreshReport) => {
			const { runId, startedAt, finishedAt, feedbackSnapshot, reportDir, backupDir, ...rest } = r;
			return rest;
		};

		expect(content(b)).toEqual(content(a));
		expect(a.ledgerAsOf).toBe(AS_OF);
		expect(a.candidateCount).toBe(5);
		expect(a.selectedCount).toBe(3);
		expect(a.priorityBands).toEqual({ CRITICAL: 0, HIGH: 0, MEDIUM: 5, LOW: 0 });
		expect(a.studySignals).toEqual({ LAPSING: 1, DUE: 0, UNSEEN: 4, LEARNING: 0, STABLE: 0 });
		expect(a.selectedByMateria).toEqual({ [TRIB]: 3 });
		expect(a.feedbackHashes["reviews.json"]).toMatch(/^[0-9a-f]{64}$/);
		expect(a.ledgerSha).toMatch(/^[0-9a-f]{64}$/);
		expect(a.deviceModel).toBe("SM_X516B");
	});

	it("keeps stable ids and bands and does not let the orchestrator alter ledger features", async () => {
		const dev = device({ remoteStudy: studyBytes(previousLedger(), 2) });
		const { io } = world(dev);

		await refreshReview(options(), io);

		const deployed = unzipSync(dev.files.get(REMOTE_FILE)!);
		const manifest = JSON.parse(strFromU8(deployed["manifest.json"]));
		const lessonIds = manifest.modules.flatMap((m: { lessons: { id: string }[] }) => m.lessons.map((l) => l.id)).sort();
		expect(lessonIds).toEqual(["error-q-1", "error-q-2", "error-q-5"]);
		expect(Object.keys(JSON.parse(strFromU8(deployed["questions/questions.json"]))).sort()).toEqual([
			"q-1-recovery",
			"q-2-recovery",
			"q-5-recovery",
		]);

		const adapted = adaptLedger(ledger());
		const plain = prioritizeEvents(adapted.events, deriveFeatures(adapted.attempts, AS_OF));
		for (const [key, meta] of Object.entries(manifest.extensions.indio.priorities) as [string, Record<string, unknown>][]) {
			const twin = plain.find((p) => p.event.questionId === key)!;
			expect(meta.priority).toBe(twin.priority);
			expect(meta.errorCount).toBe(twin.features.errorCount);
			expect(meta.recurrence).toBe(twin.features.recurrence);
		}
	});

	it("uses -s <serial> on every adb command after the device listing", async () => {
		const { io, calls } = world(device({ remoteStudy: studyBytes(previousLedger(), 2) }));

		await refreshReview(options({ restartKoreader: true }), io);

		for (const call of calls.filter((c) => c[0] !== "devices")) expect(call.slice(0, 2)).toEqual(["-s", SERIAL]);
	});
});
