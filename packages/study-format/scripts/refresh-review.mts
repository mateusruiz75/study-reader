import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import type { AdbRunner } from "./deploy-review.ts";
import { DEFAULT_REFRESH_OPTIONS, RefreshError, refreshReview, type RefreshReport } from "./refresh-review.ts";
import { priorityProfileSchema } from "./review-priority.ts";

const execFileAsync = promisify(execFile);

const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();

const { values } = parseArgs({
	args: argv,
	options: {
		serial: { type: "string" },
		ledger: { type: "string" },
		adb: { type: "string" },
		"dry-run": { type: "boolean", default: false },
		"restart-koreader": { type: "boolean", default: false },
		limit: { type: "string", default: String(DEFAULT_REFRESH_OPTIONS.limit) },
		"max-per-materia": { type: "string", default: String(DEFAULT_REFRESH_OPTIONS.maxPerMateria) },
		"as-of": { type: "string" },
		profile: { type: "string" },
		output: { type: "string", default: DEFAULT_REFRESH_OPTIONS.localPath },
	},
});

const serial = values.serial ?? process.env.INDIO_TABLET_SERIAL;
const ledgerPath = values.ledger ?? process.env.INDIO_LEDGER;
const adbPath = values.adb ?? process.env.ADB ?? "adb";

function usage(message: string): never {
	console.error(`error: ${message}`);
	console.error(
		"usage: refresh-review.mts --serial <serial | $INDIO_TABLET_SERIAL> [--dry-run] [--restart-koreader] [--ledger <ledger.json | $INDIO_LEDGER>] [--adb <path | $ADB>] [--limit 30] [--max-per-materia 6] [--as-of ISO] [--profile profile.json]",
	);
	process.exit(1);
}

if (!serial) usage("--serial is required (or INDIO_TABLET_SERIAL)");
if (!ledgerPath) usage("--ledger is required (or INDIO_LEDGER)");

const profile = values.profile
	? priorityProfileSchema.parse(JSON.parse(await readFile(resolve(values.profile), "utf8")))
	: undefined;

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

const io = {
	adb,
	readFile: (path: string) => readFile(path),
	writeFile: (path: string, data: Uint8Array) => writeFile(path, data),
	mkdir: (path: string) => mkdir(path, { recursive: true }).then(() => undefined),
	exists: (path: string) =>
		access(path).then(
			() => true,
			() => false,
		),
	remove: (path: string) => rm(path, { force: true }),
	now: () => new Date(),
};

try {
	const report = await refreshReview(
		{
			serial,
			ledgerPath: resolve(ledgerPath),
			dryRun: values["dry-run"],
			restartKoreader: values["restart-koreader"],
			limit: Number(values.limit),
			maxPerMateria: Number(values["max-per-materia"]),
			asOf: values["as-of"],
			profile,
			localPath: resolve(values.output),
			feedbackRoot: DEFAULT_REFRESH_OPTIONS.feedbackRoot,
			backupRoot: DEFAULT_REFRESH_OPTIONS.backupRoot,
			reportRoot: DEFAULT_REFRESH_OPTIONS.reportRoot,
			lockPath: DEFAULT_REFRESH_OPTIONS.lockPath,
			tempDir: join(tmpdir(), "indio-refresh-review"),
			onStep: (step) => console.log(`▶ ${step}`),
		},
		io,
	);
	printReport(report);
} catch (error) {
	if (error instanceof RefreshError) {
		console.error(`❌ REFRESH ABORTED: ${error.message}`);
		process.exit(2);
	}
	throw error;
}

function printReport(report: RefreshReport): void {
	const icon = report.result === "DEPLOYED" ? "✅" : report.result === "NO_CHANGE" ? "⏸" : report.result === "DRY_RUN" ? "🧪" : "❌";
	console.log(`${icon} ${report.result} (${report.deploymentStatus})`);
	console.log(`   run: ${report.runId} · report: ${report.reportDir}/report.json`);
	console.log(`   device: ${report.serial} (${report.deviceModel ?? "?"})`);
	console.log(`   ledger: as-of=${report.ledgerAsOf} sha256=${report.ledgerSha}`);
	console.log(`   feedback: ${report.feedbackSnapshot} ${JSON.stringify(report.feedbackHashes)}`);
	console.log(`   candidates=${report.candidateCount} bands=${JSON.stringify(report.priorityBands)} signals=${JSON.stringify(report.studySignals)}`);
	console.log(`   selected=${report.selectedCount} by-materia=${JSON.stringify(report.selectedByMateria)}`);
	console.log(`   local sha256: ${report.localStudySha} (v${report.localVersion})`);
	console.log(`   remote sha256: ${report.remoteStudyShaBefore ?? "(none)"} → ${report.remoteStudyShaAfter ?? "(none)"} (v${report.remoteVersionBefore ?? "-"} → v${report.remoteVersionAfter ?? "-"})`);
	console.log(`   delta: entered=${JSON.stringify(report.enteredSincePreviousBuild)} left=${JSON.stringify(report.leftSincePreviousBuild)} stayed=${report.delta.stayed.length}`);
	console.log(`   state preserved: ${report.statePreserved} ${JSON.stringify(report.stateHashesBefore)}`);
	console.log(`   backup: ${report.backupDir ?? "(none)"} · restart: ${report.restartPerformed}`);
}
