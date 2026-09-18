import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildStudy, readStudy, validateCrossReferences } from "../src/index.ts";
import { buildErrorCourse, errorEventSchema } from "./error-event.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
	console.error("usage: build-error-event.mts <error-event.json> <output.study>");
	process.exit(1);
}

const event = errorEventSchema.parse(
	JSON.parse(await readFile(resolve(input), "utf8")),
);
const bytes = buildStudy(buildErrorCourse(event));

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
	`   course=${restored.manifest.id} modules=${restored.manifest.modules.length} lessons=${lessons.length} questions=${Object.keys(restored.questions ?? {}).length} flashcards=${restored.flashcards?.length ?? 0}`,
);
