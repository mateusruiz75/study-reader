import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import {
	BACKUP_ROOT,
	DeployError,
	deployReview,
	type AdbRunner,
	type DeployReport,
} from "./deploy-review.ts";
import {
	DEFAULT_LIMIT,
	DEFAULT_MAX_PER_MATERIA,
	buildStableStudy,
	runReviewPipeline,
} from "./review-pipeline.ts";
import { priorityProfileSchema } from "./review-priority.ts";

const execFileAsync = promisify(execFile);

const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();

const { values } = parseArgs({
	args: argv,
	options: {
		serial: { type: "string" },
		"dry-run": { type: "boolean", default: false },
		"restart-koreader": { type: "boolean", default: false },
		ledger: { type: "string" },
		output: { type: "string", default: "examples/INDIO-REVISAO.study" },
		adb: { type: "string" },
		limit: { type: "string", default: String(DEFAULT_LIMIT) },
		"max-per-materia": { type: "string", default: String(DEFAULT_MAX_PER_MATERIA) },
		"as-of": { type: "string" },
		profile: { type: "string" },
	},
});

const serial = values.serial ?? process.env.INDIO_TABLET_SERIAL;
const ledgerPath = values.ledger ?? process.env.INDIO_LEDGER;
const adbPath = values.adb ?? process.env.ADB ?? "adb";

function usage(message: string): never {
	console.error(`error: ${message}`);
	console.error(
		"usage: deploy-review.mts --serial <serial | $INDIO_TABLET_SERIAL> [--dry-run] [--restart-koreader] [--ledger <ledger.json | $INDIO_LEDGER>] [--adb <path | $ADB>] [--limit 30] [--max-per-materia 6] [--as-of ISO] [--profile profile.json]",
	);
	process.exit(1);
}

if (!serial) usage("--serial is required (or INDIO_TABLET_SERIAL)");
if (!ledgerPath) usage("--ledger is required (or INDIO_LEDGER)");

const limit = Number(values.limit);
const maxPerMateria = Number(values["max-per-materia"]);
const profile = values.profile
	? priorityProfileSchema.parse(JSON.parse(await readFile(resolve(values.profile), "utf8")))
	: {};
const rawLedger = JSON.parse(await readFile(resolve(ledgerPath), "utf8"));

let expectedLessons = 0;
const build = (version: number): Uint8Array => {
	const result = runReviewPipeline(rawLedger, {
		limit,
		maxPerMateria,
		version,
		asOf: values["as-of"],
		profile,
	});
	expectedLessons = result.selection.selected.length;
	return buildStableStudy(result.pkg);
};
build(1);
if (expectedLessons !== limit) {
	console.warn(`⚠ ledger yields ${expectedLessons} lessons (limit ${limit}); validating against ${expectedLessons}`);
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

const tempDir = join(tmpdir(), "indio-deploy-review");

try {
	const report = await deployReview(
		{
			serial,
			dryRun: values["dry-run"],
			restartKoreader: values["restart-koreader"],
			backupRoot: BACKUP_ROOT,
			localPath: resolve(values.output),
			tempDir,
			build,
			expectedLessons,
		},
		{
			adb,
			readFile: (path) => readFile(path),
			writeFile: (path, data) => writeFile(path, data),
			mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
			now: () => new Date(),
		},
	);
	printReport(report);
} catch (error) {
	if (error instanceof DeployError) {
		console.error(`❌ DEPLOY ABORTED: ${error.message}`);
		process.exit(2);
	}
	throw error;
}

function printReport(report: DeployReport): void {
	const icon = report.status === "DEPLOYED" ? "✅" : report.status === "NO CHANGE" ? "⏸" : "🧪";
	console.log(`${icon} ${report.status}${report.status === "DRY RUN" ? (report.wouldDeploy ? " (would deploy)" : " (would be NO CHANGE)") : ""}`);
	console.log(`   device: ${report.serial}`);
	console.log(`   remote: ${report.remotePath}`);
	console.log(`   remote sha256 before: ${report.remoteShaBefore ?? "(no file on device)"}`);
	console.log(`   remote version: ${report.remoteVersion ?? "(none)"} → local version: ${report.localVersion}`);
	console.log(`   local sha256: ${report.localSha}`);
	console.log(`   logically equal to remote: ${report.logicallyEqual}`);
	console.log(`   backup: ${report.backupDir ?? "(none)"}`);
	if (report.status === "DEPLOYED") {
		console.log(`   temp sha256: ${report.tempSha}`);
		console.log(`   final sha256: ${report.finalSha}`);
		for (const [name, before] of Object.entries(report.stateBefore)) {
			const after = report.stateAfter[name as keyof typeof report.stateAfter];
			console.log(`   state ${name}: ${before ?? "(absent)"} → ${after ?? "(absent)"} ${before === after ? "OK" : "CHANGED"}`);
		}
	}
	console.log(`   koreader restarted: ${report.restarted}`);
}
