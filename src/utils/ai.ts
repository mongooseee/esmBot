import { Buffer } from "node:buffer";
import process from "node:process";
import { request } from "./media.ts";
import { mimeToExt } from "./mime.ts";

const chatEndpoint = "https://openrouter.ai/api/v1/chat/completions";
const imageEndpoint = "https://openrouter.ai/api/v1/images";

// both of these are multimodal, which the commands below rely on
const defaultChatModel = "google/gemini-3.1-flash-lite";
const defaultImageModel = "bytedance-seed/seedream-4.5";

const chatTimeout = 60000;
// image models are considerably slower than text ones
const imageTimeout = 120000;

// Discord caps messages at 2000 characters, so there's no point paying for a
// long reply that we'd only have to cut off
const chatMaxTokens = 700;

// input images are sent inline as base64, which inflates them by about a third
const maxInputSize = 8388608;

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface GeneratedImage {
  contents: Buffer;
  ext: string;
}

interface ErrorBody {
  error?: { message?: string };
}

interface ChatResponse extends ErrorBody {
  choices?: { message?: { content?: string } }[];
}

interface ImageResponse extends ErrorBody {
  data?: { b64_json?: string; media_type?: string }[];
}

/**
 * An error with a code that commands can map to a localized string.
 */
export class AIError extends Error {
  code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "AIError";
    this.code = code;
  }
}

/**
 * Whether an OpenRouter key has been configured on this instance.
 */
export function enabled() {
  return !!process.env.OPENROUTER && process.env.OPENROUTER !== "";
}

async function call<T extends ErrorBody>(endpoint: string, body: object, ms: number): Promise<T> {
  if (!enabled()) throw new AIError("disabled");

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, ms);

  let res: Response;
  try {
    res = await fetch(endpoint, {
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
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new AIError("timeout");
    throw e;
  } finally {
    clearTimeout(timeout);
  }

  const data = (await res.json().catch(() => undefined)) as T | undefined;

  if (!res.ok) {
    const message = data?.error?.message;
    if (res.status === 429) throw new AIError("ratelimit", message);
    if (res.status === 402) throw new AIError("credits", message);
    if (res.status === 403) throw new AIError("moderation", message);
    throw new AIError("error", message ?? `OpenRouter returned ${res.status}`);
  }
  // a 200 can still carry an error once the request has been handed to a provider
  if (!data || data.error) throw new AIError("error", data?.error?.message);

  return data;
}

/**
 * Send a conversation to a text model and return its reply.
 */
export async function chat(messages: ChatMessage[], model?: string) {
  const data = await call<ChatResponse>(
    chatEndpoint,
    {
      model: model || process.env.OPENROUTER_MODEL || defaultChatModel,
      messages,
      max_tokens: chatMaxTokens,
    },
    chatTimeout,
  );

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new AIError("empty");
  return content;
}

/**
 * Generate an image from a prompt. Any references are used as a starting point,
 * which is how image-to-image editing is done.
 */
export async function generateImage(prompt: string, references: string[] = [], model?: string) {
  const data = await call<ImageResponse>(
    imageEndpoint,
    {
      model: model || process.env.OPENROUTER_IMAGE_MODEL || defaultImageModel,
      prompt,
      ...(references.length > 0
        ? { input_references: references.map((url) => ({ type: "image_url", image_url: { url } })) }
        : {}),
    },
    imageTimeout,
  );

  const image = data.data?.[0];
  if (!image?.b64_json) throw new AIError("empty");

  return {
    contents: Buffer.from(image.b64_json, "base64"),
    ext: mimeToExt(image.media_type ?? "image/png"),
  } satisfies GeneratedImage;
}

/**
 * Download media for use as model input and encode it as a data URL.
 *
 * Providers can't always fetch Discord's CDN URLs, and going through the media
 * request helper gets us the same file type validation and address checks that
 * the rest of the bot relies on.
 */
export async function toDataURL(url: string) {
  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(new URL(url), ["image"], false);
  } catch (e) {
    // the request helper signals its own failures with plain strings
    if (typeof e === "string") throw new AIError(e === "large" ? "large" : e);
    throw e;
  }

  if (!res?.buf) throw new AIError("nomedia");
  if (res.buf.length > maxInputSize) throw new AIError("large");

  return `data:${res.type};base64,${res.buf.toString("base64")}`;
}
