import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";
import type { AdbRunner } from "./deploy-review.ts";
import { FEEDBACK_ROOT, SyncError, syncFeedback } from "./sync-feedback.ts";

const execFileAsync = promisify(execFile);

const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();

const { values } = parseArgs({
	args: argv,
	options: {
		serial: { type: "string" },
		adb: { type: "string" },
		root: { type: "string", default: FEEDBACK_ROOT },
	},
});

const serial = values.serial ?? process.env.INDIO_TABLET_SERIAL;
const adbPath = values.adb ?? process.env.ADB ?? "adb";
if (!serial) {
	console.error(
		"usage: sync-feedback.mts --serial <serial | $INDIO_TABLET_SERIAL> [--adb <path | $ADB>] [--root .indio-virtual/study-feedback]",
	);
	process.exit(1);
}

const adb: AdbRunner = async (args) => {
	try {
		const { stdout, stderr } = await execFileAsync(adbPath, args, { maxBuffer: 64 * 1024 * 1024 });
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
		return {
			code: typeof failure.code === "number" ? failure.code : 1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? failure.message ?? String(error),
		};
	}
};

try {
	const result = await syncFeedback(
		{ serial, root: values.root },
		{
			adb,
			readFile: (path) => readFile(path),
			writeFile: (path, data) => writeFile(path, data),
			mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
			now: () => new Date(),
		},
	);
	console.log(`✅ feedback snapshot (read-only) from ${result.metadata.serial}`);
	console.log(`   remote: ${result.metadata.remoteDir}`);
	console.log(`   snapshot: ${result.snapshotDir}`);
	console.log(`   latest: ${result.latestDir}`);
	console.log(`   collected at: ${result.metadata.collectedAt} (attempts=${result.attempts})`);
	for (const [name, meta] of Object.entries(result.metadata.files)) {
		console.log(`   ${name}: sha256=${meta.sha256} size=${meta.size}`);
	}
} catch (error) {
	if (error instanceof SyncError) {
		console.error(`❌ SYNC ABORTED: ${error.message}`);
		process.exit(2);
	}
	throw error;
}
