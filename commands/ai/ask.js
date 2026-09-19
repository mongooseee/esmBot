import AICommand from "#cmd-classes/aiCommand.js";
import { chat, toDataURL } from "#utils/ai.js";
import { selectedImages } from "#utils/collections.js";
import mediaDetect from "#utils/mediadetect.js";
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

      const image = await this.findImage();
      const reply = await chat(
        [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            // the docs recommend putting the text before any images
            content: image ? [{ type: "text", text: prompt }, image] : prompt,
          },
        ],
        this.getOptionString("model"),
      );

      this.success = true;
      // clean() neutralizes every @ in the output, so nothing the model writes can ping
      const content = clean(reply);
      return {
        content: content.length > 2000 ? `${content.slice(0, 1999)}…` : content,
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
  async findImage() {
    let path;
    if (this.getOptionAttachment("image") || this.getOptionString("link")) {
      const media = await mediaDetect(this.client, this.permissions, this.message, this.interaction, true);
      path = media[0]?.path;
    } else {
      path = selectedImages.get(this.author.id)?.path;
    }
    if (!path) return;
    return { type: "image_url", image_url: { url: await toDataURL(path) } };
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
        name: "link",
        type: "string",
        description: "The URL of an image to ask about",
      },
    );
    return this;
  }

  static description = "Asks an AI model a question, optionally about an image";
  static aliases = ["ai", "chat", "gpt"];
}

export default AskCommand;
