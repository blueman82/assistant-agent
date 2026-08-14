import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { MediaStorage, StoredMedia } from "./types.ts";

export class LocalMediaStorage implements MediaStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async save(fileName: string, data: Uint8Array, mimeType?: string): Promise<StoredMedia> {
    const safeName = basename(fileName);
    if (safeName !== fileName || safeName === "." || safeName === "..") {
      throw new Error("media file name must be a plain file name");
    }
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, safeName);
    await writeFile(path, data, { flag: "wx" });
    return { path, fileName: safeName, mimeType };
  }
}
