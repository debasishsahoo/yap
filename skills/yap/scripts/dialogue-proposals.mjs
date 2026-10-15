import { budget, failure, launchedAs, runJsonHelper } from "./inspection-artifacts.mjs";

const nonempty = (value) => typeof value === "string" && value.length > 0;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const coordinate = (value) => {
  const n = typeof value === "number" ? value : value?.numerator;
  const d = typeof value === "number" ? 1 : value?.denominator;
  if (!Number.isSafeInteger(n) || n < 0 || !positiveInteger(d))
    throw failure("INVALID_REQUEST", "Keep exact nonnegative rational measurement ranges");
  return [BigInt(n), BigInt(d)];
};

/** Pure per-occurrence drafts; no inspection, inference or edit execution. */
export function dialogueProposals(request) {
  if (
    !request ||
    !nonempty(request.projectId) ||
    !nonempty(request.revisionId) ||
    !Number.isFinite(request.targetIntegratedLufs) ||
    !Number.isFinite(request.truePeakCeilingDbtp) ||
    !Number.isFinite(request.gainBounds?.minimumDb) ||
    !Number.isFinite(request.gainBounds?.maximumDb) ||
    request.gainBounds.minimumDb > request.gainBounds.maximumDb ||
    !Array.isArray(request.clips) ||
    !request.clips.length ||
    request.clips.length > 1000
  )
    throw failure(
      "INVALID_REQUEST",
      "Supply explicit project/revision, finite targets/bounds and 1–1000 selected clips",
    );
  budget(request.minimumDurationUs, undefined, 1, 3600000000, "minimumDurationUs");
  const seen = new Set();
  for (const { clipId, evidence: e } of request.clips) {
    if (
      !nonempty(clipId) ||
      seen.has(clipId) ||
      e?.kind !== "loudness" ||
      e.domain !== "project" ||
      e.projectId !== request.projectId ||
      e.revisionId !== request.revisionId ||
      e.tap?.target?.kind !== "clip" ||
      e.tap.target.id !== clipId ||
      e.tap?.point?.kind !== "processed" ||
      e.truePeak !== true ||
      e.channelInterpretation !== "native" ||
      !nonempty(e.audio?.jobId) ||
      !positiveInteger(e.audio?.generation) ||
      !positiveInteger(e.generation) ||
      !nonempty(e.implementationId) ||
      !/^[a-f0-9]{64}$/.test(e.signalRecipe?.sha256 ?? "") ||
      !["full-signal", "excerpt"].includes(e.scope) ||
      !positiveInteger(e.sampleRate) ||
      !positiveInteger(e.channels) ||
      !Number.isSafeInteger(e.sampleRange?.start) ||
      e.sampleRange.start < 0 ||
      !positiveInteger(e.sampleRange?.end) ||
      e.sampleRange.end <= e.sampleRange.start ||
      !Array.isArray(e.unavailable) ||
      e.unavailable.some((item) => !Array.isArray(item?.ranges)) ||
      !e.measurement ||
      [e.measurement.integratedLufs, e.measurement.truePeakDbtp].some(
        (value) => value !== null && !Number.isFinite(value),
      )
    )
      throw failure(
        "INVALID_REQUEST",
        "Each selection must have one distinct occurrence and delivered processed-clip loudness evidence at the pinned revision",
      );
    const [sn, sd] = coordinate(e.range?.startUs),
      [en, ed] = coordinate(e.range?.endUs);
    if (sn * ed >= en * sd) throw failure("INVALID_REQUEST", "Keep a positive measured range");
    seen.add(clipId);
  }
  return {
    projectId: request.projectId,
    revisionId: request.revisionId,
    proposals: request.clips.map(({ clipId, evidence }) => {
      const requestedGainDb = request.targetIntegratedLufs - evidence.measurement.integratedLufs;
      const { measurement, ...pin } = evidence;
      const common = { clipId, pin: structuredClone(pin), before: structuredClone(measurement) };
      const reason = evidence.unavailable.some((item) => item.ranges.length)
        ? "missing-support"
        : BigInt(evidence.sampleRange.end - evidence.sampleRange.start) * 1000000n <
            BigInt(request.minimumDurationUs) * BigInt(evidence.sampleRate)
          ? "too-short"
          : !Number.isFinite(measurement.integratedLufs) ||
              !Number.isFinite(measurement.truePeakDbtp)
            ? "unmeasurable"
            : null;
      const unavailable = (reason) => ({
        ...common,
        status: "unavailable",
        requestedGainDb: reason === "gain-unrepresentable" ? requestedGainDb : null,
        gainDb: null,
        gainStep: null,
        issues: [
          {
            code: "proposal-unavailable",
            message: `No gain draft: ${reason}`,
            evidence: { reason },
          },
        ],
      });
      if (reason) return unavailable(reason);
      // Output by default: limits constrain the gain and are reported; the peak ceiling wins.
      const limits = [];
      let gainDb = requestedGainDb;
      if (gainDb > request.gainBounds.maximumDb) {
        gainDb = request.gainBounds.maximumDb;
        limits.push("gain-maximum");
      }
      if (gainDb < request.gainBounds.minimumDb) {
        gainDb = request.gainBounds.minimumDb;
        limits.push("gain-minimum");
      }
      const peakGainDb = request.truePeakCeilingDbtp - measurement.truePeakDbtp;
      if (gainDb > peakGainDb) {
        gainDb = peakGainDb;
        limits.push("true-peak-ceiling");
      }
      const breached = gainDb < request.gainBounds.minimumDb;
      if (breached && limits.includes("gain-minimum"))
        limits.splice(limits.indexOf("gain-minimum"), 1);
      const gain = 10 ** (gainDb / 20);
      if (!Number.isFinite(gain) || gain === 0) return unavailable("gain-unrepresentable");
      return {
        ...common,
        status: "proposed",
        requestedGainDb,
        gainDb,
        gainStep: { enabled: true, processor: { type: "gain", gain } },
        predictedIntegratedLufs: measurement.integratedLufs + gainDb,
        predictedTruePeakDbtp: measurement.truePeakDbtp + gainDb,
        issues: [
          ...limits.map((limit) => ({
            code: "gain-constrained",
            message: `The ${limit} limit constrained the requested gain`,
            evidence: { limit, requestedGainDb, gainDb },
          })),
          // The ceiling wins over the caller's minimum: report the breached bound, not a clamp.
          ...(breached
            ? [
                {
                  code: "gain-bound-breached",
                  message: "The true-peak ceiling forced the gain below the minimum bound",
                  evidence: {
                    bound: "gain-minimum",
                    boundDb: request.gainBounds.minimumDb,
                    gainDb,
                  },
                },
              ]
            : []),
        ],
      };
    }),
  };
}

if (launchedAs(import.meta.url, "dialogue-proposals.mjs")) {
  if (process.argv.includes("--help"))
    console.log(
      "Usage: node dialogue-proposals.mjs < request.json\nSupply projectId/revisionId, targetIntegratedLufs, gainBounds {minimumDb,maximumDb}, truePeakCeilingDbtp, minimumDurationUs and clips [{clipId,evidence}]. Evidence is delivered audio.measure JSON for a processed clip tap, with measurement at root. Returns exact evidence pins, measured-selection predictions and an ID-free new gainStep draft, with gain-constrained issues when the peak ceiling or gain bounds limited it (the ceiling wins), or status unavailable with a proposal-unavailable issue (missing support, too short, unmeasurable, unrepresentable gain). Append explicitly to the existing ordered stack through processing.set; remeasure. Never calls CLI, infers or edits.",
    );
  else await runJsonHelper(dialogueProposals);
}
