import { spawn } from "node:child_process";

const CLI_TIMEOUT_MS = 600_000;

/**
 * Run a CLI to completion, feeding `prompt` on stdin and capturing stdout.
 * Uses spawn() with an argv array (never shell:true) so nothing in the
 * prompt or CLI path can be interpreted by a shell.
 */
export function runCli(
  command: string,
  args: string[],
  prompt: string,
  timeoutMs: number = CLI_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d) => (stderr += d));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to spawn ${command}: ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr.slice(0, 800) || "(no stderr)"}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}
