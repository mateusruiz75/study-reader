import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildStudy, readStudy, validateCrossReferences } from "../src/index.ts";
import { adaptLedger, selectTechnicalBatch } from "./adapters/error-notebook-ledger.ts";
import { buildReviewCourse } from "./review-course.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		limit: { type: "string", default: "10" },
		"per-materia": { type: "string", default: "2" },
		version: { type: "string", default: "1" },
	},
});
const input = positionals[0] ?? process.env.INDIO_LEDGER;
const output = positionals[1] ?? "examples/INDIO-REVISAO.study";
if (!input) {
	console.error(
		"usage: build-review.mts <ledger.json | $INDIO_LEDGER> [output.study] [--limit 10] [--per-materia 2] [--version 1]",
	);
	process.exit(1);
}

const adapted = adaptLedger(JSON.parse(await readFile(resolve(input), "utf8")));
const batch = selectTechnicalBatch(
	adapted.events,
	Number(values.limit),
	Number(values["per-materia"]),
);
const bytes = buildStudy(buildReviewCourse(batch, { version: Number(values.version) }));

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

const lessons = restored.manifest.modules.flatMap((m) => m.lessons);
console.log(`✅ ${target} (${bytes.length} bytes)`);
console.log(
	`   source: errors=${adapted.errorsSeen} usable-unique=${adapted.events.length} duplicates-removed=${adapted.duplicatesRemoved} skipped=${JSON.stringify(adapted.skipped)}`,
);
console.log(
	`   course=${restored.manifest.id} v${restored.manifest.version} modules=${restored.manifest.modules.length} lessons=${lessons.length} questions=${Object.keys(restored.questions ?? {}).length} flashcards=${restored.flashcards?.length ?? 0}`,
);
for (const module of restored.manifest.modules) {
	console.log(`   - ${module.title}: ${module.lessons.map((l) => l.id).join(", ")}`);
}
