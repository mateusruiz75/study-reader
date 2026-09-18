import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildStudy,
	extractDirectives,
	readStudy,
	validateCrossReferences,
} from "../src/index.ts";
import {
	buildErrorCourse,
	DEFAULT_COURSE_ID,
	errorEventSchema,
	type ErrorEvent,
} from "../scripts/error-event.ts";

const FIXTURE = join(
	import.meta.dirname,
	"../../../examples/phase2a/adm-podc-error.json",
);

function loadEvent(): ErrorEvent {
	return errorEventSchema.parse(JSON.parse(readFileSync(FIXTURE, "utf8")));
}

function logicalContents(bytes: Uint8Array): Record<string, string> {
	return Object.fromEntries(
		Object.entries(unzipSync(bytes))
			.map(([path, data]): [string, string] => [path, strFromU8(data)])
			.sort(([a], [b]) => a.localeCompare(b)),
	);
}

describe("phase 2A: error event → .study", () => {
	it("builds a valid course from a valid ErrorEvent", () => {
		const bytes = buildStudy(buildErrorCourse(loadEvent()));
		const restored = readStudy(bytes, { loadLessons: true });

		expect(restored.manifest.id).toBe(DEFAULT_COURSE_ID);
		expect(restored.manifest.modules).toHaveLength(1);
		expect(restored.manifest.modules[0].lessons).toHaveLength(1);
		expect(Object.keys(restored.questions ?? {})).toHaveLength(1);
		expect(restored.flashcards).toHaveLength(1);
		expect(validateCrossReferences(restored)).toEqual([]);
	});

	it("derives stable ids from questionId", () => {
		const pkg = buildErrorCourse(loadEvent());
		const lesson = pkg.manifest.modules[0].lessons[0];

		expect(pkg.manifest.id).toBe("indio-error-test");
		expect(pkg.manifest.modules[0].id).toBe("administracao-geral-e-publica");
		expect(lesson.id).toBe("error-adm-podc-q1");
		expect(lesson.content).toBe("content/error-adm-podc-q1.md");
		expect(Object.keys(pkg.questions!)).toEqual(["adm-podc-q1-recovery"]);
		expect(pkg.flashcards!.map((c) => c.id)).toEqual(["adm-podc-q1-card"]);
		expect(extractDirectives(pkg.lessonContent[lesson.content])).toEqual([
			{ kind: "quiz", ref: "adm-podc-q1-recovery" },
			{ kind: "flashcard", ref: "adm-podc-q1-card" },
		]);
	});

	it("preserves the marked and the correct answers", () => {
		const event = loadEvent();
		const pkg = buildErrorCourse(event);
		const lesson = pkg.lessonContent["content/error-adm-podc-q1.md"];

		expect(event.respostaMarcada).toEqual(["a"]);
		expect(event.respostaCorreta).toEqual(["d"]);
		expect(lesson).toContain("**Resposta marcada:** a) Planejamento");
		expect(lesson).toContain("**Resposta correta:** d) Controle");
		expect(lesson).toContain(event.explicacaoOriginal!);
	});

	it("builds the quiz with the real options and the correct answer", () => {
		const event = loadEvent();
		const question = buildErrorCourse(event).questions!["adm-podc-q1-recovery"];

		expect(question.type).toBe("single-choice");
		expect(question.question).toBe(event.enunciado);
		expect(question.options).toEqual(event.alternativas);
		expect(question.correct).toEqual(["d"]);
		expect(question.options.find((o) => o.id === "d")?.text).toBe("Controle");
		expect(question.explanation).toBe(event.explicacaoOriginal);
	});

	it("generates the flashcard", () => {
		const event = loadEvent();
		const [card] = buildErrorCourse(event).flashcards!;

		expect(card.front).toBe("Na questão adm-podc-q1, qual era a resposta correta?");
		expect(card.back).toBe(`d) Controle — ${event.explicacaoOriginal}`);
	});

	it("uses '/' in every archive path", () => {
		const paths = Object.keys(unzipSync(buildStudy(buildErrorCourse(loadEvent()))));

		expect(paths.sort()).toEqual([
			"content/error-adm-podc-q1.md",
			"flashcards/flashcards.json",
			"manifest.json",
			"questions/questions.json",
		]);
		expect(paths.every((p) => !p.includes("\\"))).toBe(true);
	});

	it("produces the same logical structure for the same input", () => {
		const first = buildStudy(buildErrorCourse(loadEvent()));
		const second = buildStudy(buildErrorCourse(loadEvent()));

		expect(logicalContents(second)).toEqual(logicalContents(first));
	});

	it("rejects answers that reference unknown alternatives", () => {
		const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
		expect(() =>
			errorEventSchema.parse({ ...raw, respostaCorreta: ["z"] }),
		).toThrow();
	});
});
