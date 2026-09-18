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
import type { PrioritizedError } from "./review-priority.ts";

export const REVIEW_COURSE_ID = "indio-revisao";
export const REVIEW_COURSE_TITLE = "ÍNDIO REVISÃO — Livro de Erros";

export type ReviewCourseOptions = {
	version?: number;
};

export type ReviewItem = ErrorEvent | PrioritizedError;

function isPrioritized(item: ReviewItem): item is PrioritizedError {
	return "event" in item && "features" in item;
}

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

type ResolvedItem = {
	event: ErrorEvent;
	priority?: PrioritizedError;
	rank: number;
};

function resolveItems(items: ReviewItem[]): ResolvedItem[] {
	const prioritized = items.filter(isPrioritized);
	const rankByKey = new Map<string, number>();
	const priorityByKey = new Map<string, PrioritizedError>();
	prioritized.forEach((item, index) => {
		const key = dedupeKey(item.event);
		if (!priorityByKey.has(key)) {
			priorityByKey.set(key, item);
			rankByKey.set(key, index);
		}
	});

	const events = dedupeEvents(items.map((item) => (isPrioritized(item) ? item.event : item)));
	return events
		.map((event) => {
			const key = dedupeKey(event);
			return { event, priority: priorityByKey.get(key), rank: rankByKey.get(key) ?? Infinity };
		})
		.sort((a, b) => {
			const byMateria = a.event.materia.localeCompare(b.event.materia, "pt-BR");
			if (byMateria !== 0) return byMateria;
			if (a.rank !== b.rank) return a.rank - b.rank;
			return dedupeKey(a.event).localeCompare(dedupeKey(b.event));
		});
}

function priorityMetadata(item: PrioritizedError) {
	const f = item.features;
	return {
		priority: item.priority,
		rule: item.rule,
		priorityReasons: item.reasons,
		recurrence: f.recurrence,
		errorCount: f.errorCount,
		attemptCount: f.attemptCount,
		correctAfterLastError: f.correctAfterLastError,
		errorsAfterCorrect: f.errorsAfterCorrect,
		lastErrorAt: f.lastErrorAt,
		daysSinceLastError: f.daysSinceLastError,
		latestResult: f.latestResult,
		wrongAnswerPattern: f.wrongAnswerPattern,
	};
}

export function buildReviewCourse(
	items: ReviewItem[],
	options: ReviewCourseOptions = {},
): StudyPackage {
	const resolved = resolveItems(items);

	const modules: StudyModule[] = [];
	const questions: QuestionBank = {};
	const flashcards: FlashcardDeck = [];
	const lessonContent: Record<string, string> = {};
	const files: StudyFile[] = [];
	const priorities: Record<string, ReturnType<typeof priorityMetadata>> = {};
	let priorityAsOf: string | null = null;

	for (const { event, priority } of resolved) {
		const { ids, lesson, markdown, question, flashcard } = buildErrorLesson(event, priority);
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
		if (priority) {
			priorities[ids.dedupeKey] = priorityMetadata(priority);
			priorityAsOf ??= priority.features.asOf;
		}
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
					phase: "2C",
					dedupeKeys: resolved.map((r) => dedupeKey(r.event)),
					eventIds: resolved.map((r) => r.event.eventId),
					...(priorityAsOf ? { priorityAsOf, priorities } : {}),
				},
			},
		},
		questions,
		flashcards,
		lessonContent,
		files,
	};
}
