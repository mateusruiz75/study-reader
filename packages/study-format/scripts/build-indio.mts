import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildStudy,
  type StudyFile,
  type StudyPackage,
} from "../src/index.ts";

const source = join(
  import.meta.dirname,
  "../../../courses/indio-fiscal"
);

async function collectFiles(
  dir: string,
  base = dir,
): Promise<StudyFile[]> {
  const entries = await readdir(dir);
  const files: StudyFile[] = [];

  for (const entry of entries) {
    const full = join(dir, entry);

    if ((await stat(full)).isDirectory()) {
      files.push(...(await collectFiles(full, base)));
    } else {
      files.push({
        path: full
          .slice(base.length + 1)
          .replaceAll("\\", "/"),
        data: new Uint8Array(await readFile(full)),
      });
    }
  }

  return files;
}

const [manifestRaw, questionsRaw, flashcardsRaw, files] =
  await Promise.all([
    readFile(join(source, "manifest.json"), "utf8"),
    readFile(
      join(source, "questions/questions.json"),
      "utf8",
    ),
    readFile(
      join(source, "flashcards/flashcards.json"),
      "utf8",
    ),
    collectFiles(source),
  ]);

const pkg: StudyPackage = {
  manifest: JSON.parse(manifestRaw),
  questions: JSON.parse(questionsRaw),
  flashcards: JSON.parse(flashcardsRaw),
  lessonContent: {},
  files,
};

const output = join(
  import.meta.dirname,
  "../../../examples/INDIO-FISCAL.study",
);

await mkdir(
  join(import.meta.dirname, "../../../examples"),
  { recursive: true },
);

await writeFile(output, buildStudy(pkg));

console.log(`✅ ${output}`);