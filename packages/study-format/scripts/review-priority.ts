import { z } from "zod";
import type { ErrorEvent } from "./error-event.ts";

export type AttemptResult = "error" | "correct" | "unknown";

export type AttemptRecord = {
	questionId: string;
	materia: string;
	eventId: string;
	occurredAt: string;
	result: AttemptResult;
	respostaUsuario: string | null;
};

export type WrongAnswerPattern = "repeated" | "varied" | null;

export type PriorityFeatures = {
	questionId: string;
	asOf: string;
	errorCount: number;
	attemptCount: number;
	correctCount: number;
	unknownCount: number;
	firstErrorAt: string;
	lastErrorAt: string;
	lastAttemptAt: string;
	latestResult: AttemptResult;
	correctAfterLastError: number;
	errorsAfterCorrect: number;
	daysSinceLastError: number;
	recurrence: boolean;
	wrongAnswerPattern: WrongAnswerPattern;
};

export const PRIORITY_BANDS = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export type PriorityBand = (typeof PRIORITY_BANDS)[number];

export type PriorityRule =
	| "relapse-unrecovered"
	| "many-recent-errors"
	| "recurrent-unrecovered"
	| "recurrent-recent"
	| "unrecovered"
	| "partially-recovered"
	| "recovered-recent"
	| "recovered";

export type PriorityClassification = {
	priority: PriorityBand;
	rule: PriorityRule;
	reasons: string[];
};

export const priorityProfileSchema = z.object({
	materiaBoosts: z.record(z.string(), z.number().int().min(0).max(1)).default({}),
});

export type PriorityProfile = z.input<typeof priorityProfileSchema>;

export type PrioritizedError = PriorityClassification & {
	event: ErrorEvent;
	features: PriorityFeatures;
	boost: number;
};

export type RejectionReason = "limit" | "max-per-materia";

export type RejectedError = PrioritizedError & { rejectedBecause: RejectionReason };

export type SelectionOptions = {
	limit: number;
	maxPerMateria: number;
};

export type Selection = {
	selected: PrioritizedError[];
	rejected: RejectedError[];
};

export const RECENT_DAYS = 7;
export const OLD_DAYS = 21;
export const MANY_ERRORS = 3;
export const CONSISTENT_RECOVERY = 2;
export const CONSISTENT_RECOVERY_AFTER_RELAPSE = 3;

const DAY_MS = 86_400_000;

function compareAttempts(a: AttemptRecord, b: AttemptRecord): number {
	if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
	return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

function daysBetween(from: string, to: string): number {
	return Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

export function deriveFeatures(
	attempts: AttemptRecord[],
	asOf: string,
): Map<string, PriorityFeatures> {
	const byQuestion = new Map<string, AttemptRecord[]>();
	for (const attempt of attempts) {
		const list = byQuestion.get(attempt.questionId) ?? [];
		list.push(attempt);
		byQuestion.set(attempt.questionId, list);
	}

	const features = new Map<string, PriorityFeatures>();
	for (const [questionId, list] of byQuestion) {
		const history = [...list].sort(compareAttempts);
		const errors = history.filter((a) => a.result === "error");
		if (errors.length === 0) continue;

		let seenCorrect = false;
		let errorsAfterCorrect = 0;
		let correctAfterLastError = 0;
		for (const attempt of history) {
			if (attempt.result === "correct") {
				seenCorrect = true;
				correctAfterLastError++;
			} else if (attempt.result === "error") {
				if (seenCorrect) errorsAfterCorrect++;
				correctAfterLastError = 0;
			}
		}

		const wrongAnswers = new Set(errors.map((e) => e.respostaUsuario ?? ""));
		const lastError = errors[errors.length - 1];
		const last = history[history.length - 1];

		features.set(questionId, {
			questionId,
			asOf,
			errorCount: errors.length,
			attemptCount: history.length,
			correctCount: history.filter((a) => a.result === "correct").length,
			unknownCount: history.filter((a) => a.result === "unknown").length,
			firstErrorAt: errors[0].occurredAt,
			lastErrorAt: lastError.occurredAt,
			lastAttemptAt: last.occurredAt,
			latestResult: last.result,
			correctAfterLastError,
			errorsAfterCorrect,
			daysSinceLastError: daysBetween(lastError.occurredAt, asOf),
			recurrence: errors.length >= 2,
			wrongAnswerPattern: errors.length < 2 ? null : wrongAnswers.size === 1 ? "repeated" : "varied",
		});
	}
	return features;
}

function plural(n: number, singular: string, pluralForm: string): string {
	return `${n} ${n === 1 ? singular : pluralForm}`;
}

function describeFeatures(f: PriorityFeatures): string[] {
	const reasons = [
		plural(f.errorCount, "erro registrado", "erros registrados"),
		`último erro há ${plural(f.daysSinceLastError, "dia", "dias")}`,
	];
	if (f.errorsAfterCorrect > 0) {
		reasons.push(plural(f.errorsAfterCorrect, "erro após acerto", "erros após acerto"));
	}
	if (f.correctAfterLastError > 0) {
		reasons.push(
			plural(f.correctAfterLastError, "acerto após o último erro", "acertos após o último erro"),
		);
	} else {
		reasons.push("nenhum acerto após o último erro");
	}
	if (f.unknownCount > 0) {
		reasons.push(
			plural(
				f.unknownCount,
				"tentativa com resultado desconhecido",
				"tentativas com resultado desconhecido",
			),
		);
	}
	if (f.wrongAnswerPattern === "repeated") reasons.push("mesma alternativa errada repetida");
	if (f.wrongAnswerPattern === "varied") reasons.push("alternativas erradas variadas");
	return reasons;
}

const RULE_REASONS: Record<PriorityRule, string> = {
	"relapse-unrecovered": "voltou a errar após acerto, sem recuperação consistente",
	"many-recent-errors": `${MANY_ERRORS}+ erros com o último há no máximo ${RECENT_DAYS} dias`,
	"recurrent-unrecovered": "erro recorrente sem recuperação consistente",
	"recurrent-recent": `erro recorrente com o último há no máximo ${RECENT_DAYS} dias`,
	unrecovered: "erro sem acerto posterior",
	"partially-recovered": "apenas 1 acerto após o último erro",
	"recovered-recent": `recuperado, mas o erro tem no máximo ${RECENT_DAYS} dias`,
	recovered: "recuperação consistente após o erro",
};

function pickRule(f: PriorityFeatures): [PriorityBand, PriorityRule] {
	const recent = f.daysSinceLastError <= RECENT_DAYS;
	const old = f.daysSinceLastError > OLD_DAYS;
	const relapsed = f.recurrence && f.errorsAfterCorrect > 0;
	const recovered =
		f.correctAfterLastError >=
		(relapsed ? CONSISTENT_RECOVERY_AFTER_RELAPSE : CONSISTENT_RECOVERY);

	if (relapsed && !recovered) return ["CRITICAL", "relapse-unrecovered"];
	if (f.errorCount >= MANY_ERRORS && recent) return ["CRITICAL", "many-recent-errors"];
	if (f.recurrence && !recovered) return ["HIGH", "recurrent-unrecovered"];
	if (f.recurrence && recent) return ["HIGH", "recurrent-recent"];
	if (f.correctAfterLastError === 0) return ["MEDIUM", "unrecovered"];
	if (!recovered) return [old ? "LOW" : "MEDIUM", "partially-recovered"];
	if (recent) return ["MEDIUM", "recovered-recent"];
	return ["LOW", "recovered"];
}

export function classifyPriority(f: PriorityFeatures): PriorityClassification {
	const [priority, rule] = pickRule(f);
	return { priority, rule, reasons: [RULE_REASONS[rule], ...describeFeatures(f)] };
}

export const BOOST_REASON = "matéria priorizada no perfil";

function comparePrioritized(a: PrioritizedError, b: PrioritizedError): number {
	const band = PRIORITY_BANDS.indexOf(a.priority) - PRIORITY_BANDS.indexOf(b.priority);
	if (band !== 0) return band;
	if (a.boost !== b.boost) return b.boost - a.boost;
	const fa = a.features;
	const fb = b.features;
	if (fa.errorCount !== fb.errorCount) return fb.errorCount - fa.errorCount;
	if (fa.errorsAfterCorrect !== fb.errorsAfterCorrect) return fb.errorsAfterCorrect - fa.errorsAfterCorrect;
	if (fa.correctAfterLastError !== fb.correctAfterLastError) {
		return fa.correctAfterLastError - fb.correctAfterLastError;
	}
	if (fa.lastErrorAt !== fb.lastErrorAt) return fa.lastErrorAt < fb.lastErrorAt ? 1 : -1;
	return fa.questionId < fb.questionId ? -1 : fa.questionId > fb.questionId ? 1 : 0;
}

export function prioritizeEvents(
	events: ErrorEvent[],
	features: Map<string, PriorityFeatures>,
	profile: PriorityProfile = {},
): PrioritizedError[] {
	const { materiaBoosts } = priorityProfileSchema.parse(profile);
	const items: PrioritizedError[] = [];
	for (const event of events) {
		const f = event.questionId ? features.get(event.questionId) : undefined;
		if (!f) throw new Error(`no priority features for question ${event.questionId ?? event.eventId}`);
		const classification = classifyPriority(f);
		const boost = materiaBoosts[event.materia] ?? 0;
		items.push({
			...classification,
			reasons: boost > 0 ? [...classification.reasons, BOOST_REASON] : classification.reasons,
			event,
			features: f,
			boost,
		});
	}
	return items.sort(comparePrioritized);
}

export function selectBalanced(items: PrioritizedError[], options: SelectionOptions): Selection {
	const selected: PrioritizedError[] = [];
	const rejected: RejectedError[] = [];
	const perMateria = new Map<string, number>();
	for (const item of items) {
		const count = perMateria.get(item.event.materia) ?? 0;
		if (count >= options.maxPerMateria) {
			rejected.push({ ...item, rejectedBecause: "max-per-materia" });
		} else if (selected.length >= options.limit) {
			rejected.push({ ...item, rejectedBecause: "limit" });
		} else {
			selected.push(item);
			perMateria.set(item.event.materia, count + 1);
		}
	}
	return { selected, rejected };
}
