import fs from "node:fs";
import path from "node:path";

const MAX_BACKUPS = 5;
const BACKUP_DIR = ".clawdi-backups";

function sanitizeName(filePath: string, rootDir: string): string {
  return path.relative(rootDir, filePath).replace(/\//g, "__");
}

export function backupFile(filePath: string, rootDir: string): void {
  const backupDir = path.join(rootDir, BACKUP_DIR);
  fs.mkdirSync(backupDir, { recursive: true });

  const sanitized = sanitizeName(filePath, rootDir);
  const backupName = `${sanitized}.${Date.now()}.bak`;

  fs.copyFileSync(filePath, path.join(backupDir, backupName));

  const entries = fs.readdirSync(backupDir);
  const backupPrefix = `${sanitized}.`;
  const backups = entries
    .filter((e) => e.startsWith(backupPrefix) && e.endsWith(".bak"))
    .toSorted();

  while (backups.length > MAX_BACKUPS) {
    const oldest = backups.shift()!;
    fs.unlinkSync(path.join(backupDir, oldest));
  }
}
