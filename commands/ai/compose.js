import AICommand from "#cmd-classes/aiCommand.js";
import { compose, musicLengths, nameSong } from "#utils/ai.js";
import { clean } from "#utils/misc.js";

// long enough to be recognizable, short enough to fit in the attachment's name
const maxNameLength = 40;

class ComposeCommand extends AICommand {
  async run() {
    this.success = false;
    const blocked = this.guard();
    if (blocked) return blocked;

    try {
      const prompt = this.getOptionString("prompt") ?? this.args.join(" ");
      if (!prompt || !prompt.trim()) return this.getString("ai.noPrompt");

      await this.acknowledge();

      const { lyrics, ...music } = await compose(
        prompt,
        this.getOptionString("model"),
        this.getOptionInteger("length") ?? undefined,
      );
      this.success = true;
      const title = await nameSong(lyrics, prompt);
      return await this.sendFile(
        music,
        fileName([title, lyrics.split("\n").find((line) => line.trim() !== ""), prompt]),
        lyrics ? this.formatLyrics(clean(lyrics)) : undefined,
      );
    } catch (e) {
      return this.handleError(e);
    } finally {
      this.release();
    }
  }

  /**
   * Show the lyrics as a quote under a heading, cut down to fit in one message.
   */
  formatLyrics(lyrics) {
    const heading = `${this.getString("ai.lyrics")}\n>>> `;
    // the spoiler markers have to cover the lyrics too
    const [open, close] = this.getOptionBoolean("spoiler") ? ["||", "||"] : ["", ""];
    const room = 2000 - heading.length - open.length - close.length;
    const text = lyrics.length > room ? `${lyrics.slice(0, room - 1)}…` : lyrics;
    return `${heading}${open}${text}${close}`;
  }

  static init() {
    super.init();
    // required params need to be at the beginning of the array
    this.flags.unshift({
      name: "prompt",
      type: "string",
      description: "A description of the music you want, including any lyrics",
      maxLength: 2000,
      classic: true,
      required: true,
    });
    this.flags.push(
      {
        name: "length",
        type: "integer",
        description: "Roughly how long the music should be",
        choices: musicLengths.map((length) => ({
          name: length < 60 ? `${length} seconds` : `${length / 60} minute${length === 60 ? "" : "s"}`,
          value: length,
        })),
      },
      {
        name: "spoiler",
        type: "boolean",
        description: "Attempt to send output as a spoiler",
      },
    );
    return this;
  }

  static modelKind = "music";
  static description = "Generates a piece of music from a description";
  static aliases = ["song", "musicgen"];
}

/**
 * Turn the first usable name into something safe for a file, falling back to the
 * next when one has nothing left after cleaning up (like titles in other scripts).
 */
function fileName(sources) {
  for (const source of sources) {
    const slug = (source ?? "")
      .toLowerCase()
      .replaceAll(/['’]/g, "")
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "");
    if (slug === "") continue;
    // cut at a word boundary rather than partway through one
    return slug.length > maxNameLength ? slug.slice(0, maxNameLength).replace(/-[^-]*$/, "") : slug;
  }
  return "compose";
}

export default ComposeCommand;
