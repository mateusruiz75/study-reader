import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildStudy, readStudy, validateCrossReferences } from "../src/index.ts";
import { adaptLedger } from "./adapters/error-notebook-ledger.ts";
import { buildReviewCourse } from "./review-course.ts";
import {
	PRIORITY_BANDS,
	deriveFeatures,
	prioritizeEvents,
	priorityProfileSchema,
	selectBalanced,
	type PrioritizedError,
	type Selection,
} from "./review-priority.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		limit: { type: "string", default: "30" },
		"max-per-materia": { type: "string" },
		"per-materia": { type: "string" },
		"as-of": { type: "string" },
		profile: { type: "string" },
		"priority-report": { type: "string" },
		version: { type: "string", default: "1" },
	},
});
const input = positionals[0] ?? process.env.INDIO_LEDGER;
const output = positionals[1] ?? "examples/INDIO-REVISAO.study";
if (!input) {
	console.error(
		"usage: build-review.mts <ledger.json | $INDIO_LEDGER> [output.study] [--limit 30] [--max-per-materia 6] [--as-of ISO] [--profile profile.json] [--priority-report report.md] [--version 1]",
	);
	process.exit(1);
}

const limit = Number(values.limit);
const maxPerMateria = Number(values["max-per-materia"] ?? values["per-materia"] ?? "6");
const profile = values.profile
	? priorityProfileSchema.parse(JSON.parse(await readFile(resolve(values.profile), "utf8")))
	: {};

const adapted = adaptLedger(JSON.parse(await readFile(resolve(input), "utf8")));
const asOf = values["as-of"] ?? adapted.latestEventAt;
if (!asOf) {
	console.error("ledger has no dated events; pass --as-of");
	process.exit(1);
}
const features = deriveFeatures(adapted.attempts, asOf);
const prioritized = prioritizeEvents(adapted.events, features, profile);
const selection = selectBalanced(prioritized, { limit, maxPerMateria });
const bytes = buildStudy(buildReviewCourse(selection.selected, { version: Number(values.version) }));

const restored = readStudy(bytes, { loadLessons: true });
const errors = validateCrossReferences(restored);
const badPaths = restored.files.filter((f) => f.path.includes("\\"));
if (errors.length > 0 || badPaths.length > 0) {
	for (const error of errors) console.error(error);
	for (const file of badPaths) console.error(`non-portable path: ${file.path}`);
	process.exit(1);
}

const target = resolve(output);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, bytes);

if (values["priority-report"]) {
	const reportPath = resolve(values["priority-report"]);
	await mkdir(dirname(reportPath), { recursive: true });
	await writeFile(reportPath, renderReport(prioritized, selection, asOf));
	console.log(`📄 priority report: ${reportPath}`);
}

const lessons = restored.manifest.modules.flatMap((m) => m.lessons);
const bands = Object.fromEntries(
	PRIORITY_BANDS.map((band) => [band, prioritized.filter((p) => p.priority === band).length]),
);
console.log(`✅ ${target} (${bytes.length} bytes)`);
console.log(
	`   source: errors=${adapted.errorsSeen} answers=${adapted.answersSeen} usable-unique=${adapted.events.length} duplicates-removed=${adapted.duplicatesRemoved} skipped=${JSON.stringify(adapted.skipped)}`,
);
console.log(`   priority: as-of=${asOf} bands=${JSON.stringify(bands)}`);
console.log(
	`   selection: limit=${limit} max-per-materia=${maxPerMateria} selected=${selection.selected.length} rejected=${selection.rejected.length}`,
);
console.log(
	`   course=${restored.manifest.id} v${restored.manifest.version} modules=${restored.manifest.modules.length} lessons=${lessons.length} questions=${Object.keys(restored.questions ?? {}).length} flashcards=${restored.flashcards?.length ?? 0}`,
);
for (const module of restored.manifest.modules) {
	console.log(`   - ${module.title}: ${module.lessons.map((l) => l.id).join(", ")}`);
}

function renderReport(items: PrioritizedError[], selection: Selection, asOf: string): string {
	const selectedKeys = new Set(selection.selected.map((p) => p.event.eventId));
	const rejectedBy = new Map(selection.rejected.map((r) => [r.event.eventId, r.rejectedBecause]));
	const lines = [
		"# INDIO REVISÃO — priority report",
		"",
		`as-of: ${asOf}`,
		`analyzed: ${items.length}`,
		`selected: ${selection.selected.length}`,
		"",
		"| # | questionId | materia | priority | rule | selected | reasons |",
		"| --- | --- | --- | --- | --- | --- | --- |",
	];
	items.forEach((item, index) => {
		const status = selectedKeys.has(item.event.eventId)
			? "YES"
			: `NO (${rejectedBy.get(item.event.eventId) ?? "?"})`;
		lines.push(
			`| ${index + 1} | ${item.event.questionId} | ${item.event.materia} | ${item.priority} | ${item.rule} | ${status} | ${item.reasons.join("; ")} |`,
		);
	});
	return `${lines.join("\n")}\n`;
}
