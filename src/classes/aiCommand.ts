import process from "node:process";
import { AttachmentFlags, Constants, type Message } from "oceanic.js";
import { AIError, enabled, type GeneratedImage } from "#utils/ai.js";
import { aiRequests, selectedImages } from "#utils/collections.js";
import { getAllLocalizations } from "#utils/i18n.js";
import logger from "#utils/logger.js";
import { maxFileSize } from "#utils/misc.js";
import { upload } from "#utils/tempimages.js";
import Command from "./command.ts";

class AICommand extends Command {
  /**
   * Check that the feature is usable and that this user isn't already running
   * something expensive. Returns a message to send back when it isn't.
   */
  guard() {
    if (!enabled()) return this.getString("ai.disabled");
    // these are slow and cost the instance owner money, so hold each user to one
    // in-flight request rather than the media commands' short debounce
    if (aiRequests.has(this.author.id)) return this.getString("image.slowDown");
    aiRequests.add(this.author.id);
    return;
  }

  release() {
    aiRequests.delete(this.author.id);
  }

  /**
   * Turn a failed request into something worth showing the user.
   */
  handleError(e: unknown) {
    if (!(e instanceof AIError)) throw e;
    logger.warn(`AI request failed (${e.code}): ${e.message}`);
    return this.getString(`ai.${e.code}`, { returnNull: true }) ?? this.getString("ai.error");
  }

  /**
   * Send a generated image, falling back to the temp server when it's too big
   * to attach directly.
   */
  async sendImage(image: GeneratedImage, name: string) {
    const spoiler = this.getOptionBoolean("spoiler");
    const ephemeral = this.getOptionBoolean("ephemeral");
    const flags = ephemeral ? 64 : undefined;
    const sizeLimit = this.interaction?.attachmentSizeLimit ?? maxFileSize(this.guild);

    const file = {
      contents: image.contents,
      name: `${spoiler ? "SPOILER_" : ""}${name}.${image.ext}`,
    };

    if (file.contents.length <= sizeLimit) return { files: [file], flags };

    if (!process.env.TEMPDIR || process.env.TEMPDIR === "" || !this.permissions.has("EMBED_LINKS")) {
      return { content: this.getString("image.noTempServer"), flags: 64 };
    }
    if (this.interaction) {
      await upload(this.client, { ...file, flags }, this.interaction);
    } else if (this.message) {
      await upload(this.client, { ...file, flags }, this.message);
    }
    return;
  }

  /**
   * Make the output selectable so it can be piped straight into the image commands.
   */
  async finalize(res?: Message) {
    if (!this.interaction || !res) return;
    const attachment = res.attachments.first();
    if (!attachment) return;
    const path = new URL(attachment.proxyURL);
    path.searchParams.set("animated", "true");
    selectedImages.set(this.interaction.user.id, {
      path: path.toString(),
      spoiler: !!(attachment.flags & AttachmentFlags.IS_SPOILER),
    });
  }

  /**
   * Adds the flags every AI command shares. Subclasses unshift their own
   * required options in front of these, the same way media commands do.
   */
  static init() {
    this.flags = [
      {
        name: "model",
        nameLocalizations: getAllLocalizations("ai.flagNames.model"),
        type: Constants.ApplicationCommandOptionTypes.STRING,
        description: "An OpenRouter model slug to use instead of the configured default",
        descriptionLocalizations: getAllLocalizations("ai.flags.model"),
      },
      {
        name: "ephemeral",
        nameLocalizations: getAllLocalizations("image.flagNames.ephemeral"),
        type: Constants.ApplicationCommandOptionTypes.BOOLEAN,
        description: "Attempt to send output as an ephemeral/temporary response",
        descriptionLocalizations: getAllLocalizations("image.flags.ephemeral"),
      },
    ];
    return this;
  }
}

export default AICommand;
