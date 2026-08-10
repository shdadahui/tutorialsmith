/**
 * src/notes.js — 笔记核心业务逻辑
 *
 * 与存储层解耦：notes.js 只关心"笔记的增删查"，不关心数据存在哪里，
 * 方便后续切换存储后端（如 SQLite）而不影响业务代码。
 */
import { loadNotes, saveNotes } from "./storage.js";

/** 生成自增 ID：取现有笔记最大 id + 1 */
function nextId(notes) {
  return notes.reduce((max, n) => Math.max(max, n.id), 0) + 1;
}

/** 添加一条笔记，返回新笔记对象 */
export async function addNote(text, tag) {
  const notes = await loadNotes();
  const note = {
    id: nextId(notes),
    text,
    tag: tag || null,
    createdAt: new Date().toISOString(),
  };
  notes.push(note);
  await saveNotes(notes);
  return note;
}

/** 列出笔记，可选按标签过滤 */
export async function listNotes(tag) {
  const notes = await loadNotes();
  return tag ? notes.filter((n) => n.tag === tag) : notes;
}

/** 按 ID 删除笔记，不存在时抛出明确错误 */
export async function deleteNote(id) {
  const notes = await loadNotes();
  const idx = notes.findIndex((n) => n.id === id);
  if (idx === -1) throw new Error(`笔记 #${id} 不存在`);
  notes.splice(idx, 1);
  await saveNotes(notes);
}
