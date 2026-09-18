import { strToU8 } from "fflate";
import {
	FORMAT_VERSION,
	type FlashcardDeck,
	type QuestionBank,
	type StudyFile,
	type StudyModule,
	type StudyPackage,
} from "../src/index.ts";
import { buildErrorLesson, dedupeKey, type ErrorEvent } from "./error-event.ts";

export const REVIEW_COURSE_ID = "indio-revisao";
export const REVIEW_COURSE_TITLE = "ÍNDIO REVISÃO — Livro de Erros";

export type ReviewCourseOptions = {
	version?: number;
};

export function dedupeEvents(events: ErrorEvent[]): ErrorEvent[] {
	const byKey = new Map<string, ErrorEvent>();
	for (const event of events) {
		const key = dedupeKey(event);
		const current = byKey.get(key);
		if (
			!current ||
			event.timestamp > current.timestamp ||
			(event.timestamp === current.timestamp && event.eventId > current.eventId)
		) {
			byKey.set(key, event);
		}
	}
	return [...byKey.values()];
}

export function buildReviewCourse(
	events: ErrorEvent[],
	options: ReviewCourseOptions = {},
): StudyPackage {
	const unique = dedupeEvents(events).sort((a, b) => {
		const byMateria = a.materia.localeCompare(b.materia, "pt-BR");
		return byMateria !== 0 ? byMateria : dedupeKey(a).localeCompare(dedupeKey(b));
	});

	const modules: StudyModule[] = [];
	const questions: QuestionBank = {};
	const flashcards: FlashcardDeck = [];
	const lessonContent: Record<string, string> = {};
	const files: StudyFile[] = [];

	for (const event of unique) {
		const { ids, lesson, markdown, question, flashcard } = buildErrorLesson(event);
		let module = modules.find((m) => m.id === ids.moduleId);
		if (!module) {
			module = { id: ids.moduleId, title: event.materia, lessons: [] };
			modules.push(module);
		}
		const label = event.questionId ? ` · Q${event.questionId}` : "";
		module.lessons.push({ ...lesson, title: `${lesson.title}${label}` });
		questions[ids.questionId] = question;
		flashcards.push(flashcard);
		lessonContent[ids.lessonPath] = markdown;
		files.push({ path: ids.lessonPath, data: strToU8(markdown) });
	}

	if (modules.length === 0) {
		throw new Error("no usable error events to build a review course");
	}

	return {
		manifest: {
			formatVersion: FORMAT_VERSION,
			id: REVIEW_COURSE_ID,
			version: options.version ?? 1,
			title: REVIEW_COURSE_TITLE,
			language: "pt-BR",
			modules,
			extensions: {
				indio: {
					phase: "2B",
					dedupeKeys: unique.map((e) => dedupeKey(e)),
					eventIds: unique.map((e) => e.eventId),
				},
			},
		},
		questions,
		flashcards,
		lessonContent,
		files,
	};
}
