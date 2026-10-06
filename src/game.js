import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

// Free-for-all arena shooter with head-tracked leaning. It plays like a normal
// first-person shooter (WASD walks, the mouse aims), and moving your real head
// moves the in-game head, amplified, so leaning sideways peeks around a corner.
// Everyone else is a bot with a gun, fighting you and each other.

const ARENA = 30; // half-size, meters
const EYE_HEIGHT = 1.6;
const PLAYER_RADIUS = 0.4;
const HEAD_RADIUS = 0.2;
const BOT_NAMES = ["Red", "Orange", "Lime", "Cyan", "Violet", "Pink", "Gold"];
const BOT_COLORS = [0xe5484d, 0xf08c2e, 0x8ac926, 0x2ec4d6, 0x8f6bff, 0xff7ab8, 0xe8c547];
const ASSETS = "/models/game/";
const WALL_SEGMENT = 4; // length of one arena_wall.glb tile, meters

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createGame({ scene, rig, canvas, camera, params }) {
  const world = new THREE.Group();
  world.visible = false;
  scene.add(world);

  // --- Arena ---
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA * 2, ARENA * 2),
    new THREE.MeshStandardMaterial({ color: 0x1a2030, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  world.add(floor);
  const grid = new THREE.GridHelper(ARENA * 2, ARENA, 0x35e0c0, 0x26405a);
  grid.position.y = 0.01;
  world.add(grid);

  const solids = [floor];
  const boxes = []; // { minX, maxX, minZ, maxZ, h } for collision and sight lines
  const addBox = (x, z, w, d, h, color) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.7 }),
    );
    mesh.position.set(x, h / 2, z);
    world.add(mesh);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0.5 }),
    );
    mesh.add(edges);
    solids.push(mesh);
    boxes.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, h });
    return { mesh, x, z, w, d, h };
  };
  const boundary = [];
  const cover = [];
  const T = 1;
  boundary.push(addBox(0, -ARENA - T / 2, ARENA * 2 + 2, T, 5, 0x232b3d));
  boundary.push(addBox(0, ARENA + T / 2, ARENA * 2 + 2, T, 5, 0x232b3d));
  boundary.push(addBox(-ARENA - T / 2, 0, T, ARENA * 2 + 2, 5, 0x232b3d));
  boundary.push(addBox(ARENA + T / 2, 0, T, ARENA * 2 + 2, 5, 0x232b3d));
  const rand = mulberry32(7);
  const crateColors = [0x3b4a6b, 0x4a3b6b, 0x2f5d62, 0x6b4a3b];
  for (let i = 0; i < 34; i++) {
    const x = (rand() - 0.5) * (ARENA * 2 - 6);
    const z = (rand() - 0.5) * (ARENA * 2 - 6);
    if (Math.hypot(x, z) < 4) continue; // keep the middle clear
    const tall = rand() < 0.3;
    cover.push(addBox(x, z, 1 + rand() * 2.5, 1 + rand() * 2.5, tall ? 3 + rand() * 3 : 0.9 + rand() * 0.8, crateColors[i % 4]));
  }

  world.add(new THREE.HemisphereLight(0xcfe2ff, 0x2a2630, 2.4));
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(8, 20, 6);
  world.add(sun);
  let background = new THREE.Color(0x070a12);
  let environment = null;
  let fog = new THREE.Fog(0x070a12, 25, 75);

  // --- Collision and sight lines (all in the ground plane, with box heights) ---
  function collide(pos, radius) {
    pos.x = THREE.MathUtils.clamp(pos.x, -ARENA + radius, ARENA - radius);
    pos.z = THREE.MathUtils.clamp(pos.z, -ARENA + radius, ARENA - radius);
    for (const b of boxes) {
      const cx = THREE.MathUtils.clamp(pos.x, b.minX, b.maxX);
      const cz = THREE.MathUtils.clamp(pos.z, b.minZ, b.maxZ);
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= radius * radius) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        pos.x = cx + (dx / d) * radius;
        pos.z = cz + (dz / d) * radius;
      } else {
        // Center is inside the box: push out through the nearest face.
        const toMinX = pos.x - b.minX, toMaxX = b.maxX - pos.x;
        const toMinZ = pos.z - b.minZ, toMaxZ = b.maxZ - pos.z;
        const m = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
        if (m === toMinX) pos.x = b.minX - radius;
        else if (m === toMaxX) pos.x = b.maxX + radius;
        else if (m === toMinZ) pos.z = b.minZ - radius;
        else pos.z = b.maxZ + radius;
      }
    }
  }

  // Where along the segment (0..1) it enters the box footprint, or -1.
  function segmentEntersBox(x0, z0, x1, z1, b) {
    let tMin = 0, tMax = 1;
    const dx = x1 - x0, dz = z1 - z0;
    if (Math.abs(dx) < 1e-9) {
      if (x0 < b.minX || x0 > b.maxX) return -1;
    } else {
      let ta = (b.minX - x0) / dx, tb = (b.maxX - x0) / dx;
      if (ta > tb) [ta, tb] = [tb, ta];
      tMin = Math.max(tMin, ta);
      tMax = Math.min(tMax, tb);
      if (tMin > tMax) return -1;
    }
    if (Math.abs(dz) < 1e-9) {
      if (z0 < b.minZ || z0 > b.maxZ) return -1;
    } else {
      let ta = (b.minZ - z0) / dz, tb = (b.maxZ - z0) / dz;
      if (ta > tb) [ta, tb] = [tb, ta];
      tMin = Math.max(tMin, ta);
      tMax = Math.min(tMax, tb);
      if (tMin > tMax) return -1;
    }
    return tMin;
  }

  // Can a point at `from` see a point at `to`? A box only blocks if it is
  // taller than the sight line where the line crosses it, so ducking works.
  function canSee(from, to) {
    for (const b of boxes) {
      const t = segmentEntersBox(from.x, from.z, to.x, to.z, b);
      if (t < 0) continue;
      if (b.h > from.y + (to.y - from.y) * t) return false;
    }
    return true;
  }

  function insideAnyBox(x, z, margin) {
    for (const b of boxes) {
      if (x > b.minX - margin && x < b.maxX + margin && z > b.minZ - margin && z < b.maxZ + margin) return true;
    }
    return false;
  }

  function randomOpenPoint(out) {
    for (let i = 0; i < 60; i++) {
      const x = (Math.random() - 0.5) * (ARENA * 2 - 3);
      const z = (Math.random() - 0.5) * (ARENA * 2 - 3);
      if (insideAnyBox(x, z, 0.7)) continue;
      return out.set(x, 0, z);
    }
    return out.set(0, 0, 0);
  }

  // --- Gun, fixed to the view like any first-person weapon ---
  const gun = new THREE.Group();
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x596275, emissive: 0x141821, roughness: 0.5, metalness: 0.2 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.07, 0.3), gunMat);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 12), gunMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.012, -0.24);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.11, 0.05), gunMat);
  grip.position.set(0, -0.08, 0.09);
  grip.rotation.x = 0.25;
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.015, 0.01), new THREE.MeshBasicMaterial({ color: 0x35e0c0 }));
  sight.position.set(0, 0.043, -0.13);
  const flash = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffe9a0 }));
  flash.position.set(0, 0.012, -0.36);
  flash.visible = false;
  gun.add(body, barrel, grip, sight, flash);
  const GUN_REST = new THREE.Vector3(0.13, -0.115, -0.3); // hip-fire position
  gun.scale.setScalar(0.65);
  gun.position.copy(GUN_REST);
  // Everything that makes the weapon feel held rather than bolted to the view.
  const weapon = {
    ads: false, // right mouse held
    adsT: 0, // 0 = hip, 1 = fully aimed down the sights
    sightY: 0.028, // height of the sight line above the gun's origin
    adsZ: -0.24,
    adsPitch: 0, // muzzle-up tilt needed to line the sights up when aimed
    hipYaw: 0,
    swayX: 0, // lag behind mouse movement
    swayY: 0,
    bobPhase: 0,
    bobAmt: 0,
    kick: 0, // weapon recoil, 1 right after a shot
    viewKick: 0, // muzzle climb applied to the view
    sprinting: false,
    sprintT: 0,
    landDip: 0,
    strafe: 0,
    speed: 0,
    spread: 0.01,
    time: 0,
    fovScale: 1,
  };

  const limb = (from, to, radius, material) => {
    const dir = to.clone().sub(from);
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, dir.length(), 4, 10), material);
    mesh.position.copy(from).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return mesh;
  };
  const block = (w, h, d, x, y, z, material, rx = 0, rz = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, 0, rz);
    return mesh;
  };
  // Gloved hands and forearms, laid out in the rifle model's own coordinates:
  // right hand on the pistol grip (the model's origin), left under the handguard.
  function buildHands() {
    const hands = new THREE.Group();
    const glove = new THREE.MeshStandardMaterial({ color: 0x2a2d34, roughness: 0.75 });
    const knuckle = new THREE.MeshStandardMaterial({ color: 0x3a3f49, roughness: 0.6 });
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x39453f, roughness: 0.9 });
    const cuff = new THREE.MeshStandardMaterial({ color: 0x35e0c0, emissive: 0x0e5548, roughness: 0.5 });
    const V = (x, y, z) => new THREE.Vector3(x, y, z);

    // Right hand: palm behind the grip, fingers wrapped around its front.
    hands.add(block(0.07, 0.095, 0.05, 0.004, -0.03, 0.06, glove, 0.25));
    hands.add(block(0.084, 0.07, 0.035, 0.002, -0.036, -0.008, knuckle, 0.25));
    hands.add(block(0.022, 0.03, 0.07, 0.05, 0.03, -0.02, glove)); // trigger finger
    hands.add(block(0.024, 0.03, 0.06, -0.05, 0.035, 0.03, glove)); // thumb
    hands.add(limb(V(0.012, -0.05, 0.085), V(0.03, -0.1, 0.16), 0.04, glove)); // wrist
    hands.add(limb(V(0.03, -0.1, 0.16), V(0.2, -0.3, 0.62), 0.047, sleeve));
    hands.add(limb(V(0.036, -0.108, 0.175), V(0.047, -0.121, 0.205), 0.05, cuff));

    // Left hand: cupping the handguard from below.
    hands.add(block(0.092, 0.035, 0.1, 0, 0.062, -0.275, glove));
    hands.add(block(0.022, 0.07, 0.095, 0.052, 0.105, -0.275, knuckle)); // fingers, far side
    hands.add(block(0.022, 0.055, 0.045, -0.052, 0.1, -0.25, glove)); // thumb, near side
    hands.add(limb(V(-0.012, 0.04, -0.245), V(-0.06, -0.005, -0.17), 0.04, glove)); // wrist
    hands.add(limb(V(-0.06, -0.005, -0.17), V(-0.36, -0.27, 0.3), 0.047, sleeve));
    hands.add(limb(V(-0.07, -0.014, -0.155), V(-0.089, -0.031, -0.125), 0.05, cuff));
    return hands;
  }
  gun.visible = false;
  camera.add(gun);

  // --- Effects ---
  const effects = []; // { object, life, maxLife, grow }
  function addTracer(from, to, color) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([from, to]),
      new THREE.LineBasicMaterial({ color, transparent: true }),
    );
    world.add(line);
    effects.push({ object: line, life: 0.08, maxLife: 0.08, grow: 0 });
  }
  function addBurst(at, color, size) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(size, 12, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true }),
    );
    mesh.position.copy(at);
    world.add(mesh);
    effects.push({ object: mesh, life: 0.25, maxLife: 0.25, grow: 6 });
  }

  // --- Sound ---
  let audio = null;
  function blip(freq, duration, type, volume) {
    if (volume < 0.004) return;
    try {
      audio = audio || new AudioContext();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, audio.currentTime);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.3, audio.currentTime + duration);
      gain.gain.setValueAtTime(volume, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + duration);
      osc.connect(gain).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + duration);
    } catch {}
  }

  // --- HUD ---
  const hud = document.createElement("div");
  hud.style.cssText =
    "position:fixed;inset:0;pointer-events:none;display:none;color:#eaf6ff;font-family:ui-monospace,Consolas,monospace;";
  hud.innerHTML = `
    <div id="g-cross" style="position:absolute;left:50%;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;border:2px solid #35e0c0;border-radius:50%;box-sizing:border-box;opacity:.9"></div>
    <div id="g-stats" style="position:absolute;left:50%;top:14px;transform:translateX(-50%);font-size:18px;text-shadow:0 0 6px #000;white-space:pre"></div>
    <div id="g-feed" style="position:absolute;left:50%;top:44px;transform:translateX(-50%);font-size:13px;text-align:center;line-height:1.5;opacity:.85;text-shadow:0 0 6px #000;white-space:pre"></div>
    <div id="g-msg" style="position:absolute;left:50%;top:36%;transform:translate(-50%,-50%);font-size:26px;text-align:center;line-height:1.5;text-shadow:0 0 8px #000;white-space:pre"></div>
    <div id="g-hurt" style="position:absolute;inset:0;background:radial-gradient(transparent 50%, rgba(255,30,40,.75));opacity:0"></div>`;
  document.body.appendChild(hud);
  const statsEl = hud.querySelector("#g-stats");
  const crossEl = hud.querySelector("#g-cross");
  const feedEl = hud.querySelector("#g-feed");
  const msgEl = hud.querySelector("#g-msg");
  const hurtEl = hud.querySelector("#g-hurt");
  const HELP = [
    "CLICK TO PLAY",
    "WASD move  -  mouse aim  -  click shoot",
    "Right mouse aim down sights  -  Shift sprint  -  Space jump  -  Esc release mouse",
    "Lean your head to peek around corners, turn it to look around  (C recenters)",
    "Free-for-all: everyone shoots everyone",
  ].join("\n");
  // These are webcam games: with no tracked face there is nothing to play with.
  const NEED_FACE = [
    "WEBCAM REQUIRED",
    "This game is played with your head.",
    "Allow the camera, then sit where it can see your face.",
  ].join("\n");
  const feed = []; // { text, life }
  const announce = (text) => {
    feed.push({ text, life: 5 });
    if (feed.length > 4) feed.shift();
  };

  // --- Combatants ---
  // The player and the bots share this shape so anyone can target anyone.
  const player = {
    name: "You",
    isPlayer: true,
    alive: true,
    health: 100,
    pos: new THREE.Vector3(), // feet
    head: new THREE.Vector3(), // where others aim and what they must see
    yaw: 0,
    pitch: 0,
    vy: 0,
    y: 0,
    sinceHurt: 99,
  };
  const state = { active: false, tracked: false, kills: 0, deaths: 0, cooldown: 0, hurt: 0, respawn: 0 };
  const bots = [];
  const keys = new Set();
  let firing = false;
  // Head position (meters, window space) that counts as standing straight.
  let neutral = null;
  const lean = new THREE.Vector3();
  const leanTarget = new THREE.Vector3();

  // Real head rotation relative to how it was when you clicked in, amplified
  // (you cannot turn 90 degrees and still see the screen) with a small dead
  // zone so a resting head does not make the view swim.
  let neutralRot = null;
  const turn = [0, 0, 0];
  function headTurn(rot, dt, scale) {
    const target = [0, 0, 0];
    if (rot) {
      if (!neutralRot) neutralRot = [rot[0], rot[1], rot[2]];
      const gains = [params.shooterTurn, params.shooterTurn * 0.8, 0.6];
      const limits = [1.75, 1.0, 0.5];
      for (let i = 0; i < 3; i++) {
        let d = rot[i] - neutralRot[i];
        d = Math.sign(d) * Math.max(Math.abs(d) - 0.035, 0);
        target[i] = THREE.MathUtils.clamp(d * gains[i] * scale, -limits[i], limits[i]);
      }
    }
    const k = 1 - Math.exp(-dt * 16);
    for (let i = 0; i < 3; i++) turn[i] += (target[i] - turn[i]) * k;
    return turn;
  }

  function makeBot(i) {
    const color = BOT_COLORS[i % BOT_COLORS.length];
    const group = new THREE.Group();
    const suit = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.82, 4, 12), suit);
    torso.position.y = 0.68;
    const headMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.17, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0xd9b99b, roughness: 0.7 }),
    );
    headMesh.position.y = 1.58;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.07, 0.1), new THREE.MeshBasicMaterial({ color: 0x10141c }));
    visor.position.set(0, 1.6, -0.12);
    const botGun = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.55), new THREE.MeshStandardMaterial({ color: 0x20242c }));
    botGun.position.set(0.24, 1.22, -0.32);
    const botFlash = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffe9a0 }));
    botFlash.position.set(0.24, 1.22, -0.64);
    botFlash.visible = false;
    group.add(torso, headMesh, visor, botGun, botFlash);
    world.add(group);
    const bot = {
      name: BOT_NAMES[i % BOT_NAMES.length],
      color,
      isPlayer: false,
      alive: false,
      health: 100,
      group,
      pos: group.position,
      head: new THREE.Vector3(),
      yaw: 0,
      target: null,
      waypoint: new THREE.Vector3(),
      think: Math.random() * 0.3,
      cooldown: 1,
      reaction: 0,
      strafe: Math.random() < 0.5 ? 1 : -1,
      strafeTimer: 1,
      stuck: 0,
      respawn: 0.2 + i * 0.4,
      flash: botFlash,
      flashTimer: 0,
      suit,
      hitFlash: 0,
    };
    torso.userData = { bot, damage: 25 };
    headMesh.userData = { bot, damage: 50 };
    bot.parts = [torso, headMesh];
    bot.placeholder = [torso, headMesh, visor, botGun];
    group.visible = false;
    return bot;
  }
  for (let i = 0; i < 7; i++) bots.push(makeBot(i));
  const everyone = [player, ...bots];

  const spawnPoint = new THREE.Vector3();
  const probe = new THREE.Vector3();
  // A spot that is in the open, away from everybody, and ideally out of sight.
  function pickSpawn(who, minDistance) {
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 40; i++) {
      randomOpenPoint(probe);
      let nearest = Infinity;
      let seen = false;
      for (const other of everyone) {
        if (other === who || !other.alive) continue;
        const d = Math.hypot(other.pos.x - probe.x, other.pos.z - probe.z);
        nearest = Math.min(nearest, d);
        probe.y = EYE_HEIGHT;
        if (other.isPlayer && canSee(other.head, probe)) seen = true;
        probe.y = 0;
      }
      if (nearest < minDistance) continue;
      const score = Math.min(nearest, 25) - (seen ? 12 : 0) + Math.random() * 3;
      if (score > bestScore) {
        bestScore = score;
        best = best || new THREE.Vector3();
        best.copy(probe);
      }
    }
    return spawnPoint.copy(best || randomOpenPoint(probe));
  }

  function spawnBot(bot) {
    bot.pos.copy(pickSpawn(bot, 12));
    bot.pos.y = 0;
    bot.health = 100;
    bot.alive = true;
    bot.target = null;
    bot.cooldown = 0.8;
    bot.yaw = Math.random() * Math.PI * 2;
    randomOpenPoint(bot.waypoint);
    bot.group.visible = true;
    bot.head.set(bot.pos.x, EYE_HEIGHT, bot.pos.z);
    if (bot.mixer) {
      bot.mixer.stopAllAction();
      bot.anim = null;
      playAnim(bot, "Idle");
    }
  }

  function playAnim(bot, name) {
    if (!bot.actions || bot.anim === name || !bot.actions[name]) return;
    const next = bot.actions[name];
    const previous = bot.actions[bot.anim];
    next.reset().play();
    if (previous) next.crossFadeFrom(previous, 0.15, false);
    bot.anim = name;
  }

  function spawnPlayer() {
    player.pos.copy(pickSpawn(player, 10));
    player.pos.y = 0;
    player.health = 100;
    player.alive = true;
    player.vy = player.y = 0;
    player.pitch = 0;
    player.yaw = Math.atan2(player.pos.x, player.pos.z); // face the middle
  }

  function reset() {
    for (const bot of bots) {
      bot.alive = false;
      bot.group.visible = false;
      bot.respawn = 0.2 + bots.indexOf(bot) * 0.3;
    }
    feed.length = 0;
    state.kills = state.deaths = 0;
    state.respawn = 0;
    player.pos.set(0, 0, 0);
    player.yaw = player.pitch = player.vy = player.y = 0;
    player.health = 100;
    player.alive = true;
  }

  function damage(victim, amount, attacker) {
    if (!victim.alive) return;
    victim.health -= amount;
    if (victim.isPlayer) {
      state.hurt = 1;
      player.sinceHurt = 0;
      blip(140, 0.18, "sawtooth", 0.07);
    } else {
      victim.hitFlash = 0.1;
      // Getting shot makes a bot turn on whoever did it.
      if (attacker.alive) {
        victim.target = attacker;
        victim.reaction = Math.min(victim.reaction, 0.15);
      }
    }
    if (victim.health > 0) return;
    victim.alive = false;
    announce(`${attacker.name} took out ${victim.name}`);
    probe.set(victim.pos.x, 1.1, victim.pos.z);
    addBurst(probe, victim.isPlayer ? 0xff3344 : victim.color, 0.4);
    if (victim.isPlayer) {
      state.deaths += 1;
      state.respawn = 2.5;
      msgEl.textContent = `${attacker.name} got you`;
      blip(90, 0.5, "sawtooth", 0.1);
    } else {
      // With a real model the body falls and lies there until it respawns.
      if (victim.actions && victim.actions.Death) {
        victim.mixer.stopAllAction();
        victim.anim = "Death";
        victim.actions.Death.reset().play();
        victim.flash.visible = false;
      } else {
        victim.group.visible = false;
      }
      victim.respawn = 3 + Math.random() * 2;
      if (attacker.isPlayer) {
        state.kills += 1;
        blip(180, 0.25, "sawtooth", 0.07);
      }
    }
  }

  const locked = () => document.pointerLockElement === canvas;
  // Wherever your head is when you click in becomes "standing straight".
  document.addEventListener("pointerlockchange", () => {
    if (locked()) neutral = neutralRot = null;
  });
  canvas.addEventListener("mousedown", (e) => {
    if (!state.active) return;
    if (e.button === 2 && locked()) weapon.ads = true;
    if (e.button !== 0) return;
    if (!locked()) {
      if (state.tracked) canvas.requestPointerLock();
    } else firing = true;
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) firing = false;
    if (e.button === 2) weapon.ads = false;
  });
  canvas.addEventListener("contextmenu", (e) => {
    if (state.active) e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!state.active || !locked()) return;
    // Aiming down sights zooms in, so slow the mouse to match.
    const sensitivity = 0.0022 * (1 - 0.45 * weapon.adsT);
    player.yaw -= e.movementX * sensitivity;
    player.pitch = THREE.MathUtils.clamp(player.pitch - e.movementY * sensitivity, -1.2, 1.2);
    weapon.swayX = THREE.MathUtils.clamp(weapon.swayX - e.movementX * 0.0003, -0.05, 0.05);
    weapon.swayY = THREE.MathUtils.clamp(weapon.swayY + e.movementY * 0.0003, -0.05, 0.05);
  });
  window.addEventListener("keydown", (e) => {
    if (state.active) keys.add(e.code);
    if (state.active && e.code === "KeyC") neutral = neutralRot = null;
    if (state.active && e.code === "Space") e.preventDefault();
  });
  window.addEventListener("keyup", (e) => keys.delete(e.code));
  window.addEventListener("blur", () => keys.clear());

  const raycaster = new THREE.Raycaster();
  const eyeWorld = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const muzzle = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, "YXZ");

  function shoot() {
    state.cooldown = 0.1;
    weapon.kick = 1;
    flash.visible = true;
    flash.rotation.z = Math.random() * Math.PI;
    blip(520, 0.09, "square", 0.05);
    // Out of the (possibly leaning) head through the crosshair, scattered by
    // the current spread: loose from the hip and on the move, tight when aimed.
    camera.getWorldPosition(eyeWorld);
    camera.getWorldDirection(aim);
    aim.x += (Math.random() + Math.random() - 1) * weapon.spread;
    aim.y += (Math.random() + Math.random() - 1) * weapon.spread;
    aim.z += (Math.random() + Math.random() - 1) * weapon.spread;
    aim.normalize();
    // Muzzle climb: most of it settles back, some of it you have to pull down.
    const climb = THREE.MathUtils.lerp(0.016, 0.009, weapon.adsT);
    weapon.viewKick += climb;
    player.pitch = Math.min(player.pitch + climb * 0.3, 1.2);
    player.yaw += (Math.random() - 0.5) * climb * 0.7;
    raycaster.set(eyeWorld, aim);
    raycaster.far = 120;
    const targets = solids.slice();
    for (const bot of bots) if (bot.alive) targets.push(...bot.parts);
    const hit = raycaster.intersectObjects(targets, false)[0];
    const end = hit ? hit.point : tmp.copy(eyeWorld).addScaledVector(aim, 120);
    flash.getWorldPosition(muzzle);
    addTracer(muzzle.clone(), end.clone(), 0xfff2b0);
    if (!hit) return;
    const info = hit.object.userData;
    if (!info.bot) {
      addBurst(hit.point, 0xfff2b0, 0.04);
      return;
    }
    addBurst(hit.point, 0xffd54a, 0.08);
    blip(900, 0.05, "triangle", 0.05);
    damage(info.bot, info.damage, player);
  }

  function botShoot(bot, target, dist) {
    bot.cooldown = 0.42 + Math.random() * 0.3;
    bot.flash.visible = true;
    bot.flashTimer = 0.05;
    const toPlayer = Math.hypot(bot.pos.x - player.pos.x, bot.pos.z - player.pos.z);
    blip(380, 0.08, "square", 0.045 / (1 + toPlayer * 0.25));
    // Accuracy falls off with range; a moving target is harder to hit.
    const chance = THREE.MathUtils.clamp(0.62 - dist * 0.014, 0.15, 0.6);
    const hit = Math.random() < chance;
    bot.flash.getWorldPosition(muzzle);
    if (bot.actions && bot.actions.Shoot) bot.actions.Shoot.reset().play();
    tmp.copy(target.head);
    tmp.y -= 0.35;
    if (!hit) tmp.add(probe.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).multiplyScalar(1.6));
    addTracer(muzzle.clone(), tmp.clone(), 0xffb38a);
    if (hit) damage(target, 9 + Math.random() * 6, bot);
  }

  function updateBot(bot, dt) {
    if (bot.mixer) bot.mixer.update(dt);
    if (!bot.alive) {
      bot.respawn -= dt;
      if (bot.respawn <= 0) spawnBot(bot);
      return;
    }
    bot.head.set(bot.pos.x, EYE_HEIGHT, bot.pos.z);

    // Pick the nearest enemy in view, a few times a second.
    bot.think -= dt;
    if (bot.think <= 0) {
      bot.think = 0.2 + Math.random() * 0.15;
      let best = null;
      let bestDist = 38;
      for (const other of everyone) {
        if (other === bot || !other.alive) continue;
        const d = bot.head.distanceTo(other.head);
        // Stick with the current target unless someone is clearly closer.
        const effective = other === bot.target ? d * 0.7 : d;
        if (effective < bestDist && canSee(bot.head, other.head)) {
          best = other;
          bestDist = effective;
        }
      }
      if (best !== bot.target) bot.reaction = 0.35 + Math.random() * 0.3;
      bot.target = best;
    }

    let moveX = 0, moveZ = 0, speed = 3.4, wantYaw = bot.yaw;
    const target = bot.target && bot.target.alive ? bot.target : null;
    if (target) {
      const dx = target.head.x - bot.pos.x;
      const dz = target.head.z - bot.pos.z;
      const dist = Math.hypot(dx, dz) || 1;
      wantYaw = Math.atan2(-dx, -dz);
      // Hold a middle distance and keep strafing so they are not sitting ducks.
      const approach = dist > 14 ? 1 : dist < 6 ? -1 : 0;
      bot.strafeTimer -= dt;
      if (bot.strafeTimer <= 0) {
        bot.strafe = -bot.strafe;
        bot.strafeTimer = 0.8 + Math.random() * 1.8;
      }
      moveX = (dx / dist) * approach + (-dz / dist) * bot.strafe * 0.8;
      moveZ = (dz / dist) * approach + (dx / dist) * bot.strafe * 0.8;
      speed = 2.8;

      bot.reaction -= dt;
      bot.cooldown -= dt;
      let diff = wantYaw - bot.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      if (bot.reaction <= 0 && bot.cooldown <= 0 && Math.abs(diff) < 0.25 && canSee(bot.head, target.head)) {
        botShoot(bot, target, dist);
      }
    } else {
      // Nobody in sight: roam toward a random spot.
      const dx = bot.waypoint.x - bot.pos.x;
      const dz = bot.waypoint.z - bot.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 1) randomOpenPoint(bot.waypoint);
      else {
        moveX = dx / dist;
        moveZ = dz / dist;
        wantYaw = Math.atan2(-moveX, -moveZ);
      }
    }

    const len = Math.hypot(moveX, moveZ);
    playAnim(bot, len > 0.01 ? "Run" : "Idle");
    if (len > 0.01) {
      const beforeX = bot.pos.x, beforeZ = bot.pos.z;
      bot.pos.x += (moveX / len) * speed * dt;
      bot.pos.z += (moveZ / len) * speed * dt;
      collide(bot.pos, PLAYER_RADIUS);
      // Keep bodies from overlapping each other or the player.
      for (const other of everyone) {
        if (other === bot || !other.alive) continue;
        const ox = bot.pos.x - other.pos.x, oz = bot.pos.z - other.pos.z;
        const d = Math.hypot(ox, oz);
        if (d < 0.8 && d > 1e-4) {
          bot.pos.x = other.pos.x + (ox / d) * 0.8;
          bot.pos.z = other.pos.z + (oz / d) * 0.8;
          collide(bot.pos, PLAYER_RADIUS);
        }
      }
      // Pressed against something: go somewhere else instead of grinding on it.
      const moved = Math.hypot(bot.pos.x - beforeX, bot.pos.z - beforeZ);
      bot.stuck = moved < speed * dt * 0.35 ? bot.stuck + dt : Math.max(bot.stuck - dt, 0);
      if (bot.stuck > 0.4) {
        bot.stuck = 0;
        bot.strafe = -bot.strafe;
        randomOpenPoint(bot.waypoint);
      }
    }

    let diff = wantYaw - bot.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    bot.yaw += THREE.MathUtils.clamp(diff, -7 * dt, 7 * dt);
    bot.group.rotation.y = bot.yaw;

    bot.flashTimer -= dt;
    if (bot.flashTimer <= 0) bot.flash.visible = false;
    bot.hitFlash -= dt;
    bot.suit.emissive.setHex(bot.hitFlash > 0 ? 0xffffff : 0x000000);
  }

  function update(dt, eye, tracked, rot) {
    if (!state.active) return;
    dt = Math.min(dt, 0.05);
    state.tracked = tracked;
    // No face, no game: everything freezes until the camera can see you again.
    const playing = locked() && tracked;

    if (playing && player.alive) {
      const f = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
      const s = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
      const len = Math.hypot(f, s) || 1;
      const shift = keys.has("ShiftLeft") || keys.has("ShiftRight");
      weapon.sprinting = shift && f > 0 && !weapon.ads && !firing;
      const speed = weapon.ads ? 2.8 : weapon.sprinting ? 8 : 5;
      const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
      const fromX = player.pos.x, fromZ = player.pos.z;
      player.pos.x += ((-sin * f + cos * s) / len) * speed * dt;
      player.pos.z += ((-cos * f - sin * s) / len) * speed * dt;
      collide(player.pos, PLAYER_RADIUS);
      weapon.speed = Math.hypot(player.pos.x - fromX, player.pos.z - fromZ) / dt;
      weapon.strafe += (s - weapon.strafe) * (1 - Math.exp(-dt * 8));
      if (keys.has("Space") && player.y === 0) player.vy = 4.5;
      const falling = player.y > 0 ? player.vy : 0;
      player.vy -= 12 * dt;
      player.y = Math.max(player.y + player.vy * dt, 0);
      if (player.y === 0) {
        // Landing shoves the weapon and the view down for a moment.
        if (falling < 0) weapon.landDip = Math.min(-falling * 0.012, 0.06);
        player.vy = 0;
      }

      state.cooldown -= dt;
      if (firing && state.cooldown <= 0) shoot();

      // Catch your breath: health comes back if nobody has hit you for a bit.
      player.sinceHurt += dt;
      if (player.sinceHurt > 4) player.health = Math.min(player.health + 12 * dt, 100);
    } else if (playing && !player.alive) {
      state.respawn -= dt;
      if (state.respawn <= 0) {
        spawnPlayer();
        msgEl.textContent = "";
      }
    }

    // The world only runs while you are in it, so clicking out pauses the match.
    if (playing) for (const bot of bots) updateBot(bot, dt);

    for (let i = effects.length - 1; i >= 0; i--) {
      const fx = effects[i];
      fx.life -= dt;
      fx.object.material.opacity = Math.max(fx.life / fx.maxLife, 0);
      if (fx.grow) fx.object.scale.addScalar(fx.grow * dt);
      if (fx.life <= 0) {
        world.remove(fx.object);
        fx.object.geometry.dispose();
        effects.splice(i, 1);
      }
    }

    // The rig is the body (position + facing). The camera is the head: it
    // pitches with the mouse and is pushed around by the real head's movement.
    euler.set(0, player.yaw, 0);
    rig.quaternion.setFromEuler(euler);
    rig.position.set(player.pos.x, EYE_HEIGHT + player.y, player.pos.z);
    rig.updateMatrixWorld(true);

    // Without a tracked face there is nothing to lean with except the keys.
    if (!tracked) eye = neutral || eye;
    else if (!neutral) neutral = [eye[0], eye[1], eye[2]];
    const zero = neutral || eye;
    const gain = params.shooterLean;
    leanTarget.set(
      THREE.MathUtils.clamp((eye[0] - zero[0]) * gain, -1.5, 1.5),
      THREE.MathUtils.clamp((eye[1] - zero[1]) * gain * 0.6, -0.9, 0.5),
      THREE.MathUtils.clamp((eye[2] - zero[2]) * gain * 0.5, -0.8, 0.8),
    );
    // Do not let the head pass through crates or walls.
    rig.localToWorld(leanTarget);
    collide(leanTarget, HEAD_RADIUS);
    rig.worldToLocal(leanTarget);
    lean.lerp(leanTarget, 1 - Math.exp(-dt * 18));
    const w = weapon;
    const ease = (rate) => 1 - Math.exp(-dt * rate);
    const active = playing && player.alive;
    if (!active) w.speed = 0;
    w.time += dt;
    w.adsT += ((w.ads && active ? 1 : 0) - w.adsT) * ease(16);
    w.sprintT += ((w.sprinting && active ? 1 : 0) - w.sprintT) * ease(8);
    const grounded = player.y === 0 ? 1 : 0;
    w.bobAmt += (Math.min(w.speed / 5, 1.6) * grounded - w.bobAmt) * ease(8);
    if (w.bobAmt > 0.02) w.bobPhase += dt * (5 + w.speed * 1.3);
    w.swayX *= Math.exp(-dt * 8);
    w.swayY *= Math.exp(-dt * 8);
    w.kick *= Math.exp(-dt * 16);
    w.viewKick *= Math.exp(-dt * 9);
    w.landDip *= Math.exp(-dt * 7);
    if (!active) w.strafe *= Math.exp(-dt * 8);
    w.fovScale = 1 - 0.32 * w.adsT + 0.05 * w.sprintT;
    w.spread = THREE.MathUtils.lerp(
      0.009 + 0.018 * Math.min(w.speed / 5, 1.6) + (grounded ? 0 : 0.03) + w.kick * 0.006,
      0.0012,
      w.adsT,
    );
    // Aimed, the weapon is braced: bob and sway mostly go away.
    const loose = 1 - 0.85 * w.adsT;

    camera.position.copy(lean);
    camera.position.y += Math.sin(w.bobPhase * 2) * 0.02 * w.bobAmt * (1 - 0.6 * w.adsT) - w.landDip * 1.2;
    // Tip the view a little into the lean, as a real head would.
    // Turning your real head looks around; it is damped while aiming so the
    // sights stay steady.
    const look = headTurn(rot, dt, 1 - 0.75 * w.adsT);
    euler.set(
      THREE.MathUtils.clamp(player.pitch + w.viewKick + look[1], -1.45, 1.45),
      look[0],
      -lean.x * 0.05 + Math.sin(w.bobPhase) * 0.004 * w.bobAmt + look[2],
    );
    camera.quaternion.setFromEuler(euler);
    // Bots aim at, and must be able to see, where the head really is, so
    // leaning out exposes you and ducking behind a crate hides you.
    player.head.copy(lean);
    rig.localToWorld(player.head);

    // Weapon pose = hip or sights position, plus walk bob, breathing, lag
    // behind the mouse, recoil, strafe/lean tilt, and the lowered sprint carry.
    gun.position.set(
      THREE.MathUtils.lerp(GUN_REST.x, 0, w.adsT) +
        Math.sin(w.bobPhase) * 0.011 * w.bobAmt * loose +
        w.swayX * 0.5 * loose -
        w.sprintT * 0.05,
      THREE.MathUtils.lerp(GUN_REST.y, -w.sightY, w.adsT) -
        Math.abs(Math.cos(w.bobPhase)) * 0.009 * w.bobAmt * loose +
        Math.sin(w.time * 1.7) * 0.0025 * loose +
        w.swayY * 0.5 * loose -
        w.landDip -
        w.sprintT * 0.05,
      THREE.MathUtils.lerp(GUN_REST.z, w.adsZ, w.adsT) + w.kick * 0.045 * (1 - 0.5 * w.adsT),
    );
    gun.rotation.set(
      w.kick * 0.06 * (1 - 0.6 * w.adsT) + w.swayY * 1.6 * loose - w.sprintT * 0.32 + w.landDip * 1.5 + w.adsPitch * w.adsT,
      w.hipYaw * (1 - w.adsT) - w.swayX * 1.8 * loose + w.sprintT * 0.62,
      -w.strafe * 0.06 * loose + w.swayX * 1.1 * loose - lean.x * 0.04 + Math.sin(w.bobPhase) * 0.012 * w.bobAmt * loose,
    );
    gun.visible = player.alive;
    if (w.kick < 0.45) flash.visible = false;

    // The crosshair shows the real spread, and gives way to the sights.
    const crossSize = 12 + w.spread * 1500;
    crossEl.style.width = crossEl.style.height = `${crossSize}px`;
    crossEl.style.margin = `${-crossSize / 2}px 0 0 ${-crossSize / 2}px`;
    crossEl.style.opacity = 0.9 * (1 - w.adsT) * (player.alive ? 1 : 0);

    state.hurt = Math.max(state.hurt - dt * 2, 0);
    hurtEl.style.opacity = player.alive ? state.hurt : 0.8;
    statsEl.textContent = `HP ${Math.max(Math.round(player.health), 0)}    KILLS ${state.kills}    DEATHS ${state.deaths}`;
    for (let i = feed.length - 1; i >= 0; i--) {
      feed[i].life -= dt;
      if (feed[i].life <= 0) feed.splice(i, 1);
    }
    feedEl.textContent = feed.map((f) => f.text).join("\n");
    if (!tracked) msgEl.textContent = NEED_FACE;
    else if (!locked()) msgEl.textContent = HELP;
    else if (player.alive) msgEl.textContent = "";
  }

  // --- Real models, swapped in over the placeholders as each one arrives ---
  // The boxes and capsules above stay as invisible collision and hit shapes.
  const gltf = new GLTFLoader();
  const textures = new THREE.TextureLoader();
  const asset = (file, apply) =>
    gltf
      .loadAsync(ASSETS + file)
      .then(apply)
      .catch((err) => console.warn(`game asset ${file} not used:`, err.message || err));

  // Stretched cover would smear its texture; tile it by the box size instead.
  function fitCover(source, w, h, d, unitHeight) {
    const object = source.clone();
    object.scale.set(w, h / unitHeight, d);
    return object;
  }

  asset("crate.glb", (crate) =>
    asset("pillar.glb", (pillar) => {
      for (const c of cover) {
        const tall = c.h >= 3;
        const model = fitCover(tall ? pillar.scene : crate.scene, c.w, c.h, c.d, tall ? 4 : 1);
        model.position.set(c.x, 0, c.z);
        world.add(model);
        c.mesh.visible = false;
      }
    }),
  );

  asset("arena_wall.glb", (wall) => {
    const count = Math.ceil((ARENA * 2) / WALL_SEGMENT);
    // The modeled face is the segment's -Z side; turn it toward the arena.
    const sides = [
      { rot: Math.PI, at: (t) => [t, -ARENA - 0.5] },
      { rot: 0, at: (t) => [t, ARENA + 0.5] },
      { rot: -Math.PI / 2, at: (t) => [-ARENA - 0.5, t] },
      { rot: Math.PI / 2, at: (t) => [ARENA + 0.5, t] },
    ];
    for (const side of sides) {
      for (let i = 0; i < count; i++) {
        const segment = wall.scene.clone();
        const [x, z] = side.at(-ARENA + WALL_SEGMENT / 2 + i * WALL_SEGMENT);
        segment.position.set(x, 0, z);
        segment.rotation.y = side.rot;
        world.add(segment);
      }
    }
    for (const b of boundary) b.mesh.visible = false;
  });

  // Hands on the rifle: the modeled arms if they loaded, otherwise the blocky
  // stand-ins. Both are laid out in the rifle model's coordinates.
  let rifleLoaded = false;
  let armsModel = null;
  let handsObject = null;
  const setHands = (object) => {
    if (handsObject) gun.remove(handsObject);
    handsObject = object;
    gun.add(object);
  };
  asset("arms_fp.glb", (arms) => {
    armsModel = arms.scene;
    armsModel.traverse((child) => {
      if (child.isMesh) child.frustumCulled = false;
    });
    if (rifleLoaded) setHands(armsModel);
  });

  asset("rifle_fp.glb", (rifle) => {
    for (const part of [body, barrel, grip, sight]) gun.remove(part);
    gun.add(rifle.scene);
    rifleLoaded = true;
    setHands(armsModel || buildHands());
    gun.scale.setScalar(0.62);
    GUN_REST.set(0.15, -0.155, -0.36);
    weapon.hipYaw = 0.04;
    // This model's front post sits lower than the middle of its rear ring, so
    // the aimed pose tips the muzzle up slightly to line the two up on the eye.
    weapon.sightY = 0.132;
    weapon.adsPitch = 0.09;
    weapon.adsZ = -0.2;
    const tip = rifle.scene.getObjectByName("Muzzle");
    if (tip) flash.position.copy(tip.position);
    flash.scale.setScalar(1.6);
  });

  asset("soldier.glb", (soldier) => {
    for (const bot of bots) {
      const model = cloneSkinned(soldier.scene);
      model.traverse((child) => {
        if (!child.isMesh) return;
        child.frustumCulled = false;
        if (child.material.name === "TeamColor") {
          child.material = child.material.clone();
          child.material.color.set(bot.color);
          bot.suit = child.material; // flashes white when hit
        }
      });
      for (const part of bot.placeholder) part.visible = false;
      bot.group.add(model);
      bot.mixer = new THREE.AnimationMixer(model);
      bot.actions = {};
      for (const clip of soldier.animations) bot.actions[clip.name] = bot.mixer.clipAction(clip);
      for (const once of ["Death", "Shoot"]) {
        if (!bot.actions[once]) continue;
        bot.actions[once].setLoop(THREE.LoopOnce, 1);
        bot.actions[once].clampWhenFinished = once === "Death";
      }
      bot.anim = null;
      playAnim(bot, "Idle");
      const tip = model.getObjectByName("Muzzle");
      if (tip) {
        tip.add(bot.flash);
        bot.flash.position.set(0, 0, 0);
      }
    }
  });

  Promise.all(["floor_color.jpg", "floor_normal.jpg", "floor_orm.jpg"].map((f) => textures.loadAsync(ASSETS + f)))
    .then(([color, normal, orm]) => {
      // The textures describe a 2 x 2 m patch of floor.
      for (const t of [color, normal, orm]) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(ARENA, ARENA);
        t.anisotropy = 8;
      }
      color.colorSpace = THREE.SRGBColorSpace;
      floor.material = new THREE.MeshStandardMaterial({
        map: color,
        normalMap: normal,
        aoMap: orm,
        roughnessMap: orm,
        metalnessMap: orm,
        metalness: 1,
      });
      grid.visible = false;
    })
    .catch((err) => console.warn("game floor textures not used:", err.message || err));

  textures
    .loadAsync(ASSETS + "sky.jpg")
    .then((sky) => {
      sky.mapping = THREE.EquirectangularReflectionMapping;
      sky.colorSpace = THREE.SRGBColorSpace;
      background = sky;
      if (!environment) environment = sky; // also lights the metal surfaces
      fog = null;
      if (state.active) {
        scene.background = background;
        scene.environment = environment;
        scene.fog = fog;
      }
    })
    .catch((err) => console.warn("game sky not used:", err.message || err));
  new HDRLoader()
    .loadAsync(ASSETS + "sky.hdr")
    .then((hdr) => {
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      environment = hdr; // better lighting than the JPG, which stays as the backdrop
      if (state.active) scene.environment = environment;
    })
    .catch((err) => console.warn("game sky.hdr not used:", err.message || err));

  let savedBackground = null;
  let savedFog = null;
  let savedEnvironment = null;
  function setActive(on) {
    if (on === state.active) return;
    state.active = on;
    world.visible = on;
    gun.visible = on;
    hud.style.display = on ? "block" : "none";
    if (on) {
      savedBackground = scene.background;
      savedFog = scene.fog;
      savedEnvironment = scene.environment;
      scene.background = background;
      scene.environment = environment;
      scene.environmentIntensity = 1.6;
      scene.fog = fog;
      reset();
    } else {
      scene.background = savedBackground;
      scene.environment = savedEnvironment;
      scene.environmentIntensity = 1;
      scene.fog = savedFog;
      if (locked()) document.exitPointerLock();
      keys.clear();
      firing = false;
      weapon.ads = false;
      rig.position.set(0, 0, 0);
      rig.quaternion.identity();
      rig.updateMatrixWorld(true);
    }
  }

  return { update, setActive, state, player, bots, boxes, weapon, isActive: () => state.active };
}
