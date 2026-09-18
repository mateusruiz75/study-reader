import { z } from "zod";

const LESSON_PREFIX = "error-";
const QUIZ_SUFFIX = "-recovery";
const CARD_SUFFIX = "-card";

function between(id: string, prefix: string, suffix: string): string | null {
	if (!id.startsWith(prefix) || !id.endsWith(suffix)) return null;
	const key = id.slice(prefix.length, id.length - suffix.length);
	return key.length > 0 ? key : null;
}

export function questionKeyFromLessonId(id: string): string | null {
	return between(id, LESSON_PREFIX, "");
}

export function questionKeyFromQuizId(id: string): string | null {
	return between(id, "", QUIZ_SUFFIX);
}

export function questionKeyFromCardId(id: string): string | null {
	return between(id, "", CARD_SUFFIX);
}

export const progressFileSchema = z
	.object({
		currentLesson: z.string().nullable().optional(),
		completedLessons: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
	})
	.passthrough();

export const answersFileSchema = z.record(
	z.string(),
	z
		.object({
			selected: z.array(z.string()),
			correct: z.boolean(),
			answeredAt: z.string().optional(),
		})
		.passthrough(),
);

export const reviewsFileSchema = z.record(
	z.string(),
	z
		.object({
			reps: z.number(),
			lapses: z.number(),
			ef: z.number(),
			interval: z.number(),
			due: z.number(),
		})
		.passthrough(),
);

export type StudySnapshot = {
	progress: z.input<typeof progressFileSchema>;
	answers: z.input<typeof answersFileSchema>;
	reviews: z.input<typeof reviewsFileSchema>;
	collectedAt: number;
};

export type StudyFeedback = {
	questionKey: string;
	lessonCompleted: boolean;
	lessonCompletedAt: string | null;
	quizAnswered: boolean;
	quizCorrect: boolean | null;
	quizSelected: string[] | null;
	quizAnsweredAt: string | null;
	reviewReps: number | null;
	reviewLapses: number | null;
	reviewInterval: number | null;
	reviewEase: number | null;
	reviewDueAt: string | null;
};

export type UnknownIds = { lessons: string[]; quizzes: string[]; cards: string[] };

export type StudyFeedbackStore = {
	byQuestion: Map<string, StudyFeedback>;
	unknownIds: UnknownIds;
	collectedAt: number;
};

function emptyFeedback(questionKey: string): StudyFeedback {
	return {
		questionKey,
		lessonCompleted: false,
		lessonCompletedAt: null,
		quizAnswered: false,
		quizCorrect: null,
		quizSelected: null,
		quizAnsweredAt: null,
		reviewReps: null,
		reviewLapses: null,
		reviewInterval: null,
		reviewEase: null,
		reviewDueAt: null,
	};
}

export function normalizeStudyFeedback(snapshot: StudySnapshot): StudyFeedbackStore {
	const progress = progressFileSchema.parse(snapshot.progress);
	const answers = answersFileSchema.parse(snapshot.answers);
	const reviews = reviewsFileSchema.parse(snapshot.reviews);
	const byQuestion = new Map<string, StudyFeedback>();
	const unknownIds: UnknownIds = { lessons: [], quizzes: [], cards: [] };
	const entry = (key: string) => {
		let feedback = byQuestion.get(key);
		if (!feedback) {
			feedback = emptyFeedback(key);
			byQuestion.set(key, feedback);
		}
		return feedback;
	};

	for (const [lessonId, completed] of Object.entries(progress.completedLessons)) {
		if (completed === false) continue;
		const key = questionKeyFromLessonId(lessonId);
		if (!key) {
			unknownIds.lessons.push(lessonId);
			continue;
		}
		const feedback = entry(key);
		feedback.lessonCompleted = true;
		feedback.lessonCompletedAt = typeof completed === "string" ? completed : null;
	}

	for (const [quizId, answer] of Object.entries(answers)) {
		const key = questionKeyFromQuizId(quizId);
		if (!key) {
			unknownIds.quizzes.push(quizId);
			continue;
		}
		const feedback = entry(key);
		feedback.quizAnswered = true;
		feedback.quizCorrect = answer.correct;
		feedback.quizSelected = [...answer.selected];
		feedback.quizAnsweredAt = answer.answeredAt ?? null;
	}

	for (const [cardId, card] of Object.entries(reviews)) {
		const key = questionKeyFromCardId(cardId);
		if (!key) {
			unknownIds.cards.push(cardId);
			continue;
		}
		const feedback = entry(key);
		feedback.reviewReps = card.reps;
		feedback.reviewLapses = card.lapses;
		feedback.reviewInterval = card.interval;
		feedback.reviewEase = card.ef;
		feedback.reviewDueAt = new Date(card.due * 1000).toISOString();
	}

	for (const list of Object.values(unknownIds)) list.sort();
	return { byQuestion, unknownIds, collectedAt: snapshot.collectedAt };
}

export const STUDY_SIGNAL_ORDER = ["LAPSING", "DUE", "UNSEEN", "LEARNING", "STABLE"] as const;
export type StudySignal = (typeof STUDY_SIGNAL_ORDER)[number];

export const STABLE_REPS = 3;

export function isCardDue(feedback: StudyFeedback, nowEpoch: number): boolean {
	return feedback.reviewDueAt !== null && Date.parse(feedback.reviewDueAt) <= nowEpoch * 1000;
}

export function classifyStudySignal(feedback: StudyFeedback | undefined, nowEpoch: number): StudySignal {
	if (!feedback) return "UNSEEN";
	const hasCard = feedback.reviewReps !== null;
	const relearning = hasCard && feedback.reviewReps === 0 && (feedback.reviewLapses ?? 0) > 0;
	if (relearning || feedback.quizCorrect === false) return "LAPSING";
	if (hasCard && isCardDue(feedback, nowEpoch)) return "DUE";
	if (hasCard && (feedback.reviewReps ?? 0) >= STABLE_REPS) return "STABLE";
	if (hasCard || feedback.quizAnswered || feedback.lessonCompleted) return "LEARNING";
	return "UNSEEN";
}

function plural(n: number, singular: string, pluralForm: string): string {
	return `${n} ${n === 1 ? singular : pluralForm}`;
}

export function studyReasons(feedback: StudyFeedback, signal: StudySignal, nowEpoch: number): string[] {
	const reasons: string[] = [];
	if ((feedback.reviewLapses ?? 0) > 0) {
		reasons.push(`StudyReader: ${plural(feedback.reviewLapses!, "lapse no card", "lapses no card")}`);
	}
	if (signal === "DUE" || (feedback.reviewReps !== null && isCardDue(feedback, nowEpoch) && signal !== "LAPSING")) {
		reasons.push("StudyReader: card due");
	}
	if (feedback.quizAnswered) {
		const selected = feedback.quizSelected?.join(", ") ?? "?";
		reasons.push(`StudyReader: quiz ${feedback.quizCorrect ? "correto" : "errado"} (${selected})`);
	}
	if ((feedback.reviewReps ?? 0) > 0) {
		reasons.push(`StudyReader: ${plural(feedback.reviewReps!, "revisão concluída", "revisões concluídas")}`);
	}
	if (feedback.reviewInterval !== null && signal === "STABLE") {
		reasons.push(`StudyReader: intervalo de ${plural(feedback.reviewInterval, "dia", "dias")}`);
	}
	if (feedback.lessonCompleted) reasons.push("StudyReader: aula concluída");
	return reasons;
}
