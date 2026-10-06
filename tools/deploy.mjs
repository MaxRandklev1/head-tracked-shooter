// Publishes the production build to the gh-pages branch, which GitHub Pages serves.
// usage: npm run deploy
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" && cmd === "npx" });
const out = (cmd, args) => execFileSync(cmd, args).toString().trim();

const remote = out("git", ["remote", "get-url", "origin"]);
const name = out("git", ["config", "user.name"]);
const email = out("git", ["config", "user.email"]);
const source = out("git", ["rev-parse", "--short", "HEAD"]);

run("npx", ["vite", "build"]);
// Stop GitHub Pages from running the files through Jekyll.
writeFileSync("dist/.nojekyll", "");

// The branch only ever holds the latest build, so it is rebuilt from scratch.
rmSync("dist/.git", { recursive: true, force: true });
run("git", ["init", "-q", "-b", "gh-pages"], "dist");
run("git", ["config", "user.name", name], "dist");
run("git", ["config", "user.email", email], "dist");
run("git", ["add", "-A"], "dist");
run("git", ["commit", "-q", "-m", `Deploy ${source}`], "dist");
run("git", ["push", "-f", remote, "gh-pages"], "dist");
rmSync("dist/.git", { recursive: true, force: true });
console.log("Deployed. GitHub Pages takes a minute or two to update.");
