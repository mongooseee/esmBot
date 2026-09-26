import AICommand from "#cmd-classes/aiCommand.js";
import { generateImage, toDataURL } from "#utils/ai.js";
import { selectedImages } from "#utils/collections.js";
import mediaDetect, { klipyAttribution } from "#utils/mediadetect.js";

class EditCommand extends AICommand {
  async run() {
    this.success = false;
    const blocked = this.guard();
    if (blocked) return blocked;

    try {
      const prompt = this.getOptionString("prompt") ?? this.args.join(" ");
      if (!prompt || !prompt.trim()) return this.getString("ai.noPrompt");

      await this.acknowledge();

      // same resolution order as the image commands, so replies and the
      // Select Image message command work here too
      let selection;
      if (!this.getOptionAttachment("image") && !this.getOptionString("link")) {
        selection = selectedImages.get(this.author.id);
      }
      const media = selection
        ? [selection]
        : await mediaDetect(this.client, this.permissions, this.message, this.interaction);
      if (media.length === 0) return this.getString("ai.noImage");
      selectedImages.delete(this.author.id);

      const reference = await toDataURL(media[0].path);
      const image = await generateImage(prompt, [reference], this.getOptionString("model"));
      this.success = true;
      return await this.sendFile(image, "edit", media[0].klipy ? klipyAttribution : undefined);
    } catch (e) {
      return this.handleError(e);
    } finally {
      this.release();
    }
  }

  static init() {
    super.init();
    // required params need to be at the beginning of the array
    this.flags.unshift(
      {
        name: "prompt",
        type: "string",
        description: "A description of the change you want",
        maxLength: 2000,
        classic: true,
        required: true,
      },
      {
        name: "image",
        type: "attachment",
        description: "An image/GIF attachment",
      },
      {
        name: "link",
        type: "string",
        description: "An image/GIF URL",
      },
    );
    this.flags.push({
      name: "spoiler",
      type: "boolean",
      description: "Attempt to send output as a spoiler",
    });
    return this;
  }

  static modelKind = "image";
  static description = "Edits an image using an AI model";
  static aliases = ["img2img", "inpaint", "aiedit"];
}

export default EditCommand;
