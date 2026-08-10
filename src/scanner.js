/**
 * scanner.js — 阶段 1：项目扫描与素材提取（感知工具）
 *
 * 职责：把"一个项目目录"变成"一份喂给 LLM 的紧凑文本素材"。
 * 它模拟人类开发者的阅读顺序：
 *   1. 先看 README（项目是什么）
 *   2. 再看依赖清单（技术栈）
 *   3. 然后看入口文件、核心源码
 *   4. 大文件截断、小文件打包，控制总 token 成本
 *
 * 安全护栏（对应"工具安全"设计）：
 *   - 只读目标目录，绝不修改
 *   - 跳过 node_modules/.git/dist 等噪音目录
 *   - 过滤 .env、密钥、证书等敏感文件，避免泄露
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";

/** 跳过这些目录（常见噪音/生成物/版本库） */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next",
  ".nuxt", ".cache", ".venv", "venv", "__pycache__", ".idea", ".vscode",
  "coverage", ".workbuddy", ".turbo", ".parcel-cache", ".pytest_cache",
  "target", "bin", "obj", "vendor", ".gradle", "Pods", "DerivedData",
]);

/** 跳过这些扩展名（二进制/媒体/编译产物/锁文件） */
const IGNORED_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif",
  ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar", ".exe", ".dll", ".so",
  ".dylib", ".class", ".pyc", ".pyo", ".o", ".a", ".obj", ".woff", ".woff2",
  ".ttf", ".eot", ".mp4", ".mp3", ".wav", ".min.js", ".map", ".lock",
]);

/** 敏感文件名/扩展名：绝对不读 */
const SENSITIVE_NAMES = new Set([
  ".env", ".env.local", ".env.production", ".env.development",
  "id_rsa", "id_rsa.pub", ".npmrc", ".pypirc",
]);
const SENSITIVE_EXTS = new Set([
  ".pem", ".key", ".p12", ".pfx", ".crt", ".cer", ".keystore", ".jks",
]);

/** 最高优先级的文件：README / 依赖清单 */
const PRIORITY_MATCHERS = [
  (f) => /^readme/i.test(f),                          // README.md / README.rst
  (f) => ["package.json", "requirements.txt", "go.mod", "pyproject.toml",
          "pom.xml", "build.gradle", "Cargo.toml", "composer.json", "Gemfile",
          "setup.py", "Pipfile", "Gopkg.toml"].includes(f),
];

/** 入口文件关键词 */
const ENTRY_KEYWORDS = ["main", "index", "app", "server", "cli", "manage", "run", "entry"];

/** 可读源码扩展名（按此偏好排序） */
const SOURCE_EXTS = [
  ".js", ".ts", ".tsx", ".jsx", ".py", ".go", ".java", ".rs", ".c", ".cpp",
  ".h", ".hpp", ".cs", ".php", ".rb", ".swift", ".kt", ".vue", ".svelte",
  ".html", ".css", ".scss", ".sql", ".sh", ".bat", ".ps1", ".md", ".json",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".xml", ".proto",
];

const MAX_FILES = 60;          // 最多读 60 个文件
const MAX_BYTES_PER_FILE = 8000; // 单个文件最多取 8000 字符
const MAX_DEPTH = 6;           // 目录深度上限，防止递归过深
const MAX_IMAGES = 5;          // 视觉提取的图片数量上限

/** 判断一个文件是否敏感/不可读 */
function isSensitiveFile(name) {
  if (SENSITIVE_NAMES.has(name)) return true;
  const lower = name.toLowerCase();
  if (lower.startsWith(".env")) return true; // .env 及所有变体
  if (SENSITIVE_EXTS.has(extname(lower))) return true;
  if (/secret|credential|cred|token|api[_-]?key|password/i.test(lower)) return true;
  return false;
}

/** 计算文件优先级（数值越小越优先） */
function filePriority(name, relPath) {
  if (PRIORITY_MATCHERS.some((m) => m(name))) return 0;
  const base = basename(name, extname(name));
  if (ENTRY_KEYWORDS.includes(base.toLowerCase())) return 1;
  const depth = relPath.split(/[\\/]/).length;
  return 10 + Math.min(depth, 10); // 越靠近根目录越优先
}

/**
 * 递归遍历目录，返回候选文件列表（含相对路径与优先级），已过滤噪音/敏感/二进制。
 */
async function collectFiles(dir, relPath = "", depth = 0) {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(join(dir, relPath), { withFileTypes: true });
  } catch {
    return []; // 无权限的目录静默跳过
  }

  const results = [];
  for (const entry of entries) {
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      results.push(...(await collectFiles(dir, childRel, depth + 1)));
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (IGNORED_EXTS.has(ext)) continue;
      if (isSensitiveFile(entry.name)) continue;
      results.push({ name: entry.name, relPath: childRel, priority: filePriority(entry.name, childRel) });
    }
  }
  return results;
}

/**
 * 扫描项目目录，输出给 LLM 的素材文本。
 * @param {string} projectPath 项目目录绝对路径
 * @param {object} opts { maxProjectBytes }
 * @returns {Promise<{filesText: string, fileCount: number, totalBytes: number}>}
 */
export async function scanProject(projectPath, opts = {}) {
  const maxBytes = opts.maxProjectBytes ?? 200_000;

  let candidates = await collectFiles(projectPath);
  candidates.sort((a, b) => a.priority - b.priority);

  const picked = [];
  let total = 0;
  for (const c of candidates) {
    if (picked.length >= MAX_FILES || total >= maxBytes) break;
    let content;
    try {
      const raw = await readFile(join(projectPath, c.relPath), "utf8");
      // 只保留可打印文本，防止二进制内容混入
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(raw)) continue;
      content = raw;
      // 单文件截断（raw 在 try 作用域内，这里顺手处理）
      if (content.length > MAX_BYTES_PER_FILE) {
        content = content.slice(0, MAX_BYTES_PER_FILE) + "\n... [已截断，共 " + raw.length + " 字符]";
      }
    } catch {
      continue; // 读取失败（编码问题等）跳过
    }
    total += content.length;
    if (total > maxBytes && picked.length > 0) {
      total -= content.length;
      break;
    }
    picked.push({ ...c, content });
  }

  // 组装成给 LLM 的文本（用 ``` 代码块包裹，便于模型区分）
  const blocks = picked.map((f) => {
    const lang = extname(f.name).replace(".", "") || "text";
    return `### 文件: ${f.relPath}\n\n\`\`\`${lang}\n${f.content}\n\`\`\``;
  });
  const filesText = blocks.join("\n\n");

  // 收集项目里的图片文件（供视觉模型提取，架构图/截图等）
  const imageFiles = await collectImages(projectPath);

  return { filesText, fileCount: picked.length, totalBytes: total, filePaths: picked.map((f) => f.relPath), imageFiles };
}

/** 图片扩展名 */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/** 收集项目中的图片文件（最多 MAX_IMAGES 张，按目录深度浅者优先） */
async function collectImages(dir, relPath = "", depth = 0, found = []) {
  if (depth > MAX_DEPTH || found.length >= MAX_IMAGES) return found;
  let entries;
  try {
    entries = await readdir(join(dir, relPath), { withFileTypes: true });
  } catch {
    return found;
  }
  // 目录深度浅的图片优先（README 附近的架构图通常更相关）
  const items = entries.filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !SENSITIVE_NAMES.has(e.name));
  const images = entries.filter((e) => e.isFile() && IMAGE_EXTS.has(extname(e.name).toLowerCase()));
  for (const img of images) {
    if (found.length >= MAX_IMAGES) break;
    found.push(relPath ? `${relPath}/${img.name}` : img.name);
  }
  for (const d of items) {
    await collectImages(dir, relPath ? `${relPath}/${d.name}` : d.name, depth + 1, found);
    if (found.length >= MAX_IMAGES) break;
  }
  return found;
}

/** 图片 MIME 映射 */
const IMAGE_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
};

/**
 * 视觉模型提取：给项目中的图片（架构图/截图）生成文字描述，拼进扫描素材。
 * @param {object} deps { imageFiles, projectPath, visionConfig }
 * @returns {Promise<string>} 图片描述文本（无图片/无配置时返回空字符串）
 */
export async function describeImages({ imageFiles = [], projectPath, visionConfig }) {
  if (!imageFiles.length || !visionConfig) return "";
  const { chatVision } = await import("./llm.js");
  const descriptions = [];
  for (const f of imageFiles.slice(0, MAX_IMAGES)) {
    const mime = IMAGE_MIME[extname(f).toLowerCase()];
    if (!mime) continue;
    try {
      const buf = await readFile(join(projectPath, f));
      const base64 = buf.toString("base64");
      const text = await chatVision({
        roleConfig: visionConfig,
        system: "你是资深软件架构师。请用中文简要描述这张架构图/截图/示意图的内容与结构，提取图中的关键文字和组件关系，控制在 150 字以内。",
        text: `这是项目中的图片文件 ${f}，请描述它表达的内容（架构、流程、UI 或说明）。`,
        imageBase64: base64,
        mimeType: mime,
      });
      descriptions.push(`### 图片: ${f}（视觉模型提取）\n\n${text}`);
      console.log(`  ✓ 视觉提取: ${f}`);
    } catch (err) {
      console.warn(`  ⚠ 视觉模型描述 ${f} 失败: ${err.message}`);
    }
  }
  return descriptions.join("\n\n");
}
