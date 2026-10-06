// End-to-end check in headless Chrome. There is no webcam there, so the test
// feeds face samples through the dev-only hook, the same way the tracker does.
// Start the dev server first (npm run dev), then: npm test [url]
import puppeteer from "puppeteer-core";

const url = process.argv[2] || "http://localhost:5173/";
const chrome = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--window-size=1280,720", "--enable-gpu", "--ignore-gpu-blocklist"],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
const problems = [];
page.on("console", (m) => {
  const text = m.text();
  if ((m.type() === "error" || /not used/.test(text)) && !/404|favicon/.test(text)) problems.push(text);
});
page.on("pageerror", (e) => problems.push(e.message));
await page.goto(url, { waitUntil: "load" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
};
const locked = () => page.evaluate(() => !!document.pointerLockElement);
const message = () => page.evaluate(() => document.querySelector("#g-msg").textContent);
const cam = () => page.evaluate(() => ({ x: window.__dev.camera.position.x, yaw: window.__dev.camera.rotation.y }));
const botSpots = () =>
  page.evaluate(() => window.__dev.game.bots.map((b) => `${b.pos.x.toFixed(3)},${b.pos.z.toFixed(3)}`).join(" "));

await wait(5000); // models load

// 1. No face: the game must refuse to start.
check("asks for a webcam when there is no face", (await message()).includes("WEBCAM REQUIRED"));
await page.mouse.click(600, 360);
await wait(300);
check("cannot start without a tracked face", !(await locked()));

// 2. A face appears (simulated head, centered, 60 cm from the camera).
await page.evaluate(() => {
  window.__pose = { x: 0, y: 0, z: 0.6, yaw: 0 };
  window.__feed = setInterval(() => {
    const p = window.__pose;
    window.__dev.feed([-p.x, -p.y, p.z], [p.yaw, 0, 0]);
  }, 16);
});
await wait(400);
await page.mouse.click(600, 360);
await wait(400);
check("starts once a face is tracked", await locked());
await wait(2500);

// 3. Leaning the head moves the view; the old Q / E lean keys do nothing.
await page.keyboard.down("KeyE");
await wait(500);
const keyed = (await cam()).x;
check("E key no longer leans", Math.abs(keyed) < 0.01, `camera x ${keyed.toFixed(3)}`);
await page.keyboard.up("KeyE");
await page.evaluate(() => (window.__pose.x = 0.15));
await wait(700);
const leaned = (await cam()).x;
check("leaning the head 15 cm leans in-game", leaned > 0.2, `camera x ${leaned.toFixed(2)} m`);
await page.evaluate(() => (window.__pose.x = 0));

// 4. Turning the head turns the view.
await page.evaluate(() => (window.__pose.yaw = -0.3));
await wait(700);
const yaw = (await cam()).yaw;
check("turning the head right looks right", yaw < -0.25, `camera yaw ${yaw.toFixed(2)} rad`);
await page.evaluate(() => (window.__pose.yaw = 0));

// 5. The match is live while tracked...
const before = await botSpots();
await wait(600);
check("bots move while the face is tracked", before !== (await botSpots()));
await page.screenshot({ path: "test-playing.png" });

// 6. ...and freezes the moment the face is gone.
await page.evaluate(() => clearInterval(window.__feed));
await wait(1200);
const frozen = await botSpots();
await wait(600);
check("match freezes when the face is lost", frozen === (await botSpots()));
check("asks for the webcam again", (await message()).includes("WEBCAM REQUIRED"));
await page.screenshot({ path: "test-no-face.png" });

check("no page errors or rejected assets", problems.length === 0, problems.slice(0, 3).join(" | "));
await browser.close();
process.exit(failed ? 1 : 0);
