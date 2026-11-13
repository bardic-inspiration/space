// Where a project's files live. A project is a folder (spec 4); the studio
// reads all of it and writes only under `studio/` (S6).

export interface ProjectFiles {
  /** A name for the folder, for the title bar. */
  readonly name: string;
  /** False when changes live in memory only and are lost with the page. */
  readonly saves: boolean;
  /** Every file under the given folders, as a path from the project's root. */
  list(folders: string[]): Promise<string[]>;
  read(path: string): Promise<string | undefined>;
  write(path: string, text: string): Promise<void>;
  /** Removes a file, or a folder and everything in it. */
  remove(path: string): Promise<void>;
}

/** The studio's own folder: the only place it writes. */
export const STUDIO = 'studio/';

export function guard(path: string): void {
  if (!path.startsWith(STUDIO) || path.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`the studio writes only under ${STUDIO}, not ${path}`);
  }
}

/** A project held in memory: the bundled examples, and the tests. */
export class MemoryFiles implements ProjectFiles {
  readonly name: string;
  readonly saves = false;
  readonly files: Map<string, string>;
  /** Every path written or removed, in order. */
  readonly written: string[] = [];

  constructor(files: Record<string, string>, name = 'Examples') {
    this.files = new Map(Object.entries(files));
    this.name = name;
  }

  async list(folders: string[]): Promise<string[]> {
    return [...this.files.keys()].filter((path) => folders.some((folder) => path.startsWith(`${folder}/`))).sort();
  }

  async read(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async write(path: string, text: string): Promise<void> {
    guard(path);
    this.written.push(path);
    this.files.set(path, text);
  }

  async remove(path: string): Promise<void> {
    guard(path);
    this.written.push(path);
    for (const held of [...this.files.keys()]) if (held === path || held.startsWith(`${path}/`)) this.files.delete(held);
  }
}

/** A folder on disk, through the File System Access API. Chromium only (S4). */
export class FolderFiles implements ProjectFiles {
  readonly saves = true;
  private readonly root: FileSystemDirectoryHandle;
  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
  }

  get name(): string {
    return this.root.name;
  }

  private async dir(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
    let dir = this.root;
    for (const part of parts) {
      try {
        dir = await dir.getDirectoryHandle(part, { create });
      } catch {
        return undefined;
      }
    }
    return dir;
  }

  async list(folders: string[]): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      const entries = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
      for await (const [name, handle] of entries) {
        if (handle.kind === 'directory') await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`);
        else found.push(`${prefix}${name}`);
      }
    };
    for (const folder of folders) {
      const dir = await this.dir(folder.split('/'), false);
      if (dir) await walk(dir, `${folder}/`);
    }
    return found.sort();
  }

  async read(path: string): Promise<string | undefined> {
    const parts = path.split('/');
    const dir = await this.dir(parts.slice(0, -1), false);
    try {
      return dir && await (await (await dir.getFileHandle(parts.at(-1)!)).getFile()).text();
    } catch {
      return undefined;
    }
  }

  async write(path: string, text: string): Promise<void> {
    guard(path);
    const parts = path.split('/');
    const dir = (await this.dir(parts.slice(0, -1), true))!;
    const writable = await (await dir.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  }

  async remove(path: string): Promise<void> {
    guard(path);
    const parts = path.split('/');
    const dir = await this.dir(parts.slice(0, -1), false);
    try {
      await dir?.removeEntry(parts.at(-1)!, { recursive: true });
    } catch {
      // Already gone.
    }
  }
}
