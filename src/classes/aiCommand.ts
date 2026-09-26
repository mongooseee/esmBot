import process from "node:process";
import { AttachmentFlags, type AutocompleteInteraction, Constants, type Message } from "oceanic.js";
import { AIError, enabled, type GeneratedFile, type Kind, suggestModels } from "#utils/ai.js";
import { aiRequests, selectedImages } from "#utils/collections.js";
import { getAllLocalizations } from "#utils/i18n.js";
import logger from "#utils/logger.js";
import { clean, maxFileSize } from "#utils/misc.js";
import { upload } from "#utils/tempimages.js";
import Command from "./command.ts";

const imageExts = ["png", "jpg", "webp", "gif", "avif"];

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
    logger.warn(`AI request failed (${e.code}${e.params.model ? `, ${e.params.model}` : ""}): ${e.message}`);
    // the model can come straight from the user and the reason from the provider,
    // so neither gets to ping anyone or break out of the formatting around it
    const params = Object.fromEntries(
      Object.entries(e.params).map(([key, value]) => [key, clean(value.replaceAll(/\s+/g, " "))]),
    );
    return this.getString(`ai.${e.code}`, { returnNull: true, params }) ?? this.getString("ai.error", { params });
  }

  /**
   * Send a generated file, optionally with some text alongside it. Images fall
   * back to the temp server when they're too big to attach directly.
   */
  async sendFile(generated: GeneratedFile, name: string, content?: string) {
    const spoiler = this.getOptionBoolean("spoiler");
    const ephemeral = this.getOptionBoolean("ephemeral");
    const flags = ephemeral ? 64 : undefined;
    const sizeLimit = this.interaction?.attachmentSizeLimit ?? maxFileSize(this.guild);

    const file = {
      contents: generated.contents,
      name: `${spoiler ? "SPOILER_" : ""}${name}.${generated.ext}`,
    };

    if (file.contents.length <= sizeLimit) return { content, files: [file], flags };

    // the temp server shows files in a media gallery, which can't play audio
    if (!imageExts.includes(generated.ext)) return { content: this.getString("ai.outputTooLarge"), flags: 64 };
    if (!process.env.TEMPDIR || process.env.TEMPDIR === "" || !this.permissions.has("EMBED_LINKS")) {
      return { content: this.getString("image.noTempServer"), flags: 64 };
    }
    if (this.interaction) {
      await upload(this.client, { ...file, flags }, this.interaction, content);
    } else if (this.message) {
      await upload(this.client, { ...file, flags }, this.message, content);
    }
    return;
  }

  /**
   * Make the output selectable so it can be piped straight into the image commands.
   */
  async finalize(res?: Message) {
    if (!this.interaction || !res) return;
    const attachment = res.attachments.first();
    if (!attachment?.contentType?.startsWith("image/")) return;
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
        autocomplete: true,
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

  static async autocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.data.options.getFocused();
    if (focused?.name !== "model") return [];
    return await suggestModels(this.modelKind, String(focused.value));
  }

  /**
   * The kind of model this command uses, which decides the models suggested for it.
   */
  static modelKind: Kind = "chat";
}

export default AICommand;
