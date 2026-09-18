import { describe, expect, it } from "vitest";
import { adaptLedger } from "../scripts/adapters/error-notebook-ledger.ts";
import {
	classifyPriority,
	deriveFeatures,
	prioritizeEvents,
	selectBalanced,
	type AttemptRecord,
	type PriorityFeatures,
} from "../scripts/review-priority.ts";
import { buildReviewCourse } from "../scripts/review-course.ts";

const AS_OF = "2026-09-17T12:00:00.000Z";

const QUESTION = {
	statement: "Questão sintética de teste (não é conteúdo real).",
	alternatives: [
		{ label: "A", text: "Alternativa A" },
		{ label: "B", text: "Alternativa B" },
		{ label: "C", text: "Alternativa C" },
	],
	correctAnswer: "B",
};

let seq = 0;

function daysAgo(days: number): string {
	const d = new Date(Date.parse(AS_OF) - days * 86_400_000);
	d.setUTCHours(10, 0, 0, 0);
	return d.toISOString();
}

function base(questionId: string, materia: string, occurredAt: string, respostaUsuario: string) {
	seq++;
	return {
		eventId: `ev-${String(seq).padStart(3, "0")}`,
		questionId,
		materia,
		assunto: `Assunto ${questionId}`,
		urlCanonica: null,
		respostaUsuario,
		occurredAt,
		date: occurredAt.slice(0, 10),
	};
}

function error(questionId: string, materia: string, occurredAt: string, answer = "A", withContent = true) {
	return {
		...base(questionId, materia, occurredAt, answer),
		eventType: "knowledge.error_recorded",
		...(withContent ? { content: QUESTION } : {}),
	};
}

function correct(questionId: string, materia: string, occurredAt: string) {
	const entry = base(questionId, materia, occurredAt, "B");
	return {
		...entry,
		eventType: "knowledge.answer_recorded",
		sourceEventId: `desempenho:${questionId}_acertou:${entry.eventId}`,
	};
}

function bareAnswer(questionId: string, materia: string, occurredAt: string) {
	return { ...base(questionId, materia, occurredAt, "B"), eventType: "knowledge.answer_recorded" };
}

function attempt(
	questionId: string,
	result: AttemptRecord["result"],
	occurredAt: string,
	answer = "A",
): AttemptRecord {
	seq++;
	return { questionId, materia: "M", eventId: `at-${seq}`, occurredAt, result, respostaUsuario: answer };
}

const MAT = {
	trib: "Direito Tributário",
	cont: "Contabilidade Geral",
	const: "Direito Constitucional",
};

function ledger() {
	seq = 0;
	return [
		error("q-relapse", MAT.trib, daysAgo(20)),
		correct("q-relapse", MAT.trib, daysAgo(12)),
		error("q-relapse", MAT.trib, daysAgo(3), "C"),

		error("q-recurrent", MAT.cont, daysAgo(15)),
		error("q-recurrent", MAT.cont, daysAgo(9)),

		error("q-recovered", MAT.cont, daysAgo(25)),
		correct("q-recovered", MAT.cont, daysAgo(18)),
		correct("q-recovered", MAT.cont, daysAgo(11)),
		correct("q-recovered", MAT.cont, daysAgo(4)),

		error("q-isolated-recent", MAT.const, daysAgo(2)),
		error("q-isolated-old", MAT.const, daysAgo(24)),

		error("q-many-recent", MAT.trib, daysAgo(6)),
		error("q-many-recent", MAT.trib, daysAgo(4), "C", false),
		error("q-many-recent", MAT.trib, daysAgo(1), "A", false),

		error("q-unknown", MAT.const, daysAgo(10)),
		bareAnswer("q-unknown", MAT.const, daysAgo(5)),
	];
}

function features(raw: ReturnType<typeof ledger>) {
	return deriveFeatures(adaptLedger(raw).attempts, AS_OF);
}

describe("phase 2C: priority features", () => {
	it("derives counts, dates and recovery from the full question history", () => {
		const f = features(ledger()).get("q-relapse")!;

		expect(f).toMatchObject({
			questionId: "q-relapse",
			errorCount: 2,
			attemptCount: 3,
			correctCount: 1,
			unknownCount: 0,
			lastErrorAt: daysAgo(3),
			lastAttemptAt: daysAgo(3),
			latestResult: "error",
			correctAfterLastError: 0,
			errorsAfterCorrect: 1,
			daysSinceLastError: 3,
			recurrence: true,
			wrongAnswerPattern: "varied",
		});
	});

	it("counts content-less errors in the history", () => {
		const f = features(ledger()).get("q-many-recent")!;

		expect(f.errorCount).toBe(3);
		expect(f.daysSinceLastError).toBe(1);
		expect(f.wrongAnswerPattern).toBe("varied");
	});

	it("does not invent a result for answers without content or sourceEventId", () => {
		const f = features(ledger()).get("q-unknown")!;

		expect(f.correctCount).toBe(0);
		expect(f.unknownCount).toBe(1);
		expect(f.correctAfterLastError).toBe(0);
		expect(f.latestResult).toBe("unknown");
		expect(f.attemptCount).toBe(2);
	});

	it("reports repeated wrong answers", () => {
		const f = features(ledger()).get("q-recurrent")!;

		expect(f.wrongAnswerPattern).toBe("repeated");
		expect(f.correctAfterLastError).toBe(0);
	});

	it("uses null for the pattern of an isolated error", () => {
		expect(features(ledger()).get("q-isolated-recent")!.wrongAnswerPattern).toBeNull();
	});
});

describe("phase 2C: priority bands", () => {
	const band = (id: string) => classifyPriority(features(ledger()).get(id)!).priority;

	it("ranks a recurrent error above an isolated error", () => {
		expect(band("q-recurrent")).toBe("HIGH");
		expect(band("q-isolated-recent")).toBe("MEDIUM");
	});

	it("raises priority when an error returns after a correct answer", () => {
		expect(band("q-relapse")).toBe("CRITICAL");
	});

	it("marks many recent errors as CRITICAL", () => {
		expect(band("q-many-recent")).toBe("CRITICAL");
	});

	it("lowers priority after consistent recovery", () => {
		expect(band("q-recovered")).toBe("LOW");
	});

	it("keeps a never-retried old error at MEDIUM", () => {
		expect(band("q-isolated-old")).toBe("MEDIUM");
	});

	it("treats an unknown-result attempt as no recovery", () => {
		expect(band("q-unknown")).toBe("MEDIUM");
	});

	it("keeps a recovered but very recent error at MEDIUM", () => {
		const f = deriveFeatures(
			[
				attempt("q", "error", daysAgo(5)),
				attempt("q", "correct", daysAgo(3)),
				attempt("q", "correct", daysAgo(1)),
			],
			AS_OF,
		).get("q")!;

		expect(classifyPriority(f).priority).toBe("MEDIUM");
	});

	it("requires a longer correct streak before a relapsed question counts as recovered", () => {
		const history = [
			attempt("q", "error", daysAgo(30)),
			attempt("q", "correct", daysAgo(25)),
			attempt("q", "error", daysAgo(20)),
			attempt("q", "correct", daysAgo(15)),
			attempt("q", "correct", daysAgo(12)),
		];
		const twoCorrect = deriveFeatures(history, AS_OF).get("q")!;
		const threeCorrect = deriveFeatures(
			[...history, attempt("q", "correct", daysAgo(9))],
			AS_OF,
		).get("q")!;

		expect(classifyPriority(twoCorrect).priority).toBe("CRITICAL");
		expect(classifyPriority(threeCorrect).priority).toBe("LOW");
	});

	it("does not treat a first error after a correct answer as a relapse", () => {
		const f = deriveFeatures(
			[attempt("q", "correct", daysAgo(10)), attempt("q", "error", daysAgo(2))],
			AS_OF,
		).get("q")!;

		expect(f.errorsAfterCorrect).toBe(1);
		expect(classifyPriority(f).priority).toBe("MEDIUM");
	});

	it("is deterministic for the same features", () => {
		const f = features(ledger()).get("q-relapse")!;
		const copy: PriorityFeatures = JSON.parse(JSON.stringify(f));

		expect(classifyPriority(copy)).toEqual(classifyPriority(f));
	});

	it("explains the classification with reasons derived from the rules", () => {
		const relapse = classifyPriority(features(ledger()).get("q-relapse")!);
		const recovered = classifyPriority(features(ledger()).get("q-recovered")!);
		const unknown = classifyPriority(features(ledger()).get("q-unknown")!);

		expect(relapse.rule).toBe("relapse-unrecovered");
		expect(relapse.reasons).toEqual([
			"voltou a errar após acerto, sem recuperação consistente",
			"2 erros registrados",
			"último erro há 3 dias",
			"1 erro após acerto",
			"nenhum acerto após o último erro",
			"alternativas erradas variadas",
		]);
		expect(recovered.rule).toBe("recovered");
		expect(recovered.reasons).toContain("3 acertos após o último erro");
		expect(recovered.reasons).toContain("último erro há 25 dias");
		expect(unknown.reasons).toContain("1 tentativa com resultado desconhecido");
		expect(unknown.reasons).toContain("nenhum acerto após o último erro");
	});
});

describe("phase 2C: ordering and balanced selection", () => {
	const prioritized = (raw = ledger()) => {
		const adapted = adaptLedger(raw);
		return prioritizeEvents(adapted.events, deriveFeatures(adapted.attempts, AS_OF));
	};

	it("orders by band, then recurrence/recovery, then recency, then questionId", () => {
		expect(prioritized().map((p) => p.event.questionId)).toEqual([
			"q-many-recent",
			"q-relapse",
			"q-recurrent",
			"q-isolated-recent",
			"q-unknown",
			"q-isolated-old",
			"q-recovered",
		]);
	});

	it("breaks ties between equal histories by recency", () => {
		seq = 0;
		const raw = [error("q-older", MAT.trib, daysAgo(10)), error("q-newer", MAT.trib, daysAgo(2))];

		expect(prioritized(raw).map((p) => p.event.questionId)).toEqual(["q-newer", "q-older"]);
	});

	it("is independent of input order", () => {
		const forward = prioritized().map((p) => [p.event.questionId, p.priority, p.reasons]);
		const backward = prioritized([...ledger()].reverse()).map((p) => [
			p.event.questionId,
			p.priority,
			p.reasons,
		]);

		expect(backward).toEqual(forward);
	});

	it("enforces the global limit", () => {
		const { selected, rejected } = selectBalanced(prioritized(), { limit: 3, maxPerMateria: 10 });

		expect(selected.map((p) => p.event.questionId)).toEqual(["q-many-recent", "q-relapse", "q-recurrent"]);
		expect(rejected.map((p) => [p.event.questionId, p.rejectedBecause])).toEqual([
			["q-isolated-recent", "limit"],
			["q-unknown", "limit"],
			["q-isolated-old", "limit"],
			["q-recovered", "limit"],
		]);
	});

	it("enforces max-per-materia on lower bands without skipping lower-priority materias", () => {
		const { selected, rejected } = selectBalanced(prioritized(), { limit: 4, maxPerMateria: 1 });

		expect(selected.map((p) => [p.event.questionId, p.event.materia])).toEqual([
			["q-many-recent", MAT.trib],
			["q-relapse", MAT.trib],
			["q-recurrent", MAT.cont],
			["q-isolated-recent", MAT.const],
		]);
		expect(rejected.map((p) => [p.event.questionId, p.rejectedBecause])).toEqual([
			["q-unknown", "max-per-materia"],
			["q-isolated-old", "max-per-materia"],
			["q-recovered", "max-per-materia"],
		]);
	});

	it("uses profile boosts only as a tie-break inside the same band", () => {
		const adapted = adaptLedger(ledger());
		const f = deriveFeatures(adapted.attempts, AS_OF);
		const boosted = prioritizeEvents(adapted.events, f, { materiaBoosts: { [MAT.const]: 1 } });

		expect(boosted.map((p) => p.event.questionId)).toEqual([
			"q-many-recent",
			"q-relapse",
			"q-recurrent",
			"q-isolated-recent",
			"q-unknown",
			"q-isolated-old",
			"q-recovered",
		]);
		expect(boosted.find((p) => p.event.questionId === "q-isolated-recent")!.reasons).toContain(
			"matéria priorizada no perfil",
		);
		expect(boosted.find((p) => p.event.questionId === "q-recovered")!.reasons).not.toContain(
			"matéria priorizada no perfil",
		);
	});

	it("lets a boost reorder items of the same band", () => {
		seq = 0;
		const raw = [error("q-trib", MAT.trib, daysAgo(2)), error("q-const", MAT.const, daysAgo(2))];
		const adapted = adaptLedger(raw);
		const plain = prioritizeEvents(adapted.events, deriveFeatures(adapted.attempts, AS_OF));
		const boosted = prioritizeEvents(adapted.events, deriveFeatures(adapted.attempts, AS_OF), {
			materiaBoosts: { [MAT.trib]: 1 },
		});

		expect(plain.map((p) => p.event.questionId)).toEqual(["q-const", "q-trib"]);
		expect(boosted.map((p) => p.event.questionId)).toEqual(["q-trib", "q-const"]);
	});

	it("is stable between rebuilds", () => {
		const a = selectBalanced(prioritized(), { limit: 5, maxPerMateria: 2 });
		const b = selectBalanced(prioritized([...ledger()].reverse()), { limit: 5, maxPerMateria: 2 });

		expect(b.selected.map((p) => p.event.questionId)).toEqual(
			a.selected.map((p) => p.event.questionId),
		);
	});
});

describe("phase 2C: prioritized review course", () => {
	const build = (raw = ledger()) => {
		const adapted = adaptLedger(raw);
		const items = prioritizeEvents(adapted.events, deriveFeatures(adapted.attempts, AS_OF));
		return buildReviewCourse(selectBalanced(items, { limit: 30, maxPerMateria: 6 }).selected);
	};

	const ids = (course: ReturnType<typeof build>) => ({
		lessons: course.manifest.modules.flatMap((m) => m.lessons.map((l) => l.id)).sort(),
		questions: Object.keys(course.questions!).sort(),
		cards: course.flashcards!.map((c) => c.id).sort(),
	});

	it("keeps lesson, question and flashcard ids independent of priority", () => {
		const plain = buildReviewCourse(adaptLedger(ledger()).events);
		const prioritizedCourse = build();

		expect(ids(prioritizedCourse)).toEqual(ids(plain));
		expect(ids(prioritizedCourse).lessons).toContain("error-q-relapse");
		expect(ids(prioritizedCourse).questions).toContain("q-relapse-recovery");
		expect(ids(prioritizedCourse).cards).toContain("q-relapse-card");
	});

	it("keeps ids stable across rebuilds", () => {
		const a = build();
		const b = build([...ledger()].reverse());

		expect(b.manifest).toEqual(a.manifest);
		expect(Object.keys(b.questions!)).toEqual(Object.keys(a.questions!));
	});

	it("orders lessons inside a module by priority", () => {
		const { manifest } = build();
		const cont = manifest.modules.find((m) => m.title === MAT.cont)!;

		expect(cont.lessons.map((l) => l.id)).toEqual(["error-q-recurrent", "error-q-recovered"]);
	});

	it("exposes priority metadata in extensions.indio without build timestamps", () => {
		const { manifest } = build();
		const indio = manifest.extensions!.indio as Record<string, unknown>;
		const priorities = indio.priorities as Record<string, Record<string, unknown>>;

		expect(indio.phase).toBe("2E");
		expect(indio.priorityAsOf).toBe(AS_OF);
		expect(priorities["q-relapse"]).toMatchObject({
			priority: "CRITICAL",
			rule: "relapse-unrecovered",
			recurrence: true,
			errorCount: 2,
		});
		expect(priorities["q-relapse"].priorityReasons).toContain(
			"voltou a errar após acerto, sem recuperação consistente",
		);
		expect(JSON.stringify(manifest)).not.toContain("builtAt");
	});

	it("renders the priority and reasons inside the lesson", () => {
		const { lessonContent } = build();

		expect(lessonContent["content/error-q-relapse.md"]).toContain("### Prioridade");
		expect(lessonContent["content/error-q-relapse.md"]).toContain("**CRITICAL**");
		expect(lessonContent["content/error-q-relapse.md"]).toContain("- 2 erros registrados");
	});
});

describe("phase 2C.1: critical band invariant", () => {
	function bandLedger() {
		seq = 0;
		const relapse = (id: string, materia: string, lastDays: number) => [
			error(id, materia, daysAgo(lastDays + 10)),
			correct(id, materia, daysAgo(lastDays + 5)),
			error(id, materia, daysAgo(lastDays), "C"),
		];
		const recurrent = (id: string, materia: string, lastDays: number) => [
			error(id, materia, daysAgo(lastDays + 4)),
			error(id, materia, daysAgo(lastDays)),
		];
		return [
			...relapse("q-a1", MAT.trib, 1),
			...relapse("q-a2", MAT.trib, 2),
			...relapse("q-a3", MAT.trib, 3),
			...relapse("q-b1", MAT.cont, 4),
			...recurrent("q-c1", MAT.const, 1),
			...recurrent("q-a4", MAT.trib, 2),
			error("q-c2", MAT.const, daysAgo(1)),
		];
	}

	const prioritized = (raw = bandLedger()) => {
		const adapted = adaptLedger(raw);
		return prioritizeEvents(adapted.events, deriveFeatures(adapted.attempts, AS_OF));
	};

	const ids = (items: { event: { questionId: string | null } }[]) => items.map((i) => i.event.questionId);

	it("classifies the fixture as expected", () => {
		expect(prioritized().map((p) => [p.event.questionId, p.priority])).toEqual([
			["q-a1", "CRITICAL"],
			["q-a2", "CRITICAL"],
			["q-a3", "CRITICAL"],
			["q-b1", "CRITICAL"],
			["q-c1", "HIGH"],
			["q-a4", "HIGH"],
			["q-c2", "MEDIUM"],
		]);
	});

	it("never drops a CRITICAL for a lower band because of max-per-materia", () => {
		const { selected, rejected } = selectBalanced(prioritized(), { limit: 6, maxPerMateria: 2 });

		expect(ids(selected)).toEqual(["q-a1", "q-a2", "q-a3", "q-b1", "q-c1", "q-c2"]);
		expect(rejected.map((r) => [r.event.questionId, r.rejectedBecause])).toEqual([
			["q-a4", "max-per-materia"],
		]);
	});

	it("includes every CRITICAL when they fit in the limit even if a materia exceeds its cap", () => {
		const { selected } = selectBalanced(prioritized(), { limit: 4, maxPerMateria: 1 });

		expect(ids(selected)).toEqual(["q-a1", "q-a2", "q-a3", "q-b1"]);
		expect(selected.every((p) => p.priority === "CRITICAL")).toBe(true);
	});

	it("keeps applying max-per-materia to lower bands after the CRITICAL block", () => {
		const { selected, rejected } = selectBalanced(prioritized(), { limit: 10, maxPerMateria: 1 });

		expect(ids(selected)).toEqual(["q-a1", "q-a2", "q-a3", "q-b1", "q-c1"]);
		expect(rejected.map((r) => [r.event.questionId, r.rejectedBecause])).toEqual([
			["q-a4", "max-per-materia"],
			["q-c2", "max-per-materia"],
		]);
	});

	it("never includes HIGH when the limit is smaller than the number of CRITICAL", () => {
		const { selected, rejected } = selectBalanced(prioritized(), { limit: 2, maxPerMateria: 6 });

		expect(ids(selected)).toEqual(["q-a1", "q-a2"]);
		expect(selected.every((p) => p.priority === "CRITICAL")).toBe(true);
		expect(rejected.map((r) => [r.event.questionId, r.rejectedBecause])).toEqual([
			["q-a3", "limit"],
			["q-b1", "limit"],
			["q-c1", "limit"],
			["q-a4", "limit"],
			["q-c2", "limit"],
		]);
	});

	it("uses max-per-materia only to balance among CRITICAL when they exceed the limit", () => {
		const balanced = selectBalanced(prioritized(), { limit: 2, maxPerMateria: 1 });
		const refilled = selectBalanced(prioritized(), { limit: 3, maxPerMateria: 1 });

		expect(ids(balanced.selected)).toEqual(["q-a1", "q-b1"]);
		expect(ids(refilled.selected)).toEqual(["q-a1", "q-a2", "q-b1"]);
		expect(ids(refilled.rejected)).toEqual(["q-a3", "q-c1", "q-a4", "q-c2"]);
		expect(refilled.selected.every((p) => p.priority === "CRITICAL")).toBe(true);
	});

	it("is deterministic and independent of input order", () => {
		const a = selectBalanced(prioritized(), { limit: 5, maxPerMateria: 1 });
		const b = selectBalanced(prioritized([...bandLedger()].reverse()), { limit: 5, maxPerMateria: 1 });

		expect(ids(b.selected)).toEqual(ids(a.selected));
		expect(b.rejected.map((r) => r.rejectedBecause)).toEqual(a.rejected.map((r) => r.rejectedBecause));
	});

	it("keeps ids stable regardless of the selection rule", () => {
		const course = buildReviewCourse(selectBalanced(prioritized(), { limit: 6, maxPerMateria: 2 }).selected);
		const plain = buildReviewCourse(adaptLedger(bandLedger()).events);
		const lessonIds = (c: typeof course) =>
			c.manifest.modules.flatMap((m) => m.lessons.map((l) => l.id)).sort();

		for (const id of lessonIds(course)) expect(lessonIds(plain)).toContain(id);
		expect(Object.keys(course.questions!).sort()).toContain("q-a3-recovery");
		expect(course.flashcards!.map((c) => c.id)).toContain("q-a3-card");
	});
});
