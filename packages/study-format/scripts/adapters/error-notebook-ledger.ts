import { z } from "zod";
import { errorEventSchema, type ErrorEvent } from "../error-event.ts";

export const ERROR_RECORDED = "knowledge.error_recorded";

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
	errorsSeen: number;
	skipped: Record<SkipReason, number>;
	duplicatesRemoved: number;
};

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
	for (const item of entries) {
		const entry = ledgerEntrySchema.safeParse(item);
		if (!entry.success) {
			skipped["invalid-entry"]++;
			continue;
		}
		if (entry.data.eventType !== ERROR_RECORDED) {
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
		errorsSeen: errors.length,
		skipped,
		duplicatesRemoved: usable - latest.size,
	};
}

export function selectTechnicalBatch(
	events: ErrorEvent[],
	limit = 10,
	perMateria = 2,
): ErrorEvent[] {
	const byMateria = new Map<string, ErrorEvent[]>();
	for (const event of events) {
		const list = byMateria.get(event.materia) ?? [];
		list.push(event);
		byMateria.set(event.materia, list);
	}
	const selected: ErrorEvent[] = [];
	for (const materia of [...byMateria.keys()].sort((a, b) => a.localeCompare(b, "pt-BR"))) {
		const newestFirst = byMateria
			.get(materia)!
			.sort((a, b) =>
				a.timestamp !== b.timestamp
					? b.timestamp.localeCompare(a.timestamp)
					: b.eventId.localeCompare(a.eventId),
			);
		for (const event of newestFirst.slice(0, perMateria)) {
			if (selected.length >= limit) return selected;
			selected.push(event);
		}
	}
	return selected;
}
