// Smoke test for a built or hosted copy (no dev hook there): loads the page in
// headless Chrome with Chrome's fake camera and checks that everything loads
// from that address and that the game holds at "webcam required" with no face.
// usage: node tools/smoke.mjs <url> [screenshot.png]
import puppeteer from "puppeteer-core";

const [url, shot] = process.argv.slice(2);
if (!url) {
  console.error("usage: node tools/smoke.mjs <url> [screenshot.png]");
  process.exit(2);
}
const chrome = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: [
    "--window-size=1280,720", "--enable-gpu", "--ignore-gpu-blocklist",
    "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
  ],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
const problems = [];
const failedRequests = [];
page.on("console", (m) => {
  const text = m.text();
  // Failed requests are counted from the responses below, and MediaPipe logs
  // its start-up INFO lines through console.error.
  if (/Failed to load resource|^INFO:/.test(text)) return;
  if (m.type() === "error" || /not used/.test(text)) problems.push(text);
});
page.on("pageerror", (e) => problems.push(e.message));
page.on("response", (r) => {
  if (r.status() >= 400 && !/favicon/.test(r.url())) failedRequests.push(`${r.status()} ${r.url()}`);
});
await page.goto(url, { waitUntil: "load" });

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
};

// The face tracker (WASM + model) and the camera are up once the status line
// reports the camera with no face in view (the fake camera shows a test pattern).
let status = "";
for (let i = 0; i < 60 && !/no face in view/.test(status); i++) {
  await new Promise((r) => setTimeout(r, 500));
  status = await page.$eval("#status", (el) => el.textContent);
}
check("face tracker and camera start", /no face in view/.test(status), status);
await new Promise((r) => setTimeout(r, 4000)); // let the models finish loading
const text = await page.evaluate(() => document.body.innerText);
check("holds at WEBCAM REQUIRED with no face", text.includes("WEBCAM REQUIRED"));
await page.mouse.click(600, 360);
await new Promise((r) => setTimeout(r, 300));
check("cannot start without a face", !(await page.evaluate(() => !!document.pointerLockElement)));
check("no test hook in this build", await page.evaluate(() => typeof window.__dev === "undefined"));
check("every file loaded", failedRequests.length === 0, failedRequests.slice(0, 4).join(" | "));
check("no page errors or rejected assets", problems.length === 0, problems.slice(0, 3).join(" | "));
if (shot) await page.screenshot({ path: shot });
await browser.close();
process.exit(failed ? 1 : 0);
