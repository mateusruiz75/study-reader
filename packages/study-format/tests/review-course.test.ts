import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildStudy, readStudy, validateCrossReferences } from "../src/index.ts";
import {
	adaptLedger,
	selectTechnicalBatch,
} from "../scripts/adapters/error-notebook-ledger.ts";
import { buildReviewCourse, REVIEW_COURSE_ID } from "../scripts/review-course.ts";

type Question = {
	question: string;
	options: { id: string; text: string }[];
	correct: string[];
};

const BANK: Record<string, Question> = JSON.parse(
	readFileSync(
		join(import.meta.dirname, "../../../courses/indio-fiscal/questions/questions.json"),
		"utf8",
	),
);

function errorEntry(
	eventId: string,
	questionId: string,
	materia: string,
	occurredAt: string,
	respostaUsuario: string,
	question: Question | null,
) {
	return {
		eventId,
		eventType: "knowledge.error_recorded",
		questionId,
		materia,
		assunto: `Assunto de ${questionId}`,
		urlCanonica: null,
		respostaUsuario,
		occurredAt,
		date: occurredAt.slice(0, 10),
		content: question && {
			statement: question.question,
			alternatives: question.options.map((o) => ({ label: o.id, text: o.text })),
			correctAnswer: question.correct[0],
		},
	};
}

const SYNTHETIC: Question = {
	question: "Questão sintética de teste (não é conteúdo real).",
	options: [
		{ id: "C", text: "Certo" },
		{ id: "E", text: "Errado" },
	],
	correct: ["E"],
};

function ledger() {
	const adm = BANK["adm-podc-q1"];
	const con = BANK["const-inafastabilidade-q1"];
	return [
		errorEntry("ev-01", "adm-podc-q1", "Administração Geral e Pública", "2026-09-01T10:00:00Z", "a", adm),
		errorEntry("ev-02", "adm-podc-q1", "Administração Geral e Pública", "2026-09-03T10:00:00Z", "b", adm),
		errorEntry("ev-03", "adm-podc-q1", "Administração Geral e Pública", "2026-09-02T10:00:00Z", "c", null),
		errorEntry("ev-04", "const-inafastabilidade-q1", "Direito Constitucional", "2026-09-02T09:00:00Z", "a", con),
		errorEntry("ev-05", "synthetic-q3", "Administração Geral e Pública", "2026-09-04T09:00:00Z", "C", SYNTHETIC),
		{ ...errorEntry("ev-06", "adm-podc-q1", "Administração Geral e Pública", "2026-09-05T10:00:00Z", "d", adm), eventType: "knowledge.answer_recorded" },
		{ eventId: "ev-07", eventType: "knowledge.error_recorded" },
	];
}

function logical(bytes: Uint8Array): Record<string, string> {
	return Object.fromEntries(
		Object.entries(unzipSync(bytes))
			.map(([path, data]): [string, string] => [path, strFromU8(data)])
			.sort(([a], [b]) => a.localeCompare(b)),
	);
}

describe("phase 2B: error notebook ledger adapter", () => {
	it("keeps only complete error_recorded entries and reports the rest", () => {
		const result = adaptLedger(ledger());

		expect(result.events.map((e) => e.questionId)).toEqual([
			"adm-podc-q1",
			"const-inafastabilidade-q1",
			"synthetic-q3",
		]);
		expect(result.skipped).toEqual({
			"not-error": 1,
			"invalid-entry": 1,
			"no-content": 1,
			"invalid-event": 0,
		});
	});

	it("maps ledger fields without inventing banca, ano, notebookId or explanation", () => {
		const event = adaptLedger(ledger()).events.find((e) => e.questionId === "adm-podc-q1")!;

		expect(event.source).toBe("tec");
		expect(event.respostaCorreta).toEqual(["d"]);
		expect(event.alternativas.map((a) => a.id)).toEqual(["a", "b", "c", "d"]);
		expect(event.banca).toBeNull();
		expect(event.ano).toBeNull();
		expect(event.notebookId).toBeNull();
		expect(event.explicacaoOriginal).toBeNull();
		expect(event.raw.eventId).toBe("ev-02");
	});
});

describe("phase 2B: review course", () => {
	const events = () => adaptLedger(ledger()).events;

	it("builds one course from multiple ErrorEvents", () => {
		const restored = readStudy(buildStudy(buildReviewCourse(events())), { loadLessons: true });

		expect(restored.manifest.modules.flatMap((m) => m.lessons)).toHaveLength(3);
		expect(validateCrossReferences(restored)).toEqual([]);
	});

	it("groups errors by materia", () => {
		const { manifest } = buildReviewCourse(events());

		expect(manifest.modules.map((m) => [m.title, m.lessons.map((l) => l.id)])).toEqual([
			["Administração Geral e Pública", ["error-adm-podc-q1", "error-synthetic-q3"]],
			["Direito Constitucional", ["error-const-inafastabilidade-q1"]],
		]);
	});

	it("dedupes by questionId keeping the newest error and counting recurrence", () => {
		const adapted = adaptLedger(ledger());
		const adm = adapted.events.find((e) => e.questionId === "adm-podc-q1")!;

		expect(adapted.duplicatesRemoved).toBe(1);
		expect(adm.respostaMarcada).toEqual(["b"]);
		expect(adm.recorrencia).toBe(3);
	});

	it("keeps ids stable and independent of input order", () => {
		const forward = buildReviewCourse(events());
		const backward = buildReviewCourse([...events()].reverse());

		expect(backward.manifest).toEqual(forward.manifest);
		expect(Object.keys(forward.questions!)).toEqual([
			"adm-podc-q1-recovery",
			"synthetic-q3-recovery",
			"const-inafastabilidade-q1-recovery",
		]);
		expect(forward.flashcards!.map((c) => c.id)).toEqual([
			"adm-podc-q1-card",
			"synthetic-q3-card",
			"const-inafastabilidade-q1-card",
		]);
	});

	it("creates one lesson file per error", () => {
		const { manifest, lessonContent } = buildReviewCourse(events());
		const paths = manifest.modules.flatMap((m) => m.lessons.map((l) => l.content));

		expect(paths).toHaveLength(3);
		for (const path of paths) expect(lessonContent[path]).toContain("### O erro");
	});

	it("creates one quiz per error with the real correct answer", () => {
		const { questions } = buildReviewCourse(events());

		expect(Object.keys(questions!)).toHaveLength(3);
		expect(questions!["adm-podc-q1-recovery"].correct).toEqual(["d"]);
		expect(questions!["const-inafastabilidade-q1-recovery"].correct).toEqual(["b"]);
	});

	it("creates one flashcard per error", () => {
		const { flashcards } = buildReviewCourse(events());

		expect(flashcards).toHaveLength(3);
		expect(flashcards![0].back).toBe("d) Controle");
	});

	it("always uses indio-revisao as manifest id", () => {
		const { manifest } = buildReviewCourse(events(), { version: 7 });

		expect(manifest.id).toBe(REVIEW_COURSE_ID);
		expect(manifest.id).toBe("indio-revisao");
		expect(manifest.version).toBe(7);
		expect(manifest.title).toBe("ÍNDIO REVISÃO — Livro de Erros");
	});

	it("does not duplicate errors on rebuild or when events repeat", () => {
		const once = buildReviewCourse(events());
		const twice = buildReviewCourse([...events(), ...events()]);

		expect(logical(buildStudy(twice))).toEqual(logical(buildStudy(once)));
		expect(twice.flashcards).toHaveLength(3);
	});

	it("uses '/' in every archive path", () => {
		const paths = Object.keys(unzipSync(buildStudy(buildReviewCourse(events()))));

		expect(paths.every((p) => !p.includes("\\"))).toBe(true);
		expect(paths).toContain("content/error-adm-podc-q1.md");
	});

	it("selects a deterministic technical batch across materias", () => {
		const batch = selectTechnicalBatch(events(), 2, 1);

		expect(batch.map((e) => e.questionId)).toEqual(["synthetic-q3", "const-inafastabilidade-q1"]);
	});
});
