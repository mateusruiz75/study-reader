import { strToU8 } from "fflate";
import { createHash } from "node:crypto";
import { REVIEW_COURSE_ID } from "./review-course.ts";
import type { AdbResult, AdbRunner } from "./deploy-review.ts";

export const REMOTE_FEEDBACK_DIR = `/sdcard/koreader/studyreader/data/${REVIEW_COURSE_ID}`;
export const FEEDBACK_FILES = ["progress.json", "answers.json", "reviews.json"] as const;
export const FEEDBACK_ROOT = ".indio-virtual/study-feedback";
export const MAX_SNAPSHOT_ATTEMPTS = 2;

export class SyncError extends Error {}

export type SyncIO = {
	adb: AdbRunner;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, data: Uint8Array): Promise<void>;
	mkdir(path: string): Promise<void>;
	now(): Date;
};

export type SyncOptions = {
	serial: string | undefined;
	root: string;
};

export type FeedbackFileMeta = { sha256: string; size: number };

export type FeedbackMetadata = {
	serial: string;
	courseId: string;
	remoteDir: string;
	collectedAt: string;
	collectedAtEpoch: number;
	attempts: number;
	files: Record<string, FeedbackFileMeta>;
};

export type SyncResult = {
	snapshotDir: string;
	latestDir: string;
	attempts: number;
	metadata: FeedbackMetadata;
};

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function stamp(now: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function parseShaLines(stdout: string): Map<string, string> {
	const hashes = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const match = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/i);
		if (match) hashes.set(match[2].trim(), match[1].toLowerCase());
	}
	return hashes;
}

export async function syncFeedback(options: SyncOptions, io: SyncIO): Promise<SyncResult> {
	const serial = options.serial?.trim();
	if (!serial) throw new SyncError("an explicit --serial is required (never uses the default adb device)");

	const adb = (args: string[]): Promise<AdbResult> => io.adb(["-s", serial, ...args]);
	const must = (result: AdbResult, what: string): AdbResult => {
		if (result.code !== 0) throw new SyncError(`${what} failed: ${(result.stderr || result.stdout).trim()}`);
		return result;
	};

	const devices = must(await io.adb(["devices", "-l"]), "adb devices");
	const connected = devices.stdout
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.some(([id, state]) => id === serial && state === "device");
	if (!connected) throw new SyncError(`device ${serial} is not connected (or not authorized)`);

	if ((await adb(["shell", "ls", "-d", REMOTE_FEEDBACK_DIR])).code !== 0) {
		throw new SyncError(`remote feedback directory missing: ${REMOTE_FEEDBACK_DIR}`);
	}

	const remotePaths = FEEDBACK_FILES.map((name) => `${REMOTE_FEEDBACK_DIR}/${name}`);
	const remoteHashes = async (): Promise<Map<string, string>> => {
		const result = must(await adb(["shell", "sha256sum", ...remotePaths]), "remote sha256sum");
		const hashes = parseShaLines(result.stdout);
		for (const path of remotePaths) {
			if (!hashes.has(path)) throw new SyncError(`cannot hash ${path}: ${result.stdout.trim()}`);
		}
		return hashes;
	};

	const now = io.now();
	const snapshotDir = `${options.root}/snapshots/${stamp(now)}`;
	const latestDir = `${options.root}/latest`;
	const pullDir = `${options.root}/.pull`;
	await io.mkdir(pullDir);

	let attempts = 0;
	let files: Record<string, FeedbackFileMeta> | null = null;
	let pulled: Map<string, Uint8Array> | null = null;
	while (attempts < MAX_SNAPSHOT_ATTEMPTS && files === null) {
		attempts++;
		const before = await remoteHashes();
		const data = new Map<string, Uint8Array>();
		for (const name of FEEDBACK_FILES) {
			const remote = `${REMOTE_FEEDBACK_DIR}/${name}`;
			const local = `${pullDir}/${name}`;
			must(await adb(["pull", remote, local]), `adb pull ${name}`);
			data.set(name, await io.readFile(local));
		}
		const after = await remoteHashes();
		const consistent = FEEDBACK_FILES.every((name) => {
			const remote = `${REMOTE_FEEDBACK_DIR}/${name}`;
			return before.get(remote) === after.get(remote) && sha256(data.get(name)!) === after.get(remote);
		});
		if (consistent) {
			pulled = data;
			files = Object.fromEntries(
				FEEDBACK_FILES.map((name) => [name, { sha256: sha256(data.get(name)!), size: data.get(name)!.length }]),
			);
		}
	}
	if (files === null || pulled === null) {
		throw new SyncError(`STATE CHANGED DURING SNAPSHOT after ${attempts} attempts; nothing written to snapshots/ or latest/`);
	}

	const metadata: FeedbackMetadata = {
		serial,
		courseId: REVIEW_COURSE_ID,
		remoteDir: REMOTE_FEEDBACK_DIR,
		collectedAt: now.toISOString(),
		collectedAtEpoch: Math.floor(now.getTime() / 1000),
		attempts,
		files,
	};
	const metadataBytes = strToU8(JSON.stringify(metadata, null, "\t"));
	for (const dir of [snapshotDir, latestDir]) {
		await io.mkdir(dir);
		for (const name of FEEDBACK_FILES) await io.writeFile(`${dir}/${name}`, pulled.get(name)!);
		await io.writeFile(`${dir}/metadata.json`, metadataBytes);
	}

	return { snapshotDir, latestDir, attempts, metadata };
}
