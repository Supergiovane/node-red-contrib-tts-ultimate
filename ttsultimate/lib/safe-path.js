// Resolves client-supplied file names (uploads and delete requests from the editor) to a path
// inside a fixed folder. Anything that could escape the folder is rejected.
const path = require("path");

// Returns the bare file name (no directories), or null when it is not usable.
// Backslashes are treated as separators too, so Windows-style paths can't sneak through on posix.
function cleanFileName(fileName, extension) {
    if (typeof fileName !== "string") return null;
    if (fileName.indexOf("\0") !== -1) return null;
    const base = path.posix.basename(fileName.replace(/\\/g, "/"));
    if (base === "" || base === "." || base === "..") return null;
    if (extension !== undefined && !base.toLowerCase().endsWith(extension.toLowerCase())) return null;
    return base;
}

// Returns the absolute path of folder/fileName, or null if it would end up outside the folder.
function resolveInsideFolder(folder, fileName) {
    const root = path.resolve(folder);
    const target = path.resolve(root, fileName);
    if (!target.startsWith(root + path.sep)) return null;
    return target;
}

// Upload: strips any directory part from the original name, enforces the extension and the prefix.
function uploadPath(folder, prefix, originalName, extension) {
    const base = cleanFileName(originalName, extension);
    if (base === null) return null;
    return resolveInsideFolder(folder, prefix + base);
}

// Delete: the name must already be a bare file name with the expected prefix and extension.
function existingFilePath(folder, prefix, fileName, extension) {
    const base = cleanFileName(fileName, extension);
    if (base === null || base !== fileName || !base.startsWith(prefix)) return null;
    return resolveInsideFolder(folder, base);
}

module.exports = { cleanFileName, resolveInsideFolder, uploadPath, existingFilePath };
