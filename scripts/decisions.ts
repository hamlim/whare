import { writeFile } from "fs/promises";

let title = process.argv.slice(2).join(" ");
let slug = title.toLowerCase().replace(/ /g, "-");

writeFile(`./decisions/${slug}.md`, `# ${title}\n\n`);
