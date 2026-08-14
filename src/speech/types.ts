export interface Transcriber {
  transcribe(audioPath: string): Promise<string>;
}

export interface Synthesizer {
  synthesize(text: string, outputPath: string): Promise<void>;
}

export interface SpeechReply {
  readonly kind: "voice" | "text";
  readonly path?: string;
  readonly text: string;
}
