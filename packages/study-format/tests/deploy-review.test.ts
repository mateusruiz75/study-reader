import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync } from "fflate";
import { createHash } from "node:crypto";
import { readStudy } from "../src/index.ts";
import type { ErrorEvent } from "../scripts/error-event.ts";
import { buildReviewCourse } from "../scripts/review-course.ts";
import { buildStableStudy } from "../scripts/review-pipeline.ts";
import {
	BACKUP_ROOT,
	DeployError,
	KOREADER_PACKAGE,
	REMOTE_DATA_DIR,
	REMOTE_DIR,
	REMOTE_FILE,
	REMOTE_TMP,
	STATE_FILES,
	deployReview,
	logicalKey,
	validateReviewPackage,
	type AdbRunner,
	type DeployIO,
	type DeployOptions,
} from "../scripts/deploy-review.ts";

const SERIAL = "RX2X102891H";
const AS_OF = "2026-09-17T12:00:00.000Z";

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function event(questionId: string, materia: string, marked = "A"): ErrorEvent {
	return {
		eventId: `ev-${questionId}`,
		timestamp: "2026-09-10T10:00:00.000Z",
		source: "tec",
		banca: null,
		ano: null,
		materia,
		assunto: `Assunto ${questionId}`,
		questionId,
		enunciado: "Questão sintética de teste (não é conteúdo real).",
		alternativas: [
			{ id: "A", text: "Alternativa A" },
			{ id: "B", text: "Alternativa B" },
		],
		respostaMarcada: [marked],
		respostaCorreta: ["B"],
		explicacaoOriginal: null,
		recorrencia: 1,
		notebookId: null,
		raw: {},
	};
}

const EVENTS = [event("q-1", "Direito Tributário"), event("q-2", "Contabilidade Geral")];

function build(version: number, events = EVENTS): Uint8Array {
	return buildStableStudy(buildReviewCourse(events, { version }), new Date(AS_OF));
}

type FakeDevice = {
	serial: string;
	state: string;
	files: Map<string, Uint8Array>;
	dirs: Set<string>;
};

function fakeWorld(options: { devices?: FakeDevice[]; localFiles?: Map<string, Uint8Array> } = {}) {
	const devices = options.devices ?? [];
	const local = options.localFiles ?? new Map<string, Uint8Array>();
	const calls: string[][] = [];
	const shellLog: string[] = [];

	const adb: AdbRunner = async (args) => {
		calls.push(args);
		const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
		const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });
		if (args[0] === "devices") {
			return ok(
				`List of devices attached\n${devices.map((d) => `${d.serial}\t${d.state} product:x model:y`).join("\n")}\n`,
			);
		}
		if (args[0] !== "-s") return fail("no serial");
		const device = devices.find((d) => d.serial === args[1] && d.state === "device");
		if (!device) return fail(`device '${args[1]}' not found`);
		const rest = args.slice(2);
		if (rest[0] === "shell") {
			const cmd = rest.slice(1).join(" ");
			shellLog.push(cmd);
			const [bin, ...argv] = rest.slice(1);
			if (bin === "ls" && argv[0] === "-d") {
				return device.dirs.has(argv[1]) ? ok(`${argv[1]}\n`) : fail(`ls: ${argv[1]}: No such file or directory`);
			}
			if (bin === "sha256sum") {
				const data = device.files.get(argv[0]);
				return data ? ok(`${sha256(data)}  ${argv[0]}\n`) : fail(`sha256sum: ${argv[0]}: No such file or directory`);
			}
			if (bin === "mv") {
				const data = device.files.get(argv[0]);
				if (!data) return fail("mv: missing");
				device.files.delete(argv[0]);
				device.files.set(argv[1], data);
				return ok();
			}
			if (bin === "rm") {
				device.files.delete(argv[argv.length - 1]);
				return ok();
			}
			if (bin === "touch") return device.files.has(argv[0]) ? ok() : fail("touch: missing");
			if (bin === "am" || bin === "monkey") return ok();
			return fail(`unknown shell command ${cmd}`);
		}
		if (rest[0] === "pull") {
			const data = device.files.get(rest[1]);
			if (!data) return fail("remote object does not exist");
			local.set(rest[2], data);
			return ok("1 file pulled");
		}
		if (rest[0] === "push") {
			const data = local.get(rest[1]);
			if (!data) return fail("local file missing");
			device.files.set(rest[2], data);
			return ok("1 file pushed");
		}
		return fail(`unknown adb command ${rest.join(" ")}`);
	};

	const io: DeployIO = {
		adb,
		readFile: async (path) => {
			const data = local.get(path);
			if (!data) throw new Error(`missing local file ${path}`);
			return data;
		},
		writeFile: async (path, data) => {
			local.set(path, data);
		},
		mkdir: async () => {},
		now: () => new Date("2026-09-18T10:00:00.000Z"),
	};

	return { adb, io, calls, shellLog, local, devices };
}

function tablet(files: Record<string, Uint8Array> = {}, state = "device"): FakeDevice {
	return {
		serial: SERIAL,
		state,
		files: new Map(Object.entries(files)),
		dirs: new Set([REMOTE_DIR, REMOTE_DATA_DIR]),
	};
}

const CHANGED: Partial<DeployOptions> = { build: (v) => build(v, [EVENTS[0]]), expectedLessons: 1 };

function options(overrides: Partial<DeployOptions> = {}): DeployOptions {
	return {
		serial: SERIAL,
		dryRun: false,
		restartKoreader: false,
		backupRoot: BACKUP_ROOT,
		localPath: "examples/INDIO-REVISAO.study",
		tempDir: "tmp/deploy",
		build: (version) => build(version),
		expectedLessons: 2,
		...overrides,
	};
}

describe("phase 2D: package validation", () => {
	it("accepts a valid review package with the expected lesson count", () => {
		const result = validateReviewPackage(build(1), { expectedLessons: 2 });

		expect(result.errors).toEqual([]);
		expect(result.manifest?.id).toBe("indio-revisao");
		expect(result.manifest?.version).toBe(1);
	});

	it("rejects a package whose manifest.id is not indio-revisao", () => {
		const pkg = buildReviewCourse(EVENTS, { version: 1 });
		pkg.manifest.id = "outro-curso";
		const result = validateReviewPackage(buildStableStudy(pkg, new Date(AS_OF)), { expectedLessons: 2 });

		expect(result.errors).toContain("manifest.id is 'outro-curso', expected 'indio-revisao'");
	});

	it("rejects a package with an unexpected lesson count", () => {
		const result = validateReviewPackage(build(1), { expectedLessons: 30 });

		expect(result.errors).toContain("expected 30 lessons, found 2");
	});

	it("rejects an invalid or corrupt package", () => {
		const result = validateReviewPackage(strToU8("not a zip"), { expectedLessons: 2 });

		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.manifest).toBeUndefined();
	});

	it("rejects duplicated lesson ids", () => {
		const pkg = buildReviewCourse(EVENTS, { version: 1 });
		pkg.manifest.modules[0].lessons.push({ ...pkg.manifest.modules[1].lessons[0] });
		const result = validateReviewPackage(buildStableStudy(pkg, new Date(AS_OF)), { expectedLessons: 3 });

		expect(result.errors.some((e) => e.includes("duplicate lesson id"))).toBe(true);
	});
});

describe("phase 2D: stable bytes and logical key", () => {
	it("produces identical bytes for identical content", () => {
		expect(sha256(build(1))).toBe(sha256(build(1)));
	});

	it("changes bytes when the version changes but keeps the logical key", () => {
		expect(sha256(build(1))).not.toBe(sha256(build(2)));
		expect(logicalKey(build(1))).toBe(logicalKey(build(2)));
	});

	it("changes the logical key when content changes", () => {
		expect(logicalKey(build(1))).not.toBe(logicalKey(build(1, [EVENTS[0]])));
	});
});

describe("phase 2D: safe deploy", () => {
	it("requires an explicit serial", async () => {
		const { io } = fakeWorld({ devices: [tablet()] });

		await expect(deployReview(options({ serial: undefined }), io)).rejects.toThrow(DeployError);
		await expect(deployReview(options({ serial: "" }), io)).rejects.toThrow(/serial/);
	});

	it("fails when the device is not connected", async () => {
		const { io, calls } = fakeWorld({ devices: [] });

		await expect(deployReview(options(), io)).rejects.toThrow(/not connected/);
		expect(calls.some((c) => c[0] === "push" || c.includes("push"))).toBe(false);
	});

	it("fails when the device is unauthorized", async () => {
		const { io } = fakeWorld({ devices: [tablet({}, "unauthorized")] });

		await expect(deployReview(options(), io)).rejects.toThrow(/not connected/);
	});

	it("fails when the remote courses directory is missing", async () => {
		const device = tablet();
		device.dirs.delete(REMOTE_DIR);
		const { io } = fakeWorld({ devices: [device] });

		await expect(deployReview(options(), io)).rejects.toThrow(/destination/);
	});

	it("always passes -s <serial> to every adb command after the device listing", async () => {
		const { io, calls } = fakeWorld({ devices: [tablet({ [REMOTE_FILE]: build(1) })] });

		await deployReview(options({ restartKoreader: true, ...CHANGED }), io);

		const commands = calls.filter((c) => c[0] !== "devices");
		expect(commands.length).toBeGreaterThan(5);
		for (const command of commands) expect(command.slice(0, 2)).toEqual(["-s", SERIAL]);
	});

	it("reports NO CHANGE when the remote sha matches and does not push", async () => {
		const { io, calls } = fakeWorld({ devices: [tablet({ [REMOTE_FILE]: build(3) })] });

		const report = await deployReview(options(), io);

		expect(report.status).toBe("NO CHANGE");
		expect(report.remoteVersion).toBe(3);
		expect(report.localSha).toBe(report.remoteShaBefore);
		expect(calls.some((c) => c.includes("push"))).toBe(false);
		expect(calls.some((c) => c.includes("mv"))).toBe(false);
	});

	it("does not write a deploy backup on NO CHANGE", async () => {
		const { io, local } = fakeWorld({ devices: [tablet({ [REMOTE_FILE]: build(3) })] });

		const report = await deployReview(options(), io);

		expect(report.backupDir).toBeNull();
		expect([...local.keys()].some((k) => k.startsWith(BACKUP_ROOT))).toBe(false);
	});

	it("does not restart KOReader on NO CHANGE even with the flag", async () => {
		const { io, shellLog } = fakeWorld({ devices: [tablet({ [REMOTE_FILE]: build(3) })] });

		const report = await deployReview(options({ restartKoreader: true }), io);

		expect(report.status).toBe("NO CHANGE");
		expect(report.restarted).toBe(false);
		expect(shellLog.some((c) => c.includes(KOREADER_PACKAGE))).toBe(false);
	});

	it("reports NO CHANGE when only the archive bytes differ but the logical content is identical", async () => {
		const drifted = buildStableStudy(buildReviewCourse(EVENTS, { version: 3 }), new Date("2020-01-01T00:00:00Z"));
		const { io, calls } = fakeWorld({ devices: [tablet({ [REMOTE_FILE]: drifted })] });

		const report = await deployReview(options(), io);

		expect(report.status).toBe("NO CHANGE");
		expect(report.localSha).not.toBe(report.remoteShaBefore);
		expect(calls.some((c) => c.includes("push"))).toBe(false);
	});

	it("plans a deploy with version remote+1 when the content differs", async () => {
		const { io, calls, devices } = fakeWorld({ devices: [tablet({ [REMOTE_FILE]: build(3) })] });

		const report = await deployReview(options({ ...CHANGED }), io);

		expect(report.status).toBe("DEPLOYED");
		expect(report.remoteVersion).toBe(3);
		expect(report.localVersion).toBe(4);
		expect(report.finalSha).toBe(report.localSha);
		expect(report.tempSha).toBe(report.localSha);
		const remote = devices[0].files.get(REMOTE_FILE)!;
		expect(readStudy(remote).manifest.version).toBe(4);
		expect(sha256(remote)).toBe(report.localSha);
		expect(devices[0].files.has(REMOTE_TMP)).toBe(false);
		const pushIndex = calls.findIndex((c) => c.includes("push"));
		const mvIndex = calls.findIndex((c) => c.includes("mv"));
		expect(pushIndex).toBeGreaterThan(-1);
		expect(calls[pushIndex][calls[pushIndex].length - 1]).toBe(REMOTE_TMP);
		expect(mvIndex).toBeGreaterThan(pushIndex);
		expect(calls[mvIndex].slice(-3)).toEqual(["mv", REMOTE_TMP, REMOTE_FILE]);
		const touchIndex = calls.findIndex((c) => c.includes("touch"));
		expect(touchIndex).toBeGreaterThan(mvIndex);
		expect(calls[touchIndex].slice(-2)).toEqual(["touch", REMOTE_FILE]);
	});

	it("uses version 1 and documents the missing remote file on a first deploy", async () => {
		const { io, calls } = fakeWorld({ devices: [tablet()] });

		const report = await deployReview(options(), io);

		expect(report.status).toBe("DEPLOYED");
		expect(report.remoteShaBefore).toBeNull();
		expect(report.remoteVersion).toBeNull();
		expect(report.localVersion).toBe(1);
		expect(report.backupDir).toBeNull();
		expect(calls.some((c) => c.includes("pull"))).toBe(false);
	});

	it("backs up the previous file outside git before replacing it", async () => {
		const previous = build(3);
		const { io, local } = fakeWorld({ devices: [tablet({ [REMOTE_FILE]: previous })] });

		const report = await deployReview(options({ ...CHANGED }), io);

		expect(report.backupDir).toBe(`${BACKUP_ROOT}/20260918-100000`);
		expect(report.backupDir!.startsWith(".indio-virtual/")).toBe(true);
		expect(local.get(`${report.backupDir}/INDIO-REVISAO.study`)).toEqual(previous);
		const meta = JSON.parse(strFromU8(local.get(`${report.backupDir}/meta.json`)!));
		expect(meta).toMatchObject({
			serial: SERIAL,
			remotePath: REMOTE_FILE,
			sha256: sha256(previous),
			size: previous.length,
			manifestId: "indio-revisao",
			manifestVersion: 3,
		});
	});

	it("dry-run validates, hashes and plans but never mutates the device or writes backups", async () => {
		const { io, calls, local, devices } = fakeWorld({ devices: [tablet({ [REMOTE_FILE]: build(3) })] });
		const before = new Map(devices[0].files);

		const report = await deployReview(
			options({ dryRun: true, restartKoreader: true, ...CHANGED }),
			io,
		);

		expect(report.status).toBe("DRY RUN");
		expect(report.wouldDeploy).toBe(true);
		expect(report.localVersion).toBe(4);
		expect(report.backupDir).toBeNull();
		expect(report.restarted).toBe(false);
		expect(calls.some((c) => c.includes("push") || c.includes("mv") || c.includes("rm"))).toBe(false);
		expect(calls.some((c) => c.includes("am") || c.includes("monkey"))).toBe(false);
		expect(devices[0].files).toEqual(before);
		expect([...local.keys()].some((k) => k.startsWith(BACKUP_ROOT))).toBe(false);
	});

	it("dry-run reports no change when nothing would be deployed", async () => {
		const { io } = fakeWorld({ devices: [tablet({ [REMOTE_FILE]: build(3) })] });

		const report = await deployReview(options({ dryRun: true }), io);

		expect(report.status).toBe("DRY RUN");
		expect(report.wouldDeploy).toBe(false);
	});

	it("aborts before pushing when the package is invalid", async () => {
		const { io, calls } = fakeWorld({ devices: [tablet({ [REMOTE_FILE]: build(3) })] });

		await expect(
			deployReview(options({ ...CHANGED, expectedLessons: 30 }), io),
		).rejects.toThrow(/expected 30 lessons/);
		expect(calls.some((c) => c.includes("push"))).toBe(false);
	});

	it("aborts when the remote package has a different manifest.id", async () => {
		const pkg = buildReviewCourse(EVENTS, { version: 1 });
		pkg.manifest.id = "indio-fiscal";
		const foreign = buildStableStudy(pkg, new Date(AS_OF));
		const { io, calls } = fakeWorld({ devices: [tablet({ [REMOTE_FILE]: foreign })] });

		await expect(deployReview(options(), io)).rejects.toThrow(/indio-fiscal/);
		expect(calls.some((c) => c.includes("push"))).toBe(false);
	});

	it("removes the temporary file and keeps the previous package when the pushed sha differs", async () => {
		const previous = build(3);
		const world = fakeWorld({ devices: [tablet({ [REMOTE_FILE]: previous })] });
		const corruptingAdb: AdbRunner = async (args) => {
			const result = await world.adb(args);
			if (args.includes("push")) world.devices[0].files.set(REMOTE_TMP, strToU8("corrupted"));
			return result;
		};

		await expect(
			deployReview(options({ ...CHANGED }), { ...world.io, adb: corruptingAdb }),
		).rejects.toThrow(/sha256/);
		expect(world.devices[0].files.get(REMOTE_FILE)).toEqual(previous);
		expect(world.devices[0].files.has(REMOTE_TMP)).toBe(false);
	});

	it("does not restart KOReader without the flag", async () => {
		const { io, shellLog } = fakeWorld({ devices: [tablet({ [REMOTE_FILE]: build(3) })] });

		const report = await deployReview(options({ ...CHANGED }), io);

		expect(report.restarted).toBe(false);
		expect(shellLog.some((c) => c.includes(KOREADER_PACKAGE))).toBe(false);
	});

	it("restarts KOReader only with the flag, after a successful deploy", async () => {
		const { io, shellLog } = fakeWorld({ devices: [tablet({ [REMOTE_FILE]: build(3) })] });

		const report = await deployReview(
			options({ restartKoreader: true, ...CHANGED }),
			io,
		);

		expect(report.restarted).toBe(true);
		expect(shellLog).toContain(`am force-stop ${KOREADER_PACKAGE}`);
		expect(shellLog.some((c) => c.startsWith("monkey -p " + KOREADER_PACKAGE))).toBe(true);
	});

	it("records the student state hashes before and after and never touches them", async () => {
		const state = {
			[`${REMOTE_DATA_DIR}/progress.json`]: strToU8("{\"p\":1}"),
			[`${REMOTE_DATA_DIR}/answers.json`]: strToU8("{\"a\":1}"),
			[`${REMOTE_DATA_DIR}/reviews.json`]: strToU8("{}"),
		};
		const { io, calls, devices } = fakeWorld({ devices: [tablet({ [REMOTE_FILE]: build(3), ...state })] });

		const report = await deployReview(options({ ...CHANGED }), io);

		expect(Object.keys(report.stateBefore)).toEqual(STATE_FILES);
		expect(report.stateAfter).toEqual(report.stateBefore);
		expect(report.stateBefore["progress.json"]).toBe(sha256(state[`${REMOTE_DATA_DIR}/progress.json`]));
		for (const [path, data] of Object.entries(state)) expect(devices[0].files.get(path)).toEqual(data);
		const touching = calls.filter((c) => c.some((a) => a.includes(REMOTE_DATA_DIR)));
		expect(touching.every((c) => c.includes("sha256sum") || (c.includes("ls") && c.includes("-d")))).toBe(true);
	});

	it("uses only the fixed remote paths", () => {
		expect(REMOTE_DIR).toBe("/sdcard/koreader/studyreader/courses");
		expect(REMOTE_FILE).toBe("/sdcard/koreader/studyreader/courses/INDIO-REVISAO.study");
		expect(REMOTE_TMP).toBe("/sdcard/koreader/studyreader/courses/INDIO-REVISAO.study.tmp");
		expect(REMOTE_DATA_DIR).toBe("/sdcard/koreader/studyreader/data/indio-revisao");
	});

	it("never references other courses or their data", async () => {
		const { io, calls } = fakeWorld({ devices: [tablet({ [REMOTE_FILE]: build(3) })] });

		await deployReview(options({ restartKoreader: true, ...CHANGED }), io);

		const flat = calls.flat().join(" ");
		expect(flat).not.toContain("INDIO-FISCAL");
		expect(flat).not.toContain("INDIO-ERROR-TEST");
		expect(flat).not.toContain("indio-fiscal");
		expect(flat).not.toContain("indio-error-test");
	});
});

describe("phase 2D: unzip sanity", () => {
	it("keeps every archive path portable in the stable build", () => {
		const paths = Object.keys(unzipSync(build(1)));

		expect(paths.every((p) => !p.includes("\\"))).toBe(true);
		expect(paths).toContain("manifest.json");
	});
});
