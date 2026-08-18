import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const swiftPackage = resolve(root, "ios/App/CapApp-SPM/Package.swift");
const generatedTextFiles = [
  resolve(root, "android/build.gradle"),
  resolve(root, "android/app/src/main/res/xml/config.xml"),
  resolve(root, "ios/App/App/config.xml"),
];

try {
  await access(swiftPackage);
  const source = await readFile(swiftPackage, "utf8");
  const normalized = source.replaceAll("\\", "/");
  if (normalized !== source) {
    await writeFile(swiftPackage, normalized, "utf8");
    console.log("normalized iOS Swift package paths");
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

for (const path of generatedTextFiles) {
  try {
    const source = await readFile(path, "utf8");
    const normalized = source.replace(/[ \t]+$/gm, "");
    if (normalized !== source) {
      await writeFile(path, normalized, "utf8");
      console.log(`removed generated trailing whitespace: ${path}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
