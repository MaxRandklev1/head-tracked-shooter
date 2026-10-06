# Head-Tracked Shooter

A free-for-all arena shooter you play with your head. Your webcam tracks your face, and your real head movement becomes your in-game head movement:

- **Lean** left or right to peek around cover.
- **Duck** behind a low crate to break line of sight.
- **Turn** your head to look around.

Seven armed bots fight you and each other. They cannot see or shoot through tall cover, and they aim at where your head really is, so leaning out exposes you.

**This is a webcam game. There is no keyboard or mouse substitute for the head.** If no face is being tracked, the game does not start, and if your face leaves the picture mid-match everything freezes until it is back.

## Play it

**https://maxrandklev1.github.io/head-tracked-shooter/** (Chrome or Edge, with a webcam).

## Run it locally

Needs [Node.js](https://nodejs.org) 20 or newer, a webcam, and a Chromium-based browser (Chrome or Edge).

```
npm install
npm run dev
```

Open the address it prints (http://localhost:5173/), allow the camera, sit where it can see your face, and click to play. Press **F** for fullscreen.

## Controls

| Input | Action |
|---|---|
| Your head | Lean, duck, look around |
| W A S D | Walk |
| Mouse | Aim |
| Left mouse | Fire |
| Right mouse (hold) | Aim down sights |
| Shift | Sprint |
| Space | Jump |
| C | Recenter: your current head position becomes "standing straight" |
| Esc | Release the mouse and pause |

Wherever your head is when you click in counts as standing straight.

## Tips

- A 60 fps webcam mode makes a big difference. The game asks the camera for its fastest mode; many webcams fall back to 30 fps in dim light, so light your face.
- If leaning or turning feels like too much or too little, the sliders are in the Settings panel (visible while paused).

## How it works

- [three.js](https://threejs.org) for rendering.
- [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) runs in the browser. Head position comes from the iris landmarks (distance from the pixel spacing of the eyes), head rotation from the face transformation matrix. Nothing leaves your machine.
- A One Euro filter smooths the tracking, and a short velocity prediction hides camera latency.

`src/game.js` is the game, `src/tracker.js` the webcam tracking, `src/filter.js` the smoothing, `src/main.js` the glue.

## Deploy

`npm run deploy` builds the game and pushes the build to the `gh-pages` branch, which GitHub Pages serves.

## Test

With the dev server running:

```
npm test
```

This drives the game in headless Chrome. There is no webcam there, so it feeds simulated face samples through a development-only hook and checks that the game refuses to run without a face, that head movement leans and turns the view, and that the match freezes when the face is lost. The hook does not exist in production builds (`npm run build`).
