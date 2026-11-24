import { readFile, writeFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
await writeFile(new URL("./.generated-game.mjs", import.meta.url), "export default " + JSON.stringify(html) + ";\n");
