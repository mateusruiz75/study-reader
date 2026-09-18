import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readStudy, validateCrossReferences } from "../src/index.ts";
import {
	DEFAULT_LIMIT,
	DEFAULT_MAX_PER_MATERIA,
	buildStableStudy,
	runReviewPipeline,
	studyContextFromFiles,
} from "./review-pipeline.ts";
import {
	PRIORITY_BANDS,
	priorityProfileSchema,
	type PrioritizedError,
	type Selection,
} from "./review-priority.ts";

const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();

const { values, positionals } = parseArgs({
	args: argv,
	allowPositionals: true,
	options: {
		limit: { type: "string", default: String(DEFAULT_LIMIT) },
		"max-per-materia": { type: "string" },
		"per-materia": { type: "string" },
		"as-of": { type: "string" },
		profile: { type: "string" },
		"priority-report": { type: "string" },
		feedback: { type: "string" },
		version: { type: "string", default: "1" },
	},
});
const input = positionals[0] ?? process.env.INDIO_LEDGER;
const output = positionals[1] ?? "examples/INDIO-REVISAO.study";
if (!input) {
	console.error(
		"usage: build-review.mts <ledger.json | $INDIO_LEDGER> [output.study] [--limit 30] [--max-per-materia 6] [--as-of ISO] [--profile profile.json] [--feedback .indio-virtual/study-feedback/latest] [--priority-report report.md] [--version 1]",
	);
	process.exit(1);
}

const limit = Number(values.limit);
const maxPerMateria = Number(
	values["max-per-materia"] ?? values["per-materia"] ?? String(DEFAULT_MAX_PER_MATERIA),
);
const profile = values.profile
	? priorityProfileSchema.parse(JSON.parse(await readFile(resolve(values.profile), "utf8")))
	: {};

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const study = values.feedback
	? studyContextFromFiles({
			progress: await readJson(resolve(values.feedback, "progress.json")),
			answers: await readJson(resolve(values.feedback, "answers.json")),
			reviews: await readJson(resolve(values.feedback, "reviews.json")),
			metadata: await readJson(resolve(values.feedback, "metadata.json")),
		})
	: undefined;

const { adapted, asOf, prioritized, selection, pkg } = runReviewPipeline(
	JSON.parse(await readFile(resolve(input), "utf8")),
	{ limit, maxPerMateria, version: Number(values.version), asOf: values["as-of"], profile, study },
);
const bytes = buildStableStudy(pkg);

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
if (study) {
	const signals: Record<string, number> = {};
	for (const item of prioritized) signals[item.study!.signal] = (signals[item.study!.signal] ?? 0) + 1;
	const unknown = study.store.unknownIds;
	console.log(
		`   study feedback: questions=${study.store.byQuestion.size} signals(candidates)=${JSON.stringify(signals)} unknown-ids=${unknown.lessons.length + unknown.quizzes.length + unknown.cards.length}`,
	);
}
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
		"| # | questionId | materia | priority | rule | selected | studySignal | quizCorrect | reviewReps | reviewLapses | reviewInterval | reviewDue | reasons |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	];
	const cell = (value: unknown) => (value === null || value === undefined ? "" : String(value));
	items.forEach((item, index) => {
		const status = selectedKeys.has(item.event.eventId)
			? "YES"
			: `NO (${rejectedBy.get(item.event.eventId) ?? "?"})`;
		const fb = item.study?.feedback;
		lines.push(
			`| ${index + 1} | ${item.event.questionId} | ${item.event.materia} | ${item.priority} | ${item.rule} | ${status} | ${cell(item.study?.signal)} | ${cell(fb?.quizCorrect)} | ${cell(fb?.reviewReps)} | ${cell(fb?.reviewLapses)} | ${cell(fb?.reviewInterval)} | ${cell(fb?.reviewDueAt)} | ${item.reasons.join("; ")} |`,
		);
	});
	return `${lines.join("\n")}\n`;
}
