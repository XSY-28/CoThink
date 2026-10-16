import { normalizeTasks } from "./normalize.js";
import { renderReport } from "./report.js";

process.stdin.setEncoding("utf8");
let input = "";
try {
  for await (const chunk of process.stdin) input += String(chunk);
} catch {
  process.stderr.write("E_INPUT\n");
  process.exitCode = 1;
}
if (process.exitCode !== 1) {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    process.stderr.write("E_JSON\n");
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) {
    try {
      const output = renderReport(normalizeTasks(value));
      process.stdout.write(output);
    } catch {
      process.stderr.write("E_INPUT\n");
      process.exitCode = 1;
    }
  }
}
