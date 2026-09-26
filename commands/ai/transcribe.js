import { Buffer } from "node:buffer";
import AICommand from "#cmd-classes/aiCommand.js";
import { AIError, fetchAudio, transcribe } from "#utils/ai.js";
import mediaDetect from "#utils/mediadetect.js";
import { clean } from "#utils/misc.js";

// media detection also turns up images, so only check this many of its results
// for audio before giving up
const maxCandidates = 10;

class TranscribeCommand extends AICommand {
  async run() {
    this.success = false;
    const blocked = this.guard();
    if (blocked) return blocked;

    try {
      await this.acknowledge();

      const audio = await this.findAudio();
      if (!audio) return this.getString("ai.noAudio");

      const text = clean(await transcribe(audio, this.getOptionString("model")));
      this.success = true;
      const flags = this.getOptionBoolean("ephemeral") ? 64 : undefined;
      if (text.length <= 2000) return { content: text, flags };
      return {
        content: this.getString("ai.longTranscript"),
        files: [{ contents: Buffer.from(text), name: "transcript.txt" }],
        flags,
      };
    } catch (e) {
      return this.handleError(e);
    } finally {
      this.release();
    }
  }

  async findAudio() {
    // something given explicitly is used as-is, even if it turns out not to be audio
    const attachment = this.type === "application" ? this.getOptionAttachment("audio") : undefined;
    const link = this.getOptionString("link");
    if (attachment || link) {
      const audio = await fetchAudio(attachment?.url ?? link);
      if (!audio) throw new AIError("nomediaAudio");
      return audio;
    }

    // otherwise take the first audio or video in a reply or the recent messages,
    // which is how voice messages get picked up
    const media = await mediaDetect(this.client, this.permissions, this.message, this.interaction);
    for (const candidate of media.slice(0, maxCandidates)) {
      const audio = await fetchAudio(candidate.path);
      if (audio) return audio;
    }
  }

  static init() {
    super.init();
    this.flags.unshift(
      {
        name: "audio",
        type: "attachment",
        description: "An audio or video file",
      },
      {
        name: "link",
        type: "string",
        description: "An audio or video URL",
      },
    );
    return this;
  }

  static modelKind = "transcription";
  static description = "Transcribes the speech in an audio or video file";
  static aliases = ["stt", "transcript"];
}

export default TranscribeCommand;
