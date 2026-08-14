import type { TelegramApi } from "./api.ts";
import type { TelegramMessage } from "./types.ts";

export interface MediaInput { text: string; path: string; kind: "image" | "document" | "voice" }

export async function downloadMedia(api: TelegramApi, message: TelegramMessage, directory: string): Promise<MediaInput | undefined> {
  const voice = message.voice;
  const photo = message.photo?.at(-1);
  const document = message.document;
  const item = voice ? { id: voice.file_id, kind: "voice" as const, ext: "ogg" } :
    photo ? { id: photo.file_id, kind: "image" as const, ext: "jpg" } :
    document && (document.mime_type?.startsWith("image/") || document.mime_type === "application/pdf")
      ? { id: document.file_id, kind: document.mime_type === "application/pdf" ? "document" as const : "image" as const, ext: extension(document.file_name, document.mime_type) }
      : undefined;
  if (!item) return undefined;
  const path = `${directory}/${item.id}.${item.ext}`;
  await api.download(item.id, path);
  const caption = message.caption?.trim();
  return { kind: item.kind, path, text: caption ? `[${item.kind}: ${path}]\n${caption}` : `[${item.kind}: ${path}]` };
}

function extension(name: string | undefined, mime: string | undefined): string {
  const fromName = name?.split(".").at(-1);
  const ext = fromName ?? mime?.split("/").at(-1) ?? "bin";
  return ext.replace(/[^a-z0-9]/gi, "").slice(0, 10) || "bin";
}

