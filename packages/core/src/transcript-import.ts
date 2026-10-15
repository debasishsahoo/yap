import { createHash } from "node:crypto";
import { CatalogError } from "./catalog.js";

export type ImportedFormat = "srt" | "vtt" | "json";
export type ImportedRange = { startUs: number; endUs: number };
export type ImportedWord = {
  text: string;
  source: ImportedRange;
  confidence?: number;
};
export type ImportedCue = {
  id: string;
  ordinal: number;
  text: string;
  speaker?: string;
  settings?: string;
  source: ImportedRange;
  words: ImportedWord[];
};
export type ImportedTranscript = {
  format: ImportedFormat;
  parser: { name: string; version: string };
  timingBasis: "supplied";
  raw: { bytes: number; sha256: string };
  metadata: Record<string, unknown>;
  cues: ImportedCue[];
};

const parserVersion = "transcript-import-v1";

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new CatalogError("INVALID_PARAMS", message, details);
}

function range(startUs: number, endUs: number): ImportedRange {
  if (
    !Number.isSafeInteger(startUs) ||
    !Number.isSafeInteger(endUs) ||
    startUs < 0 ||
    endUs <= startUs
  )
    invalid("Transcript timing must be a non-empty non-negative range", { startUs, endUs });
  return { startUs, endUs };
}

function timestamp(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) invalid("Transcript timestamp is invalid", { value });
    const micros = Math.round(value * 1_000_000);
    if (!Number.isSafeInteger(micros))
      invalid("Transcript timestamp is outside the supported range", { value });
    return micros;
  }
  if (typeof value !== "string") invalid("Transcript timestamp must be a string or number");
  const match = value.trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{3,6})$/);
  if (!match) invalid("Transcript timestamp is invalid", { value });
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fraction = match[4]!.padEnd(6, "0").slice(0, 6);
  if (minutes > 59 || seconds > 59) invalid("Transcript timestamp is invalid", { value });
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000_000 + Number(fraction);
}

function parseTiming(line: string): { source: ImportedRange; settings?: string } {
  const match = line.match(/^\s*(.*?)\s*-->\s*(.*?)(?:\s+.*)?$/);
  if (!match) invalid("Transcript cue timing is malformed", { line });
  const endAndSettings = match[2]!.trim().split(/\s+/, 2);
  return {
    source: range(timestamp(match[1]), timestamp(endAndSettings[0])),
    ...(endAndSettings[1] === undefined ? {} : { settings: endAndSettings[1] }),
  };
}

function extractSpeaker(text: string): { text: string; speaker?: string } {
  const match = text.match(/^\s*<v\s+([^>]+)>([\s\S]*)<\/v>\s*$/i);
  if (!match) return { text };
  const speaker = match[1]!.trim();
  if (!speaker) return { text: match[2]!.trim() };
  return { text: match[2]!.trim(), speaker };
}

function cue(
  id: string,
  ordinal: number,
  source: ImportedRange,
  text: string,
  speaker?: string,
  settings?: string,
): ImportedCue {
  const extracted = extractSpeaker(text);
  return {
    id,
    ordinal,
    text: extracted.text,
    ...(speaker === undefined
      ? extracted.speaker === undefined
        ? {}
        : { speaker: extracted.speaker }
      : { speaker }),
    ...(settings === undefined ? {} : { settings }),
    source,
    words: [],
  };
}

function parseTextCues(
  raw: string,
  format: "srt" | "vtt",
): { cues: ImportedCue[]; metadata: Record<string, unknown> } {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  let index = 0;
  if (format === "vtt") {
    if (!/^WEBVTT(?:\s|$)/.test(lines[0] ?? "")) invalid("VTT input must begin with WEBVTT");
    index = 1;
  }
  const cues: ImportedCue[] = [];
  while (index < lines.length) {
    while (index < lines.length && !lines[index]!.trim()) index++;
    if (index >= lines.length) break;
    if (format === "vtt" && /^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[index]!.trim())) {
      while (index < lines.length && lines[index]!.trim()) index++;
      continue;
    }
    const first = lines[index]!.trim();
    let id = String(cues.length + 1);
    let timing = first;
    if (!first.includes("-->")) {
      id = first;
      index++;
      timing = lines[index]?.trim() ?? "";
    }
    const timed = parseTiming(timing);
    index++;
    const textLines: string[] = [];
    while (index < lines.length && lines[index]!.trim()) textLines.push(lines[index++]!);
    if (!textLines.length) invalid("Transcript cue has no text", { id });
    const text = textLines.join("\n");
    cues.push(
      format === "vtt"
        ? cue(id, cues.length, timed.source, text, undefined, timed.settings)
        : { id, ordinal: cues.length, text, source: timed.source, words: [] },
    );
  }
  if (!cues.length) invalid("Transcript contains no cues");
  return { cues, metadata: {} };
}

function objectRange(value: Record<string, unknown>, label: string): ImportedRange {
  const start = value.startUs ?? value.start;
  const end = value.endUs ?? value.end;
  if (start === undefined || end === undefined) invalid(`JSON ${label} is missing timing`);
  return range(
    value.startUs !== undefined ? Number(start) : timestamp(start),
    value.endUs !== undefined ? Number(end) : timestamp(end),
  );
}

function parseJson(raw: string): { cues: ImportedCue[]; metadata: Record<string, unknown> } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalid("Transcript JSON is malformed");
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as { cues?: unknown }).cues))
    invalid("Transcript JSON must contain a cues array");
  const cues = (value as { cues: unknown[] }).cues.map((entry, ordinal) => {
    if (!entry || typeof entry !== "object") invalid("Transcript JSON cue is invalid", { ordinal });
    const item = entry as Record<string, unknown>;
    const text = item.text;
    if (typeof text !== "string" || !text.trim())
      invalid("Transcript JSON cue text is invalid", { ordinal });
    const words = item.words;
    if (words !== undefined && !Array.isArray(words))
      invalid("Transcript JSON cue words are invalid", { ordinal });
    const parsedWords = (words ?? []).map((word, wordOrdinal) => {
      if (!word || typeof word !== "object")
        invalid("Transcript JSON word is invalid", { ordinal, wordOrdinal });
      const w = word as Record<string, unknown>;
      if (typeof w.text !== "string" || !w.text.trim())
        invalid("Transcript JSON word text is invalid", { ordinal, wordOrdinal });
      const result: ImportedWord = { text: w.text, source: objectRange(w, "word") };
      if (w.confidence !== undefined) {
        if (
          typeof w.confidence !== "number" ||
          !Number.isFinite(w.confidence) ||
          w.confidence < 0 ||
          w.confidence > 1
        )
          invalid("Transcript JSON word confidence is invalid", { ordinal, wordOrdinal });
        result.confidence = w.confidence;
      }
      return result;
    });
    const source = objectRange(item, "cue");
    for (const word of parsedWords)
      if (word.source.startUs < source.startUs || word.source.endUs > source.endUs)
        invalid("Transcript JSON word falls outside its cue", { ordinal });
    const id = item.id === undefined ? String(ordinal + 1) : String(item.id);
    const speaker = item.speaker;
    if (speaker !== undefined && typeof speaker !== "string")
      invalid("Transcript JSON speaker is invalid", { ordinal });
    return {
      id,
      ordinal,
      text,
      ...(speaker === undefined ? {} : { speaker }),
      source,
      words: parsedWords,
    };
  });
  const metadata = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "cues"),
  );
  if (!cues.length) invalid("Transcript JSON contains no cues");
  return { cues, metadata };
}

export function parseImportedTranscript(
  input: Uint8Array | string,
  options: { format?: ImportedFormat } = {},
): ImportedTranscript {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid("Transcript input is not valid UTF-8");
  }
  const format =
    options.format ??
    (raw.trimStart().startsWith("WEBVTT")
      ? "vtt"
      : raw.trimStart().startsWith("{")
        ? "json"
        : "srt");
  const parsed = format === "json" ? parseJson(raw) : parseTextCues(raw, format);
  return {
    format,
    parser: { name: "yap-transcript-import", version: parserVersion },
    timingBasis: "supplied",
    raw: { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") },
    metadata: parsed.metadata,
    cues: parsed.cues,
  };
}
