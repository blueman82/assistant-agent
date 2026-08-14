import type { MediaStorage, StoredMedia } from "./types.ts";

export interface TelegramFile {
  readonly filePath: string;
}

export interface TelegramFileClient {
  getFile(fileId: string): Promise<TelegramFile>;
  downloadFile(filePath: string): Promise<Uint8Array>;
}

export interface TelegramDownloadRequest {
  readonly fileId: string;
  readonly fileName: string;
  readonly mimeType?: string;
}

export class TelegramMediaDownloader {
  private readonly client: TelegramFileClient;
  private readonly storage: MediaStorage;

  constructor(
    client: TelegramFileClient,
    storage: MediaStorage,
  ) {
    this.client = client;
    this.storage = storage;
  }

  async download(request: TelegramDownloadRequest): Promise<StoredMedia> {
    const file = await this.client.getFile(request.fileId);
    const data = await this.client.downloadFile(file.filePath);
    return this.storage.save(request.fileName, data, request.mimeType);
  }
}
