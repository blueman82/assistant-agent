import type { SpeechReply, Synthesizer } from "./types.ts";

export async function voiceOrText(
  text: string,
  outputPath: string,
  synthesizer: Synthesizer,
  encode: () => Promise<void>,
): Promise<SpeechReply> {
  try {
    await synthesizer.synthesize(text, outputPath);
    await encode();
    return { kind: "voice", path: outputPath, text };
  } catch {
    return { kind: "text", text };
  }
}
