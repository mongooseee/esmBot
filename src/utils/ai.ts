import { Buffer } from "node:buffer";
import process from "node:process";
import { fileTypeFromBuffer } from "file-type";
import logger from "./logger.ts";
import { download, formats, request, runMediaJob } from "./media.ts";
import { mimeToExt } from "./mime.ts";

const apiBase = "https://openrouter.ai/api/v1";

// the multimodal defaults are what let ask and edit take images
const defaultChatModel = "meta/muse-spark-1.3-contributor";
const defaultImageModel = "openai/gpt-image-2.5-sunburst";
const defaultSpeechModel = "hexgrad/kokoro-82m";
const defaultSpeechVoice = "af_heart";
const defaultTranscriptionModel = "openai/whisper-large-v3-turbo";
const defaultMusicModel = "google/lyria-3-clip-preview";
const defaultLongMusicModel = "google/lyria-3-pro-preview";

// what compose can be asked for, in seconds; clips are always this long
const clipLength = 30;
export const musicLengths = [clipLength, 60, 120, 180];

// OpenRouter's reasoning effort levels, from least to most
export const effortLevels = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof effortLevels)[number];
const defaultEffort: Effort = "low";
// reasoning is billed as output, so without a setting users can't go all the way up
const defaultMaxEffort: Effort = "medium";

// Reasoning shares max_tokens with the reply itself, so more effort needs a
// bigger budget or it runs out before writing anything. Discord caps messages at
// 2000 characters, which is why the lowest levels don't need more than this.
const effortBudgets: { [effort in Effort]: { tokens: number; timeout: number } } = {
  none: { tokens: 2000, timeout: 60000 },
  minimal: { tokens: 2000, timeout: 60000 },
  low: { tokens: 2000, timeout: 60000 },
  medium: { tokens: 4000, timeout: 90000 },
  high: { tokens: 8000, timeout: 120000 },
  xhigh: { tokens: 16000, timeout: 180000 },
  max: { tokens: 32000, timeout: 300000 },
};

const speechTimeout = 60000;
// naming a song is a small job, so don't hold up the reply for long
const titleTimeout = 15000;
// image, music and long transcription jobs are considerably slower than text ones
const imageTimeout = 120000;
const transcriptionTimeout = 120000;
// a three minute song took about 50 seconds when tested, so leave plenty of room
const musicTimeout = 300000;

// inputs are sent inline as base64, which inflates them by about a third
const maxInputSize = 8388608;
// the most any transcription provider takes
const maxAudioSize = 26214400;

// the formats every provider we've tried accepts; anything else (GIF, AVIF,
// HEIF) gets its first frame converted before it's sent
const directTypes = ["image/jpeg", "image/png", "image/webp"];

// what file-type detects for the audio and video people tend to post; video is
// only ever used for its audio track
const audioTypes = [
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/ogg; codecs=opus",
  "audio/flac",
  "audio/x-m4a",
  "audio/mp4",
  "audio/aac",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
  "video/matroska",
];

// chat models only reliably take these as audio input, so everything else
// (including Discord voice messages) is transcribed and sent as text instead
const chatAudioFormats: { [mime: string]: string } = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

// provider messages are shown to users when they explain what was wrong with
// the request, so keep them from taking over the reply
const maxReasonLength = 300;
const maxVoiceListLength = 700;

// how long OpenRouter's lists of models (and their voices) are trusted for
const modelCacheTime = 3600000;

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface GeneratedFile {
  contents: Buffer;
  ext: string;
}

export interface AudioFile {
  buf: Buffer;
  type: string;
  ext: string;
}

interface ErrorBody {
  error?: { message?: string; code?: number | string; metadata?: { raw?: unknown } };
}

interface ChatResponse extends ErrorBody {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
}

interface ImageResponse extends ErrorBody {
  data?: { b64_json?: string; media_type?: string }[];
}

interface TranscriptionResponse extends ErrorBody {
  text?: string;
}

interface StreamEvent extends ErrorBody {
  choices?: { delta?: { content?: string; audio?: { data?: string } } }[];
}

/**
 * An error with a code that commands can map to a localized string.
 */
export class AIError extends Error {
  code: string;
  params: { [key: string]: string };

  constructor(code: string, message?: string, params: { [key: string]: string } = {}) {
    super(message ?? code);
    this.name = "AIError";
    this.code = code;
    this.params = params;
  }
}

export type Kind = "chat" | "image" | "speech" | "transcription" | "music";

// the setting each kind of model is configured with, and what's used without it
const modelSettings: { [kind in Kind]: [setting: string, fallback: string] } = {
  chat: ["OPENROUTER_MODEL", defaultChatModel],
  image: ["OPENROUTER_IMAGE_MODEL", defaultImageModel],
  speech: ["OPENROUTER_SPEECH_MODEL", defaultSpeechModel],
  transcription: ["OPENROUTER_TRANSCRIPTION_MODEL", defaultTranscriptionModel],
  music: ["OPENROUTER_MUSIC_MODEL", defaultMusicModel],
};

// what each kind of model has to output, which is how OpenRouter's model list is filtered
const listingModalities: { [kind in Kind]: string } = {
  chat: "text",
  image: "image",
  speech: "speech",
  transcription: "transcription",
  music: "audio",
};

const endpoints: { [kind in Kind]: string } = {
  chat: `${apiBase}/chat/completions`,
  image: `${apiBase}/images`,
  speech: `${apiBase}/audio/speech`,
  transcription: `${apiBase}/audio/transcriptions`,
  // music models are chat models that answer with audio
  music: `${apiBase}/chat/completions`,
};

const badModelCodes: { [kind in Kind]: string } = {
  chat: "badChatModel",
  image: "badImageModel",
  speech: "badSpeechModel",
  transcription: "badTranscriptionModel",
  music: "badMusicModel",
};

/**
 * Pull the most useful message out of an error body. When a provider fails,
 * OpenRouter's own message is just "Provider returned error" and the actual
 * explanation is in the provider's raw response.
 */
function errorMessage(data?: ErrorBody) {
  const error = data?.error;
  if (!error) return;
  const raw = error.metadata?.raw;
  if (typeof raw === "string") {
    try {
      const inner = JSON.parse(raw);
      const message = inner?.error?.message ?? inner?.message ?? inner?.detail;
      if (typeof message === "string" && message !== "") return message;
    } catch {
      // not JSON, so fall back to OpenRouter's message
    }
  }
  return error.message;
}

/**
 * Work out which error a failed response should become. OpenRouter only uses a
 * handful of status codes, so the message is needed to tell some of them apart.
 */
function classify(status: number, message: string | undefined, kind: Kind, model: string) {
  const text = message ?? `OpenRouter returned ${status}`;
  const reason = text.length > maxReasonLength ? `${text.slice(0, maxReasonLength - 1)}…` : text;
  const params = { model, reason };

  // a provider refusing what it was asked for comes back as a 502, but retrying
  // the same prompt won't help the way it does when a model is actually down
  if (message && /\bblocked\b/i.test(message)) return new AIError("blocked", text, params);

  switch (status) {
    case 401:
      return new AIError("auth", text, params);
    case 402:
      return new AIError("credits", text, params);
    case 403:
      return new AIError("moderation", text, params);
    case 408:
    case 504:
      return new AIError("timeout", text, params);
    case 413:
      return new AIError(kind === "transcription" ? "largeAudio" : "large", text, params);
    case 429:
      return new AIError("ratelimit", text, params);
    case 502:
    case 503:
      return new AIError("unavailable", text, params);
  }

  if (message?.includes("support image input")) return new AIError("noVision", text, params);
  // an unknown slug is a 400 on the chat and transcription endpoints but a 404
  // on the others, which also 404 for real models that can't do what was asked
  if (status === 404 || message?.includes("not a valid model ID") || /^Model \S+ does not exist/.test(message ?? "")) {
    return new AIError(badModelCodes[kind], text, params);
  }
  // anything else in the 4xx range means the provider didn't like what we sent,
  // and its own explanation is the most useful thing we can pass on
  if (status >= 400 && status < 500) return new AIError("rejected", text, params);
  return new AIError("error", text, params);
}

/**
 * Whether an OpenRouter key has been configured on this instance.
 */
export function enabled() {
  return !!process.env.OPENROUTER && process.env.OPENROUTER !== "";
}

function configuredModel(kind: Kind) {
  const [setting, fallback] = modelSettings[kind];
  return process.env[setting] || fallback;
}

interface ModelInfo {
  id: string;
  name: string;
  supported_voices?: string[] | null;
}

const modelLists = new Map<Kind, { models: ModelInfo[]; fetched: number }>();
// autocomplete asks on every keystroke, so share one request while it's running
const pendingLists = new Map<Kind, Promise<ModelInfo[] | undefined>>();

/**
 * Get OpenRouter's list of models of a kind, or undefined when it can't be fetched.
 */
async function listModels(kind: Kind, ms = 10000) {
  const cached = modelLists.get(kind);
  if (cached && Date.now() - cached.fetched < modelCacheTime) return cached.models;

  let pending = pendingLists.get(kind);
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetch(`${apiBase}/models?output_modalities=${listingModalities[kind]}`, {
          signal: AbortSignal.timeout(10000),
        });
        const data = (await res.json()) as { data?: ModelInfo[] };
        if (!data.data) throw new Error(`OpenRouter returned ${res.status}`);
        modelLists.set(kind, { models: data.data, fetched: Date.now() });
        return data.data;
      } catch (e) {
        logger.warn(`Couldn't fetch the list of ${kind} models: ${e}`);
      } finally {
        pendingLists.delete(kind);
      }
    })();
    pendingLists.set(kind, pending);
  }

  // an outdated list is better than none
  const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref?.());
  return (await Promise.race([pending, timeout])) ?? cached?.models;
}

/**
 * Suggest models of a kind matching what the user has typed so far, with the
 * configured one first.
 */
export async function suggestModels(kind: Kind, query: string) {
  if (!enabled()) return [];
  // Discord stops waiting for suggestions after 3 seconds
  const models = await listModels(kind, 2500);
  if (!models) return [];

  const configured = configuredModel(kind);
  const search = query.trim().toLowerCase();
  const terms = search.split(/\s+/).filter((term) => term !== "");
  const rank = (model: ModelInfo) => {
    if (model.id === configured) return 0;
    if (model.id.toLowerCase().startsWith(search)) return 1;
    if (model.name.toLowerCase().startsWith(search)) return 2;
    return 3;
  };

  return (
    models
      // choice values can't be longer than 100 characters, and batch variants
      // only work through OpenRouter's batch API
      .filter((model) => model.id.length <= 100 && !model.id.endsWith(":batch"))
      .filter((model) =>
        terms.every((term) => model.id.toLowerCase().includes(term) || model.name.toLowerCase().includes(term)),
      )
      // the list comes newest first, which is kept as the tiebreaker
      .map((model, index) => ({ model, index }))
      .sort((a, b) => rank(a.model) - rank(b.model) || a.index - b.index)
      .slice(0, 25)
      .map(({ model }) => {
        const label = `${model.name} (${model.id})${model.id === configured ? " ★" : ""}`;
        return { name: label.length > 100 ? `${label.slice(0, 99)}…` : label, value: model.id };
      })
  );
}

/**
 * Send a request and hand the successful response to `read`. The timeout covers
 * reading the body too, since some responses are streamed.
 */
async function call<T>(
  kind: Kind,
  body: { model: string; [key: string]: unknown },
  ms: number,
  read: (res: Response) => Promise<T>,
): Promise<T> {
  if (!enabled()) throw new AIError("disabled");

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, ms);

  try {
    const res = await fetch(endpoints[kind], {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER}`,
        "Content-Type": "application/json",
        // both are optional, and only affect how the bot shows up in OpenRouter's rankings
        "HTTP-Referer": process.env.OPENROUTER_REFERER || "https://esmbot.net",
        "X-OpenRouter-Title": "esmBot",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => undefined)) as ErrorBody | undefined;
      throw classify(res.status, errorMessage(data), kind, body.model);
    }
    return await read(res);
  } catch (e) {
    if (e instanceof AIError) throw e;
    if ((e as Error).name === "AbortError") throw new AIError("timeout", undefined, { model: body.model });
    // DNS failures, dropped connections and the like
    throw new AIError("unreachable", (e as Error).message, { model: body.model });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJSON<T extends ErrorBody>(res: Response, model: string) {
  const data = (await res.json().catch(() => undefined)) as T | undefined;
  // a 200 can still carry an error once the request has been handed to a provider
  if (!data || data.error) throw new AIError("error", errorMessage(data), { model });
  return data;
}

let warnedEffort = false;

/**
 * The effort levels users are allowed to pick, up to the configured maximum.
 */
export function allowedEfforts() {
  const setting = process.env.OPENROUTER_MAX_EFFORT?.trim().toLowerCase();
  let max = defaultMaxEffort;
  if (setting && effortLevels.includes(setting as Effort)) {
    max = setting as Effort;
  } else if (setting && !warnedEffort) {
    warnedEffort = true;
    logger.warn(`OPENROUTER_MAX_EFFORT is set to an unknown level (${setting}), using ${defaultMaxEffort} instead`);
  }
  return effortLevels.slice(0, effortLevels.indexOf(max) + 1);
}

/**
 * The effort used when none is picked, which the maximum can bring down.
 */
export function standardEffort() {
  const allowed = allowedEfforts();
  return allowed.includes(defaultEffort) ? defaultEffort : allowed[allowed.length - 1];
}

/**
 * Send a conversation to a text model and return its reply. The effort only
 * affects models that reason.
 */
export async function chat(messages: ChatMessage[], model?: string, effort?: string) {
  const chosen = model || configuredModel("chat");
  const allowed = allowedEfforts();
  const level = (effort?.trim().toLowerCase() || standardEffort()) as Effort;
  // slash commands only offer the allowed levels, but classic ones take anything
  if (!allowed.includes(level)) {
    throw new AIError("badEffort", `${level} isn't an allowed effort level`, {
      effort: effort ?? level,
      levels: allowed.join(", "),
    });
  }

  const budget = effortBudgets[level];
  const data = await call(
    "chat",
    {
      model: chosen,
      messages,
      max_tokens: budget.tokens,
      reasoning: { effort: level },
    },
    budget.timeout,
    (res) => readJSON<ChatResponse>(res, chosen),
  );

  const choice = data.choices?.[0];
  const content = choice?.message?.content?.trim();
  if (!content) {
    // reasoning models can use up the whole budget before writing anything
    if (choice?.finish_reason === "length") throw new AIError("length", undefined, { model: chosen });
    throw new AIError("empty");
  }
  return content;
}

/**
 * Generate an image from a prompt. Any references are used as a starting point,
 * which is how image-to-image editing is done.
 */
export async function generateImage(prompt: string, references: string[] = [], model?: string) {
  const chosen = model || configuredModel("image");
  const data = await call(
    "image",
    {
      model: chosen,
      prompt,
      ...(references.length > 0
        ? { input_references: references.map((url) => ({ type: "image_url", image_url: { url } })) }
        : {}),
    },
    imageTimeout,
    (res) => readJSON<ImageResponse>(res, chosen),
  );

  const image = data.data?.[0];
  if (!image?.b64_json) throw new AIError("empty");

  return {
    contents: Buffer.from(image.b64_json, "base64"),
    ext: mimeToExt(image.media_type ?? "image/png"),
  } satisfies GeneratedFile;
}

/**
 * Get the voices a speech model supports, or undefined when that can't be
 * checked. Voices are provider-specific and a bad one only gets a vague error
 * back, so it's worth catching them before paying for a request.
 */
async function voicesFor(model: string) {
  const models = await listModels("speech");
  if (!models) return;

  const found = models.find((m) => m.id === model);
  if (!found) throw new AIError("badSpeechModel", `${model} isn't listed as a speech model`, { model });
  return found.supported_voices ?? [];
}

/**
 * Pick the voice to use when none was asked for.
 */
function defaultVoice(model: string, modelGiven: boolean, voices?: string[]) {
  return (
    // the configured voice only makes sense for the configured model
    (!modelGiven && process.env.OPENROUTER_SPEECH_VOICE) ||
    (model === defaultSpeechModel ? defaultSpeechVoice : undefined) ||
    voices?.[0]
  );
}

/**
 * Suggest voices for a speech model matching what the user has typed so far,
 * with the one that would be used by default first.
 */
export async function suggestVoices(query: string, model?: string) {
  if (!enabled()) return [];
  const chosen = model || configuredModel("speech");
  // Discord stops waiting for suggestions after 3 seconds
  const found = (await listModels("speech", 2500))?.find((m) => m.id === chosen);
  const voices = found?.supported_voices ?? [];
  const fallback = defaultVoice(chosen, !!model, voices);
  const search = query.trim().toLowerCase();

  return voices
    .filter((voice) => voice.length <= 100 && voice.toLowerCase().includes(search))
    .sort((a, b) => Number(b === fallback) - Number(a === fallback))
    .slice(0, 25)
    .map((voice) => ({ name: voice === fallback ? `${voice} ★` : voice, value: voice }));
}

function listVoices(voices: string[]) {
  let list = "";
  for (const [i, voice] of voices.entries()) {
    const next = list === "" ? voice : `${list}, ${voice}`;
    if (next.length > maxVoiceListLength) return `${list} (+${voices.length - i} more)`;
    list = next;
  }
  return list;
}

/**
 * Read text aloud, returning a WAV file.
 */
export async function speak(input: string, voice?: string, model?: string) {
  const chosen = model || configuredModel("speech");
  const voices = await voicesFor(chosen);

  let chosenVoice = voice || defaultVoice(chosen, !!model, voices);
  if (chosenVoice && voices && voices.length > 0) {
    const match = voices.find((v) => v.toLowerCase() === chosenVoice?.toLowerCase());
    if (!match) {
      throw new AIError("badVoice", `${chosen} has no voice ${chosenVoice}`, {
        model: chosen,
        voice: chosenVoice,
        voices: listVoices(voices),
      });
    }
    chosenVoice = match;
  }

  return await call(
    "speech",
    {
      model: chosen,
      input,
      ...(chosenVoice ? { voice: chosenVoice } : {}),
      // some providers' MP3s are several files glued together, which a lot of
      // players cut off after the first one, so wrap raw samples ourselves
      response_format: "pcm",
    },
    speechTimeout,
    async (res) => {
      const type = res.headers.get("content-type") ?? "";
      // a 200 can still carry an error once the request has been handed to a provider
      if (!type.startsWith("audio/")) {
        const data = (await res.json().catch(() => undefined)) as ErrorBody | undefined;
        throw new AIError("error", errorMessage(data) ?? `unexpected ${type} response`, { model: chosen });
      }
      const contents = Buffer.from(await res.arrayBuffer());
      if (contents.length === 0) throw new AIError("empty");
      if (!type.startsWith("audio/pcm")) return { contents, ext: mimeToExt(type.split(";")[0]) };

      const rate = Number(/rate=(\d+)/.exec(type)?.[1] ?? 24000);
      const channels = Number(/channels=(\d+)/.exec(type)?.[1] ?? 1);
      return { contents: pcmToWav(contents, rate, channels), ext: "wav" } satisfies GeneratedFile;
    },
  );
}

/**
 * Wrap 16-bit little-endian PCM samples in a WAV header.
 */
function pcmToWav(pcm: Buffer, rate: number, channels: number) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Turn speech in an audio or video file into text.
 */
export async function transcribe(audio: AudioFile, model?: string) {
  const chosen = model || configuredModel("transcription");
  const data = await call(
    "transcription",
    { model: chosen, input_audio: { data: audio.buf.toString("base64"), format: audio.ext } },
    transcriptionTimeout,
    (res) => readJSON<TranscriptionResponse>(res, chosen),
  );

  const text = data.text?.trim();
  if (!text) throw new AIError("noSpeech");
  return text;
}

/**
 * Generate a piece of music, roughly `length` seconds long. Any lyrics the model
 * wrote come back alongside it.
 */
export async function compose(prompt: string, model?: string, length = clipLength) {
  if (!musicLengths.includes(length)) {
    throw new AIError("badLength", `${length} isn't an allowed length`, { lengths: musicLengths.join(", ") });
  }
  // clips always come out the same length, so anything longer needs a model
  // that makes full songs, which only goes by what the prompt asks for
  const long = length > clipLength;
  const chosen =
    model || (long ? process.env.OPENROUTER_LONG_MUSIC_MODEL || defaultLongMusicModel : configuredModel("music"));
  const minutes = length / 60;
  const content = long
    ? `${prompt}\n\nThe song should be about ${minutes} minute${minutes === 1 ? "" : "s"} long.`
    : prompt;

  const { audio, text } = await call(
    "music",
    {
      model: chosen,
      messages: [{ role: "user", content }],
      modalities: ["audio"],
      // audio output is only available as a stream
      stream: true,
    },
    musicTimeout,
    (res) => readAudioStream(res, chosen),
  );

  const type = await fileTypeFromBuffer(audio);
  if (!type) throw new AIError("empty", `${chosen} returned ${audio.length} bytes of unrecognized audio`);

  return { contents: audio, ext: type.ext, lyrics: cleanLyrics(text) };
}

/**
 * Come up with a title for a song using the chat model, since music models don't
 * name what they make. Returns undefined if that doesn't work out.
 */
export async function nameSong(lyrics: string, prompt: string) {
  const chosen = configuredModel("chat");
  try {
    const data = await call(
      "chat",
      {
        model: chosen,
        messages: [
          {
            role: "system",
            content: "You name songs. Reply with only a short title of two to five words, without quotes.",
          },
          {
            role: "user",
            content: lyrics
              ? `Lyrics:\n${lyrics.slice(0, 1500)}`
              : `Description of an instrumental piece:\n${prompt.slice(0, 1500)}`,
          },
        ],
        max_tokens: 1000,
        // reasoning models would otherwise think about this at length
        reasoning: { effort: "minimal" },
      },
      titleTimeout,
      (res) => readJSON<ChatResponse>(res, chosen),
    );
    return data.choices?.[0]?.message?.content?.trim() || undefined;
  } catch (e) {
    logger.warn(`Couldn't name a song with ${chosen}: ${(e as Error).message}`);
  }
}

/**
 * Strip Lyria's markup out of its lyrics.
 */
function cleanLyrics(text: string) {
  const lyrics = text
    // full songs mark each section like "[[A0]]", which reads better as a gap
    .replaceAll(/^\[\[\w+\]\] *$/gm, "")
    // every line starts with a timestamp like "[3.4:]", a range like
    // "[21.0:24.0]", or just "[:]"
    .replaceAll(/^\[[\d.]*:[\d.]*\] */gm, "")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
  // written in place of lyrics for instrumentals
  return lyrics === "<instrumental>" ? "" : lyrics;
}

/**
 * Collect the audio and text out of a streamed chat completion.
 */
async function readAudioStream(res: Response, model: string) {
  const chunks: string[] = [];
  let text = "";

  for (const line of (await res.text()).split("\n")) {
    // anything else is a keep-alive comment or a blank separator
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") break;

    let event: StreamEvent;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    // failures after the stream has started can only be reported inside it
    if (event.error) throw classify(Number(event.error.code) || 500, errorMessage(event), "music", model);

    const delta = event.choices?.[0]?.delta;
    if (delta?.audio?.data) chunks.push(delta.audio.data);
    if (delta?.content) text += delta.content;
  }

  if (chunks.length === 0) throw new AIError("empty", `${model} didn't return any audio`, { model });
  return { audio: Buffer.from(chunks.join(""), "base64"), text };
}

/**
 * Download media for use as model input and encode it as a data URL.
 *
 * Providers can't always fetch Discord's CDN URLs, and going through the media
 * request helper gets us the same file type validation and address checks that
 * the rest of the bot relies on.
 */
export async function toDataURL(url: string) {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new AIError("badLink");
  }

  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(target, ["image"], false);
  } catch (e) {
    throw downloadError(e);
  }

  // this also covers media that isn't an image at all, like videos
  if (!res?.buf) throw new AIError("nomedia");

  return await imageDataURL(res, url);
}

async function imageDataURL(res: { buf: Buffer; type: string }, url: string) {
  const image = directTypes.includes(res.type) ? { buf: res.buf, type: res.type } : await firstFrame(url);
  if (image.buf.length > maxInputSize) throw new AIError("large");

  return `data:${image.type};base64,${image.buf.toString("base64")}`;
}

/**
 * Download an audio or video file, or return undefined if the URL points at
 * something else.
 */
export async function fetchAudio(url: string): Promise<AudioFile | undefined> {
  const res = await fetchInput(url, audioTypes);
  if (!res) return;
  if (res.buf.length > maxAudioSize) throw new AIError("largeAudio");
  return { buf: res.buf, type: res.type, ext: res.ext };
}

/**
 * Turn an image, audio or video file into something a chat model can take.
 */
export async function toContentPart(url: string, transcriptionModel?: string): Promise<ContentPart> {
  const res = await fetchInput(url, [...formats.image, ...audioTypes]);
  if (!res) throw new AIError("nomediaAny");

  if (res.type.startsWith("image/")) return { type: "image_url", image_url: { url: await imageDataURL(res, url) } };

  if (res.buf.length > maxAudioSize) throw new AIError("largeAudio");
  const format = chatAudioFormats[res.type];
  if (format) {
    if (res.buf.length > maxInputSize) throw new AIError("large");
    return { type: "input_audio", input_audio: { data: res.buf.toString("base64"), format } };
  }

  const transcript = await transcribe(res, transcriptionModel);
  const kind = res.type.startsWith("video/") ? "video" : "audio";
  return { type: "text", text: `Transcript of the attached ${kind}:\n${transcript}` };
}

async function fetchInput(url: string, allowed: string[]) {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new AIError("badLink");
  }
  if (allowed.some((type) => !type.startsWith("image/")) && target.host === "media.discordapp.net") {
    // the media proxy is only meant for images and video, but the original
    // attachment URL takes the same signature
    target = new URL(target.pathname + target.search, "https://cdn.discordapp.com");
    target.searchParams.delete("animated");
  }

  try {
    return await download(target, allowed);
  } catch (e) {
    throw downloadError(
      e,
      allowed.some((type) => !type.startsWith("image/")),
    );
  }
}

/**
 * Convert the first frame of an image into something every provider accepts.
 */
async function firstFrame(url: string) {
  let result: Awaited<ReturnType<typeof runMediaJob>>;
  try {
    result = await runMediaJob({
      cmd: "still",
      params: {},
      id: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(),
      inputs: [{ path: url, spoiler: false }],
    });
  } catch (e) {
    throw new AIError("convert", String(e));
  }

  if (result.type === "png") return { buf: result.buffer, type: "image/png" };
  if (result.type === "jpg") return { buf: result.buffer, type: "image/jpeg" };
  if (result.type === "large" || result.type === "ratelimit" || result.type === "nomedia") {
    throw downloadError(result.type);
  }
  // e.g. "nocmd" when a media server hasn't been rebuilt with this command yet
  throw new AIError("convert", `media job returned ${result.type}`);
}

function downloadError(e: unknown, audio = false) {
  // the media helpers signal their own failures with plain strings
  if (e === "large") return new AIError(audio ? "largeAudio" : "large");
  // this is the host of the file rate limiting us, not the AI provider
  if (e === "ratelimit") return new AIError("downloadRatelimit");
  if (e === "nomedia") return new AIError("nomedia");
  return new AIError("download", e instanceof Error ? e.message : String(e));
}
