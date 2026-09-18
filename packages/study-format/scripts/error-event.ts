import { z } from "zod";
import { strToU8 } from "fflate";
import {
	FORMAT_VERSION,
	flashcardDirective,
	quizDirective,
	type StudyFlashcard,
	type StudyLesson,
	type StudyPackage,
	type StudyQuestion,
} from "../src/index.ts";

const optionIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).max(32);

export const errorEventSchema = z
	.object({
		eventId: z.string().min(1),
		timestamp: z.string().datetime(),
		source: z.string().min(1),
		banca: z.string().nullable(),
		ano: z.number().int().nullable(),
		materia: z.string().min(1),
		assunto: z.string().nullable(),
		questionId: z.string().min(1).nullable(),
		enunciado: z.string().min(1),
		alternativas: z
			.array(z.object({ id: optionIdSchema, text: z.string().min(1) }))
			.min(2),
		respostaMarcada: z.array(optionIdSchema),
		respostaCorreta: z.array(optionIdSchema).min(1),
		explicacaoOriginal: z.string().nullable(),
		recorrencia: z.number().int().min(1),
		notebookId: z.string().nullable(),
		raw: z.record(z.string(), z.unknown()),
	})
	.refine(
		(e) =>
			[...e.respostaMarcada, ...e.respostaCorreta].every((id) =>
				e.alternativas.some((a) => a.id === id),
			),
		{ message: "respostaMarcada/respostaCorreta reference unknown alternativas" },
	);

export type ErrorEvent = z.infer<typeof errorEventSchema>;

export type ErrorCourseOptions = {
	courseId?: string;
	title?: string;
};

export const DEFAULT_COURSE_ID = "indio-error-test";
export const DEFAULT_COURSE_TITLE = "INDIO Error Test";

export function slugify(value: string): string {
	return value
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function dedupeKey(event: ErrorEvent): string {
	if (event.questionId) {
		const key = slugify(event.questionId);
		if (key) return key;
	}
	return slugify(event.eventId);
}

export function errorCourseIds(event: ErrorEvent) {
	const key = dedupeKey(event);
	return {
		dedupeKey: key,
		moduleId: slugify(event.materia),
		lessonId: `error-${key}`,
		questionId: `${key}-recovery`,
		flashcardId: `${key}-card`,
		lessonPath: `content/error-${key}.md`,
	};
}

function describeAnswer(event: ErrorEvent, ids: string[]): string {
	if (ids.length === 0) return "(nenhuma)";
	return ids
		.map((id) => {
			const option = event.alternativas.find((a) => a.id === id);
			return option ? `${id}) ${option.text}` : id;
		})
		.join("; ");
}

export type LessonPriority = {
	priority: string;
	reasons: string[];
};

export function renderErrorLesson(event: ErrorEvent, priority?: LessonPriority): string {
	const ids = errorCourseIds(event);
	const sections = [`# ${event.materia}`];
	if (event.assunto) sections.push(`## ${event.assunto}`);
	sections.push(
		"### O erro",
		`**Questão:** ${event.enunciado}`,
		[
			`- **Resposta marcada:** ${describeAnswer(event, event.respostaMarcada)}`,
			`- **Resposta correta:** ${describeAnswer(event, event.respostaCorreta)}`,
		].join("\n"),
	);
	if (priority) {
		sections.push(
			"### Prioridade",
			`**${priority.priority}**`,
			priority.reasons.map((reason) => `- ${reason}`).join("\n"),
		);
	}
	sections.push(
		"### Explicação",
		event.explicacaoOriginal ?? "Sem explicação original registrada.",
		"### Revisão ativa",
		"Responda novamente a questão e revise o flashcard.",
		quizDirective(ids.questionId),
		flashcardDirective(ids.flashcardId),
	);
	return `${sections.join("\n\n")}\n`;
}

export type ErrorLesson = {
	ids: ReturnType<typeof errorCourseIds>;
	lesson: StudyLesson;
	markdown: string;
	question: StudyQuestion;
	flashcard: StudyFlashcard;
};

export function buildErrorLesson(event: ErrorEvent, priority?: LessonPriority): ErrorLesson {
	const ids = errorCourseIds(event);
	const correct = describeAnswer(event, event.respostaCorreta);
	const questionLabel = event.questionId ?? event.eventId;

	return {
		ids,
		lesson: {
			id: ids.lessonId,
			title: event.assunto ?? event.materia,
			content: ids.lessonPath,
		},
		markdown: renderErrorLesson(event, priority),
		question: {
			type: event.respostaCorreta.length === 1 ? "single-choice" : "multiple-choice",
			question: event.enunciado,
			options: event.alternativas,
			correct: event.respostaCorreta,
			...(event.explicacaoOriginal
				? { explanation: event.explicacaoOriginal }
				: {}),
		},
		flashcard: {
			id: ids.flashcardId,
			front: `Na questão ${questionLabel}, qual era a resposta correta?`,
			back: event.explicacaoOriginal
				? `${correct} — ${event.explicacaoOriginal}`
				: correct,
			tags: ["erro", ids.dedupeKey],
		},
	};
}

export function buildErrorCourse(
	event: ErrorEvent,
	options: ErrorCourseOptions = {},
): StudyPackage {
	const { ids, lesson, markdown, question, flashcard } = buildErrorLesson(event);

	return {
		manifest: {
			formatVersion: FORMAT_VERSION,
			id: options.courseId ?? DEFAULT_COURSE_ID,
			version: 1,
			title: options.title ?? DEFAULT_COURSE_TITLE,
			language: "pt-BR",
			modules: [{ id: ids.moduleId, title: event.materia, lessons: [lesson] }],
			extensions: {
				indio: {
					phase: "2A",
					dedupeKey: ids.dedupeKey,
					eventIds: [event.eventId],
					source: event.source,
				},
			},
		},
		questions: { [ids.questionId]: question },
		flashcards: [flashcard],
		lessonContent: { [ids.lessonPath]: markdown },
		files: [{ path: ids.lessonPath, data: strToU8(markdown) }],
	};
}
