import { invoke } from "@tauri-apps/api/core";

export type EditorDocumentKey = "monitor" | "positions" | "motion_groups";
export type EditorDocumentSnapshot = { revision: number; content: string | null };
type CommitResult = { accepted: boolean; snapshot: EditorDocumentSnapshot };
type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

export class DocumentConflict extends Error {
  constructor() { super("配置已由其他窗口更新，已载入最新版本，请检查后重试"); }
}

/** Each WebView has a reader; Rust is the only writer. Never retry stale writes. */
export class EditorDocumentClient {
  private current: EditorDocumentSnapshot | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private listeners = new Set<(snapshot: EditorDocumentSnapshot) => void>();
  constructor(readonly key: EditorDocumentKey, private ipc: Invoke = invoke) {}

  private accept(snapshot: EditorDocumentSnapshot) {
    if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
      || !(snapshot.content === null || typeof snapshot.content === "string")) throw new Error("编辑配置响应无效");
    if (!this.current || snapshot.revision > this.current.revision) {
      this.current = snapshot;
      this.listeners.forEach(listener => listener(snapshot));
    }
    return this.current;
  }

  subscribe(listener: (snapshot: EditorDocumentSnapshot) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async read() {
    return this.accept(await this.ipc<EditorDocumentSnapshot>("editor_document_read", { key: this.key }));
  }

  change(update: (content: string | null) => string, expected?: number): Promise<EditorDocumentSnapshot> {
    if (this.pending >= 32) return Promise.reject(new Error("编辑保存队列已满，请等待保存完成"));
    this.pending++;
    const operation = this.queue.catch(() => {}).then(async () => {
      const before = await this.read();
      if (expected !== undefined && before.revision !== expected) throw new DocumentConflict();
      const content = update(before.content);
      if (content === before.content) return before;
      const reply = await this.ipc<CommitResult>("editor_document_commit", { key: this.key, expected: before.revision, content });
      const latest = this.accept(reply.snapshot);
      if (!reply.accepted) throw new DocumentConflict();
      return latest;
    }).finally(() => { this.pending--; });
    this.queue = operation;
    return operation;
  }
}
