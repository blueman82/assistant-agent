export type AttachmentKind = "image" | "audio" | "document";

export interface Attachment {
  readonly kind: AttachmentKind;
  readonly path: string;
  readonly mimeType?: string;
  readonly fileName?: string;
}

export interface StoredMedia {
  readonly path: string;
  readonly fileName: string;
  readonly mimeType?: string;
}

export interface MediaStorage {
  save(fileName: string, data: Uint8Array, mimeType?: string): Promise<StoredMedia>;
}
