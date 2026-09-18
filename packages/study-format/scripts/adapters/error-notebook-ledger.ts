import { z } from "zod";
import { errorEventSchema, type ErrorEvent } from "../error-event.ts";
import type { AttemptRecord, AttemptResult } from "../review-priority.ts";

export const ERROR_RECORDED = "knowledge.error_recorded";
export const ANSWER_RECORDED = "knowledge.answer_recorded";

const ledgerEntrySchema = z
	.object({
		eventId: z.string().min(1),
		eventType: z.string(),
		questionId: z.string().min(1),
		materia: z.string().min(1),
		assunto: z.string().nullable().optional(),
		urlCanonica: z.string().nullable().optional(),
		respostaUsuario: z.string().nullable().optional(),
		occurredAt: z.string(),
		date: z.string().optional(),
		content: z.unknown().optional(),
		sourceEventId: z.string().nullable().optional(),
	})
	.passthrough();

const contentSchema = z.object({
	statement: z.string().min(1),
	alternatives: z
		.array(z.object({ label: z.string().min(1), text: z.string().min(1) }))
		.min(2),
	correctAnswer: z.string().min(1),
});

export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

export type SkipReason = "not-error" | "invalid-entry" | "no-content" | "invalid-event";

export type AdaptResult = {
	events: ErrorEvent[];
	attempts: AttemptRecord[];
	latestEventAt: string | null;
	errorsSeen: number;
	answersSeen: number;
	skipped: Record<SkipReason, number>;
	duplicatesRemoved: number;
};

export function attemptResult(entry: LedgerEntry): AttemptResult | undefined {
	if (entry.eventType === ERROR_RECORDED) return "error";
	if (entry.eventType !== ANSWER_RECORDED) return undefined;
	const content = contentSchema.safeParse(entry.content);
	if (content.success && entry.respostaUsuario) {
		return entry.respostaUsuario === content.data.correctAnswer ? "correct" : "error";
	}
	if (/_acertou:/.test(entry.sourceEventId ?? "")) return "correct";
	if (/_errou:/.test(entry.sourceEventId ?? "")) return "error";
	return "unknown";
}

export function toAttempt(entry: LedgerEntry): AttemptRecord | undefined {
	const result = attemptResult(entry);
	if (!result) return undefined;
	return {
		questionId: entry.questionId,
		materia: entry.materia,
		eventId: entry.eventId,
		occurredAt: entry.occurredAt,
		result,
		respostaUsuario: entry.respostaUsuario ?? null,
	};
}

export function adaptLedgerEntry(
	entry: LedgerEntry,
	recorrencia: number,
): ErrorEvent | undefined {
	const content = contentSchema.safeParse(entry.content);
	if (!content.success || !entry.respostaUsuario) return undefined;
	const candidate = {
		eventId: entry.eventId,
		timestamp: entry.occurredAt,
		source: "tec",
		banca: null,
		ano: null,
		materia: entry.materia,
		assunto: entry.assunto ?? null,
		questionId: entry.questionId,
		enunciado: content.data.statement,
		alternativas: content.data.alternatives.map((a) => ({ id: a.label, text: a.text })),
		respostaMarcada: [entry.respostaUsuario],
		respostaCorreta: [content.data.correctAnswer],
		explicacaoOriginal: null,
		recorrencia,
		notebookId: null,
		raw: entry,
	};
	const parsed = errorEventSchema.safeParse(candidate);
	return parsed.success ? parsed.data : undefined;
}

function isNewer(a: LedgerEntry, b: LedgerEntry): boolean {
	if (a.occurredAt !== b.occurredAt) return a.occurredAt > b.occurredAt;
	return a.eventId > b.eventId;
}

export function adaptLedger(raw: unknown): AdaptResult {
	const entries = z.array(z.unknown()).parse(raw);
	const skipped: Record<SkipReason, number> = {
		"not-error": 0,
		"invalid-entry": 0,
		"no-content": 0,
		"invalid-event": 0,
	};
	const errors: LedgerEntry[] = [];
	const attempts: AttemptRecord[] = [];
	let answersSeen = 0;
	let latestEventAt: string | null = null;
	for (const item of entries) {
		const entry = ledgerEntrySchema.safeParse(item);
		if (!entry.success) {
			skipped["invalid-entry"]++;
			continue;
		}
		if (latestEventAt === null || entry.data.occurredAt > latestEventAt) {
			latestEventAt = entry.data.occurredAt;
		}
		const attempt = toAttempt(entry.data);
		if (attempt) attempts.push(attempt);
		if (entry.data.eventType !== ERROR_RECORDED) {
			if (entry.data.eventType === ANSWER_RECORDED) answersSeen++;
			skipped["not-error"]++;
			continue;
		}
		errors.push(entry.data);
	}

	const recurrence = new Map<string, number>();
	for (const entry of errors) {
		recurrence.set(entry.questionId, (recurrence.get(entry.questionId) ?? 0) + 1);
	}

	const latest = new Map<string, LedgerEntry>();
	let usable = 0;
	for (const entry of errors) {
		if (!contentSchema.safeParse(entry.content).success) {
			skipped["no-content"]++;
			continue;
		}
		usable++;
		const current = latest.get(entry.questionId);
		if (!current || isNewer(entry, current)) latest.set(entry.questionId, entry);
	}

	const events: ErrorEvent[] = [];
	for (const entry of latest.values()) {
		const event = adaptLedgerEntry(entry, recurrence.get(entry.questionId) ?? 1);
		if (event) events.push(event);
		else skipped["invalid-event"]++;
	}
	events.sort((a, b) => (a.questionId ?? "").localeCompare(b.questionId ?? ""));

	return {
		events,
		attempts,
		latestEventAt,
		errorsSeen: errors.length,
		answersSeen,
		skipped,
		duplicatesRemoved: usable - latest.size,
	};
}
