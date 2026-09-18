import { describe, expect, it } from "vitest";
import { strToU8 } from "fflate";
import { createHash } from "node:crypto";
import { adaptLedger } from "../scripts/adapters/error-notebook-ledger.ts";
import { buildReviewCourse } from "../scripts/review-course.ts";
import {
	deriveFeatures,
	prioritizeEvents,
	selectBalanced,
} from "../scripts/review-priority.ts";
import {
	STUDY_SIGNAL_ORDER,
	classifyStudySignal,
	normalizeStudyFeedback,
	questionKeyFromCardId,
	questionKeyFromLessonId,
	questionKeyFromQuizId,
	studyReasons,
	type StudyFeedback,
	type StudyFeedbackStore,
} from "../scripts/study-feedback.ts";
import {
	FEEDBACK_FILES,
	FEEDBACK_ROOT,
	REMOTE_FEEDBACK_DIR,
	SyncError,
	syncFeedback,
	type SyncIO,
} from "../scripts/sync-feedback.ts";

const SERIAL = "RX2X102891H";
const AS_OF = "2026-09-17T12:00:00.000Z";
const NOW = Math.floor(Date.parse("2026-09-18T12:00:00.000Z") / 1000);

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("phase 2E: stable id mapping", () => {
	it("parses lesson ids", () => {
		expect(questionKeyFromLessonId("error-2235984")).toBe("2235984");
		expect(questionKeyFromLessonId("error-q-relapse")).toBe("q-relapse");
	});

	it("parses quiz ids", () => {
		expect(questionKeyFromQuizId("2235984-recovery")).toBe("2235984");
		expect(questionKeyFromQuizId("q-relapse-recovery")).toBe("q-relapse");
	});

	it("parses card ids", () => {
		expect(questionKeyFromCardId("2235984-card")).toBe("2235984");
		expect(questionKeyFromCardId("q-relapse-card")).toBe("q-relapse");
	});

	it("never assigns unknown ids to a question", () => {
		expect(questionKeyFromLessonId("lesson-1")).toBeNull();
		expect(questionKeyFromLessonId("error-")).toBeNull();
		expect(questionKeyFromQuizId("adm-podc-q1")).toBeNull();
		expect(questionKeyFromQuizId("-recovery")).toBeNull();
		expect(questionKeyFromCardId("adm-podc-card1")).toBeNull();
		expect(questionKeyFromCardId("card")).toBeNull();
	});
});

const SNAPSHOT = {
	progress: {
		currentLesson: "error-776579",
		completedLessons: {
			"error-1509532": "2026-09-18T07:04:36Z",
			"error-2235984": "2026-09-18T07:26:03Z",
			"error-legacy": true,
			"lesson-unknown": "2026-09-18T07:00:00Z",
		},
	},
	answers: {
		"2235984-recovery": { answeredAt: "2026-09-18T07:25:33Z", correct: true, selected: ["C"] },
		"1509532-recovery": { answeredAt: "2026-09-18T07:04:10Z", correct: false, selected: ["C"] },
		"adm-podc-q1": { answeredAt: "2026-09-18T05:54:40Z", correct: false, selected: ["a"] },
	},
	reviews: {
		"2967204-card": { due: NOW + 600, interval: 0, ef: 2.5, reps: 0, lapses: 1 },
		"2235984-card": { due: NOW - 3600, interval: 1, ef: 2.5, reps: 1, lapses: 0 },
		"stable-card": { due: NOW + 20 * 86400, interval: 16, ef: 2.5, reps: 3, lapses: 0 },
		"learning-card": { due: NOW + 5 * 86400, interval: 6, ef: 2.5, reps: 2, lapses: 0 },
		"adm-podc-card1": { due: NOW, interval: 0, ef: 2.5, reps: 0, lapses: 1 },
	},
	collectedAt: NOW,
};

describe("phase 2E: feedback normalization", () => {
	const store = normalizeStudyFeedback(SNAPSHOT);

	it("merges lesson, quiz and card signals per question using only real fields", () => {
		expect(store.byQuestion.get("2235984")).toEqual({
			questionKey: "2235984",
			lessonCompleted: true,
			lessonCompletedAt: "2026-09-18T07:26:03Z",
			quizAnswered: true,
			quizCorrect: true,
			quizSelected: ["C"],
			quizAnsweredAt: "2026-09-18T07:25:33Z",
			reviewReps: 1,
			reviewLapses: 0,
			reviewInterval: 1,
			reviewEase: 2.5,
			reviewDueAt: new Date((NOW - 3600) * 1000).toISOString(),
		} satisfies StudyFeedback);
	});

	it("keeps absent signals explicit", () => {
		expect(store.byQuestion.get("stable")).toEqual({
			questionKey: "stable",
			lessonCompleted: false,
			lessonCompletedAt: null,
			quizAnswered: false,
			quizCorrect: null,
			quizSelected: null,
			quizAnsweredAt: null,
			reviewReps: 3,
			reviewLapses: 0,
			reviewInterval: 16,
			reviewEase: 2.5,
			reviewDueAt: new Date((NOW + 20 * 86400) * 1000).toISOString(),
		});
	});

	it("keeps a legacy boolean completion without inventing a timestamp", () => {
		const legacy = store.byQuestion.get("legacy")!;

		expect(legacy.lessonCompleted).toBe(true);
		expect(legacy.lessonCompletedAt).toBeNull();
	});

	it("reports unknown ids instead of assigning them", () => {
		expect(store.unknownIds).toEqual({
			lessons: ["lesson-unknown"],
			quizzes: ["adm-podc-q1"],
			cards: ["adm-podc-card1"],
		});
		expect(store.byQuestion.has("adm-podc")).toBe(false);
		expect(store.byQuestion.has("lesson-unknown")).toBe(false);
	});

	it("keeps feedback for questions outside the current course", () => {
		expect(store.byQuestion.has("2967204")).toBe(true);
	});
});

describe("phase 2E: study signal", () => {
	const store = normalizeStudyFeedback(SNAPSHOT);
	const signal = (key: string) => classifyStudySignal(store.byQuestion.get(key), NOW);

	it("classifies a lapsed card as LAPSING", () => {
		expect(signal("2967204")).toBe("LAPSING");
	});

	it("classifies a wrong latest quiz answer as LAPSING", () => {
		expect(signal("1509532")).toBe("LAPSING");
	});

	it("classifies an overdue card as DUE", () => {
		expect(signal("2235984")).toBe("DUE");
	});

	it("classifies a short-interval card as LEARNING", () => {
		expect(signal("learning")).toBe("LEARNING");
	});

	it("classifies three successful reviews with a long interval as STABLE", () => {
		expect(signal("stable")).toBe("STABLE");
	});

	it("classifies missing feedback as UNSEEN", () => {
		expect(signal("never-seen")).toBe("UNSEEN");
		expect(classifyStudySignal(undefined, NOW)).toBe("UNSEEN");
	});

	it("classifies a completed lesson without quiz or card as LEARNING", () => {
		expect(signal("legacy")).toBe("LEARNING");
	});

	it("orders LAPSING → DUE → UNSEEN → LEARNING → STABLE", () => {
		expect(STUDY_SIGNAL_ORDER).toEqual(["LAPSING", "DUE", "UNSEEN", "LEARNING", "STABLE"]);
	});

	it("explains study signals with StudyReader-prefixed reasons", () => {
		expect(studyReasons(store.byQuestion.get("2967204")!, "LAPSING", NOW)).toEqual([
			"StudyReader: 1 lapse no card",
		]);
		expect(studyReasons(store.byQuestion.get("2235984")!, "DUE", NOW)).toEqual([
			"StudyReader: card due",
			"StudyReader: quiz correto (C)",
			"StudyReader: 1 revisão concluída",
			"StudyReader: aula concluída",
		]);
		expect(studyReasons(store.byQuestion.get("1509532")!, "LAPSING", NOW)).toEqual([
			"StudyReader: quiz errado (C)",
			"StudyReader: aula concluída",
		]);
	});
});

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

const MAT = "Direito Tributário";

function ledger() {
	seq = 0;
	return [
		error("q-stable", MAT, daysAgo(5)),
		error("q-lapsing", MAT, daysAgo(5)),
		error("q-unseen", MAT, daysAgo(5)),
		error("q-due", MAT, daysAgo(5)),
		error("q-learning", MAT, daysAgo(5)),
		error("q-low", MAT, daysAgo(30)),
	];
}

function feedbackStore(): StudyFeedbackStore {
	return normalizeStudyFeedback({
		progress: { currentLesson: null, completedLessons: {} },
		answers: {},
		reviews: {
			"q-stable-card": { due: NOW + 20 * 86400, interval: 16, ef: 2.5, reps: 3, lapses: 0 },
			"q-lapsing-card": { due: NOW + 600, interval: 0, ef: 2.5, reps: 0, lapses: 1 },
			"q-due-card": { due: NOW - 60, interval: 1, ef: 2.5, reps: 1, lapses: 0 },
			"q-learning-card": { due: NOW + 5 * 86400, interval: 6, ef: 2.5, reps: 2, lapses: 0 },
			"q-low-card": { due: NOW + 600, interval: 0, ef: 2.5, reps: 0, lapses: 3 },
			"q-outside-card": { due: NOW - 60, interval: 1, ef: 2.5, reps: 1, lapses: 0 },
		},
		collectedAt: NOW,
	});
}

function prioritized(withFeedback: boolean, raw = ledger()) {
	const adapted = adaptLedger(raw);
	const features = deriveFeatures(adapted.attempts, AS_OF);
	return prioritizeEvents(
		adapted.events,
		features,
		{},
		withFeedback ? { store: feedbackStore(), now: NOW } : undefined,
	);
}

describe("phase 2E: feedback inside the priority engine", () => {
	it("never changes priority bands", () => {
		const without = prioritized(false).map((p) => [p.event.questionId, p.priority, p.rule]);
		const withFb = prioritized(true).map((p) => [p.event.questionId, p.priority, p.rule]);

		expect([...withFb].sort()).toEqual([...without].sort());
		expect(prioritized(true).find((p) => p.event.questionId === "q-low")!.priority).toBe("MEDIUM");
	});

	it("keeps the 2C.1 order when no feedback is given", () => {
		expect(prioritized(false).map((p) => p.event.questionId)).toEqual([
			"q-due",
			"q-lapsing",
			"q-learning",
			"q-stable",
			"q-unseen",
			"q-low",
		]);
		expect(prioritized(false).every((p) => p.study === undefined)).toBe(true);
	});

	it("orders LAPSING before STABLE and DUE before UNSEEN inside the same band", () => {
		expect(prioritized(true).map((p) => [p.event.questionId, p.study!.signal])).toEqual([
			["q-lapsing", "LAPSING"],
			["q-low", "LAPSING"],
			["q-due", "DUE"],
			["q-unseen", "UNSEEN"],
			["q-learning", "LEARNING"],
			["q-stable", "STABLE"],
		]);
	});

	it("does not touch the ledger features", () => {
		const without = prioritized(false);
		const withFb = prioritized(true);
		for (const item of withFb) {
			const twin = without.find((p) => p.event.questionId === item.event.questionId)!;
			expect(item.features).toEqual(twin.features);
			expect(item.features.errorCount).toBe(twin.features.errorCount);
			expect(item.features.recurrence).toBe(twin.features.recurrence);
			expect(item.features.errorsAfterCorrect).toBe(twin.features.errorsAfterCorrect);
			expect(item.features.correctAfterLastError).toBe(twin.features.correctAfterLastError);
		}
	});

	it("appends StudyReader reasons after the ledger reasons without mixing them", () => {
		const lapsing = prioritized(true).find((p) => p.event.questionId === "q-lapsing")!;
		const ledgerOnly = prioritized(false).find((p) => p.event.questionId === "q-lapsing")!;

		expect(lapsing.reasons.slice(0, ledgerOnly.reasons.length)).toEqual(ledgerOnly.reasons);
		expect(lapsing.reasons.slice(ledgerOnly.reasons.length)).toEqual(["StudyReader: 1 lapse no card"]);
		expect(lapsing.reasons.some((r) => /erro registrado/.test(r) && /StudyReader/.test(r))).toBe(false);
	});

	it("keeps feedback for questions outside the selection available", () => {
		const store = feedbackStore();

		expect(store.byQuestion.get("q-outside")).toBeDefined();
		expect(classifyStudySignal(store.byQuestion.get("q-outside"), NOW)).toBe("DUE");
		expect(prioritized(true).some((p) => p.event.questionId === "q-outside")).toBe(false);
	});

	it("selects deterministically with feedback", () => {
		const a = selectBalanced(prioritized(true), { limit: 3, maxPerMateria: 6 });
		const b = selectBalanced(prioritized(true, [...ledger()].reverse()), { limit: 3, maxPerMateria: 6 });

		expect(a.selected.map((p) => p.event.questionId)).toEqual(["q-lapsing", "q-low", "q-due"]);
		expect(b.selected.map((p) => p.event.questionId)).toEqual(a.selected.map((p) => p.event.questionId));
	});

	it("keeps lesson, quiz and card ids stable with feedback", () => {
		const course = buildReviewCourse(selectBalanced(prioritized(true), { limit: 6, maxPerMateria: 6 }).selected);
		const plain = buildReviewCourse(selectBalanced(prioritized(false), { limit: 6, maxPerMateria: 6 }).selected);
		const ids = (c: typeof course) => ({
			lessons: c.manifest.modules.flatMap((m) => m.lessons.map((l) => l.id)).sort(),
			questions: Object.keys(c.questions!).sort(),
			cards: c.flashcards!.map((f) => f.id).sort(),
		});

		expect(ids(course)).toEqual(ids(plain));
		const indio = course.manifest.extensions!.indio as Record<string, Record<string, Record<string, unknown>>>;
		expect(indio.priorities["q-lapsing"].study).toMatchObject({ signal: "LAPSING", reviewLapses: 1 });
		expect(indio.priorities["q-lapsing"].priority).toBe("MEDIUM");
	});
});

type RemoteFiles = Record<string, Uint8Array>;

function fakeSync(remote: RemoteFiles, options: { mutateOnPull?: number } = {}) {
	const calls: string[][] = [];
	const local = new Map<string, Uint8Array>();
	let pulls = 0;
	const io: SyncIO = {
		adb: async (args) => {
			calls.push(args);
			const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
			const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });
			if (args[0] === "devices") return ok(`List of devices attached\n${SERIAL}\tdevice model:SM_X516B\n`);
			if (args[0] !== "-s" || args[1] !== SERIAL) return fail("wrong serial");
			const rest = args.slice(2);
			if (rest[0] === "shell" && rest[1] === "sha256sum") {
				const lines = rest.slice(2).map((p) => (remote[p] ? `${sha256(remote[p])}  ${p}` : null));
				if (lines.some((l) => l === null)) return fail("No such file or directory");
				return ok(`${lines.join("\n")}\n`);
			}
			if (rest[0] === "shell" && rest[1] === "ls" && rest[2] === "-d") {
				const present = Object.keys(remote).some((k) => k.startsWith(`${rest[3]}/`));
				return present ? ok(`${rest[3]}\n`) : fail("missing");
			}
			if (rest[0] === "pull") {
				const data = remote[rest[1]];
				if (!data) return fail("remote object does not exist");
				local.set(rest[2], data);
				pulls++;
				if (options.mutateOnPull !== undefined && pulls <= options.mutateOnPull) {
					remote[rest[1]] = strToU8(`${new TextDecoder().decode(data)} `);
				}
				return ok("1 file pulled");
			}
			return fail(`unexpected adb command: ${rest.join(" ")}`);
		},
		readFile: async (path) => {
			const data = local.get(path);
			if (!data) throw new Error(`missing ${path}`);
			return data;
		},
		writeFile: async (path, data) => {
			local.set(path, data);
		},
		mkdir: async () => {},
		now: () => new Date(NOW * 1000),
	};
	return { io, calls, local };
}

function remoteState(): RemoteFiles {
	return {
		[`${REMOTE_FEEDBACK_DIR}/progress.json`]: strToU8(JSON.stringify(SNAPSHOT.progress)),
		[`${REMOTE_FEEDBACK_DIR}/answers.json`]: strToU8(JSON.stringify(SNAPSHOT.answers)),
		[`${REMOTE_FEEDBACK_DIR}/reviews.json`]: strToU8(JSON.stringify(SNAPSHOT.reviews)),
	};
}

describe("phase 2E: read-only feedback sync", () => {
	it("requires an explicit serial", async () => {
		const { io } = fakeSync(remoteState());

		await expect(syncFeedback({ serial: undefined, root: FEEDBACK_ROOT }, io)).rejects.toThrow(SyncError);
	});

	it("uses -s <serial> on every adb command after the device listing", async () => {
		const { io, calls } = fakeSync(remoteState());

		await syncFeedback({ serial: SERIAL, root: FEEDBACK_ROOT }, io);

		for (const call of calls.filter((c) => c[0] !== "devices")) expect(call.slice(0, 2)).toEqual(["-s", SERIAL]);
	});

	it("never writes to the device", async () => {
		const { io, calls } = fakeSync(remoteState());

		await syncFeedback({ serial: SERIAL, root: FEEDBACK_ROOT }, io);

		const verbs = calls.map((c) => (c[0] === "-s" ? c[2] : c[0]));
		expect(new Set(verbs)).toEqual(new Set(["devices", "shell", "pull"]));
		const shellBins = calls.filter((c) => c[2] === "shell").map((c) => c[3]);
		expect(new Set(shellBins)).toEqual(new Set(["ls", "sha256sum"]));
	});

	it("writes the original files, hashes and metadata into snapshots/<ts> and latest/", async () => {
		const remote = remoteState();
		const { io, local } = fakeSync(remote);

		const result = await syncFeedback({ serial: SERIAL, root: FEEDBACK_ROOT }, io);

		expect(result.snapshotDir).toBe(`${FEEDBACK_ROOT}/snapshots/20260918-120000`);
		expect(result.latestDir).toBe(`${FEEDBACK_ROOT}/latest`);
		for (const name of FEEDBACK_FILES) {
			expect(local.get(`${result.snapshotDir}/${name}`)).toEqual(remote[`${REMOTE_FEEDBACK_DIR}/${name}`]);
			expect(local.get(`${result.latestDir}/${name}`)).toEqual(remote[`${REMOTE_FEEDBACK_DIR}/${name}`]);
		}
		const meta = JSON.parse(new TextDecoder().decode(local.get(`${result.latestDir}/metadata.json`)!));
		expect(meta).toMatchObject({
			serial: SERIAL,
			courseId: "indio-revisao",
			remoteDir: REMOTE_FEEDBACK_DIR,
			collectedAt: new Date(NOW * 1000).toISOString(),
			collectedAtEpoch: NOW,
		});
		expect(meta.files["reviews.json"]).toEqual({
			sha256: sha256(remote[`${REMOTE_FEEDBACK_DIR}/reviews.json`]),
			size: remote[`${REMOTE_FEEDBACK_DIR}/reviews.json`].length,
		});
	});

	it("retries once when a file changes during the snapshot", async () => {
		const { io, calls } = fakeSync(remoteState(), { mutateOnPull: 1 });

		const result = await syncFeedback({ serial: SERIAL, root: FEEDBACK_ROOT }, io);

		expect(result.attempts).toBe(2);
		expect(calls.filter((c) => c.includes("pull")).length).toBe(6);
	});

	it("aborts when the state keeps changing", async () => {
		const { io } = fakeSync(remoteState(), { mutateOnPull: 99 });

		await expect(syncFeedback({ serial: SERIAL, root: FEEDBACK_ROOT }, io)).rejects.toThrow(
			/STATE CHANGED DURING SNAPSHOT/,
		);
	});

	it("aborts when the remote data directory is missing", async () => {
		const { io } = fakeSync({});

		await expect(syncFeedback({ serial: SERIAL, root: FEEDBACK_ROOT }, io)).rejects.toThrow(/missing/);
	});
});
