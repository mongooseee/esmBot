import AICommand from "#cmd-classes/aiCommand.js";
import { generateImage } from "#utils/ai.js";

class ImagineCommand extends AICommand {
  async run() {
    this.success = false;
    const blocked = this.guard();
    if (blocked) return blocked;

    try {
      const prompt = this.getOptionString("prompt") ?? this.args.join(" ");
      if (!prompt || !prompt.trim()) return this.getString("ai.noPrompt");

      await this.acknowledge();

      const image = await generateImage(prompt, [], this.getOptionString("model"));
      this.success = true;
      return await this.sendFile(image, "imagine");
    } catch (e) {
      return this.handleError(e);
    } finally {
      this.release();
    }
  }

  static init() {
    super.init();
    // required params need to be at the beginning of the array
    this.flags.unshift({
      name: "prompt",
      type: "string",
      description: "A description of the image you want",
      maxLength: 2000,
      classic: true,
      required: true,
    });
    this.flags.push({
      name: "spoiler",
      type: "boolean",
      description: "Attempt to send output as a spoiler",
    });
    return this;
  }

  static modelKind = "image";
  static description = "Generates an image from a description";
  static aliases = ["generate", "dream", "txt2img"];
}

export default ImagineCommand;
