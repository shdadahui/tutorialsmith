/**
 * src/storage.js — JSON 文件存储层
 *
 * 关键设计：
 *   1. 原子写入：先写 <db>.tmp 临时文件，再 rename 覆盖正式文件。
 *      即使写入中途进程崩溃，正式文件也只会是"旧的完整版本"，不会损坏。
 *   2. 路径动态计算：支持环境变量 MINI_NOTES_DB 覆盖数据目录（测试隔离用），
 *      所以每次读写都实时取路径，而不是模块加载时固化。
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/** 数据目录：默认用户主目录下隐藏文件夹，可用 MINI_NOTES_DB 覆盖 */
export function getDataDir() {
  return process.env.MINI_NOTES_DB || join(homedir(), ".mini-notes");
}

/** 数据库文件路径 */
export function getDbPath() {
  return join(getDataDir(), "notes.json");
}

/** 展示用路径（帮助信息里显示） */
export const DB_PATH = () => getDbPath();

/** 读取全部笔记；文件不存在时返回空数组 */
export async function loadNotes() {
  try {
    const raw = await readFile(getDbPath(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err; // 文件损坏等真实错误要抛出，不能静默吞掉
  }
}

/** 原子写入：临时文件 + rename */
export async function saveNotes(notes) {
  await mkdir(getDataDir(), { recursive: true });
  const tmpPath = `${getDbPath()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(notes, null, 2), "utf8");
  await rename(tmpPath, getDbPath());
}
