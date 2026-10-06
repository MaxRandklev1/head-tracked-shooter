import * as THREE from "three";
import GUI from "lil-gui";
import { HeadFilter, OneEuro } from "./filter.js";
import { FaceTracker } from "./tracker.js";
import { createGame } from "./game.js";

const STORAGE_KEY = "head-tracked-shooter-v1";
const params = {
  // Camera model used to turn the face in the image into a position in meters.
  camFovDeg: 70,
  ipdMm: 63,
  // Head tracking smoothing and latency compensation.
  minCutoff: 1.2,
  beta: 15,
  velCutoff: 4,
  latencyMs: 35,
  predict: 1,
  // Game feel.
  shooterLean: 2.5,
  shooterTurn: 1.5,
  gameFov: 75,
  showPreview: true,
};
try {
  Object.assign(params, JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
} catch {}
const save = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
  } catch {}
};

// --- Renderer -------------------------------------------------------------

const canvas = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
// The rig is the player's body; the camera is their head, moved by the webcam.
const rig = new THREE.Group();
scene.add(rig);
const camera = new THREE.PerspectiveCamera(params.gameFov, 1, 0.03, 500);
rig.add(camera);

const resize = () => renderer.setSize(window.innerWidth, window.innerHeight, false);
window.addEventListener("resize", resize);
resize();

// --- Head tracking --------------------------------------------------------

// Head position in meters (x right, y up, z away from the screen, all from the
// player's point of view) and head rotation (yaw, pitch, roll in radians).
const filter = new HeadFilter(params);
const headRot = [0, 0, 0];
const rotFilters = [new OneEuro(), new OneEuro(), new OneEuro()];
let lastRotT = 0;

function onSample(pc, t, rot) {
  // The camera faces the player, so its image x and y are both flipped.
  filter.push([-pc[0], -pc[1], pc[2]], t);
  if (!rot) return;
  const dt = lastRotT ? Math.min(Math.max((t - lastRotT) / 1000, 1e-3), 0.2) : 1 / 30;
  lastRotT = t;
  for (let i = 0; i < 3; i++) headRot[i] = rotFilters[i].step(rot[i], dt, 0.8, 6, 1.5);
}

const video = document.getElementById("cam");
const preview = document.getElementById("preview");
const tracker = new FaceTracker(video, params, onSample);
let cameraError = "";

async function startCamera(deviceId) {
  cameraError = "";
  try {
    await tracker.start(deviceId);
    filter.reset();
    refreshCameraList();
  } catch (err) {
    const name = err && err.name;
    cameraError =
      name === "NotFoundError" ? "no webcam found"
      : name === "NotAllowedError" ? "camera permission was denied"
      : name === "NotReadableError" ? "the webcam is in use by another app"
      : String((err && err.message) || err);
    tracker.status = "off";
  }
}

// --- Game -----------------------------------------------------------------

const game = createGame({ scene, rig, canvas, camera, params });
game.setActive(true);

// --- Settings -------------------------------------------------------------

const gui = new GUI({ title: "Settings  (F fullscreen)" });
gui.onChange(save);
const actions = {
  camera: "",
  fullscreen: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()),
  restart: () => startCamera(actions.camera || undefined),
};
gui.add(actions, "fullscreen").name("fullscreen");
let cameraController = gui.add(actions, "camera", { default: "" }).name("webcam");
gui.add(actions, "restart").name("restart webcam");
gui.add(params, "shooterLean", 0.5, 8, 0.25).name("lean amount");
gui.add(params, "shooterTurn", 0, 6, 0.25).name("head turn amount");
gui.add(params, "gameFov", 50, 110, 1).name("field of view");
gui.add(params, "showPreview").name("show webcam when paused");
const fTrack = gui.addFolder("Tracking");
fTrack.add(params, "minCutoff", 0.2, 6, 0.1).name("smoothing at rest (Hz)");
fTrack.add(params, "beta", 0, 60, 1).name("responsiveness");
fTrack.add(params, "latencyMs", 0, 120, 1).name("latency to predict (ms)");
fTrack.add(params, "predict", 0, 1.5, 0.05).name("prediction strength");
fTrack.close();

async function refreshCameraList() {
  const cams = await tracker.listCameras();
  const options = { default: "" };
  cams.forEach((c, i) => (options[c.label || `camera ${i + 1}`] = c.deviceId));
  cameraController = cameraController.options(options).name("webcam");
  cameraController.onChange((id) => startCamera(id || undefined));
}

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === "KeyF") actions.fullscreen();
});
// While the mouse is captured by the game, get the panel out of the way.
document.addEventListener("pointerlockchange", () => gui.show(!document.pointerLockElement));
// A webcam plugged in after the page loaded gets picked up automatically.
navigator.mediaDevices.addEventListener("devicechange", () => {
  if (!tracker.stream) startCamera();
  else refreshCameraList();
});

// --- Loop -----------------------------------------------------------------

const status = document.getElementById("status");
const eye = [0, 0, 0.6];
let lastNow = performance.now();
let uiTimer = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastNow) / 1000, 0.1);
  lastNow = now;

  // The game only runs while face samples are still arriving. There is no
  // keyboard or mouse substitute for the head.
  const tracked = !!filter.pos && now - filter.t < 600;
  if (tracked) filter.predict(now, eye);
  game.update(dt, eye, tracked, tracked ? headRot : null);

  camera.fov = params.gameFov * game.weapon.fovScale;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);

  if (now - uiTimer > 100) {
    uiTimer = now;
    const paused = !document.pointerLockElement;
    const showPreview = paused && params.showPreview && !!tracker.stream;
    preview.classList.toggle("hidden", !showPreview);
    if (showPreview) tracker.drawPreview(preview);
    status.classList.toggle("hidden", !paused);
    status.textContent = cameraError
      ? `webcam: ${cameraError}`
      : tracker.stream
        ? `webcam: ${tracker.cameraLabel}  ${tracker.cameraMode}  -  ${tracked ? `tracking your face at ${tracker.fps.toFixed(0)} fps` : "no face in view"}`
        : `webcam: ${tracker.status}`;
  }
}
requestAnimationFrame(frame);

tracker
  .init()
  .then(() => startCamera())
  .catch((err) => {
    cameraError = `face tracker failed to load (${(err && err.message) || err})`;
  });

// Development only (stripped from production builds): lets the automated test
// stand in for the webcam by feeding face samples, exactly as the tracker does.
if (import.meta.env.DEV) {
  window.__dev = { feed: (pc, rot) => onSample(pc, performance.now(), rot), game, camera, params };
}
