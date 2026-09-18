import { unzipSync, zipSync, type Zippable } from "fflate";
import { buildStudy, type StudyPackage } from "../src/index.ts";
import { adaptLedger, type AdaptResult } from "./adapters/error-notebook-ledger.ts";
import { buildReviewCourse } from "./review-course.ts";
import {
	deriveFeatures,
	prioritizeEvents,
	selectBalanced,
	type PriorityProfile,
	type PrioritizedError,
	type Selection,
} from "./review-priority.ts";

export const DEFAULT_LIMIT = 30;
export const DEFAULT_MAX_PER_MATERIA = 6;

export type ReviewPipelineOptions = {
	limit: number;
	maxPerMateria: number;
	version: number;
	asOf?: string;
	profile?: PriorityProfile;
};

export type ReviewPipelineResult = {
	adapted: AdaptResult;
	asOf: string;
	prioritized: PrioritizedError[];
	selection: Selection;
	pkg: StudyPackage;
};

export function runReviewPipeline(rawLedger: unknown, options: ReviewPipelineOptions): ReviewPipelineResult {
	const adapted = adaptLedger(rawLedger);
	const asOf = options.asOf ?? adapted.latestEventAt;
	if (!asOf) throw new Error("ledger has no dated events; pass --as-of");
	const features = deriveFeatures(adapted.attempts, asOf);
	const prioritized = prioritizeEvents(adapted.events, features, options.profile ?? {});
	const selection = selectBalanced(prioritized, {
		limit: options.limit,
		maxPerMateria: options.maxPerMateria,
	});
	const pkg = buildReviewCourse(selection.selected, { version: options.version });
	return { adapted, asOf, prioritized, selection, pkg };
}

export const STABLE_MTIME_FALLBACK = new Date("2000-01-01T00:00:00.000Z");

export function stableMtime(pkg: StudyPackage): Date {
	const indio = pkg.manifest.extensions?.indio as Record<string, unknown> | undefined;
	const asOf = typeof indio?.priorityAsOf === "string" ? Date.parse(indio.priorityAsOf) : NaN;
	return Number.isNaN(asOf) ? STABLE_MTIME_FALLBACK : new Date(asOf);
}

export function buildStableStudy(pkg: StudyPackage, mtime = stableMtime(pkg)): Uint8Array {
	const entries = unzipSync(buildStudy(pkg));
	const stamped: Zippable = {};
	for (const path of Object.keys(entries).sort()) stamped[path] = [entries[path], { mtime }];
	return zipSync(stamped, { level: 6 });
}
