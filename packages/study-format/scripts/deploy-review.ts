import { strFromU8, strToU8, unzipSync } from "fflate";
import { createHash } from "node:crypto";
import { readStudy, validateCrossReferences, type StudyManifest } from "../src/index.ts";
import { REVIEW_COURSE_ID } from "./review-course.ts";

export const REMOTE_DIR = "/sdcard/koreader/studyreader/courses";
export const REMOTE_FILE = `${REMOTE_DIR}/INDIO-REVISAO.study`;
export const REMOTE_TMP = `${REMOTE_FILE}.tmp`;
export const REMOTE_DATA_DIR = `/sdcard/koreader/studyreader/data/${REVIEW_COURSE_ID}`;
export const STATE_FILES = ["progress.json", "answers.json", "reviews.json"] as const;
export const KOREADER_PACKAGE = "org.koreader.launcher";
export const BACKUP_ROOT = ".indio-virtual/deploy-backups";
export const BACKUP_FILE = "INDIO-REVISAO.study";

export class DeployError extends Error {}

export type AdbResult = { code: number; stdout: string; stderr: string };
export type AdbRunner = (args: string[]) => Promise<AdbResult>;

export type DeployIO = {
	adb: AdbRunner;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, data: Uint8Array): Promise<void>;
	mkdir(path: string): Promise<void>;
	now(): Date;
};

export type DeployOptions = {
	serial: string | undefined;
	dryRun: boolean;
	restartKoreader: boolean;
	backupRoot: string;
	localPath: string;
	tempDir: string;
	build: (version: number) => Uint8Array;
	expectedLessons: number;
};

export type StateHashes = Partial<Record<(typeof STATE_FILES)[number], string | null>>;

export type DeployReport = {
	status: "NO CHANGE" | "DEPLOYED" | "DRY RUN";
	wouldDeploy: boolean;
	serial: string;
	remotePath: string;
	remoteShaBefore: string | null;
	remoteVersion: number | null;
	localVersion: number;
	localSha: string;
	logicallyEqual: boolean;
	backupDir: string | null;
	tempSha: string | null;
	finalSha: string | null;
	stateBefore: StateHashes;
	stateAfter: StateHashes;
	restarted: boolean;
};

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export type ValidationResult = { manifest?: StudyManifest; errors: string[] };

export function validateReviewPackage(
	bytes: Uint8Array,
	options: { expectedLessons: number },
): ValidationResult {
	let restored: ReturnType<typeof readStudy>;
	try {
		restored = readStudy(bytes, { loadLessons: true });
	} catch (error) {
		return { errors: [`package unreadable: ${error instanceof Error ? error.message : String(error)}`] };
	}
	const errors = validateCrossReferences(restored);
	const { manifest } = restored;
	if (manifest.id !== REVIEW_COURSE_ID) {
		errors.push(`manifest.id is '${manifest.id}', expected '${REVIEW_COURSE_ID}'`);
	}
	const lessons = manifest.modules.flatMap((m) => m.lessons);
	if (lessons.length !== options.expectedLessons) {
		errors.push(`expected ${options.expectedLessons} lessons, found ${lessons.length}`);
	}
	const seenLessons = new Set<string>();
	for (const lesson of lessons) {
		if (seenLessons.has(lesson.id)) errors.push(`duplicate lesson id: ${lesson.id}`);
		seenLessons.add(lesson.id);
		if (!(lesson.content in restored.lessonContent)) errors.push(`missing lesson file: ${lesson.content}`);
	}
	const seenModules = new Set<string>();
	for (const module of manifest.modules) {
		if (seenModules.has(module.id)) errors.push(`duplicate module id: ${module.id}`);
		seenModules.add(module.id);
	}
	const seenCards = new Set<string>();
	for (const card of restored.flashcards ?? []) {
		if (seenCards.has(card.id)) errors.push(`duplicate flashcard id: ${card.id}`);
		seenCards.add(card.id);
	}
	if (restored.files.some((f) => f.path.includes("\\"))) errors.push("non-portable path in archive");
	return { manifest, errors };
}

export function logicalKey(bytes: Uint8Array): string {
	const entries = unzipSync(bytes);
	const hash = createHash("sha256");
	for (const path of Object.keys(entries).sort()) {
		let data = entries[path];
		if (path === "manifest.json") {
			const manifest = JSON.parse(strFromU8(data)) as Record<string, unknown>;
			delete manifest.version;
			data = strToU8(JSON.stringify(manifest));
		}
		hash.update(path).update("\0").update(data).update("\0");
	}
	return hash.digest("hex");
}

function parseSha(stdout: string): string | null {
	const match = stdout.trim().match(/^([0-9a-f]{64})\b/i);
	return match ? match[1].toLowerCase() : null;
}

function backupStamp(now: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

export type ConnectedDevice = { serial: string; model: string | null };

export async function requireDevice(
	adb: AdbRunner,
	serial: string,
	fail: (message: string) => Error = (message) => new DeployError(message),
): Promise<ConnectedDevice> {
	const devices = await adb(["devices", "-l"]);
	if (devices.code !== 0) throw fail(`adb devices failed: ${(devices.stderr || devices.stdout).trim()}`);
	for (const line of devices.stdout.split("\n")) {
		const [id, state, ...rest] = line.trim().split(/\s+/);
		if (id === serial && state === "device") {
			const model = rest.find((token) => token.startsWith("model:"))?.slice("model:".length) ?? null;
			return { serial, model };
		}
	}
	throw fail(`device ${serial} is not connected (or not authorized)`);
}

export async function deployReview(options: DeployOptions, io: DeployIO): Promise<DeployReport> {
	const serial = options.serial?.trim();
	if (!serial) throw new DeployError("an explicit --serial is required (never uses the default adb device)");

	const adb = async (args: string[]): Promise<AdbResult> => io.adb(["-s", serial, ...args]);
	const shell = (...argv: string[]) => adb(["shell", ...argv]);
	const must = (result: AdbResult, what: string): AdbResult => {
		if (result.code !== 0) throw new DeployError(`${what} failed: ${(result.stderr || result.stdout).trim()}`);
		return result;
	};

	await requireDevice(io.adb, serial);

	if ((await shell("ls", "-d", REMOTE_DIR)).code !== 0) {
		throw new DeployError(`destination directory missing on device: ${REMOTE_DIR}`);
	}

	const remoteHash = async (path: string): Promise<string | null> => {
		const result = await shell("sha256sum", path);
		if (result.code !== 0) return null;
		const sha = parseSha(result.stdout);
		if (!sha) throw new DeployError(`cannot parse sha256sum output for ${path}: ${result.stdout.trim()}`);
		return sha;
	};
	const stateHashes = async (): Promise<StateHashes> => {
		const hashes: StateHashes = {};
		for (const name of STATE_FILES) hashes[name] = await remoteHash(`${REMOTE_DATA_DIR}/${name}`);
		return hashes;
	};

	const remoteShaBefore = await remoteHash(REMOTE_FILE);
	let remoteVersion: number | null = null;
	let remoteLogicalKey: string | null = null;
	let backupDir: string | null = null;
	let previous: Uint8Array | null = null;

	let remoteManifest: StudyManifest | null = null;
	if (remoteShaBefore) {
		await io.mkdir(options.tempDir);
		const pulled = `${options.tempDir}/${BACKUP_FILE}`;
		must(await adb(["pull", REMOTE_FILE, pulled]), "adb pull of the current package");
		previous = await io.readFile(pulled);
		if (sha256(previous) !== remoteShaBefore) {
			throw new DeployError("pulled package does not match the remote sha256; aborting");
		}
		try {
			remoteManifest = readStudy(previous).manifest;
		} catch (error) {
			throw new DeployError(
				`remote package is not a readable .study: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (remoteManifest.id !== REVIEW_COURSE_ID) {
			throw new DeployError(
				`unexpected course at ${REMOTE_FILE}: manifest.id is '${remoteManifest.id}', expected '${REVIEW_COURSE_ID}'`,
			);
		}
		remoteVersion = remoteManifest.version;
		remoteLogicalKey = logicalKey(previous);
	}

	const baseVersion = remoteVersion ?? 1;
	const candidate = options.build(baseVersion);
	const candidateSha = sha256(candidate);
	const logicallyEqual = remoteLogicalKey !== null && logicalKey(candidate) === remoteLogicalKey;
	const unchanged = candidateSha === remoteShaBefore || logicallyEqual;

	const base: Omit<DeployReport, "status" | "wouldDeploy" | "localVersion" | "localSha"> = {
		serial,
		remotePath: REMOTE_FILE,
		remoteShaBefore,
		remoteVersion,
		logicallyEqual,
		backupDir,
		tempSha: null,
		finalSha: null,
		stateBefore: {},
		stateAfter: {},
		restarted: false,
	};

	if (unchanged) {
		return {
			...base,
			status: options.dryRun ? "DRY RUN" : "NO CHANGE",
			wouldDeploy: false,
			localVersion: baseVersion,
			localSha: candidateSha,
		};
	}

	const localVersion = remoteVersion === null ? 1 : remoteVersion + 1;
	const bytes = localVersion === baseVersion ? candidate : options.build(localVersion);
	const validation = validateReviewPackage(bytes, { expectedLessons: options.expectedLessons });
	if (validation.errors.length > 0) {
		throw new DeployError(`package validation failed:\n- ${validation.errors.join("\n- ")}`);
	}
	if (validation.manifest!.version !== localVersion) {
		throw new DeployError(`builder produced version ${validation.manifest!.version}, expected ${localVersion}`);
	}
	const localSha = sha256(bytes);
	await io.writeFile(options.localPath, bytes);

	if (options.dryRun) {
		return { ...base, status: "DRY RUN", wouldDeploy: true, localVersion, localSha };
	}

	if (previous && remoteManifest) {
		backupDir = `${options.backupRoot}/${backupStamp(io.now())}`;
		await io.mkdir(backupDir);
		await io.writeFile(`${backupDir}/${BACKUP_FILE}`, previous);
		await io.writeFile(
			`${backupDir}/meta.json`,
			strToU8(
				JSON.stringify(
					{
						serial,
						remotePath: REMOTE_FILE,
						sha256: remoteShaBefore,
						size: previous.length,
						manifestId: remoteManifest.id,
						manifestVersion: remoteManifest.version,
						pulledAt: io.now().toISOString(),
					},
					null,
					"	",
				),
			),
		);
	}

	const stateBefore = await stateHashes();

	must(await adb(["push", options.localPath, REMOTE_TMP]), "adb push");
	const tempSha = await remoteHash(REMOTE_TMP);
	if (tempSha !== localSha) {
		await shell("rm", "-f", REMOTE_TMP);
		throw new DeployError(
			`remote temporary sha256 mismatch (local ${localSha}, remote ${tempSha ?? "missing"}); previous package kept`,
		);
	}
	must(await shell("mv", REMOTE_TMP, REMOTE_FILE), "atomic rename");
	must(await shell("touch", REMOTE_FILE), "touch of the final file");
	const finalSha = await remoteHash(REMOTE_FILE);
	if (finalSha !== localSha) {
		throw new DeployError(`final sha256 mismatch after rename (local ${localSha}, remote ${finalSha ?? "missing"})`);
	}

	const stateAfter = await stateHashes();
	for (const name of STATE_FILES) {
		if (stateBefore[name] !== stateAfter[name]) {
			throw new DeployError(`student state changed during deploy: ${name}`);
		}
	}

	let restarted = false;
	if (options.restartKoreader) {
		must(await shell("am", "force-stop", KOREADER_PACKAGE), "KOReader force-stop");
		must(
			await shell("monkey", "-p", KOREADER_PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"),
			"KOReader relaunch",
		);
		restarted = true;
	}

	return {
		...base,
		status: "DEPLOYED",
		wouldDeploy: true,
		localVersion,
		localSha,
		backupDir,
		tempSha,
		finalSha,
		stateBefore,
		stateAfter,
		restarted,
	};
}
