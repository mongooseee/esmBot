import AICommand from "#cmd-classes/aiCommand.js";
import { speak, suggestVoices } from "#utils/ai.js";

// about a minute of speech, which keeps the file well under Discord's limit
const maxLength = 1000;

class SpeakCommand extends AICommand {
  async run() {
    this.success = false;
    const blocked = this.guard();
    if (blocked) return blocked;

    try {
      // mentions and custom emoji get read out by name instead of as raw IDs
      const text = this.clean(this.getOptionString("text") ?? this.args.join(" "));
      if (!text || !text.trim()) return this.getString("ai.noText");
      // slash commands enforce this themselves, but classic ones don't
      if (text.length > maxLength) return this.getString("ai.textTooLong", { params: { max: String(maxLength) } });

      await this.acknowledge();

      const audio = await speak(text, this.getOptionString("voice"), this.getOptionString("model"));
      this.success = true;
      return await this.sendFile(audio, "speech");
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
        name: "text",
        type: "string",
        description: "The text to read aloud",
        maxLength,
        classic: true,
        required: true,
      },
      {
        name: "voice",
        type: "string",
        description: "The voice to use, which depends on the model",
        autocomplete: true,
      },
    );
    this.flags.push({
      name: "spoiler",
      type: "boolean",
      description: "Attempt to send output as a spoiler",
    });
    return this;
  }

  static async autocomplete(interaction) {
    const focused = interaction.data.options.getFocused();
    // voices depend on the model, so follow whichever one has been picked
    if (focused?.name === "voice") {
      return await suggestVoices(String(focused.value), interaction.data.options.getString("model"));
    }
    return await super.autocomplete(interaction);
  }

  static modelKind = "speech";
  static description = "Reads text aloud using an AI voice";
  static aliases = ["tts", "voice"];
}

export default SpeakCommand;
