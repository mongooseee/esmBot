import AICommand from "#cmd-classes/aiCommand.js";
import { allowedEfforts, chat, standardEffort, toContentPart } from "#utils/ai.js";
import { selectedImages } from "#utils/collections.js";
import mediaDetect, { klipyAttribution } from "#utils/mediadetect.js";
import { clean } from "#utils/misc.js";

const systemPrompt =
  "You are esmBot, a Discord bot. Answer concisely, in under 1500 characters, using Discord-flavored markdown.";

class AskCommand extends AICommand {
  async run() {
    this.success = false;
    const blocked = this.guard();
    if (blocked) return blocked;

    try {
      const prompt = this.getOptionString("prompt") ?? this.args.join(" ");
      if (!prompt || !prompt.trim()) return this.getString("ai.noPrompt");

      await this.acknowledge();

      const media = await this.findMedia();
      const reply = await chat(
        [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            // the docs recommend putting the text before any images
            content: media ? [{ type: "text", text: prompt }, media.part] : prompt,
          },
        ],
        this.getOptionString("model"),
        this.getOptionString("effort"),
      );

      this.success = true;
      // clean() neutralizes every @ in the output, so nothing the model writes can ping
      const content = clean(reply);
      // leave room for the attribution so truncation can't cut it off
      const footer = media?.klipy ? `\n${klipyAttribution}` : "";
      const limit = 2000 - footer.length;
      return {
        content: `${content.length > limit ? `${content.slice(0, limit - 1)}…` : content}${footer}`,
        flags: this.getOptionBoolean("ephemeral") ? 64 : undefined,
      };
    } catch (e) {
      return this.handleError(e);
    } finally {
      this.release();
    }
  }

  /**
   * Only look at media the user actually pointed at. Scanning back through the
   * channel the way the image commands do would silently staple an unrelated
   * image onto plain text questions.
   */
  async findMedia() {
    let meta;
    const audio = this.type === "application" ? this.getOptionAttachment("audio") : undefined;
    if (audio) {
      meta = { path: audio.url };
    } else if (this.getOptionAttachment("image") || this.getOptionString("link")) {
      const media = await mediaDetect(this.client, this.permissions, this.message, this.interaction, true);
      meta = media[0];
    } else {
      meta = selectedImages.get(this.author.id);
    }
    if (!meta?.path) return;
    return { part: await toContentPart(meta.path), klipy: !!meta.klipy };
  }

  static init() {
    super.init();
    // required params need to be at the beginning of the array
    this.flags.unshift(
      {
        name: "prompt",
        type: "string",
        description: "What you want to ask",
        maxLength: 2000,
        classic: true,
        required: true,
      },
      {
        name: "image",
        type: "attachment",
        description: "An image to ask about",
      },
      {
        name: "audio",
        type: "attachment",
        description: "An audio or video file to ask about",
      },
      {
        name: "link",
        type: "string",
        description: "The URL of an image, audio or video file to ask about",
      },
      {
        name: "effort",
        type: "string",
        description: "How much the model thinks before answering, if it can",
        // only what OPENROUTER_MAX_EFFORT allows, so there's nothing to reject
        choices: allowedEfforts().map((level) => ({
          name: level === standardEffort() ? `${level} (default)` : level,
          value: level,
        })),
      },
    );
    return this;
  }

  static description = "Asks an AI model a question, optionally about an image, audio or video";
  static aliases = ["ai", "chat", "gpt"];
}

export default AskCommand;
